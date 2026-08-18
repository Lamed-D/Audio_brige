/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/shared/accessibility/announcements.ts"
/*!***************************************************!*\
  !*** ./src/shared/accessibility/announcements.ts ***!
  \***************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY: () => (/* binding */ PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY),
/* harmony export */   isPendingAccessibilityAnnouncement: () => (/* binding */ isPendingAccessibilityAnnouncement),
/* harmony export */   playbackPositionAnnouncement: () => (/* binding */ playbackPositionAnnouncement)
/* harmony export */ });
const PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY = 'voiceBridgePendingAccessibilityAnnouncement';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPendingAccessibilityAnnouncement(value) {
    if (!isRecord(value)) {
        return false;
    }
    return (typeof value.id === 'string' &&
        value.id.length > 0 &&
        typeof value.text === 'string' &&
        value.text.trim().length > 0 &&
        Number.isInteger(value.requested_at) &&
        value.requested_at > 0 &&
        (value.urgency === 'polite' || value.urgency === 'assertive') &&
        (value.tone === 'action' ||
            value.tone === 'success' ||
            value.tone === 'error' ||
            value.tone === 'toggle-on' ||
            value.tone === 'toggle-off') &&
        typeof value.speech_handled === 'boolean');
}
function durationForSpeech(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0)
        parts.push(`${hours}시간`);
    if (minutes > 0)
        parts.push(`${minutes}분`);
    if (seconds > 0 || parts.length === 0)
        parts.push(`${seconds}초`);
    return parts.join(' ');
}
function playbackPositionAnnouncement(position) {
    const stateLabel = position.state === 'playing'
        ? '재생 중'
        : position.state === 'paused'
            ? '일시정지 상태'
            : '재생 완료';
    const elapsed = durationForSpeech(position.current_time_ms);
    if (position.duration_ms === null) {
        return `${stateLabel}. 현재 ${elapsed} 지났습니다.`;
    }
    const remaining = durationForSpeech(Math.max(0, position.duration_ms - position.current_time_ms));
    const total = durationForSpeech(position.duration_ms);
    return `${stateLabel}. 현재 ${elapsed}, 남은 시간 ${remaining}, 전체 ${total}입니다.`;
}


/***/ },

/***/ "./src/shared/accessibility/feedback-sound.ts"
/*!****************************************************!*\
  !*** ./src/shared/accessibility/feedback-sound.ts ***!
  \****************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   FeedbackSoundPlayer: () => (/* binding */ FeedbackSoundPlayer),
/* harmony export */   feedbackTonePattern: () => (/* binding */ feedbackTonePattern)
/* harmony export */ });
function feedbackTonePattern(sound, normalizedValue = 0.5) {
    const value = Math.min(1, Math.max(0, normalizedValue));
    switch (sound) {
        case 'focus':
            return [{ frequency: 720, duration_ms: 28, delay_ms: 0 }];
        case 'adjust':
            return [{ frequency: 360 + value * 720, duration_ms: 34, delay_ms: 0 }];
        case 'toggle-on':
            return [
                { frequency: 520, duration_ms: 42, delay_ms: 0 },
                { frequency: 780, duration_ms: 55, delay_ms: 48 },
            ];
        case 'toggle-off':
            return [
                { frequency: 700, duration_ms: 42, delay_ms: 0 },
                { frequency: 440, duration_ms: 55, delay_ms: 48 },
            ];
        case 'success':
            return [
                { frequency: 520, duration_ms: 55, delay_ms: 0 },
                { frequency: 660, duration_ms: 55, delay_ms: 60 },
                { frequency: 880, duration_ms: 75, delay_ms: 120 },
            ];
        case 'error':
            return [
                { frequency: 260, duration_ms: 85, delay_ms: 0 },
                { frequency: 210, duration_ms: 105, delay_ms: 95 },
            ];
        case 'action':
            return [{ frequency: 620, duration_ms: 48, delay_ms: 0 }];
    }
}
class FeedbackSoundPlayer {
    context = null;
    enabled = true;
    volume = 0.8;
    lastSoundAt = 0;
    setEnabled(enabled) {
        this.enabled = enabled;
    }
    setVolume(volume) {
        this.volume = Math.min(1, Math.max(0, volume));
    }
    async unlock() {
        if (!this.enabled || this.volume === 0)
            return;
        const context = this.getContext();
        if (context.state === 'suspended') {
            await context.resume();
        }
    }
    play(sound, normalizedValue = 0.5) {
        if (!this.enabled || this.volume === 0)
            return;
        const nowMilliseconds = performance.now();
        if ((sound === 'focus' || sound === 'adjust') && nowMilliseconds - this.lastSoundAt < 45) {
            return;
        }
        this.lastSoundAt = nowMilliseconds;
        const context = this.getContext();
        if (context.state !== 'running')
            return;
        const start = context.currentTime;
        for (const step of feedbackTonePattern(sound, normalizedValue)) {
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            const stepStart = start + step.delay_ms / 1000;
            const stepEnd = stepStart + step.duration_ms / 1000;
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(step.frequency, stepStart);
            gain.gain.setValueAtTime(0.0001, stepStart);
            gain.gain.exponentialRampToValueAtTime(0.18 * this.volume, stepStart + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, stepEnd);
            oscillator.connect(gain);
            gain.connect(context.destination);
            oscillator.start(stepStart);
            oscillator.stop(stepEnd + 0.01);
        }
    }
    getContext() {
        this.context ??= new AudioContext();
        return this.context;
    }
}


/***/ },

/***/ "./src/shared/config/constants.ts"
/*!****************************************!*\
  !*** ./src/shared/config/constants.ts ***!
  \****************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   API_BASE_URL: () => (/* binding */ API_BASE_URL),
/* harmony export */   CONTRACT_VERSION: () => (/* binding */ CONTRACT_VERSION)
/* harmony export */ });
/* harmony import */ var _contracts_manifest__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../contracts/manifest */ "./src/shared/contracts/manifest.ts");

const API_BASE_URL = 'http://127.0.0.1:5000';
const CONTRACT_VERSION = _contracts_manifest__WEBPACK_IMPORTED_MODULE_0__.SUPPORTED_SCHEMA_VERSION;


/***/ },

/***/ "./src/shared/contracts/job-status.ts"
/*!********************************************!*\
  !*** ./src/shared/contracts/job-status.ts ***!
  \********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   JOB_PROCESSING_STAGES: () => (/* binding */ JOB_PROCESSING_STAGES),
/* harmony export */   JOB_TRACKING_STORAGE_KEY: () => (/* binding */ JOB_TRACKING_STORAGE_KEY),
/* harmony export */   PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY: () => (/* binding */ PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY),
/* harmony export */   ensureMonotonicProgress: () => (/* binding */ ensureMonotonicProgress),
/* harmony export */   isBackendJobStatus: () => (/* binding */ isBackendJobStatus),
/* harmony export */   isJobStatus: () => (/* binding */ isJobStatus),
/* harmony export */   isPendingProgressAnnouncement: () => (/* binding */ isPendingProgressAnnouncement),
/* harmony export */   shouldPollJob: () => (/* binding */ shouldPollJob)
/* harmony export */ });
const JOB_PROCESSING_STAGES = [
    'media_preparation',
    'audio_analysis',
    'visual_analysis',
    'description_generation',
    'speech_synthesis',
    'validation',
];
const JOB_TRACKING_STORAGE_KEY = 'voice_bridge_job_tracking_v1';
const PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY = 'voice_bridge_pending_progress_announcement_v1';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isIntegerInRange(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
}
function isTimestamp(value) {
    return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}
function isJobId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value);
}
function isVideoKey(value) {
    return typeof value === 'string' && /^youtube:[A-Za-z0-9_-]{11}$/.test(value);
}
function isEta(value) {
    const secondsValid = value.eta_seconds === null || isIntegerInRange(value.eta_seconds, 0, 86400);
    const confidenceValid = value.eta_confidence === null ||
        value.eta_confidence === 'low' ||
        value.eta_confidence === 'medium' ||
        value.eta_confidence === 'high';
    return secondsValid && confidenceValid;
}
function isBackendJobStatus(value) {
    if (!isRecord(value) ||
        !isVideoKey(value.video_key) ||
        !isTimestamp(value.updated_at) ||
        !isIntegerInRange(value.progress_percent, 0, 100)) {
        return false;
    }
    if (value.status === 'ready') {
        return ((value.job_id === null || isJobId(value.job_id)) &&
            value.progress_percent === 100 &&
            typeof value.manifest_id === 'string' &&
            value.manifest_id.length > 0 &&
            Number.isInteger(value.revision) &&
            value.revision >= 0);
    }
    if (value.status === 'failed') {
        return (isJobId(value.job_id) &&
            isRecord(value.error) &&
            typeof value.error.code === 'string' &&
            /^[A-Z0-9_]+$/.test(value.error.code) &&
            typeof value.error.retryable === 'boolean');
    }
    if (!isJobId(value.job_id) ||
        !isEta(value) ||
        !isIntegerInRange(value.retry_after_ms, 1000, 30000) ||
        value.progress_percent >= 100) {
        return false;
    }
    if (value.status === 'queued') {
        return value.stage === 'queued';
    }
    return (value.status === 'processing' &&
        typeof value.stage === 'string' &&
        JOB_PROCESSING_STAGES.includes(value.stage));
}
function isJobStatus(value) {
    if (isBackendJobStatus(value)) {
        return true;
    }
    if (!isRecord(value)) {
        return false;
    }
    if (value.status === 'not_started') {
        return isVideoKey(value.video_key);
    }
    return (value.status === 'unavailable' &&
        (value.video_key === null || isVideoKey(value.video_key)) &&
        (value.reason === 'unsupported_page' ||
            value.reason === 'network' ||
            value.reason === 'invalid_response'));
}
function isPendingProgressAnnouncement(value) {
    return (isRecord(value) &&
        (value.video_key === null || isVideoKey(value.video_key)) &&
        Number.isInteger(value.requested_at) &&
        value.requested_at > 0 &&
        (value.speech_handled === undefined || typeof value.speech_handled === 'boolean') &&
        isJobStatus(value.job));
}
function ensureMonotonicProgress(previousPercent, status) {
    if (previousPercent === null ||
        status.status === 'ready' ||
        status.progress_percent >= previousPercent) {
        return status;
    }
    return { ...status, progress_percent: previousPercent };
}
function shouldPollJob(status) {
    return status.status === 'queued' || status.status === 'processing';
}


