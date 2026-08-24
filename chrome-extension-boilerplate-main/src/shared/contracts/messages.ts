import {
  parseManifestV1_1,
  SUPPORTED_SCHEMA_VERSION,
  type PlaybackMode,
  type VoiceBridgeManifestV1_1,
} from './manifest';
import { API_BASE_URL } from '../config/constants';
import { isPlaybackSettings, type PlaybackSettings } from '../settings/playback-settings';
import type { JobStatus } from './job-status';
import type { FeedbackTone } from '../accessibility/announcements';

const API_ORIGIN = new URL(API_BASE_URL).origin;

export type RuntimeStatusRequest = {
  type: 'RUNTIME_STATUS_GET';
};

export type AudioEnginePing = {
  type: 'AUDIO_ENGINE_PING';
};

export type AudioEnginePlayRequest = {
  type: 'AUDIO_ENGINE_PLAY';
  request_id: string;
  manifest_id: string;
  segment_id: string;
  audio_path: string;
  expected_duration_ms: number;
  playback_rate: number;
  volume: number;
};

export type AudioEngineStopRequest = {
  type: 'AUDIO_ENGINE_STOP';
  request_id?: string;
};

export type OffscreenAudioPlayCommand = Omit<
  AudioEnginePlayRequest,
  'type' | 'audio_path'
> & {
  type: 'OFFSCREEN_AUDIO_PLAY';
  audio_url: string;
};

export type OffscreenAudioStopCommand = {
  type: 'OFFSCREEN_AUDIO_STOP';
  request_id?: string;
};

export type AudioEngineResponse =
  | {
      ok: true;
      request_id: string;
      elapsed_ms: number;
    }
  | {
      ok: false;
      request_id: string;
      error: 'cancelled' | 'load_failed' | 'play_failed' | 'timeout' | 'invalid_request';
    };

export type PlayerContextGet = {
  type: 'PLAYER_CONTEXT_GET';
};

export type SchedulerStatusGet = {
  type: 'SCHEDULER_STATUS_GET';
};

export type DescriptionEnabledSet = {
  type: 'DESCRIPTION_ENABLED_SET';
  enabled: boolean;
};

export type PlaybackSettingsSet = {
  type: 'PLAYBACK_SETTINGS_SET';
  settings: PlaybackSettings;
};

export type AccessibilityAnnounce = {
  type: 'ACCESSIBILITY_ANNOUNCE';
  text: string;
  urgency: 'polite' | 'assertive';
  tone: FeedbackTone;
  speech_handled: boolean;
};

export type PanelVisibilityChanged = {
  type: 'PANEL_VISIBILITY_CHANGED';
  visible: boolean;
};

export type JobTarget = {
  provider: 'youtube';
  video_id: string;
  duration_ms: number | null;
};

export type JobStatusGet = JobTarget & {
  type: 'JOB_STATUS_GET';
};

export type JobCreate = JobTarget & {
  type: 'JOB_CREATE';
};

export type JobStatusResponse = JobStatus;

export type ManifestGet = JobTarget & {
  type: 'MANIFEST_GET';
};

export type ManifestRefresh = {
  type: 'MANIFEST_REFRESH';
  video_key: string;
};

export type ManifestFetchResponse =
  | {
      status: 'ready';
      video_key: string;
      manifest: VoiceBridgeManifestV1_1;
    }
  | {
      status: 'pending';
      video_key: string;
      retry_after_ms: number;
    }
  | {
      status: 'not_found';
      video_key: string;
    }
  | {
      status: 'unavailable';
      video_key: string;
      reason: 'network' | 'invalid_response';
    };

export type PlayerPlaybackState = 'playing' | 'paused' | 'ended';

export type PlayerContextReady = {
  available: true;
  provider: 'youtube';
  video_id: string;
  video_key: string;
  title: string;
  duration_ms: number | null;
  current_time_ms: number;
  playback_rate: number;
  volume: number;
  muted: boolean;
  state: PlayerPlaybackState;
};

