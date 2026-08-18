import assert from 'node:assert/strict';

import validFixture from '../../../fixtures/manifest-v1.1.valid.json';
import { parseManifestV1_1 } from '../../shared/contracts/manifest';
import type {
  AudioEngineResponse,
  PlayerContext,
  PlayerContextReady,
} from '../../shared/contracts/messages';
import { PlaybackCoordinator, type PlayerControlPort } from './playback-coordinator';
import type { AudioGateway, AudioPlayInput } from './runtime-audio-gateway';

const manifest = parseManifestV1_1(validFixture);

class FakePlayer implements PlayerControlPort {
  context: PlayerContextReady = {
    available: true,
    provider: 'youtube',
    video_id: 'dQw4w9WgXcQ',
    video_key: 'youtube:dQw4w9WgXcQ',
    title: '접근성 테스트 영상',
    duration_ms: 213061,
    current_time_ms: 12400,
    playback_rate: 1,
    volume: 0.8,
    muted: false,
    state: 'playing',
  };

  volumeCalls: number[] = [];
  pauseCalls = 0;
  playCalls = 0;

  getContext(): PlayerContext {
    return this.context;
  }

  async play(): Promise<boolean> {
    this.playCalls += 1;
    this.context.state = 'playing';
    return true;
  }

  pause(): boolean {
    this.pauseCalls += 1;
    this.context.state = 'paused';
    return true;
  }

  setVolume(volume: number): boolean {
    this.volumeCalls.push(volume);
    this.context.volume = volume;
    return true;
  }
}

class ImmediateAudioGateway implements AudioGateway {
  stopCalls: Array<string | undefined> = [];
  playCalls: AudioPlayInput[] = [];

  constructor(private readonly succeeds = true) {}

  async play(input: AudioPlayInput): Promise<AudioEngineResponse> {
    this.playCalls.push(input);
    return this.succeeds
      ? { ok: true, request_id: input.request_id, elapsed_ms: input.expected_duration_ms }
      : { ok: false, request_id: input.request_id, error: 'play_failed' };
  }

  async stop(requestId?: string): Promise<void> {
    this.stopCalls.push(requestId);
  }
}

class DeferredAudioGateway implements AudioGateway {
  stopCalls: Array<string | undefined> = [];
  private resolvePlay: ((response: AudioEngineResponse) => void) | null = null;
  private requestId = '';

  play(input: AudioPlayInput): Promise<AudioEngineResponse> {
    this.requestId = input.request_id;
    return new Promise((resolve) => {
      this.resolvePlay = resolve;
    });
  }

  async stop(requestId?: string): Promise<void> {
    this.stopCalls.push(requestId);
  }

  resolveSuccess(): void {
    this.resolvePlay?.({ ok: true, request_id: this.requestId, elapsed_ms: 3000 });
  }

  resolveCancelled(): void {
    this.resolvePlay?.({ ok: false, request_id: this.requestId, error: 'cancelled' });
  }
}

export async function runPlaybackCoordinatorTests(): Promise<void> {
  {
    const player = new FakePlayer();
    const audio = new ImmediateAudioGateway();
    const coordinator = new PlaybackCoordinator(player, audio);
    await coordinator.playSegment(
      manifest.manifest_id,
      manifest.segments[0],
      manifest.playback.duck_factor,
      1,
      0.6,
    );
    assert.equal(player.volumeCalls.length, 2);
    assert.ok(Math.abs(player.volumeCalls[0] - 0.28) < 0.0001);
    assert.equal(player.volumeCalls[1], 0.8);
    assert.equal(audio.playCalls[0].volume, 0.6);
    assert.equal(coordinator.getStatus().audio_state, 'idle');
  }

  {
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator(player, new ImmediateAudioGateway());
    await coordinator.playSegment(
      manifest.manifest_id,
      manifest.segments[1],
      manifest.playback.duck_factor,
      1,
      1,
    );
    assert.equal(player.pauseCalls, 1);
    assert.equal(player.playCalls, 1);
    assert.equal(player.context.state, 'playing');
  }

  {
    const player = new FakePlayer();
    const audio = new DeferredAudioGateway();
    const coordinator = new PlaybackCoordinator(player, audio);
    const playback = coordinator.playSegment(
      manifest.manifest_id,
      manifest.segments[0],
      manifest.playback.duck_factor,
      1,
      1,
    );
    await Promise.resolve();
    player.context.volume = 0.5;
    coordinator.handlePlayerContext(player.context, 'volumechange');
    assert.equal(player.volumeCalls.at(-1), 0.175);
    audio.resolveSuccess();
    await playback;
    assert.equal(player.volumeCalls.at(-1), 0.5);
  }

  {
    const player = new FakePlayer();
    const audio = new DeferredAudioGateway();
    const coordinator = new PlaybackCoordinator(player, audio);
    const playback = coordinator.playSegment(
      manifest.manifest_id,
      manifest.segments[1],
      manifest.playback.duck_factor,
      1,
      1,
    );
    await Promise.resolve();
    coordinator.handlePlayerContext(player.context, 'seeking');
    assert.equal(audio.stopCalls.length, 1);
    audio.resolveCancelled();
    await playback;
    assert.equal(player.playCalls, 0);
  }

  {
    const player = new FakePlayer();
    const audio = new DeferredAudioGateway();
    const coordinator = new PlaybackCoordinator(player, audio);
    const playback = coordinator.playSegment(
      manifest.manifest_id,
      manifest.segments[1],
      manifest.playback.duck_factor,
      1,
      1,
    );
    await Promise.resolve();
    coordinator.cancel('disabled', true);
    audio.resolveCancelled();
    await playback;
    assert.equal(player.playCalls, 1);
    assert.equal(player.context.state, 'playing');
  }

  {
    const player = new FakePlayer();
    const coordinator = new PlaybackCoordinator(player, new ImmediateAudioGateway(false));
    await coordinator.playSegment(
      manifest.manifest_id,
      manifest.segments[1],
      manifest.playback.duck_factor,
      1,
      1,
    );
    assert.equal(player.playCalls, 1);
    assert.equal(coordinator.getStatus().audio_state, 'error');
  }

  console.log('playback coordinator tests passed');
}