/***/ },

/***/ "./src/shared/contracts/manifest.ts"
/*!******************************************!*\
  !*** ./src/shared/contracts/manifest.ts ***!
  \******************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ManifestValidationError: () => (/* binding */ ManifestValidationError),
/* harmony export */   SUPPORTED_SCHEMA_VERSION: () => (/* binding */ SUPPORTED_SCHEMA_VERSION),
/* harmony export */   parseManifestV1_1: () => (/* binding */ parseManifestV1_1)
/* harmony export */ });
const SUPPORTED_SCHEMA_VERSION = '1.1';
class ManifestValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ManifestValidationError';
    }
}
function fail(path, message) {
    throw new ManifestValidationError(`${path}: ${message}`);
}
function record(value, path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return fail(path, 'object expected');
    }
    return value;
}
function string(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
        return fail(path, 'non-empty string expected');
    }
    return value;
}
function integer(value, path, min = 0) {
    if (!Number.isInteger(value) || value < min) {
        return fail(path, `integer greater than or equal to ${min} expected`);
    }
    return value;
}
function numberInRange(value, path, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        return fail(path, `number between ${min} and ${max} expected`);
    }
    return value;
}
function boolean(value, path) {
    if (typeof value !== 'boolean') {
        return fail(path, 'boolean expected');
    }
    return value;
}
function enumValue(value, values, path) {
    if (typeof value !== 'string' || !values.includes(value)) {
        return fail(path, `one of ${values.join(', ')} expected`);
    }
    return value;
}
function parseAudio(value, path) {
    const input = record(value, path);
    const audioPath = string(input.path, `${path}.path`);
    const sha256 = string(input.sha256, `${path}.sha256`);
    if (!audioPath.startsWith('/v1/audio/') || audioPath.includes('://')) {
        fail(`${path}.path`, 'backend-relative /v1/audio/ path expected');
    }
    if (!/^[a-f0-9]{64}$/i.test(sha256)) {
        fail(`${path}.sha256`, '64-character hexadecimal digest expected');
    }
    return {
        path: audioPath,
        duration_ms: integer(input.duration_ms, `${path}.duration_ms`, 1),
        sha256,
    };
}
function parseSegment(value, index) {
    const path = `segments[${index}]`;
    const input = record(value, path);
    const mode = enumValue(input.mode, ['overlay', 'extended'], `${path}.mode`);
    const importance = enumValue(input.importance, ['normal', 'high'], `${path}.importance`);
    const base = {
        id: string(input.id, `${path}.id`),
        trigger_ms: integer(input.trigger_ms, `${path}.trigger_ms`),
        text: string(input.text, `${path}.text`),
        importance,
        source: enumValue(input.source, ['ocr', 'vlm'], `${path}.source`),
        confidence: enumValue(input.confidence, ['low', 'medium', 'high'], `${path}.confidence`),
        audio: parseAudio(input.audio, `${path}.audio`),
    };
    if (mode === 'overlay') {
        const deadlineMs = integer(input.deadline_ms, `${path}.deadline_ms`, 1);
        if (deadlineMs <= base.trigger_ms) {
            fail(`${path}.deadline_ms`, 'must be greater than trigger_ms');
        }
        if (base.audio.duration_ms > deadlineMs - base.trigger_ms) {
            fail(`${path}.audio.duration_ms`, 'audio exceeds the overlay window');
        }
        return { ...base, mode, deadline_ms: deadlineMs };
    }
    if ('deadline_ms' in input) {
        fail(`${path}.deadline_ms`, 'must be omitted for extended mode');
    }
    if (importance !== 'high') {
        fail(`${path}.importance`, 'extended mode requires high importance');
    }
    return { ...base, mode };
}
function parseManifestV1_1(value) {
    const input = record(value, 'manifest');
    const schemaVersion = string(input.schema_version, 'schema_version');
    if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        fail('schema_version', `unsupported version ${schemaVersion}`);
    }
    const videoInput = record(input.video, 'video');
    const provider = string(videoInput.provider, 'video.provider');
    if (!/^[a-z0-9_-]+$/.test(provider)) {
        fail('video.provider', 'lowercase provider enum expected');
    }
    const videoId = string(videoInput.video_id, 'video.video_id');
    const videoDurationMs = integer(videoInput.duration_ms, 'video.duration_ms', 1);
    const revision = integer(input.revision, 'revision');
    const manifestId = string(input.manifest_id, 'manifest_id');
    if (manifestId !== `${provider}:${videoId}:r${revision}`) {
        fail('manifest_id', 'must match provider:video_id:revision');
    }
    const voiceInput = record(input.voice, 'voice');
    const playbackInput = record(input.playback, 'playback');
    const playback = {
        duck_factor: numberInRange(playbackInput.duck_factor, 'playback.duck_factor', 0, 1),
        preload_count: integer(playbackInput.preload_count, 'playback.preload_count'),
        lookahead_ms: integer(playbackInput.lookahead_ms, 'playback.lookahead_ms'),
        late_tolerance_ms: integer(playbackInput.late_tolerance_ms, 'playback.late_tolerance_ms'),
        auto_pause_default: boolean(playbackInput.auto_pause_default, 'playback.auto_pause_default'),
        max_extended_duration_ms: integer(playbackInput.max_extended_duration_ms, 'playback.max_extended_duration_ms', 1),
        min_extended_interval_ms: integer(playbackInput.min_extended_interval_ms, 'playback.min_extended_interval_ms'),
    };
    if (!Array.isArray(input.segments)) {
        fail('segments', 'array expected');
    }
    const segments = input.segments.map(parseSegment);
    const ids = new Set();
    let previousTrigger = -1;
    let previousOverlayDeadline = -1;
    let previousExtendedTrigger = Number.NEGATIVE_INFINITY;
    for (const [index, segment] of segments.entries()) {
        if (ids.has(segment.id)) {
            fail(`segments[${index}].id`, 'duplicate segment id');
        }
        ids.add(segment.id);
        if (segment.trigger_ms < previousTrigger) {
            fail(`segments[${index}].trigger_ms`, 'segments must be sorted');
        }
        if (segment.trigger_ms >= videoDurationMs) {
            fail(`segments[${index}].trigger_ms`, 'must be inside video duration');
        }
        previousTrigger = segment.trigger_ms;
        if (segment.mode === 'overlay') {
            if (segment.deadline_ms > videoDurationMs) {
                fail(`segments[${index}].deadline_ms`, 'must be inside video duration');
            }
            if (segment.trigger_ms < previousOverlayDeadline) {
                fail(`segments[${index}]`, 'overlay windows must not overlap');
            }
            previousOverlayDeadline = segment.deadline_ms;
            continue;
        }
        if (segment.audio.duration_ms > playback.max_extended_duration_ms) {
            fail(`segments[${index}].audio.duration_ms`, 'extended duration exceeds playback limit');
        }
        if (segment.trigger_ms - previousExtendedTrigger <
            playback.min_extended_interval_ms) {
            fail(`segments[${index}].trigger_ms`, 'extended segments are too close together');
        }
        previousExtendedTrigger = segment.trigger_ms;
    }
    return {
        schema_version: SUPPORTED_SCHEMA_VERSION,
        manifest_id: manifestId,
        revision,
        video: {
            provider,
            video_id: videoId,
            duration_ms: videoDurationMs,
        },
        voice: {
            voice_id: string(voiceInput.voice_id, 'voice.voice_id'),
            format: string(voiceInput.format, 'voice.format'),
            sample_rate_hz: integer(voiceInput.sample_rate_hz, 'voice.sample_rate_hz', 1),
        },
        playback,
        segments,
    };
}


/***/ },

/***/ "./src/shared/contracts/messages.ts"
/*!******************************************!*\
  !*** ./src/shared/contracts/messages.ts ***!
  \******************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   isAudioEnginePlayRequest: () => (/* binding */ isAudioEnginePlayRequest),
