import assert from 'node:assert/strict';

import {
  isAudioEnginePlayRequest,
  isExtensionMessage,
  isManifestFetchResponse,
  isPlayerContext,
  isSchedulerStatus,
} from './messages';
import validManifest from '../../../fixtures/manifest-v1.1.valid.json';

const readyContext = {
  available: true,
  provider: 'youtube',
  video_id: 'dQw4w9WgXcQ',
  video_key: 'youtube:dQw4w9WgXcQ',
  title: '접근성 테스트 영상',
  duration_ms: 90000,
  current_time_ms: 12000,
  playback_rate: 1,
  volume: 0.8,
  muted: false,
  state: 'playing',
};

assert.equal(isPlayerContext(readyContext), true);
assert.equal(isPlayerContext({ ...readyContext, video_key: 'youtube:other' }), false);
assert.equal(isPlayerContext({ available: false, reason: 'unsupported_page' }), true);
assert.equal(isPlayerContext({ available: false, reason: 'unknown' }), false);
assert.equal(isExtensionMessage({ type: 'PLAYER_CONTEXT_GET' }), true);
assert.equal(isExtensionMessage({ type: 'SCHEDULER_STATUS_GET' }), true);
assert.equal(
  isExtensionMessage({
    type: 'ACCESSIBILITY_ANNOUNCE',
    text: '현재 2분 지났습니다.',
    urgency: 'polite',
    tone: 'action',
    speech_handled: true,
  }),
  true,
);
assert.equal(
  isExtensionMessage({
    type: 'MANIFEST_GET',
    provider: 'youtube',
    video_id: 'dQw4w9WgXcQ',
    duration_ms: 213061,
  }),
  true,
);
assert.equal(
  isExtensionMessage({
    type: 'MANIFEST_REFRESH',
    video_key: 'youtube:dQw4w9WgXcQ',
  }),
  true,
);
assert.equal(
  isManifestFetchResponse({
    status: 'ready',
    video_key: 'youtube:dQw4w9WgXcQ',
    manifest: validManifest,
  }),
  true,
);
assert.equal(
  isManifestFetchResponse({
    status: 'pending',
    video_key: 'youtube:dQw4w9WgXcQ',
    retry_after_ms: 1500,
  }),
  true,
);
assert.equal(
  isExtensionMessage({
    type: 'ACCESSIBILITY_ANNOUNCE',
    text: '',
    urgency: 'polite',
    tone: 'action',
    speech_handled: false,
  }),
  false,
);
assert.equal(
  isExtensionMessage({ type: 'PANEL_VISIBILITY_CHANGED', visible: true }),
  true,
);
assert.equal(
  isExtensionMessage({
    type: 'JOB_STATUS_GET',
    provider: 'youtube',
    video_id: 'dQw4w9WgXcQ',
    duration_ms: 90000,
  }),
  true,
);
assert.equal(
  isExtensionMessage({
    type: 'JOB_CREATE',
    provider: 'youtube',
    video_id: 'invalid',
    duration_ms: 90000,
  }),
  false,
);
assert.equal(isExtensionMessage({ type: 'PLAYER_CONTEXT_UPDATED', payload: readyContext }), false);

const schedulerStatus = {
  active: true,
  enabled: true,
  audio_state: 'idle',
  active_segment_id: null,
  active_segment_text: null,
  active_mode: null,
  settings: {
    enabled: true,
    description_volume: 1,
    duck_factor: 0.35,
    auto_pause_enabled: true,
  },
  manifest_id: 'youtube:dQw4w9WgXcQ:r1',
  revision: 1,
  total_segments: 2,
  handled_segments: 1,
  next_segment_id: 'seg-002',
  next_trigger_ms: 32800,
  last_event: {
    type: 'trigger',
    segment_id: 'seg-001',
    mode: 'overlay',
    at_ms: 12400,
  },
};

assert.equal(isSchedulerStatus(schedulerStatus), true);
assert.equal(
  isSchedulerStatus({
    active: false,
    enabled: true,
    audio_state: 'idle',
    active_segment_id: null,
    active_segment_text: null,
    active_mode: null,
    settings: schedulerStatus.settings,
    reason: 'no_manifest',
  }),
  true,
);
assert.equal(
  isSchedulerStatus({
    ...schedulerStatus,
    last_event: { ...schedulerStatus.last_event, type: 'skip' },
  }),
  false,
);

const audioPlayRequest = {
  type: 'AUDIO_ENGINE_PLAY',
  request_id: 'seg-001:1',
  manifest_id: 'youtube:dQw4w9WgXcQ:r1',
  segment_id: 'seg-001',
  audio_path:
    '/v1/audio/89cc07fa802c26cdb0c4b6911e2de88fc49cfc34df99ba22330d62af7eb1b476.wav',
  expected_duration_ms: 3300,
  playback_rate: 1,
  volume: 1,
};

assert.equal(isAudioEnginePlayRequest(audioPlayRequest), true);
assert.equal(isExtensionMessage(audioPlayRequest), true);
assert.equal(isAudioEnginePlayRequest({ ...audioPlayRequest, audio_path: 'https://evil.test/a' }), false);
assert.equal(isAudioEnginePlayRequest({ ...audioPlayRequest, playback_rate: 8 }), false);

console.log('extension message contract tests passed');