export type PlayerContextUnavailable = {
  available: false;
  reason: 'unsupported_page' | 'video_not_found';
};

export type PlayerContext = PlayerContextReady | PlayerContextUnavailable;

export type SchedulerLastEvent = {
  type: 'trigger' | 'skip';
  segment_id: string;
  mode: PlaybackMode;
  at_ms: number;
  reason?: 'late' | 'seek' | 'auto_pause_disabled';
};

export type SchedulerStatusActive = {
  active: true;
  enabled: boolean;
  audio_state: 'idle' | 'playing' | 'error';
  active_segment_id: string | null;
  active_segment_text: string | null;
  active_mode: PlaybackMode | null;
  settings: PlaybackSettings;
  manifest_id: string;
  revision: number;
  total_segments: number;
  handled_segments: number;
  next_segment_id: string | null;
  next_trigger_ms: number | null;
  last_event: SchedulerLastEvent | null;
};

export type SchedulerStatusInactive = {
  active: false;
  enabled: boolean;
  audio_state: 'idle' | 'playing' | 'error';
  active_segment_id: string | null;
  active_segment_text: string | null;
  active_mode: PlaybackMode | null;
  settings: PlaybackSettings;
  reason: 'no_video' | 'no_manifest';
};

export type SchedulerStatus = SchedulerStatusActive | SchedulerStatusInactive;

export type ExtensionMessage =
  | RuntimeStatusRequest
  | AudioEnginePing
  | AudioEnginePlayRequest
  | AudioEngineStopRequest
  | OffscreenAudioPlayCommand
  | OffscreenAudioStopCommand
  | PlayerContextGet
  | SchedulerStatusGet
  | DescriptionEnabledSet
  | PlaybackSettingsSet
  | AccessibilityAnnounce
  | PanelVisibilityChanged
  | JobStatusGet
  | JobCreate
  | ManifestGet
  | ManifestRefresh;