/* harmony export */   isAudioEngineStopRequest: () => (/* binding */ isAudioEngineStopRequest),
/* harmony export */   isExtensionMessage: () => (/* binding */ isExtensionMessage),
/* harmony export */   isOffscreenAudioPlayCommand: () => (/* binding */ isOffscreenAudioPlayCommand),
/* harmony export */   isOffscreenAudioStopCommand: () => (/* binding */ isOffscreenAudioStopCommand),
/* harmony export */   isPlayerContext: () => (/* binding */ isPlayerContext),
/* harmony export */   isSchedulerStatus: () => (/* binding */ isSchedulerStatus)
/* harmony export */ });
/* harmony import */ var _config_constants__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../config/constants */ "./src/shared/config/constants.ts");
/* harmony import */ var _settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../settings/playback-settings */ "./src/shared/settings/playback-settings.ts");


const API_ORIGIN = new URL(_config_constants__WEBPACK_IMPORTED_MODULE_0__.API_BASE_URL).origin;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPlayerContext(value) {
    if (!isRecord(value) || typeof value.available !== 'boolean') {
        return false;
    }
    if (!value.available) {
        return value.reason === 'unsupported_page' || value.reason === 'video_not_found';
    }
    return (value.provider === 'youtube' &&
        typeof value.video_id === 'string' &&
        /^[A-Za-z0-9_-]{11}$/.test(value.video_id) &&
        value.video_key === `youtube:${value.video_id}` &&
        typeof value.title === 'string' &&
        value.title.trim().length > 0 &&
        (value.duration_ms === null ||
            (Number.isInteger(value.duration_ms) && value.duration_ms > 0)) &&
        Number.isInteger(value.current_time_ms) &&
        value.current_time_ms >= 0 &&
        typeof value.playback_rate === 'number' &&
        Number.isFinite(value.playback_rate) &&
        value.playback_rate > 0 &&
        typeof value.volume === 'number' &&
        value.volume >= 0 &&
        value.volume <= 1 &&
        typeof value.muted === 'boolean' &&
        (value.state === 'playing' || value.state === 'paused' || value.state === 'ended'));
}
function isSchedulerStatus(value) {
    if (!isRecord(value) || typeof value.active !== 'boolean') {
        return false;
    }
    const playbackValid = typeof value.enabled === 'boolean' &&
        (value.audio_state === 'idle' ||
            value.audio_state === 'playing' ||
            value.audio_state === 'error') &&
        (value.active_segment_id === null || typeof value.active_segment_id === 'string');
    const activeDetailValid = (value.active_segment_text === null || typeof value.active_segment_text === 'string') &&
        (value.active_mode === null || value.active_mode === 'overlay' || value.active_mode === 'extended') &&
        (0,_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.isPlaybackSettings)(value.settings);
    if (!playbackValid || !activeDetailValid) {
        return false;
    }
    if (!value.active) {
        return value.reason === 'no_video' || value.reason === 'no_manifest';
    }
    const nextSegmentValid = value.next_segment_id === null || typeof value.next_segment_id === 'string';
    const nextTriggerValid = value.next_trigger_ms === null ||
        (Number.isInteger(value.next_trigger_ms) && value.next_trigger_ms >= 0);
    const lastEventValid = value.last_event === null || isSchedulerLastEvent(value.last_event);
    return (typeof value.manifest_id === 'string' &&
        Number.isInteger(value.revision) &&
        value.revision >= 0 &&
        Number.isInteger(value.total_segments) &&
        value.total_segments >= 0 &&
        Number.isInteger(value.handled_segments) &&
        value.handled_segments >= 0 &&
        value.handled_segments <= value.total_segments &&
        nextSegmentValid &&
        nextTriggerValid &&
        lastEventValid);
}
function isAudioEnginePlayRequest(value) {
    if (!isRecord(value) || value.type !== 'AUDIO_ENGINE_PLAY') {
        return false;
    }
    return (typeof value.request_id === 'string' &&
        value.request_id.length > 0 &&
        typeof value.manifest_id === 'string' &&
        value.manifest_id.length > 0 &&
        typeof value.segment_id === 'string' &&
        /^[A-Za-z0-9._-]+$/.test(value.segment_id) &&
        typeof value.audio_path === 'string' &&
        /^\/v1\/audio\/[A-Za-z0-9._-]+$/.test(value.audio_path) &&
        Number.isInteger(value.expected_duration_ms) &&
        value.expected_duration_ms > 0 &&
        typeof value.playback_rate === 'number' &&
        Number.isFinite(value.playback_rate) &&
        value.playback_rate >= 0.25 &&
        value.playback_rate <= 4 &&
        typeof value.volume === 'number' &&
        Number.isFinite(value.volume) &&
        value.volume >= 0 &&
        value.volume <= 1);
}
function isAudioEngineStopRequest(value) {
    return (isRecord(value) &&
        value.type === 'AUDIO_ENGINE_STOP' &&
        (value.request_id === undefined ||
            (typeof value.request_id === 'string' && value.request_id.length > 0)));
}
function isOffscreenAudioPlayCommand(value) {
    if (!isRecord(value) || value.type !== 'OFFSCREEN_AUDIO_PLAY') {
        return false;
    }
    return (typeof value.request_id === 'string' &&
        value.request_id.length > 0 &&
        typeof value.manifest_id === 'string' &&
        typeof value.segment_id === 'string' &&
        typeof value.audio_url === 'string' &&
        isAllowedAudioUrl(value.audio_url) &&
        Number.isInteger(value.expected_duration_ms) &&
        value.expected_duration_ms > 0 &&
        typeof value.playback_rate === 'number' &&
        Number.isFinite(value.playback_rate) &&
        value.playback_rate >= 0.25 &&
        value.playback_rate <= 4 &&
        typeof value.volume === 'number' &&
        Number.isFinite(value.volume) &&
        value.volume >= 0 &&
        value.volume <= 1);
}
function isAllowedAudioUrl(value) {
    if (value.startsWith('chrome-extension://')) {
        return true;
    }
    try {
        const url = new URL(value);
        return url.origin === API_ORIGIN && url.pathname.startsWith('/v1/audio/');
    }
    catch {
        return false;
    }
}
function isOffscreenAudioStopCommand(value) {
    return (isRecord(value) &&
        value.type === 'OFFSCREEN_AUDIO_STOP' &&
        (value.request_id === undefined ||
            (typeof value.request_id === 'string' && value.request_id.length > 0)));
}
function isSchedulerLastEvent(value) {
    if (!isRecord(value)) {
        return false;
    }
    const reasonValid = value.type === 'skip'
        ? value.reason === 'late' ||
            value.reason === 'seek' ||
            value.reason === 'auto_pause_disabled'
        : value.type === 'trigger' && value.reason === undefined;
    return ((value.type === 'trigger' || value.type === 'skip') &&
        typeof value.segment_id === 'string' &&
        (value.mode === 'overlay' || value.mode === 'extended') &&
        Number.isInteger(value.at_ms) &&
        value.at_ms >= 0 &&
        reasonValid);
}
function isJobTarget(value) {
    return (value.provider === 'youtube' &&
        typeof value.video_id === 'string' &&
        /^[A-Za-z0-9_-]{11}$/.test(value.video_id) &&
        (value.duration_ms === null ||
            (Number.isInteger(value.duration_ms) && value.duration_ms > 0)));
}
function isExtensionMessage(value) {
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
        return (0,_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.isPlaybackSettings)(value.settings);
    }
    if (value.type === 'ACCESSIBILITY_ANNOUNCE') {
        return (typeof value.text === 'string' &&
            value.text.trim().length > 0 &&
            (value.urgency === 'polite' || value.urgency === 'assertive') &&
            (value.tone === 'action' ||
                value.tone === 'success' ||
                value.tone === 'error' ||
                value.tone === 'toggle-on' ||
                value.tone === 'toggle-off') &&
            typeof value.speech_handled === 'boolean');
    }
    if (value.type === 'PANEL_VISIBILITY_CHANGED') {
        return typeof value.visible === 'boolean';
    }
    if (value.type === 'JOB_CREATE') {
        return (isJobTarget(value) &&
            (value.force === undefined || typeof value.force === 'boolean'));
    }
    if (value.type === 'JOB_STATUS_GET' || value.type === 'MANIFEST_GET') {
        return isJobTarget(value);
    }
    return (value.type === 'RUNTIME_STATUS_GET' ||
        value.type === 'BACKEND_HEALTH_GET' ||
        value.type === 'AUDIO_ENGINE_PING' ||
        value.type === 'PLAYER_CONTEXT_GET' ||
        value.type === 'SCHEDULER_STATUS_GET');
}


/***/ },

/***/ "./src/shared/settings/accessibility-settings.ts"
/*!*******************************************************!*\
  !*** ./src/shared/settings/accessibility-settings.ts ***!
  \*******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ACCESSIBILITY_SETTINGS_STORAGE_KEY: () => (/* binding */ ACCESSIBILITY_SETTINGS_STORAGE_KEY),
