import demoManifestFixture from '../../../fixtures/manifest-v1.1.valid.json';
import {
  parseManifestV1_1,
  type VoiceBridgeManifestV1_1,
} from '../../shared/contracts/manifest';
import type {
  PlayerContext,
  SchedulerLastEvent,
  SchedulerStatus,
} from '../../shared/contracts/messages';
import {
  DEFAULT_PLAYBACK_SETTINGS,
  type PlaybackSettings,
} from '../../shared/settings/playback-settings';
import type { PlayerContextUpdateReason } from '../player-controller';
import type { PlaybackCoordinator } from '../playback/playback-coordinator';
import { DescriptionScheduler } from './description-scheduler';
import type { SchedulerEvent } from './types';

const SCHEDULER_TICK_MS = 50;
const demoManifest = parseManifestV1_1(demoManifestFixture);

export class DemoSchedulerRuntime {
  private readonly scheduler = new DescriptionScheduler();
  private readonly manifests = new Map<string, VoiceBridgeManifestV1_1>([
    [`${demoManifest.video.provider}:${demoManifest.video.video_id}`, demoManifest],
  ]);
  private activeVideoKey: string | null = null;
  private inactiveReason: 'no_video' | 'no_manifest' = 'no_video';
  private timer: number | null = null;
  private settings: PlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
  private lastPlaybackEvent: SchedulerLastEvent | null = null;

  constructor(
    private readonly getPlayerContext: () => PlayerContext,
    private readonly playback: PlaybackCoordinator,
  ) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.handlePlayerContext(this.getPlayerContext(), 'sync');
    this.timer = window.setInterval(() => {
      this.tick();
    }, SCHEDULER_TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.playback.cancel('runtime-stop');
    this.activeVideoKey = null;
    this.scheduler.unload();
  }

  handlePlayerContext(context: PlayerContext, reason: PlayerContextUpdateReason): void {
    this.playback.handlePlayerContext(context, reason);
    if (!context.available) {
      this.deactivate('no_video');
      return;
    }

    if (context.video_key !== this.activeVideoKey) {
      const manifest = this.manifests.get(context.video_key);
      if (!manifest) {
        this.deactivate('no_manifest');
        return;
      }
      this.activeVideoKey = context.video_key;
      this.scheduler.load(manifest, context.current_time_ms);
      this.lastPlaybackEvent = null;
    }

    this.scheduler.setPlaying(this.settings.enabled && context.state === 'playing');
    if (reason === 'seeking' || reason === 'seeked') {
      this.recordEvents(this.scheduler.seek(context.current_time_ms));
    }
  }

  setEnabled(enabled: boolean): void {
    this.updateSettings({ ...this.settings, enabled });
  }

  updateSettings(settings: PlaybackSettings): void {
    const wasEnabled = this.settings.enabled;
    const autoPauseTurnedOff =
      this.settings.auto_pause_enabled && !settings.auto_pause_enabled;
    this.settings = { ...settings };
    const context = this.getPlayerContext();
    if (!settings.enabled) {
      this.scheduler.setPlaying(false);
      if (wasEnabled) {
        this.playback.cancel('disabled', true);
      }
      return;
    }
    if (autoPauseTurnedOff) {
      this.playback.cancelExtended('auto-pause-disabled');
    }
    if (!wasEnabled && context.available && context.video_key === this.activeVideoKey) {
      this.recordEvents(this.scheduler.seek(context.current_time_ms));
    }
    this.scheduler.setPlaying(context.available && context.state === 'playing');
  }

  getStatus(): SchedulerStatus {
    const snapshot = this.scheduler.getSnapshot();
    const playbackStatus = this.playback.getStatus();
    if (!snapshot || this.activeVideoKey === null) {
      return {
        active: false,
        enabled: this.settings.enabled,
        ...playbackStatus,
        settings: { ...this.settings },
        reason: this.inactiveReason,
      };
    }
    return {
      active: true,
      enabled: this.settings.enabled,
      ...playbackStatus,
      settings: { ...this.settings },
      ...snapshot,
      last_event: this.lastPlaybackEvent ?? snapshot.last_event,
    };
  }

  private tick(): void {
    const context = this.getPlayerContext();
    if (!context.available || context.video_key !== this.activeVideoKey) {
      this.handlePlayerContext(context, 'sync');
      return;
    }
    this.scheduler.setPlaying(this.settings.enabled && context.state === 'playing');
    this.recordEvents(this.scheduler.tick(context.current_time_ms));
  }

  private deactivate(reason: 'no_video' | 'no_manifest'): void {
    this.playback.cancel(reason);
    this.activeVideoKey = null;
    this.inactiveReason = reason;
    this.lastPlaybackEvent = null;
    this.scheduler.unload();
  }

  private recordEvents(events: SchedulerEvent[]): void {
    for (const event of events) {
      const detail = event.type === 'skip' ? ` (${event.reason})` : '';
      console.info(
        `[VOICE BRIDGE] Scheduler ${event.type}: ${event.segment.id}${detail}`,
      );
      this.lastPlaybackEvent = {
        type: event.type,
        segment_id: event.segment.id,
        mode: event.segment.mode,
        at_ms: event.atMs,
        ...(event.type === 'skip' ? { reason: event.reason } : {}),
      };
      if (
        event.type === 'trigger' &&
        event.segment.mode === 'extended' &&
        !this.settings.auto_pause_enabled
      ) {
        this.lastPlaybackEvent = {
          type: 'skip',
          segment_id: event.segment.id,
          mode: event.segment.mode,
          at_ms: event.atMs,
          reason: 'auto_pause_disabled',
        };
        continue;
      }
      if (event.type === 'trigger' && this.settings.enabled && this.activeVideoKey) {
        const manifest = this.manifests.get(this.activeVideoKey);
        const context = this.getPlayerContext();
        if (manifest && context.available) {
          void this.playback.playSegment(
            manifest.manifest_id,
            event.segment,
            this.settings.duck_factor,
            context.playback_rate,
            this.settings.description_volume,
          );
        }
      }
    }
  }
}
