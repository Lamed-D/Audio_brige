import assert from 'node:assert/strict';

import manifestFixture from '../../../fixtures/manifest-v1.1.valid.json';
import { parseManifestV1_1 } from '../../shared/contracts/manifest';
import type { PlayerContextReady } from '../../shared/contracts/messages';
import type { PlaybackCoordinator } from '../playback/playback-coordinator';
import { DemoSchedulerRuntime } from './demo-scheduler-runtime';

const videoId = 'A3WwuY_atyA';
const raw = structuredClone(manifestFixture);
raw.video.video_id = videoId;
raw.manifest_id = `youtube:${videoId}:r1`;
const manifest = parseManifestV1_1(raw);

const context: PlayerContextReady = {
  available: true,
  provider: 'youtube',
  video_id: videoId,
  video_key: `youtube:${videoId}`,
  title: '백엔드 manifest 테스트',
  duration_ms: manifest.video.duration_ms,
  current_time_ms: 0,
  playback_rate: 1,
  volume: 1,
  muted: false,
  state: 'paused',
};

const playback = {
  handlePlayerContext: () => undefined,
  cancel: () => undefined,
  cancelExtended: () => undefined,
  getStatus: () => ({
    audio_state: 'idle' as const,
    active_segment_id: null,
    active_segment_text: null,
    active_mode: null,
  }),
} as unknown as PlaybackCoordinator;

const runtime = new DemoSchedulerRuntime(() => context, playback);
assert.equal(runtime.hasManifest(context.video_key), false);
runtime.installManifest(manifest);
assert.equal(runtime.hasManifest(context.video_key), true);
const status = runtime.getStatus();
assert.equal(status.active, true);
if (status.active) {
  assert.equal(status.manifest_id, manifest.manifest_id);
  assert.equal(status.total_segments, manifest.segments.length);
}

console.log('backend manifest runtime tests passed');