/* harmony export */   DEFAULT_ACCESSIBILITY_SETTINGS: () => (/* binding */ DEFAULT_ACCESSIBILITY_SETTINGS),
/* harmony export */   parseStoredAccessibilitySettings: () => (/* binding */ parseStoredAccessibilitySettings)
/* harmony export */ });
const ACCESSIBILITY_SETTINGS_STORAGE_KEY = 'voiceBridgeAccessibilitySettings';
const DEFAULT_ACCESSIBILITY_SETTINGS = {
    interaction_sounds_enabled: true,
    interaction_sound_volume: 0.8,
    shortcut_speech_enabled: true,
};
function isUnitInterval(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function parseStoredAccessibilitySettings(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ...DEFAULT_ACCESSIBILITY_SETTINGS };
    }
    const settings = value;
    return {
        interaction_sounds_enabled: typeof settings.interaction_sounds_enabled === 'boolean'
            ? settings.interaction_sounds_enabled
            : DEFAULT_ACCESSIBILITY_SETTINGS.interaction_sounds_enabled,
        interaction_sound_volume: isUnitInterval(settings.interaction_sound_volume)
            ? settings.interaction_sound_volume
            : DEFAULT_ACCESSIBILITY_SETTINGS.interaction_sound_volume,
        shortcut_speech_enabled: typeof settings.shortcut_speech_enabled === 'boolean'
            ? settings.shortcut_speech_enabled
            : DEFAULT_ACCESSIBILITY_SETTINGS.shortcut_speech_enabled,
    };
}


/***/ },

/***/ "./src/shared/settings/playback-settings.ts"
/*!**************************************************!*\
  !*** ./src/shared/settings/playback-settings.ts ***!
  \**************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DEFAULT_PLAYBACK_SETTINGS: () => (/* binding */ DEFAULT_PLAYBACK_SETTINGS),
/* harmony export */   PLAYBACK_SETTINGS_STORAGE_KEY: () => (/* binding */ PLAYBACK_SETTINGS_STORAGE_KEY),
/* harmony export */   isPlaybackSettings: () => (/* binding */ isPlaybackSettings),
/* harmony export */   parseStoredPlaybackSettings: () => (/* binding */ parseStoredPlaybackSettings)
/* harmony export */ });
const PLAYBACK_SETTINGS_STORAGE_KEY = 'voiceBridgePlaybackSettings';
const DEFAULT_PLAYBACK_SETTINGS = {
    enabled: false,
    description_volume: 1,
    duck_factor: 0.35,
    auto_pause_enabled: true,
};
function isUnitInterval(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
function isPlaybackSettings(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const settings = value;
    return (typeof settings.enabled === 'boolean' &&
        isUnitInterval(settings.description_volume) &&
        isUnitInterval(settings.duck_factor) &&
        typeof settings.auto_pause_enabled === 'boolean');
}
function parseStoredPlaybackSettings(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { ...DEFAULT_PLAYBACK_SETTINGS };
    }
    const settings = value;
    return {
        enabled: typeof settings.enabled === 'boolean'
            ? settings.enabled
            : DEFAULT_PLAYBACK_SETTINGS.enabled,
        description_volume: isUnitInterval(settings.description_volume)
            ? settings.description_volume
            : DEFAULT_PLAYBACK_SETTINGS.description_volume,
        duck_factor: isUnitInterval(settings.duck_factor)
            ? settings.duck_factor
            : DEFAULT_PLAYBACK_SETTINGS.duck_factor,
        auto_pause_enabled: typeof settings.auto_pause_enabled === 'boolean'
            ? settings.auto_pause_enabled
            : DEFAULT_PLAYBACK_SETTINGS.auto_pause_enabled,
    };
}


/***/ },

/***/ "./src/sidepanel/job-progress.ts"
/*!***************************************!*\
  !*** ./src/sidepanel/job-progress.ts ***!
  \***************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   JobAnnouncementTracker: () => (/* binding */ JobAnnouncementTracker),
/* harmony export */   formatEta: () => (/* binding */ formatEta),
/* harmony export */   formatJobAnnouncement: () => (/* binding */ formatJobAnnouncement),
/* harmony export */   jobProgressView: () => (/* binding */ jobProgressView)
/* harmony export */ });
const STAGE_LABELS = {
    queued: '분석 대기 중',
    media_preparation: '영상 준비 중',
    audio_analysis: '음성과 대사 분석 중',
    visual_analysis: '화면 글자와 장면 분석 중',
    description_generation: '화면해설 문장 생성 중',
    speech_synthesis: '화면해설 음성 생성 중',
    validation: '음성 길이와 재생 시점 확인 중',
};
function formatEta(seconds) {
    if (seconds === null) {
        return '예상 시간 계산 중';
    }
    if (seconds < 60) {
        return '약 1분 이내 남음';
    }
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `약 ${minutes}분 남음`;
}
function jobProgressView(status) {
    if (status.status === 'not_started') {
        return {
            summary: '이 영상은 아직 화면해설이 없습니다.',
            stage: null,
            percent: null,
            eta: null,
            progressValueText: null,
        };
    }
    if (status.status === 'unavailable') {
        return {
            summary: status.reason === 'unsupported_page'
                ? '지원되는 영상에서 현재 상태를 확인할 수 있습니다.'
                : '화면해설 생성 상태를 확인하지 못했습니다.',
            stage: null,
            percent: null,
            eta: null,
            progressValueText: null,
        };
    }
    if (status.status === 'ready') {
        return {
            summary: '화면해설 준비 완료',
            stage: '바로 재생할 수 있습니다.',
            percent: 100,
            eta: null,
            progressValueText: '화면해설 생성 100% 완료',
        };
    }
    if (status.status === 'failed') {
        return {
            summary: '화면해설 생성 실패',
            stage: status.error.retryable
                ? '잠시 후 다시 시도할 수 있습니다.'
                : '이 영상은 현재 처리할 수 없습니다.',
            percent: status.progress_percent,
            eta: null,
            progressValueText: `화면해설 생성 ${status.progress_percent}%에서 중단됨`,
        };
    }
    const stage = STAGE_LABELS[status.stage];
    const eta = formatEta(status.eta_seconds);
    return {
        summary: status.status === 'queued' ? '화면해설 생성 대기 중' : '화면해설 생성 중',
        stage,
        percent: status.progress_percent,
        eta,
        progressValueText: `화면해설 생성 ${status.progress_percent}% 완료, ${stage}, ${eta}`,
    };
}
function formatJobAnnouncement(status) {
    const view = jobProgressView(status);
    if (status.status === 'queued' || status.status === 'processing') {
        return `화면해설 생성 ${status.progress_percent}% 완료. ${view.stage}. ${view.eta}.`;
    }
    if (status.status === 'ready') {
        return '화면해설 생성이 완료되었습니다. 바로 재생할 수 있습니다.';
    }
    if (status.status === 'failed') {
        return status.error.retryable
            ? '화면해설을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.'
            : '이 영상의 화면해설을 현재 만들 수 없습니다.';
    }
    return view.summary;
}
function milestone(percent) {
    if (percent >= 75)
        return 75;
    if (percent >= 50)
        return 50;
    if (percent >= 25)
        return 25;
    return 0;
}
function materialEtaChange(previous, current) {
    if (previous === null || current === null) {
        return previous !== current;
    }
    const difference = Math.abs(previous - current);
    return difference >= 60 || difference / Math.max(previous, 1) >= 0.3;
}
class JobAnnouncementTracker {
    videoKey = null;
    status = null;
    stage = null;
    milestone = 0;
    etaSeconds = null;
    next(value, manual = false) {
        if (manual) {
            this.capture(value);
            return formatJobAnnouncement(value);
        }
        const videoChanged = value.video_key !== this.videoKey;
        const statusChanged = value.status !== this.status;
        const nextStage = value.status === 'queued' || value.status === 'processing' ? value.stage : null;
        const stageChanged = nextStage !== this.stage;
        const nextMilestone = value.status === 'queued' || value.status === 'processing'
            ? milestone(value.progress_percent)
            : 0;
        const milestoneChanged = nextMilestone > this.milestone;
        const nextEta = value.status === 'queued' || value.status === 'processing' ? value.eta_seconds : null;
        const etaChanged = materialEtaChange(this.etaSeconds, nextEta);
        this.capture(value);
        if (videoChanged ||
            statusChanged ||
            stageChanged ||
            milestoneChanged ||
            (etaChanged && nextEta !== null)) {
            return formatJobAnnouncement(value);
        }
        return null;
    }
    capture(value) {
        this.videoKey = value.video_key;
        this.status = value.status;
        if (value.status === 'queued' || value.status === 'processing') {
            this.stage = value.stage;
            this.milestone = milestone(value.progress_percent);
            this.etaSeconds = value.eta_seconds;
            return;
        }
        this.stage = null;
        this.milestone = 0;
        this.etaSeconds = null;
    }
}


