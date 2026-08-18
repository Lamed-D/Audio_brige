/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

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
  !*** ./src/offscreen/index.ts ***!
  \********************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/contracts/messages */ "./src/shared/contracts/messages.ts");

class OffscreenAudioEngine {
    active = null;
    play(command) {
        this.stop();
        return new Promise((resolve) => {
            const audio = new Audio(command.audio_url);
            const startedAt = performance.now();
            let settled = false;
            let timeoutId = 0;
            const settle = (response) => {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeoutId);
                audio.pause();
                audio.removeAttribute('src');
                audio.load();
                if (this.active?.requestId === command.request_id) {
                    this.active = null;
                }
                resolve(response);
            };
            this.active = { requestId: command.request_id, audio, settle };
            audio.preload = 'auto';
            audio.playbackRate = command.playback_rate;
            audio.volume = command.volume;
            audio.addEventListener('ended', () => {
                settle({
                    ok: true,
                    request_id: command.request_id,
                    elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
                });
            }, { once: true });
            audio.addEventListener('error', () => {
                settle({ ok: false, request_id: command.request_id, error: 'load_failed' });
            }, { once: true });
            const timeoutMs = Math.max(5000, Math.ceil(command.expected_duration_ms / command.playback_rate) + 3000);
            timeoutId = window.setTimeout(() => {
                settle({ ok: false, request_id: command.request_id, error: 'timeout' });
            }, timeoutMs);
            void audio.play().catch(() => {
                settle({ ok: false, request_id: command.request_id, error: 'play_failed' });
            });
        });
    }
    stop(requestId) {
        if (!this.active || (requestId && this.active.requestId !== requestId)) {
            return;
        }
        const active = this.active;
        active.settle({ ok: false, request_id: active.requestId, error: 'cancelled' });
    }
}
const audioEngine = new OffscreenAudioEngine();
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if ((0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isOffscreenAudioPlayCommand)(message)) {
        void audioEngine.play(message).then(sendResponse);
        return true;
    }
    if ((0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isOffscreenAudioStopCommand)(message)) {
        audioEngine.stop(message.request_id);
        sendResponse({ ok: true });
    }
    return false;
});

})();

/******/ })()
;
//# sourceMappingURL=offscreen.js.map