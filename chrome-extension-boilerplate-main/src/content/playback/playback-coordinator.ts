import type { DescriptionSegment } from '../../shared/contracts/manifest';
import type { PlayerContext } from '../../shared/contracts/messages';
import type { PlayerContextUpdateReason } from '../player-controller';
import type { AudioGateway } from './runtime-audio-gateway';

const VOLUME_EPSILON = 0.005;

export interface PlayerControlPort {
  getContext(): PlayerContext;
  play(): Promise<boolean>;
  pause(): boolean;
  setVolume(volume: number): boolean;
}

export type PlaybackCoordinatorStatus = {
  audio_state: 'idle' | 'playing' | 'error';
  active_segment_id: string | null;
  active_segment_text: string | null;
  active_mode: DescriptionSegment['mode'] | null;
};

type ActivePlayback = {
  requestId: string;
  segment: DescriptionSegment;
  videoKey: string;
  userVolume: number;
  duckFactor: number;
  expectedVolume: number | null;
  wasPlaying: boolean;
  expectingPauseEvent: boolean;
};

export class PlaybackCoordinator {
  private active: ActivePlayback | null = null;
  private audioState: PlaybackCoordinatorStatus['audio_state'] = 'idle';
  private requestSequence = 0;

  constructor(
    private readonly player: PlayerControlPort,
    private readonly audio: AudioGateway,
  ) {}

  async playSegment(
    manifestId: string,
    segment: DescriptionSegment,
    duckFactor: number,
    playbackRate: number,
    descriptionVolume: number,
  ): Promise<void> {
    this.cancel('superseded');
    const context = this.player.getContext();
    if (!context.available || context.state !== 'playing') {
      return;
    }

    const requestId = `${segment.id}:${Date.now()}:${this.requestSequence++}`;
    const active: ActivePlayback = {
      requestId,
      segment,
      videoKey: context.video_key,
      userVolume: context.volume,
      duckFactor,
      expectedVolume: null,
      wasPlaying: true,
      expectingPauseEvent: segment.mode === 'extended',
    };
    this.active = active;
    this.audioState = 'playing';

    if (segment.mode === 'overlay') {
      active.expectedVolume = active.userVolume * duckFactor;
      if (!this.player.setVolume(active.expectedVolume)) {
        this.failBeforePlayback(active);
        return;
      }
    } else if (!this.player.pause()) {
      this.failBeforePlayback(active);
      return;
    }

    let response;
    try {
      response = await this.audio.play({
        request_id: requestId,
        manifest_id: manifestId,
        segment_id: segment.id,
        audio_path: segment.audio.path,
        expected_duration_ms: segment.audio.duration_ms,
        playback_rate: Math.min(4, Math.max(0.25, playbackRate)),
        volume: Math.min(1, Math.max(0, descriptionVolume)),
      });
    } catch {
      response = { ok: false as const, request_id: requestId, error: 'play_failed' as const };
    }

    if (this.active?.requestId !== requestId) {
      return;
    }
    await this.finish(active, response.request_id === requestId && response.ok);
  }

  handlePlayerContext(context: PlayerContext, reason: PlayerContextUpdateReason): void {
    const active = this.active;
    if (!active) {
      return;
    }
    if (!context.available || context.video_key !== active.videoKey) {
      this.cancel('videochange');
      return;
    }
    if (reason === 'seeking' || reason === 'seeked' || reason === 'videochange') {
      this.cancel(reason);
      return;
    }
    if (reason === 'ended') {
      this.cancel('ended');
      return;
    }
    if (reason === 'pause') {
      if (active.segment.mode === 'extended' && active.expectingPauseEvent) {
        active.expectingPauseEvent = false;
      } else {
        this.cancel('pause');
      }
      return;
    }
    if (reason === 'play' && active.segment.mode === 'extended') {
      this.cancel('manual-resume');
      return;
    }
    if (reason === 'volumechange' && active.segment.mode === 'overlay') {
      this.handleVolumeChange(active, context.volume);
    }
  }

  cancel(_reason: string, resumeExtended = false): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = null;
    this.audioState = 'idle';
    if (active.segment.mode === 'overlay') {
      this.player.setVolume(active.userVolume);
    } else if (resumeExtended) {
      const context = this.player.getContext();
      if (
        active.wasPlaying &&
        context.available &&
        context.video_key === active.videoKey &&
        context.state === 'paused'
      ) {
        void this.player.play().then((resumed) => {
          if (!resumed) {
            this.audioState = 'error';
          }
        });
      }
    }
    void this.audio.stop(active.requestId).catch(() => undefined);
  }

  getStatus(): PlaybackCoordinatorStatus {
    return {
      audio_state: this.audioState,
      active_segment_id: this.active?.segment.id ?? null,
      active_segment_text: this.active?.segment.text ?? null,
      active_mode: this.active?.segment.mode ?? null,
    };
  }

  cancelExtended(reason: string): void {
    if (this.active?.segment.mode === 'extended') {
      this.cancel(reason, true);
    }
  }

  private handleVolumeChange(active: ActivePlayback, reportedVolume: number): void {
    if (
      active.expectedVolume !== null &&
      Math.abs(reportedVolume - active.expectedVolume) <= VOLUME_EPSILON
    ) {
      return;
    }
    active.userVolume = reportedVolume;
    active.expectedVolume = reportedVolume * active.duckFactor;
    this.player.setVolume(active.expectedVolume);
  }

  private failBeforePlayback(active: ActivePlayback): void {
    if (this.active?.requestId !== active.requestId) {
      return;
    }
    this.active = null;
    this.audioState = 'error';
    if (active.segment.mode === 'overlay') {
      this.player.setVolume(active.userVolume);
    }
  }

  private async finish(active: ActivePlayback, succeeded: boolean): Promise<void> {
    this.active = null;
    this.audioState = succeeded ? 'idle' : 'error';
    if (active.segment.mode === 'overlay') {
      this.player.setVolume(active.userVolume);
      return;
    }

    const context = this.player.getContext();
    if (
      active.wasPlaying &&
      context.available &&
      context.video_key === active.videoKey &&
      context.state === 'paused'
    ) {
      const resumed = await this.player.play();
      if (!resumed) {
        this.audioState = 'error';
      }
    }
  }
}