export type RuntimeStatusResponse = {
  ok: true;
  schemaVersion: typeof SUPPORTED_SCHEMA_VERSION;
  extensionVersion: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlayerContext(value: unknown): value is PlayerContext {
  if (!isRecord(value) || typeof value.available !== 'boolean') {
    return false;
  }

  if (!value.available) {
    return value.reason === 'unsupported_page' || value.reason === 'video_not_found';
  }

  return (
    value.provider === 'youtube' &&
    typeof value.video_id === 'string' &&
    /^[A-Za-z0-9_-]{11}$/.test(value.video_id) &&
    value.video_key === `youtube:${value.video_id}` &&
    typeof value.title === 'string' &&
    value.title.trim().length > 0 &&
    (value.duration_ms === null ||
      (Number.isInteger(value.duration_ms) && (value.duration_ms as number) > 0)) &&
    Number.isInteger(value.current_time_ms) &&
    (value.current_time_ms as number) >= 0 &&
    typeof value.playback_rate === 'number' &&
    Number.isFinite(value.playback_rate) &&
    (value.playback_rate as number) > 0 &&
    typeof value.volume === 'number' &&
    (value.volume as number) >= 0 &&
    (value.volume as number) <= 1 &&
    typeof value.muted === 'boolean' &&
    (value.state === 'playing' || value.state === 'paused' || value.state === 'ended')
  );
}

function isVideoKey(value: unknown): value is string {
  return typeof value === 'string' && /^youtube:[A-Za-z0-9_-]{11}$/.test(value);
}

export function isManifestFetchResponse(value: unknown): value is ManifestFetchResponse {
  if (!isRecord(value) || !isVideoKey(value.video_key)) {
    return false;
  }
  if (value.status === 'not_found') {
    return true;
  }
  if (value.status === 'pending') {
    return (
      Number.isInteger(value.retry_after_ms) &&
      (value.retry_after_ms as number) >= 1000 &&
      (value.retry_after_ms as number) <= 30000
    );
  }
  if (value.status === 'unavailable') {
    return value.reason === 'network' || value.reason === 'invalid_response';
  }
  if (value.status !== 'ready') {
    return false;
  }
  try {
    const manifest = parseManifestV1_1(value.manifest);
    return `${manifest.video.provider}:${manifest.video.video_id}` === value.video_key;
  } catch {
    return false;
  }
}

export function isSchedulerStatus(value: unknown): value is SchedulerStatus {
  if (!isRecord(value) || typeof value.active !== 'boolean') {
    return false;
  }
  const playbackValid =
    typeof value.enabled === 'boolean' &&
    (value.audio_state === 'idle' ||
      value.audio_state === 'playing' ||
      value.audio_state === 'error') &&
    (value.active_segment_id === null || typeof value.active_segment_id === 'string');
  const activeDetailValid =
    (value.active_segment_text === null || typeof value.active_segment_text === 'string') &&
    (value.active_mode === null || value.active_mode === 'overlay' || value.active_mode === 'extended') &&
    isPlaybackSettings(value.settings);
  if (!playbackValid || !activeDetailValid) {
    return false;
  }
  if (!value.active) {
    return value.reason === 'no_video' || value.reason === 'no_manifest';
  }

  const nextSegmentValid =
    value.next_segment_id === null || typeof value.next_segment_id === 'string';
  const nextTriggerValid =
    value.next_trigger_ms === null ||
    (Number.isInteger(value.next_trigger_ms) && (value.next_trigger_ms as number) >= 0);
  const lastEventValid = value.last_event === null || isSchedulerLastEvent(value.last_event);

  return (
    typeof value.manifest_id === 'string' &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    Number.isInteger(value.total_segments) &&
    (value.total_segments as number) >= 0 &&
    Number.isInteger(value.handled_segments) &&
    (value.handled_segments as number) >= 0 &&
    (value.handled_segments as number) <= (value.total_segments as number) &&
    nextSegmentValid &&
    nextTriggerValid &&
    lastEventValid
  );
}

export function isAudioEnginePlayRequest(value: unknown): value is AudioEnginePlayRequest {
  if (!isRecord(value) || value.type !== 'AUDIO_ENGINE_PLAY') {
    return false;
  }
  return (
    typeof value.request_id === 'string' &&
    value.request_id.length > 0 &&
    typeof value.manifest_id === 'string' &&
    value.manifest_id.length > 0 &&
    typeof value.segment_id === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(value.segment_id) &&
    typeof value.audio_path === 'string' &&
    /^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(value.audio_path) &&
    Number.isInteger(value.expected_duration_ms) &&
    (value.expected_duration_ms as number) > 0 &&
    typeof value.playback_rate === 'number' &&
    Number.isFinite(value.playback_rate) &&
    (value.playback_rate as number) >= 0.25 &&
    (value.playback_rate as number) <= 4 &&
    typeof value.volume === 'number' &&
    Number.isFinite(value.volume) &&
    (value.volume as number) >= 0 &&
    (value.volume as number) <= 1
  );
}

export function isAudioEngineStopRequest(value: unknown): value is AudioEngineStopRequest {
  return (
    isRecord(value) &&
    value.type === 'AUDIO_ENGINE_STOP' &&
    (value.request_id === undefined ||
      (typeof value.request_id === 'string' && value.request_id.length > 0))
  );
}

export function isOffscreenAudioPlayCommand(
  value: unknown,
): value is OffscreenAudioPlayCommand {
  if (!isRecord(value) || value.type !== 'OFFSCREEN_AUDIO_PLAY') {
    return false;
  }
  return (
    typeof value.request_id === 'string' &&
    value.request_id.length > 0 &&
    typeof value.manifest_id === 'string' &&
    typeof value.segment_id === 'string' &&
    typeof value.audio_url === 'string' &&
    isAllowedAudioUrl(value.audio_url) &&
    Number.isInteger(value.expected_duration_ms) &&
    (value.expected_duration_ms as number) > 0 &&
    typeof value.playback_rate === 'number' &&
    Number.isFinite(value.playback_rate) &&
    (value.playback_rate as number) >= 0.25 &&
    (value.playback_rate as number) <= 4 &&
    typeof value.volume === 'number' &&
    Number.isFinite(value.volume) &&
    (value.volume as number) >= 0 &&
    (value.volume as number) <= 1
  );
}

function isAllowedAudioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === API_ORIGIN &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      /^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function isOffscreenAudioStopCommand(
  value: unknown,
): value is OffscreenAudioStopCommand {
  return (
    isRecord(value) &&
    value.type === 'OFFSCREEN_AUDIO_STOP' &&
    (value.request_id === undefined ||
      (typeof value.request_id === 'string' && value.request_id.length > 0))
  );
}

function isSchedulerLastEvent(value: unknown): value is SchedulerLastEvent {
  if (!isRecord(value)) {
    return false;
  }
  const reasonValid =
    value.type === 'skip'
      ? value.reason === 'late' ||
        value.reason === 'seek' ||
        value.reason === 'auto_pause_disabled'
      : value.type === 'trigger' && value.reason === undefined;
  return (
    (value.type === 'trigger' || value.type === 'skip') &&
    typeof value.segment_id === 'string' &&
    (value.mode === 'overlay' || value.mode === 'extended') &&
    Number.isInteger(value.at_ms) &&
    (value.at_ms as number) >= 0 &&
    reasonValid
  );
}

function isJobTarget(value: Record<string, unknown>): boolean {
  return (
    value.provider === 'youtube' &&
    typeof value.video_id === 'string' &&
    /^[A-Za-z0-9_-]{11}$/.test(value.video_id) &&
    (value.duration_ms === null ||
      (Number.isInteger(value.duration_ms) && (value.duration_ms as number) > 0))
  );
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'AUDIO_ENGINE_PLAY') {
    return isAudioEnginePlayRequest(value);
  }
  if (value.type === 'AUDIO_ENGINE_STOP') {
    return isAudioEngineStopRequest(value);
  }
  if (value.type === 'OFFSCREEN_AUDIO_PLAY') {
    return isOffscreenAudioPlayCommand(value);
  }
  if (value.type === 'OFFSCREEN_AUDIO_STOP') {
    return isOffscreenAudioStopCommand(value);
  }
  if (value.type === 'DESCRIPTION_ENABLED_SET') {
    return typeof value.enabled === 'boolean';
  }
  if (value.type === 'PLAYBACK_SETTINGS_SET') {
    return isPlaybackSettings(value.settings);
  }
  if (value.type === 'ACCESSIBILITY_ANNOUNCE') {
    return (
      typeof value.text === 'string' &&
      value.text.trim().length > 0 &&
      (value.urgency === 'polite' || value.urgency === 'assertive') &&
      (value.tone === 'action' ||
        value.tone === 'success' ||
        value.tone === 'error' ||
        value.tone === 'toggle-on' ||
        value.tone === 'toggle-off') &&
      typeof value.speech_handled === 'boolean'
    );
  }
  if (value.type === 'PANEL_VISIBILITY_CHANGED') {
    return typeof value.visible === 'boolean';
  }
  if (
    value.type === 'JOB_STATUS_GET' ||
    value.type === 'JOB_CREATE' ||
    value.type === 'MANIFEST_GET'
  ) {
    return isJobTarget(value);
  }
  if (value.type === 'MANIFEST_REFRESH') {
    return isVideoKey(value.video_key);
  }
  return (
    value.type === 'RUNTIME_STATUS_GET' ||
    value.type === 'AUDIO_ENGINE_PING' ||
    value.type === 'PLAYER_CONTEXT_GET' ||
    value.type === 'SCHEDULER_STATUS_GET'
  );
}