/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	const __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		const cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		const module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		if (!(moduleId in __webpack_modules__)) {
/******/ 			delete __webpack_module_cache__[moduleId];
/******/ 			const e = new Error("Cannot find module '" + moduleId + "'");
/******/ 			e.code = 'MODULE_NOT_FOUND';
/******/ 			throw e;
/******/ 		}
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter/value functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			if(Array.isArray(definition)) {
/******/ 				var i = 0;
/******/ 				while(i < definition.length) {
/******/ 					var key = definition[i++];
/******/ 					var binding = definition[i++];
/******/ 					if(!__webpack_require__.o(exports, key)) {
/******/ 						if(binding === 0) {
/******/ 							Object.defineProperty(exports, key, { enumerable: true, value: definition[i++] });
/******/ 						} else {
/******/ 							Object.defineProperty(exports, key, { enumerable: true, get: binding });
/******/ 						}
/******/ 					} else if(binding === 0) { i++; }
/******/ 				}
/******/ 			} else {
/******/ 				for(var key in definition) {
/******/ 					if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 						Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 					}
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
let __webpack_exports__ = {};
// This entry needs to be wrapped in an IIFE because it needs to be isolated against other modules in the chunk.
(() => {
/*!********************************!*\
  !*** ./src/sidepanel/index.ts ***!
  \********************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/contracts/messages */ "./src/shared/contracts/messages.ts");
/* harmony import */ var _shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/contracts/job-status */ "./src/shared/contracts/job-status.ts");
/* harmony import */ var _shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../shared/settings/playback-settings */ "./src/shared/settings/playback-settings.ts");
/* harmony import */ var _shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../shared/settings/accessibility-settings */ "./src/shared/settings/accessibility-settings.ts");
/* harmony import */ var _shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ../shared/accessibility/announcements */ "./src/shared/accessibility/announcements.ts");
/* harmony import */ var _job_progress__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./job-progress */ "./src/sidepanel/job-progress.ts");
/* harmony import */ var _shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(/*! ../shared/accessibility/feedback-sound */ "./src/shared/accessibility/feedback-sound.ts");







const statusElement = document.querySelector('#runtime-status');
const versionElement = document.querySelector('#extension-version');
const schemaElement = document.querySelector('#schema-version');
const playerStatusElement = document.querySelector('#player-status');
const playerTitleElement = document.querySelector('#player-title');
const providerElement = document.querySelector('#player-provider');
const videoIdElement = document.querySelector('#player-video-id');
const playbackStateElement = document.querySelector('#player-state');
const positionElement = document.querySelector('#player-position');
const playbackRateElement = document.querySelector('#player-rate');
const schedulerStatusElement = document.querySelector('#scheduler-status');
const manifestIdElement = document.querySelector('#scheduler-manifest-id');
const progressElement = document.querySelector('#scheduler-progress');
const nextSegmentElement = document.querySelector('#scheduler-next');
const lastEventElement = document.querySelector('#scheduler-last-event');
const audioStateElement = document.querySelector('#scheduler-audio-state');
const descriptionToggleElement = document.querySelector('#description-toggle');
const descriptionVolumeElement = document.querySelector('#description-volume');
const descriptionVolumeOutputElement = document.querySelector('#description-volume-output');
const duckFactorElement = document.querySelector('#duck-factor');
const duckFactorOutputElement = document.querySelector('#duck-factor-output');
const autoPauseEnabledElement = document.querySelector('#auto-pause-enabled');
const currentDescriptionElement = document.querySelector('#current-description-text');
const accessibilityAnnouncementElement = document.querySelector('#accessibility-announcement');
const accessibilityAlertElement = document.querySelector('#accessibility-alert');
const generationStatusElement = document.querySelector('#generation-status');
const jobSummaryElement = document.querySelector('#job-summary');
const jobProgressContentElement = document.querySelector('#job-progress-content');
const jobStageElement = document.querySelector('#job-stage');
const jobProgressElement = document.querySelector('#job-progress');
const jobProgressOutputElement = document.querySelector('#job-progress-output');
const jobEtaElement = document.querySelector('#job-eta');
const jobCreateElement = document.querySelector('#job-create');
const jobStatusCheckElement = document.querySelector('#job-status-check');
const jobRetryElement = document.querySelector('#job-retry');
const jobRegenerateElement = document.querySelector('#job-regenerate');
const backendStatusElement = document.querySelector('#backend-status');
const backendRetryElement = document.querySelector('#backend-retry');
const interactionSoundsEnabledElement = document.querySelector('#interaction-sounds-enabled');
const interactionSoundVolumeElement = document.querySelector('#interaction-sound-volume');
const interactionSoundVolumeOutputElement = document.querySelector('#interaction-sound-volume-output');
const shortcutSpeechEnabledElement = document.querySelector('#shortcut-speech-enabled');
const positionAnnounceElement = document.querySelector('#position-announce');
let activeTabId = null;
let playerRequestInFlight = false;
let contentConnected = false;
let settingsRequestVersion = 0;
let settingsInteractionActive = false;
let currentSettings = { ..._shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.DEFAULT_PLAYBACK_SETTINGS };
let currentAccessibilitySettings = {
    ..._shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.DEFAULT_ACCESSIBILITY_SETTINGS,
};
let lastPlayerContext = null;
let lastAudioState = 'idle';
let activeJobTarget = null;
let currentJobStatus = null;
let jobRequestInFlight = false;
let toggleRequestInFlight = false;
let nextJobPollAt = 0;
let announcementTimer = null;
let alertTimer = null;
let keyboardFocusCuePending = false;
const jobAnnouncementTracker = new _job_progress__WEBPACK_IMPORTED_MODULE_5__.JobAnnouncementTracker();
const PENDING_ANNOUNCEMENT_MAX_AGE_MS = 10000;
const feedbackSoundPlayer = new _shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_6__.FeedbackSoundPlayer();
const PLAYBACK_STATE_LABELS = {
    playing: '재생 중',
    paused: '일시정지',
    ended: '재생 완료',
};
function announce(text, options = {}) {
    const urgency = options.urgency ?? 'polite';
    const target = urgency === 'assertive'
        ? accessibilityAlertElement
        : accessibilityAnnouncementElement;
    if (!target) {
        return;
    }
    const activeTimer = urgency === 'assertive' ? alertTimer : announcementTimer;
    if (activeTimer !== null) {
        window.clearTimeout(activeTimer);
    }
    target.textContent = '';
    const timer = window.setTimeout(() => {
        target.textContent = text;
        if (urgency === 'assertive') {
            alertTimer = null;
        }
        else {
            announcementTimer = null;
        }
    }, 40);
    if (urgency === 'assertive') {
        alertTimer = timer;
    }
    else {
        announcementTimer = timer;
    }
    if (options.tone) {
        const tone = options.tone;
        void feedbackSoundPlayer
            .unlock()
            .then(() => feedbackSoundPlayer.play(tone))
            .catch(() => undefined);
    }
}
function setHidden(element, hidden) {
    if (element) {
        element.hidden = hidden;
    }
}
function activeVideoKey() {
    return activeJobTarget
        ? `${activeJobTarget.provider}:${activeJobTarget.video_id}`
        : null;
}
function formatTime(milliseconds) {
    if (milliseconds === null) {
        return '--:--';
    }
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
function renderFailure() {
    if (statusElement) {
        statusElement.textContent = '연결 오류';
        statusElement.dataset.state = 'error';
    }
}
async function loadRuntimeStatus() {
    const request = { type: 'RUNTIME_STATUS_GET' };
    const response = (await chrome.runtime.sendMessage(request));
    if (!response?.ok) {
        renderFailure();
        return;
    }
    if (statusElement) {
        statusElement.textContent = '확장 준비됨';
        statusElement.dataset.state = 'ready';
    }
    if (versionElement) {
        versionElement.textContent = response.extensionVersion;
    }
    if (schemaElement) {
        schemaElement.textContent = response.schemaVersion;
    }
}
async function loadBackendHealth() {
    if (backendRetryElement)
        backendRetryElement.disabled = true;
    if (backendStatusElement) {
        backendStatusElement.textContent = '로컬 API 확인 중';
        backendStatusElement.dataset.state = 'loading';
    }
    try {
        const request = { type: 'BACKEND_HEALTH_GET' };
        const response = await chrome.runtime.sendMessage(request);
        const ok = typeof response === 'object' &&
            response !== null &&
            response.ok === true;
        if (backendStatusElement) {
            backendStatusElement.textContent = ok ? '로컬 API 연결됨' : '로컬 API 연결 안 됨';
            backendStatusElement.dataset.state = ok ? 'ready' : 'error';
        }
    }
    catch {
        if (backendStatusElement) {
            backendStatusElement.textContent = '로컬 API 연결 안 됨';
            backendStatusElement.dataset.state = 'error';
        }
    }
    finally {
        if (backendRetryElement)
            backendRetryElement.disabled = false;
    }
}
function renderPlayerContext(context) {
    lastPlayerContext = context;
    if (!context.available) {
        if (playerStatusElement) {
            playerStatusElement.textContent =
                context.reason === 'video_not_found' ? '플레이어 탐색 중' : '지원 영상 없음';
            playerStatusElement.dataset.state = 'loading';
        }
        for (const element of [
            providerElement,
            videoIdElement,
            playbackStateElement,
            positionElement,
            playbackRateElement,
        ]) {
            if (element) {
                element.textContent = '-';
            }
        }
        if (playerTitleElement) {
            playerTitleElement.textContent = '영상 정보 없음';
        }
        renderSettings(currentSettings);
        return;
    }
    if (playerStatusElement) {
        playerStatusElement.textContent = '영상 연결됨';
        playerStatusElement.dataset.state = 'ready';
    }
    if (providerElement) {
        providerElement.textContent = 'YouTube';
    }
    if (videoIdElement) {
        videoIdElement.textContent = context.video_id;
    }
    if (playerTitleElement) {
        playerTitleElement.textContent = context.title;
    }
    if (playbackStateElement) {
        playbackStateElement.textContent = PLAYBACK_STATE_LABELS[context.state];
    }
    if (positionElement) {
        positionElement.textContent = `${formatTime(context.current_time_ms)} / ${formatTime(context.duration_ms)}`;
    }
    if (playbackRateElement) {
        playbackRateElement.textContent = `${context.playback_rate}x`;
    }
    renderSettings(currentSettings);
}
function unavailableSchedulerStatus() {
    return {
        active: false,
        enabled: currentSettings.enabled,
        audio_state: 'idle',
        active_segment_id: null,
        active_segment_text: null,
        active_mode: null,
        settings: { ...currentSettings },
        reason: 'no_video',
    };
}
function renderRangeValue(input, output) {
    if (!input || !output) {
        return;
    }
    const text = `${input.value}%`;
    output.textContent = text;
    input.setAttribute('aria-valuetext', `${input.value}퍼센트`);
}
function renderSettings(settings) {
    currentSettings = { ...settings };
    if (descriptionToggleElement) {
        descriptionToggleElement.textContent = settings.enabled
            ? '화면해설 끄기'
            : '화면해설 켜기';
        descriptionToggleElement.setAttribute('aria-pressed', String(settings.enabled));
        descriptionToggleElement.disabled =
            toggleRequestInFlight || !lastPlayerContext?.available;
    }
    if (descriptionVolumeElement) {
        descriptionVolumeElement.value = String(Math.round(settings.description_volume * 100));
    }
    if (duckFactorElement) {
        duckFactorElement.value = String(Math.round(settings.duck_factor * 100));
    }
    if (autoPauseEnabledElement) {
        autoPauseEnabledElement.checked = settings.auto_pause_enabled;
    }
    renderRangeValue(descriptionVolumeElement, descriptionVolumeOutputElement);
    renderRangeValue(duckFactorElement, duckFactorOutputElement);
}
function renderAccessibilitySettings(settings) {
    currentAccessibilitySettings = { ...settings };
    feedbackSoundPlayer.setEnabled(settings.interaction_sounds_enabled);
    feedbackSoundPlayer.setVolume(settings.interaction_sound_volume);
    if (interactionSoundsEnabledElement) {
        interactionSoundsEnabledElement.checked = settings.interaction_sounds_enabled;
    }
    if (interactionSoundVolumeElement) {
        interactionSoundVolumeElement.value = String(Math.round(settings.interaction_sound_volume * 100));
    }
    if (shortcutSpeechEnabledElement) {
        shortcutSpeechEnabledElement.checked = settings.shortcut_speech_enabled;
    }
    renderRangeValue(interactionSoundVolumeElement, interactionSoundVolumeOutputElement);
}
function jobAnnouncementTone(status) {
    if (status.status === 'ready')
        return 'success';
    if (status.status === 'failed' || status.status === 'unavailable')
        return 'error';
    return 'action';
}
function announceJobStatus(status, message) {
    const isError = status.status === 'failed' || status.status === 'unavailable';
    announce(message, {
        tone: jobAnnouncementTone(status),
        urgency: isError ? 'assertive' : 'polite',
    });
}
function hideGenerationStatus() {
    setHidden(generationStatusElement, true);
    if (generationStatusElement) {
        generationStatusElement.setAttribute('aria-busy', 'false');
    }
}
function renderJobLoading() {
    setHidden(generationStatusElement, false);
    setHidden(jobProgressContentElement, true);
    setHidden(jobCreateElement, true);
    setHidden(jobStatusCheckElement, true);
    setHidden(jobRetryElement, true);
    setHidden(jobRegenerateElement, true);
    if (jobSummaryElement) {
        jobSummaryElement.textContent = '화면해설 생성 상태 확인 중';
    }
    if (generationStatusElement) {
        generationStatusElement.setAttribute('aria-busy', 'true');
    }
}
function renderJobStatus(status, allowAutomaticAnnouncement = true) {
    currentJobStatus = status;
    const view = (0,_job_progress__WEBPACK_IMPORTED_MODULE_5__.jobProgressView)(status);
    setHidden(generationStatusElement, false);
    setHidden(jobProgressContentElement, view.percent === null);
    const canCreate = activeJobTarget?.duration_ms != null &&
        (status.status === 'not_started' ||
            (status.status === 'failed' && status.error.retryable));
    setHidden(jobCreateElement, !canCreate);
    setHidden(jobStatusCheckElement, status.status !== 'queued' && status.status !== 'processing');
    setHidden(jobRetryElement, status.status !== 'unavailable');
    setHidden(jobRegenerateElement, status.status !== 'ready');
    if (jobCreateElement) {
        jobCreateElement.textContent = status.status === 'failed' ? '다시 만들기' : '화면해설 만들기';
        jobCreateElement.disabled = jobRequestInFlight;
    }
    if (jobStatusCheckElement) {
        jobStatusCheckElement.disabled = jobRequestInFlight;
    }
    if (jobRetryElement) {
        jobRetryElement.disabled = jobRequestInFlight;
    }
    if (jobRegenerateElement) {
        jobRegenerateElement.disabled = jobRequestInFlight;
    }
    if (jobSummaryElement) {
        jobSummaryElement.textContent = view.summary;
    }
    if (jobStageElement) {
        jobStageElement.textContent = view.stage ?? '';
    }
    if (jobEtaElement) {
        jobEtaElement.textContent = view.eta ?? '';
    }
    if (jobProgressElement && view.percent !== null) {
        jobProgressElement.value = view.percent;
        jobProgressElement.textContent = `${view.percent}%`;
        if (view.progressValueText) {
            jobProgressElement.setAttribute('aria-valuetext', view.progressValueText);
        }
        else {
            jobProgressElement.removeAttribute('aria-valuetext');
        }
    }
    if (jobProgressOutputElement) {
        jobProgressOutputElement.textContent = view.percent === null ? '' : `${view.percent}%`;
    }
    if (generationStatusElement) {
        generationStatusElement.setAttribute('aria-busy', status.status === 'queued' || status.status === 'processing' ? 'true' : 'false');
    }
    if (schedulerStatusElement) {
        if (status.status === 'queued' || status.status === 'processing') {
            schedulerStatusElement.textContent = '화면해설 생성 중';
            schedulerStatusElement.dataset.state = 'processing';
        }
        else if (status.status === 'failed') {
            schedulerStatusElement.textContent = '화면해설 생성 실패';
            schedulerStatusElement.dataset.state = 'error';
        }
        else if (status.status === 'unavailable') {
            schedulerStatusElement.textContent = '생성 상태 확인 오류';
            schedulerStatusElement.dataset.state = 'error';
        }
        else if (status.status === 'ready') {
            schedulerStatusElement.textContent = currentSettings.enabled
                ? '화면해설 준비됨'
                : '화면해설 꺼짐';
            schedulerStatusElement.dataset.state = currentSettings.enabled ? 'ready' : 'loading';
        }
    }
    if (allowAutomaticAnnouncement) {
        const message = jobAnnouncementTracker.next(status);
        if (message) {
            announceJobStatus(status, message);
        }
    }
}
function setJobButtonsBusy(busy) {
    for (const button of [
        jobCreateElement,
        jobStatusCheckElement,
        jobRetryElement,
        jobRegenerateElement,
    ]) {
        if (button && !button.hidden) {
            button.disabled = busy;
        }
    }
}
async function loadJobStatus(force = false, announceManually = false) {
    const target = activeJobTarget;
    if (!target || (jobRequestInFlight && !force)) {
        if (announceManually && currentJobStatus) {
            const message = jobAnnouncementTracker.next(currentJobStatus, true);
            if (message)
                announceJobStatus(currentJobStatus, message);
        }
        return;
    }
    if (!force && Date.now() < nextJobPollAt) {
        return;
    }
    jobRequestInFlight = true;
    setJobButtonsBusy(true);
    if (!currentJobStatus || currentJobStatus.video_key !== activeVideoKey()) {
        renderJobLoading();
    }
    const request = { type: 'JOB_STATUS_GET', ...target };
    try {
        const response = await chrome.runtime.sendMessage(request);
        if (!(0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.isJobStatus)(response) || response.video_key !== activeVideoKey()) {
            renderJobStatus({
                status: 'unavailable',
                video_key: activeVideoKey(),
                reason: 'invalid_response',
            });
            nextJobPollAt = Date.now() + 5000;
            return;
        }
        renderJobStatus(response, !announceManually);
        if (announceManually) {
            const message = jobAnnouncementTracker.next(response, true);
            if (message)
                announceJobStatus(response, message);
        }
        nextJobPollAt = (0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.shouldPollJob)(response)
            ? Date.now() + response.retry_after_ms
            : Number.POSITIVE_INFINITY;
    }
    catch {
        const unavailable = {
            status: 'unavailable',
            video_key: activeVideoKey(),
            reason: 'network',
        };
        renderJobStatus(unavailable, !announceManually);
        if (announceManually) {
            const message = jobAnnouncementTracker.next(unavailable, true);
            if (message)
                announceJobStatus(unavailable, message);
        }
        nextJobPollAt = Date.now() + 5000;
    }
    finally {
        jobRequestInFlight = false;
        setJobButtonsBusy(false);
    }
}
async function createJob(force = false) {
    const target = activeJobTarget;
    if (!target || target.duration_ms === null || jobRequestInFlight) {
        if (target?.duration_ms === null) {
            announce('영상 길이를 확인하는 중입니다. 잠시 후 다시 시도해 주세요.', {
                tone: 'action',
            });
        }
        return;
    }
    jobRequestInFlight = true;
    setJobButtonsBusy(true);
    announce(force ? '새 화면해설 분석을 요청했습니다.' : '화면해설 생성을 요청했습니다.', {
        tone: 'action',
    });
    const request = { type: 'JOB_CREATE', ...target, ...(force ? { force: true } : {}) };
    try {
        const response = await chrome.runtime.sendMessage(request);
        if (!(0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.isJobStatus)(response) || response.video_key !== activeVideoKey()) {
            renderJobStatus({
                status: 'unavailable',
                video_key: activeVideoKey(),
                reason: 'invalid_response',
            });
            return;
        }
        renderJobStatus(response);
        nextJobPollAt = (0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.shouldPollJob)(response)
            ? Date.now() + response.retry_after_ms
            : Number.POSITIVE_INFINITY;
    }
    catch {
        renderJobStatus({ status: 'unavailable', video_key: activeVideoKey(), reason: 'network' });
    }
    finally {
        jobRequestInFlight = false;
        setJobButtonsBusy(false);
    }
}
function renderSchedulerStatus(status) {
    if (!settingsInteractionActive && settingsRequestVersion === 0) {
        renderSettings(status.settings);
    }
    if (audioStateElement) {
        audioStateElement.textContent =
            status.audio_state === 'playing'
                ? status.active_mode === 'extended'
                    ? '영상 정지 후 재생 중'
                    : '원본과 함께 재생 중'
                : status.audio_state === 'error'
                    ? '재생 오류'
                    : '대기';
    }
    if (currentDescriptionElement) {
        currentDescriptionElement.textContent =
            status.audio_state === 'playing' && status.active_segment_text
                ? status.active_segment_text
                : status.audio_state === 'error'
                    ? '화면해설을 재생하지 못했습니다.'
                    : '재생 대기 중';
        currentDescriptionElement.setAttribute('aria-busy', status.audio_state === 'playing' ? 'true' : 'false');
    }
    if (status.audio_state === 'error' &&
        lastAudioState !== 'error') {
        announce('화면해설 음성을 재생하지 못했습니다.', {
            urgency: 'assertive',
            tone: 'error',
        });
    }
    lastAudioState = status.audio_state;
    if (!status.active) {
        if (schedulerStatusElement) {
            schedulerStatusElement.textContent =
                status.reason === 'no_manifest'
                    ? '이 영상은 아직 화면해설이 없습니다.'
                    : '영상 연결 대기 중';
            schedulerStatusElement.dataset.state = 'loading';
        }
        for (const element of [
            manifestIdElement,
            progressElement,
            nextSegmentElement,
            lastEventElement,
        ]) {
            if (element) {
                element.textContent = '-';
            }
        }
        return;
    }
    if (schedulerStatusElement) {
        schedulerStatusElement.textContent = status.enabled ? '화면해설 준비됨' : '화면해설 꺼짐';
        schedulerStatusElement.dataset.state = status.enabled ? 'ready' : 'loading';
    }
    if (manifestIdElement) {
        manifestIdElement.textContent = status.manifest_id;
    }
    if (progressElement) {
        progressElement.textContent = `${status.handled_segments} / ${status.total_segments}`;
    }
    if (nextSegmentElement) {
        nextSegmentElement.textContent = status.next_segment_id
            ? `${status.next_segment_id} · ${formatTime(status.next_trigger_ms)}`
            : '모든 구간 처리됨';
    }
    if (lastEventElement) {
        if (!status.last_event) {
            lastEventElement.textContent = '아직 없음';
        }
        else {
            const action = status.last_event.type === 'trigger' ? '발화 요청' : '건너뜀';
            const reason = status.last_event.reason === 'late'
                ? ' · 지연'
                : status.last_event.reason === 'seek'
                    ? ' · 탐색'
                    : status.last_event.reason === 'auto_pause_disabled'
                        ? ' · 자동 정지 꺼짐'
                        : '';
            lastEventElement.textContent = `${status.last_event.segment_id} · ${action}${reason}`;
        }
    }
}
async function loadPlayerContext() {
    if (playerRequestInFlight) {
        return;
    }
    playerRequestInFlight = true;
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        activeTabId = tab?.id ?? null;
        if (activeTabId === null) {
            contentConnected = false;
            activeJobTarget = null;
            currentJobStatus = null;
            hideGenerationStatus();
            renderPlayerContext({ available: false, reason: 'unsupported_page' });
            renderSchedulerStatus(unavailableSchedulerStatus());
            return;
        }
        const request = { type: 'PLAYER_CONTEXT_GET' };
        const response = await chrome.tabs.sendMessage(activeTabId, request);
        contentConnected = true;
        const playerContext = (0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isPlayerContext)(response)
            ? response
            : { available: false, reason: 'unsupported_page' };
        renderPlayerContext(playerContext);
        const schedulerRequest = { type: 'SCHEDULER_STATUS_GET' };
        const schedulerResponse = await chrome.tabs.sendMessage(activeTabId, schedulerRequest);
        const schedulerStatus = (0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isSchedulerStatus)(schedulerResponse)
            ? schedulerResponse
            : unavailableSchedulerStatus();
        renderSchedulerStatus(schedulerStatus);
        if (!playerContext.available) {
            activeJobTarget = null;
            currentJobStatus = null;
            hideGenerationStatus();
            return;
        }
        const nextTarget = {
            provider: playerContext.provider,
            video_id: playerContext.video_id,
            duration_ms: playerContext.duration_ms,
        };
        const nextVideoKey = `${nextTarget.provider}:${nextTarget.video_id}`;
        if (nextVideoKey !== activeVideoKey()) {
            activeJobTarget = nextTarget;
            currentJobStatus = null;
            nextJobPollAt = 0;
        }
        else {
            activeJobTarget = nextTarget;
        }
        if (schedulerStatus.active) {
            currentJobStatus = {
                status: 'ready',
                job_id: null,
                video_key: nextVideoKey,
                progress_percent: 100,
                manifest_id: schedulerStatus.manifest_id,
                revision: schedulerStatus.revision,
                updated_at: new Date().toISOString(),
            };
            renderJobStatus(currentJobStatus, false);
            return;
        }
        if (currentJobStatus?.video_key === nextVideoKey) {
            renderJobStatus(currentJobStatus, false);
        }
        else {
            renderJobLoading();
        }
        void loadJobStatus();
    }
    catch {
        contentConnected = false;
        activeJobTarget = null;
        currentJobStatus = null;
        hideGenerationStatus();
        renderPlayerContext({ available: false, reason: 'unsupported_page' });
        renderSchedulerStatus(unavailableSchedulerStatus());
    }
    finally {
        playerRequestInFlight = false;
    }
}
function sendSettings(settings) {
    currentSettings = { ...settings };
    renderSettings(currentSettings);
    const requestVersion = ++settingsRequestVersion;
    const tabId = activeTabId;
    const request = {
        type: 'PLAYBACK_SETTINGS_SET',
        settings,
    };
    const contentUpdate = tabId !== null && contentConnected
        ? chrome.tabs.sendMessage(tabId, request).catch(() => undefined)
        : Promise.resolve(undefined);
    void Promise.all([
        chrome.storage.local.set({ [_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.PLAYBACK_SETTINGS_STORAGE_KEY]: settings }),
        contentUpdate,
    ])
        .then(([, response]) => {
        if (requestVersion === settingsRequestVersion && (0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isSchedulerStatus)(response)) {
            renderSchedulerStatus(response);
        }
    })
        .catch((error) => {
        console.error('[VOICE BRIDGE] Failed to save settings.', error);
        void loadPlayerContext();
    })
        .finally(() => {
        if (requestVersion === settingsRequestVersion) {
            settingsRequestVersion = 0;
            settingsInteractionActive = false;
        }
    });
}
function saveAccessibilitySettings(settings) {
    renderAccessibilitySettings(settings);
    void chrome.storage.local
        .set({ [_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.ACCESSIBILITY_SETTINGS_STORAGE_KEY]: settings })
        .catch((error) => {
        console.error('[VOICE BRIDGE] Failed to save accessibility settings.', error);
        announce('접근성 설정을 저장하지 못했습니다.', {
            urgency: 'assertive',
            tone: 'error',
        });
    });
}
function announceCurrentPlaybackPosition() {
    if (!lastPlayerContext?.available) {
        announce('지원하는 유튜브 영상을 찾지 못했습니다.', {
            urgency: 'assertive',
            tone: 'error',
        });
        return;
    }
    announce((0,_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_4__.playbackPositionAnnouncement)(lastPlayerContext), { tone: 'action' });
}
document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
        keyboardFocusCuePending = true;
    }
    void feedbackSoundPlayer.unlock().catch(() => undefined);
}, true);
document.addEventListener('pointerdown', () => {
    keyboardFocusCuePending = false;
    void feedbackSoundPlayer.unlock().catch(() => undefined);
}, true);
document.addEventListener('focusin', (event) => {
    if (!keyboardFocusCuePending)
        return;
    keyboardFocusCuePending = false;
    const target = event.target;
    if (target instanceof HTMLElement &&
        target.matches('button, input, summary, a[href], [tabindex]:not([tabindex="-1"])')) {
        feedbackSoundPlayer.play('focus');
    }
});
descriptionToggleElement?.addEventListener('click', () => {
    if (toggleRequestInFlight || !lastPlayerContext?.available)
        return;
    const enabled = !currentSettings.enabled;
    toggleRequestInFlight = true;
    feedbackSoundPlayer.play(enabled ? 'toggle-on' : 'toggle-off');
    sendSettings({ ...currentSettings, enabled });
    announce(enabled ? '화면해설을 켰습니다.' : '화면해설을 껐습니다.', {
        tone: enabled ? 'toggle-on' : 'toggle-off',
    });
    if (enabled &&
        (currentJobStatus?.status === 'not_started' ||
            (currentJobStatus?.status === 'failed' && currentJobStatus.error.retryable))) {
        void createJob();
    }
    window.setTimeout(() => {
        toggleRequestInFlight = false;
        renderSettings(currentSettings);
        void loadPlayerContext();
    }, 300);
});
descriptionVolumeElement?.addEventListener('input', () => {
    settingsInteractionActive = true;
    currentSettings.description_volume = Number(descriptionVolumeElement.value) / 100;
    renderRangeValue(descriptionVolumeElement, descriptionVolumeOutputElement);
    feedbackSoundPlayer.play('adjust', currentSettings.description_volume);
});
descriptionVolumeElement?.addEventListener('change', () => {
    sendSettings({ ...currentSettings });
});
duckFactorElement?.addEventListener('input', () => {
    settingsInteractionActive = true;
    currentSettings.duck_factor = Number(duckFactorElement.value) / 100;
    renderRangeValue(duckFactorElement, duckFactorOutputElement);
    feedbackSoundPlayer.play('adjust', currentSettings.duck_factor);
});
duckFactorElement?.addEventListener('change', () => {
    sendSettings({ ...currentSettings });
});
autoPauseEnabledElement?.addEventListener('change', () => {
    feedbackSoundPlayer.play(autoPauseEnabledElement.checked ? 'toggle-on' : 'toggle-off');
    sendSettings({
        ...currentSettings,
        auto_pause_enabled: autoPauseEnabledElement.checked,
    });
});
interactionSoundsEnabledElement?.addEventListener('change', () => {
    const enabled = interactionSoundsEnabledElement.checked;
    if (enabled) {
        feedbackSoundPlayer.setEnabled(true);
        void feedbackSoundPlayer
            .unlock()
            .then(() => feedbackSoundPlayer.play('toggle-on'))
            .catch(() => undefined);
    }
    else {
        feedbackSoundPlayer.play('toggle-off');
    }
    saveAccessibilitySettings({
        ...currentAccessibilitySettings,
        interaction_sounds_enabled: enabled,
    });
});
interactionSoundVolumeElement?.addEventListener('input', () => {
    currentAccessibilitySettings.interaction_sound_volume =
        Number(interactionSoundVolumeElement.value) / 100;
    feedbackSoundPlayer.setVolume(currentAccessibilitySettings.interaction_sound_volume);
    renderRangeValue(interactionSoundVolumeElement, interactionSoundVolumeOutputElement);
    feedbackSoundPlayer.play('adjust', currentAccessibilitySettings.interaction_sound_volume);
});
interactionSoundVolumeElement?.addEventListener('change', () => {
    saveAccessibilitySettings({ ...currentAccessibilitySettings });
});
shortcutSpeechEnabledElement?.addEventListener('change', () => {
    feedbackSoundPlayer.play(shortcutSpeechEnabledElement.checked ? 'toggle-on' : 'toggle-off');
    saveAccessibilitySettings({
        ...currentAccessibilitySettings,
        shortcut_speech_enabled: shortcutSpeechEnabledElement.checked,
    });
});
positionAnnounceElement?.addEventListener('click', () => {
    announceCurrentPlaybackPosition();
});
jobCreateElement?.addEventListener('click', () => {
    void createJob();
});
jobStatusCheckElement?.addEventListener('click', () => {
    void loadJobStatus(true, true);
});
jobRetryElement?.addEventListener('click', () => {
    nextJobPollAt = 0;
    void loadJobStatus(true, true);
});
jobRegenerateElement?.addEventListener('click', () => {
    void createJob(true);
});
backendRetryElement?.addEventListener('click', () => {
    void loadBackendHealth();
});
async function consumePendingProgressAnnouncement(value) {
    if (!(0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.isPendingProgressAnnouncement)(value)) {
        return;
    }
    await chrome.storage.session.remove(_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY);
    if (Date.now() - value.requested_at > PENDING_ANNOUNCEMENT_MAX_AGE_MS) {
        return;
    }
    if (value.video_key !== null && activeVideoKey() !== null && value.video_key !== activeVideoKey()) {
        return;
    }
    renderJobStatus(value.job, false);
    const message = jobAnnouncementTracker.next(value.job, true);
    if (message) {
        if (value.speech_handled) {
            void feedbackSoundPlayer
                .unlock()
                .then(() => feedbackSoundPlayer.play(jobAnnouncementTone(value.job)))
                .catch(() => undefined);
        }
        else {
            announceJobStatus(value.job, message);
        }
    }
}
async function consumePendingAccessibilityAnnouncement(value) {
    if (!(0,_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_4__.isPendingAccessibilityAnnouncement)(value)) {
        return;
    }
    await chrome.storage.session.remove(_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_4__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY);
    if (Date.now() - value.requested_at > PENDING_ANNOUNCEMENT_MAX_AGE_MS) {
        return;
    }
    if (value.speech_handled) {
        void feedbackSoundPlayer
            .unlock()
            .then(() => feedbackSoundPlayer.play(value.tone))
            .catch(() => undefined);
    }
    else {
        announce(value.text, { urgency: value.urgency, tone: value.tone });
    }
    void loadPlayerContext();
}
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') {
        return;
    }
    const pending = changes[_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY]?.newValue;
    if (pending !== undefined) {
        void consumePendingProgressAnnouncement(pending);
    }
    const accessibilityPending = changes[_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_4__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY]?.newValue;
    if (accessibilityPending !== undefined) {
        void consumePendingAccessibilityAnnouncement(accessibilityPending);
    }
});
chrome.tabs.onActivated.addListener(() => {
    void loadPlayerContext();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === activeTabId && (changeInfo.status === 'loading' || changeInfo.status === 'complete')) {
        void loadPlayerContext();
    }
});
let panelReportedVisible = false;
function reportPanelVisibility(visible) {
    if (visible === panelReportedVisible) {
        return;
    }
    panelReportedVisible = visible;
    const message = {
        type: 'PANEL_VISIBILITY_CHANGED',
        visible,
    };
    void chrome.runtime.sendMessage(message).catch(() => undefined);
}
document.addEventListener('visibilitychange', () => {
    reportPanelVisibility(document.visibilityState === 'visible');
});
window.addEventListener('pagehide', () => {
    reportPanelVisibility(false);
});
if (document.visibilityState === 'visible') {
    reportPanelVisibility(true);
}
void loadRuntimeStatus().catch((error) => {
    console.error('[VOICE BRIDGE] Runtime status request failed.', error);
    renderFailure();
});
void loadBackendHealth();
void chrome.storage.local
    .get(_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.PLAYBACK_SETTINGS_STORAGE_KEY)
    .then((stored) => {
    renderSettings((0,_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.parseStoredPlaybackSettings)(stored[_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.PLAYBACK_SETTINGS_STORAGE_KEY]));
})
    .catch((error) => {
    console.error('[VOICE BRIDGE] Failed to load settings.', error);
    renderSettings(_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.DEFAULT_PLAYBACK_SETTINGS);
});
const accessibilitySettingsReady = chrome.storage.local
    .get(_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.ACCESSIBILITY_SETTINGS_STORAGE_KEY)
    .then((stored) => {
    renderAccessibilitySettings((0,_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.parseStoredAccessibilitySettings)(stored[_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.ACCESSIBILITY_SETTINGS_STORAGE_KEY]));
})
    .catch((error) => {
    console.error('[VOICE BRIDGE] Failed to load accessibility settings.', error);
    renderAccessibilitySettings(_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.DEFAULT_ACCESSIBILITY_SETTINGS);
});
void accessibilitySettingsReady;
void chrome.storage.session
    .get([
    _shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY,
    _shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_4__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY,
])
    .then(async (stored) => {
    await accessibilitySettingsReady;
    await consumePendingProgressAnnouncement(stored[_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY]);
    await consumePendingAccessibilityAnnouncement(stored[_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_4__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY]);
})
    .catch((error) => {
    console.error('[VOICE BRIDGE] Failed to restore progress announcement.', error);
});
void loadPlayerContext();
window.setInterval(() => {
    void loadPlayerContext();
}, 1000);

})();

/******/ })()
;
//# sourceMappingURL=sidepanel.js.map