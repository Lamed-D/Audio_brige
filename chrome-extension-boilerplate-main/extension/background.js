/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/background/job-client.ts"
/*!**************************************!*\
  !*** ./src/background/job-client.ts ***!
  \**************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   JobClient: () => (/* binding */ JobClient)
/* harmony export */ });
/* harmony import */ var _shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/contracts/job-status */ "./src/shared/contracts/job-status.ts");
/* harmony import */ var _shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/contracts/manifest */ "./src/shared/contracts/manifest.ts");


const API_TIMEOUT_MS = 5000;
const MANIFEST_DURATION_TOLERANCE_MS = 1000;
function videoKey(target) {
    return `${target.provider}:${target.video_id}`;
}
function isStoredJob(value) {
    return (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.job_id === 'string' &&
        /^[A-Za-z0-9._:-]+$/.test(value.job_id) &&
        Number.isInteger(value.last_progress_percent) &&
        value.last_progress_percent >= 0 &&
        value.last_progress_percent <= 100 &&
        (value.status === 'queued' ||
            value.status === 'processing' ||
            value.status === 'failed'));
}
function parseStoredJobs(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {};
    }
    const result = {};
    for (const [key, job] of Object.entries(value)) {
        if (/^youtube:[A-Za-z0-9_-]{11}$/.test(key) && isStoredJob(job)) {
            result[key] = job;
        }
    }
    return result;
}
async function readStoredJobs() {
    const stored = await chrome.storage.local.get(_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.JOB_TRACKING_STORAGE_KEY);
    return parseStoredJobs(stored[_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.JOB_TRACKING_STORAGE_KEY]);
}
async function writeStoredJobs(jobs) {
    await chrome.storage.local.set({ [_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.JOB_TRACKING_STORAGE_KEY]: jobs });
}
async function clearStoredJob(key) {
    const jobs = await readStoredJobs();
    if (!(key in jobs)) {
        return;
    }
    delete jobs[key];
    await writeStoredJobs(jobs);
}
async function fetchWithTimeout(path, init) {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
        return await fetch(path, { ...init, signal: controller.signal });
    }
    finally {
        globalThis.clearTimeout(timeout);
    }
}
async function parseJson(response) {
    try {
        return await response.json();
    }
    catch {
        return null;
    }
}
function parseTargetManifest(value, target) {
    const manifest = (0,_shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_1__.parseManifestV1_1)(value);
    if (`${manifest.video.provider}:${manifest.video.video_id}` !== videoKey(target)) {
        throw new Error('Manifest video does not match the requested video.');
    }
    if (target.duration_ms !== null &&
        Math.abs(manifest.video.duration_ms - target.duration_ms) >
            MANIFEST_DURATION_TOLERANCE_MS) {
        throw new Error('Manifest duration does not match the current video.');
    }
    return manifest;
}
class JobClient {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }
    async listPollingTargets() {
        const jobs = await readStoredJobs();
        return Object.entries(jobs)
            .filter(([, job]) => job.status === 'queued' || job.status === 'processing')
            .map(([key]) => {
            const [, videoId] = key.split(':');
            return { provider: 'youtube', video_id: videoId, duration_ms: null };
        });
    }
    async getStatus(target) {
        const key = videoKey(target);
        const jobs = await readStoredJobs();
        const storedJob = jobs[key];
        try {
            if (storedJob) {
                const tracked = await this.fetchTrackedJob(key, storedJob, jobs);
                if (tracked) {
                    return tracked;
                }
            }
            return await this.fetchManifestStatus(target, jobs);
        }
        catch {
            return { status: 'unavailable', video_key: key, reason: 'network' };
        }
    }
    async create(target) {
        const key = videoKey(target);
        try {
            const response = await fetchWithTimeout(`${this.baseUrl}/v1/jobs`, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    provider: target.provider,
                    video_id: target.video_id,
                    duration_ms: target.duration_ms,
                }),
            });
            if (response.status !== 202 && response.status !== 200) {
                return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
            }
            const value = await parseJson(response);
            if (!(0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.isBackendJobStatus)(value) || value.video_key !== key) {
                return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
            }
            return await this.persistProgress(value);
        }
        catch {
            return { status: 'unavailable', video_key: key, reason: 'network' };
        }
    }
    async getManifest(target) {
        const key = videoKey(target);
        let response;
        try {
            response = await fetchWithTimeout(`${this.baseUrl}/v1/manifests/${target.provider}/${encodeURIComponent(target.video_id)}`, { headers: { Accept: 'application/json' } });
        }
        catch {
            return { status: 'unavailable', video_key: key, reason: 'network' };
        }
        if (response.status === 404) {
            return { status: 'not_found', video_key: key };
        }
        if (response.status === 202) {
            const value = await parseJson(response);
            if (!(0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.isBackendJobStatus)(value) ||
                value.video_key !== key ||
                (value.status !== 'queued' && value.status !== 'processing')) {
                return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
            }
            const retryAfterMs = value.retry_after_ms;
            await this.persistProgress(value);
            return {
                status: 'pending',
                video_key: key,
                retry_after_ms: retryAfterMs,
            };
        }
        if (!response.ok) {
            return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
        }
        try {
            const manifest = parseTargetManifest(await parseJson(response), target);
            await clearStoredJob(key);
            return { status: 'ready', video_key: key, manifest };
        }
        catch {
            return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
        }
    }
    async fetchTrackedJob(key, storedJob, jobs) {
        const response = await fetchWithTimeout(`${this.baseUrl}/v1/jobs/${encodeURIComponent(storedJob.job_id)}`);
        if (response.status === 404) {
            delete jobs[key];
            await writeStoredJobs(jobs);
            return null;
        }
        if (!response.ok) {
            return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
        }
        const value = await parseJson(response);
        if (!(0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.isBackendJobStatus)(value) || value.video_key !== key) {
            return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
        }
        return this.persistProgress(value, storedJob.last_progress_percent);
    }
    async fetchManifestStatus(target, jobs) {
        const key = videoKey(target);
        const response = await fetchWithTimeout(`${this.baseUrl}/v1/manifests/${target.provider}/${encodeURIComponent(target.video_id)}`);
        if (response.status === 404) {
            return { status: 'not_started', video_key: key };
        }
        if (response.status === 202) {
            const value = await parseJson(response);
            if (!(0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.isBackendJobStatus)(value) || value.video_key !== key) {
                return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
            }
            return this.persistProgress(value);
        }
        if (!response.ok) {
            return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
        }
        try {
            const manifest = parseTargetManifest(await parseJson(response), target);
            delete jobs[key];
            await writeStoredJobs(jobs);
            return {
                status: 'ready',
                job_id: null,
                video_key: key,
                progress_percent: 100,
                manifest_id: manifest.manifest_id,
                revision: manifest.revision,
                updated_at: new Date().toISOString(),
            };
        }
        catch {
            return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
        }
    }
    async persistProgress(status, previousPercent = null) {
        const jobs = await readStoredJobs();
        const previous = jobs[status.video_key];
        const normalized = (0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_0__.ensureMonotonicProgress)(previousPercent ?? previous?.last_progress_percent ?? null, status);
        if (normalized.status === 'ready') {
            delete jobs[normalized.video_key];
        }
        else {
            jobs[normalized.video_key] = {
                job_id: normalized.job_id,
                last_progress_percent: normalized.progress_percent,
                status: normalized.status,
            };
        }
        await writeStoredJobs(jobs);
        return normalized;
    }
}


/***/ },

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

/***/ "./src/shared/accessibility/shortcut-speech.ts"
/*!*****************************************************!*\
  !*** ./src/shared/accessibility/shortcut-speech.ts ***!
  \*****************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   jobStatusSpeech: () => (/* binding */ jobStatusSpeech),
/* harmony export */   panelVisibilitySpeech: () => (/* binding */ panelVisibilitySpeech),
/* harmony export */   shouldCreateJobFromShortcut: () => (/* binding */ shouldCreateJobFromShortcut)
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
function etaForSpeech(seconds) {
    if (seconds === null)
        return '예상 시간 계산 중입니다';
    if (seconds < 60)
        return '약 1분 이내 남았습니다';
    return `약 ${Math.max(1, Math.round(seconds / 60))}분 남았습니다`;
}
function jobStatusSpeech(status) {
    if (status.status === 'queued' || status.status === 'processing') {
        return `화면해설 생성 ${status.progress_percent}퍼센트 완료. ${STAGE_LABELS[status.stage]}. ${etaForSpeech(status.eta_seconds)}.`;
    }
    if (status.status === 'ready') {
        return '화면해설 생성이 완료되었습니다. 바로 재생할 수 있습니다.';
    }
    if (status.status === 'failed') {
        return status.error.retryable
            ? '화면해설을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.'
            : '이 영상의 화면해설을 현재 만들 수 없습니다.';
    }
    if (status.status === 'not_started') {
        return '이 영상은 아직 화면해설이 없습니다.';
    }
    return status.reason === 'unsupported_page'
        ? '지원하는 유튜브 영상에서 현재 상태를 확인할 수 있습니다.'
        : '화면해설 생성 상태를 확인하지 못했습니다.';
}
function shouldCreateJobFromShortcut(status) {
    return (status.status === 'not_started' ||
        (status.status === 'failed' && status.error.retryable));
}
function panelVisibilitySpeech(visible) {
    return visible
        ? '보이스 브리지 패널이 열렸습니다. 현재 패널을 조작할 수 있습니다.'
        : '보이스 브리지 패널이 닫혔습니다. 영상 화면으로 돌아왔습니다.';
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

// kwon2/backend binds to the IPv4 loopback interface by default. Keep this
// value in sync with extension/manifest.json host_permissions.
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
            value.revision >= 1);
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
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
        fail(`${path}.sha256`, '64-character lowercase hexadecimal digest expected');
    }
    if (audioPath !== `/v1/audio/${sha256}.wav`) {
        fail(`${path}.path`, 'must match /v1/audio/{sha256}.wav');
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
        confidence: enumValue(input.confidence, ['high'], `${path}.confidence`),
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
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(provider)) {
        fail('video.provider', 'lowercase provider identifier expected');
    }
    const videoId = string(videoInput.video_id, 'video.video_id');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) {
        fail('video.video_id', 'provider video identifier expected');
    }
    const videoDurationMs = integer(videoInput.duration_ms, 'video.duration_ms', 1);
    const revision = integer(input.revision, 'revision', 1);
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
    let previousExtendedTrigger = Number.NEGATIVE_INFINITY;
    for (const [index, segment] of segments.entries()) {
        if (ids.has(segment.id)) {
            fail(`segments[${index}].id`, 'duplicate segment id');
        }
        ids.add(segment.id);
        if (segment.trigger_ms < previousTrigger) {
            fail(`segments[${index}].trigger_ms`, 'segments must be sorted');
        }
        if (segment.trigger_ms > videoDurationMs) {
            fail(`segments[${index}].trigger_ms`, 'must not exceed video duration');
        }
        previousTrigger = segment.trigger_ms;
        if (segment.mode === 'overlay') {
            if (segment.deadline_ms > videoDurationMs) {
                fail(`segments[${index}].deadline_ms`, 'must be inside video duration');
            }
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
            format: enumValue(voiceInput.format, ['audio/wav'], 'voice.format'),
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
/* harmony export */   isManifestFetchResponse: () => (/* binding */ isManifestFetchResponse),
/* harmony export */   isOffscreenAudioPlayCommand: () => (/* binding */ isOffscreenAudioPlayCommand),
/* harmony export */   isOffscreenAudioStopCommand: () => (/* binding */ isOffscreenAudioStopCommand),
/* harmony export */   isPlayerContext: () => (/* binding */ isPlayerContext),
/* harmony export */   isSchedulerStatus: () => (/* binding */ isSchedulerStatus)
/* harmony export */ });
/* harmony import */ var _manifest__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./manifest */ "./src/shared/contracts/manifest.ts");
/* harmony import */ var _config_constants__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../config/constants */ "./src/shared/config/constants.ts");
/* harmony import */ var _settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../settings/playback-settings */ "./src/shared/settings/playback-settings.ts");



const API_ORIGIN = new URL(_config_constants__WEBPACK_IMPORTED_MODULE_1__.API_BASE_URL).origin;
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
function isVideoKey(value) {
    return typeof value === 'string' && /^youtube:[A-Za-z0-9_-]{11}$/.test(value);
}
function isManifestFetchResponse(value) {
    if (!isRecord(value) || !isVideoKey(value.video_key)) {
        return false;
    }
    if (value.status === 'not_found') {
        return true;
    }
    if (value.status === 'pending') {
        return (Number.isInteger(value.retry_after_ms) &&
            value.retry_after_ms >= 1000 &&
            value.retry_after_ms <= 30000);
    }
    if (value.status === 'unavailable') {
        return value.reason === 'network' || value.reason === 'invalid_response';
    }
    if (value.status !== 'ready') {
        return false;
    }
    try {
        const manifest = (0,_manifest__WEBPACK_IMPORTED_MODULE_0__.parseManifestV1_1)(value.manifest);
        return `${manifest.video.provider}:${manifest.video.video_id}` === value.video_key;
    }
    catch {
        return false;
    }
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
        (0,_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.isPlaybackSettings)(value.settings);
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
        /^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(value.audio_path) &&
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
    try {
        const url = new URL(value);
        return (url.origin === API_ORIGIN &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === '' &&
            /^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(url.pathname));
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
        return (0,_settings_playback_settings__WEBPACK_IMPORTED_MODULE_2__.isPlaybackSettings)(value.settings);
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
    if (value.type === 'JOB_STATUS_GET' ||
        value.type === 'JOB_CREATE' ||
        value.type === 'MANIFEST_GET') {
        return isJobTarget(value);
    }
    if (value.type === 'MANIFEST_REFRESH') {
        return isVideoKey(value.video_key);
    }
    return (value.type === 'RUNTIME_STATUS_GET' ||
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
/*!*********************************!*\
  !*** ./src/background/index.ts ***!
  \*********************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/contracts/messages */ "./src/shared/contracts/messages.ts");
/* harmony import */ var _shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/contracts/job-status */ "./src/shared/contracts/job-status.ts");
/* harmony import */ var _shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../shared/accessibility/announcements */ "./src/shared/accessibility/announcements.ts");
/* harmony import */ var _shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ../shared/settings/accessibility-settings */ "./src/shared/settings/accessibility-settings.ts");
/* harmony import */ var _shared_accessibility_shortcut_speech__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ../shared/accessibility/shortcut-speech */ "./src/shared/accessibility/shortcut-speech.ts");
/* harmony import */ var _shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ../shared/contracts/manifest */ "./src/shared/contracts/manifest.ts");
/* harmony import */ var _shared_config_constants__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(/*! ../shared/config/constants */ "./src/shared/config/constants.ts");
/* harmony import */ var _job_client__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(/*! ./job-client */ "./src/background/job-client.ts");









const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const BACKEND_ORIGIN = new URL(_shared_config_constants__WEBPACK_IMPORTED_MODULE_6__.API_BASE_URL).origin;
const PROGRESS_ANNOUNCEMENT_MAX_AGE_MS = 10000;
const ACCESSIBILITY_ANNOUNCEMENT_MAX_AGE_MS = 10000;
const JOB_MONITOR_ALARM = 'voice-bridge-job-monitor';
const JOB_NOTIFICATION_PREFIX = 'voice-bridge-job:';
let creatingOffscreenDocument = null;
const jobClient = new _job_client__WEBPACK_IMPORTED_MODULE_7__.JobClient(_shared_config_constants__WEBPACK_IMPORTED_MODULE_6__.API_BASE_URL);
async function speakShortcut(text) {
    try {
        const stored = await chrome.storage.local.get(_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.ACCESSIBILITY_SETTINGS_STORAGE_KEY);
        const settings = (0,_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.parseStoredAccessibilitySettings)(stored[_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_3__.ACCESSIBILITY_SETTINGS_STORAGE_KEY]);
        if (!settings.shortcut_speech_enabled) {
            return false;
        }
        await chrome.tts.speak(text, {
            lang: 'ko-KR',
            rate: 1.05,
            pitch: 1,
            volume: 1,
            enqueue: false,
        });
        return true;
    }
    catch (error) {
        console.error('[VOICE BRIDGE] Shortcut TTS failed.', error);
        return false;
    }
}
async function configureSidePanel() {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
void configureSidePanel().catch((error) => {
    console.error('[VOICE BRIDGE] Failed to configure side panel.', error);
});
chrome.runtime.onInstalled.addListener(() => {
    void configureSidePanel();
    void restoreJobMonitor();
});
chrome.runtime.onStartup.addListener(() => {
    void configureSidePanel();
    void restoreJobMonitor();
});
async function activeJobTarget(tab) {
    if (tab.id === undefined) {
        return null;
    }
    try {
        const request = { type: 'PLAYER_CONTEXT_GET' };
        const context = await chrome.tabs.sendMessage(tab.id, request);
        if (!(0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isPlayerContext)(context) || !context.available) {
            return null;
        }
        return {
            provider: context.provider,
            video_id: context.video_id,
            duration_ms: context.duration_ms,
        };
    }
    catch {
        return null;
    }
}
async function queueProgressAnnouncement(tab) {
    const target = await activeJobTarget(tab);
    let job = {
        status: 'unavailable',
        video_key: null,
        reason: 'unsupported_page',
    };
    let creationRequested = false;
    let waitingForMetadata = false;
    if (target) {
        try {
            const scheduler = tab.id === undefined
                ? null
                : await chrome.tabs.sendMessage(tab.id, { type: 'SCHEDULER_STATUS_GET' });
            job =
                (0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isSchedulerStatus)(scheduler) && scheduler.active
                    ? {
                        status: 'ready',
                        job_id: null,
                        video_key: `${target.provider}:${target.video_id}`,
                        progress_percent: 100,
                        manifest_id: scheduler.manifest_id,
                        revision: scheduler.revision,
                        updated_at: new Date().toISOString(),
                    }
                    : await jobClient.getStatus(target);
        }
        catch {
            job = await jobClient.getStatus(target);
        }
        if ((0,_shared_accessibility_shortcut_speech__WEBPACK_IMPORTED_MODULE_4__.shouldCreateJobFromShortcut)(job)) {
            if (target.duration_ms === null) {
                waitingForMetadata = true;
            }
            else {
                console.info('[VOICE BRIDGE] Requesting backend analysis job.', target);
                job = await jobClient.create(target);
                console.info('[VOICE BRIDGE] Backend analysis job response.', job);
                creationRequested = true;
                await setJobBadge(job);
                await restoreJobMonitor();
            }
        }
    }
    const speechText = waitingForMetadata
        ? '영상 길이를 확인 중입니다. 잠시 후 다시 시도해 주세요.'
        : creationRequested
            ? `화면해설 생성을 요청했습니다. ${(0,_shared_accessibility_shortcut_speech__WEBPACK_IMPORTED_MODULE_4__.jobStatusSpeech)(job)}`
            : (0,_shared_accessibility_shortcut_speech__WEBPACK_IMPORTED_MODULE_4__.jobStatusSpeech)(job);
    const speechHandled = await speakShortcut(speechText);
    const pending = {
        video_key: job.video_key,
        requested_at: Date.now(),
        job,
        speech_handled: speechHandled,
    };
    await chrome.storage.session.set({
        [_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY]: pending,
    });
    globalThis.setTimeout(() => {
        void chrome.storage.session.get(_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY).then((stored) => {
            const value = stored[_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY];
            if (value && Date.now() - value.requested_at >= PROGRESS_ANNOUNCEMENT_MAX_AGE_MS) {
                void chrome.storage.session.remove(_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY);
            }
        });
    }, PROGRESS_ANNOUNCEMENT_MAX_AGE_MS);
}
async function queueAccessibilityAnnouncement(text, tone, urgency = 'polite', speechHandled = false) {
    const pending = {
        id: crypto.randomUUID(),
        text,
        requested_at: Date.now(),
        urgency,
        tone,
        speech_handled: speechHandled,
    };
    await chrome.storage.session.set({
        [_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_2__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY]: pending,
    });
    globalThis.setTimeout(() => {
        void chrome.storage.session
            .get(_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_2__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY)
            .then((stored) => {
            const value = stored[_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_2__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY];
            if (value?.id === pending.id) {
                void chrome.storage.session.remove(_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_2__.PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY);
            }
        });
    }, ACCESSIBILITY_ANNOUNCEMENT_MAX_AGE_MS);
}
async function openSidePanel(tab) {
    if (tab.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
    }
}
async function deliverAccessibilityAnnouncement(tab, text, tone, urgency = 'polite') {
    const speechHandled = await speakShortcut(text);
    if (tab.id !== undefined) {
        try {
            const message = {
                type: 'ACCESSIBILITY_ANNOUNCE',
                text,
                urgency,
                tone,
                speech_handled: speechHandled,
            };
            const response = await chrome.tabs.sendMessage(tab.id, message);
            if (typeof response === 'object' &&
                response !== null &&
                response.ok === true) {
                return;
            }
        }
        catch {
            // Fall back to the extension Side Panel when the active page has no content script.
        }
    }
    await openSidePanel(tab);
    await queueAccessibilityAnnouncement(text, tone, urgency, speechHandled);
}
async function announcePlaybackPosition(tab) {
    if (tab.id === undefined) {
        await deliverAccessibilityAnnouncement(tab, '현재 영상 정보를 확인할 수 없습니다.', 'error', 'assertive');
        return;
    }
    try {
        const request = { type: 'PLAYER_CONTEXT_GET' };
        const context = await chrome.tabs.sendMessage(tab.id, request);
        if (!(0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isPlayerContext)(context) || !context.available) {
            throw new Error('Player unavailable');
        }
        await deliverAccessibilityAnnouncement(tab, (0,_shared_accessibility_announcements__WEBPACK_IMPORTED_MODULE_2__.playbackPositionAnnouncement)(context), 'action');
    }
    catch {
        await deliverAccessibilityAnnouncement(tab, '지원하는 유튜브 영상을 찾지 못했습니다.', 'error', 'assertive');
    }
}
async function toggleDescription(tab) {
    if (tab.id === undefined) {
        await deliverAccessibilityAnnouncement(tab, '화면해설 설정을 변경할 수 없습니다.', 'error', 'assertive');
        return;
    }
    try {
        const statusRequest = { type: 'SCHEDULER_STATUS_GET' };
        const current = await chrome.tabs.sendMessage(tab.id, statusRequest);
        if (!(0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isSchedulerStatus)(current)) {
            throw new Error('Scheduler unavailable');
        }
        const enabled = !current.settings.enabled;
        const updateRequest = {
            type: 'DESCRIPTION_ENABLED_SET',
            enabled,
        };
        const updated = await chrome.tabs.sendMessage(tab.id, updateRequest);
        if (!(0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isSchedulerStatus)(updated) || updated.settings.enabled !== enabled) {
            throw new Error('Setting update failed');
        }
        await deliverAccessibilityAnnouncement(tab, enabled ? '화면해설을 켰습니다.' : '화면해설을 껐습니다.', enabled ? 'toggle-on' : 'toggle-off');
    }
    catch {
        await deliverAccessibilityAnnouncement(tab, '화면해설 설정을 변경하지 못했습니다.', 'error', 'assertive');
    }
}
async function setJobBadge(status) {
    if (status && (0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.shouldPollJob)(status)) {
        await chrome.action.setBadgeBackgroundColor({ color: '#0B5FFF' });
        await chrome.action.setBadgeText({ text: `${status.progress_percent}%` });
        await chrome.action.setTitle({
            title: `VOICE BRIDGE · 화면해설 생성 ${status.progress_percent}%`,
        });
        return;
    }
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'VOICE BRIDGE 열기' });
}
async function refreshReadyManifest(status) {
    if (status.status !== 'ready') {
        return;
    }
    const message = {
        type: 'MANIFEST_REFRESH',
        video_key: status.video_key,
    };
    const tabs = await chrome.tabs.query({ active: true });
    await Promise.allSettled(tabs
        .filter((tab) => tab.id !== undefined)
        .map((tab) => chrome.tabs.sendMessage(tab.id, message)));
}
async function notifyTerminalStatus(status) {
    if (status.status !== 'ready' && status.status !== 'failed') {
        return;
    }
    const title = status.status === 'ready' ? '화면해설 준비 완료' : '화면해설 생성 실패';
    const message = status.status === 'ready'
        ? '요청한 영상의 화면해설을 바로 재생할 수 있습니다.'
        : status.error.retryable
            ? '화면해설을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.'
            : '이 영상은 현재 화면해설로 처리할 수 없습니다.';
    await chrome.notifications.create(`${JOB_NOTIFICATION_PREFIX}${status.video_key}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon.png'),
        title,
        message,
    });
}
async function restoreJobMonitor() {
    const targets = await jobClient.listPollingTargets();
    if (targets.length === 0) {
        await chrome.alarms.clear(JOB_MONITOR_ALARM);
        await setJobBadge(null);
        return;
    }
    await chrome.alarms.create(JOB_MONITOR_ALARM, { periodInMinutes: 1 });
}
async function monitorJobs() {
    const targets = await jobClient.listPollingTargets();
    if (targets.length === 0) {
        await restoreJobMonitor();
        return;
    }
    let badgeStatus = null;
    for (const target of targets) {
        const status = await jobClient.getStatus(target);
        if ((0,_shared_contracts_job_status__WEBPACK_IMPORTED_MODULE_1__.shouldPollJob)(status)) {
            badgeStatus = status;
        }
        else if (status.status === 'ready' || status.status === 'failed') {
            await notifyTerminalStatus(status);
            await refreshReadyManifest(status);
        }
    }
    await setJobBadge(badgeStatus);
    await restoreJobMonitor();
}
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === JOB_MONITOR_ALARM) {
        void monitorJobs();
    }
});
chrome.commands.onCommand.addListener((command, tab) => {
    void (async () => {
        const activeTab = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        if (!activeTab) {
            return;
        }
        if (command === 'announce-progress') {
            await openSidePanel(activeTab);
            await queueProgressAnnouncement(activeTab);
        }
        else if (command === 'announce-current-video-time') {
            await announcePlaybackPosition(activeTab);
        }
        else if (command === 'toggle-audio-description') {
            await toggleDescription(activeTab);
        }
    })();
});
async function ensureOffscreenDocument() {
    const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [documentUrl],
    });
    if (contexts.length > 0) {
        return;
    }
    if (!creatingOffscreenDocument) {
        creatingOffscreenDocument = chrome.offscreen
            .createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ['AUDIO_PLAYBACK'],
            justification: '화면해설 음성 클립을 영상과 동기화해 재생합니다.',
        })
            .finally(() => {
            creatingOffscreenDocument = null;
        });
    }
    await creatingOffscreenDocument;
}
function resolveAudioUrl(audioPath) {
    const url = new URL(audioPath, _shared_config_constants__WEBPACK_IMPORTED_MODULE_6__.API_BASE_URL);
    if (url.origin !== BACKEND_ORIGIN ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== '' ||
        !/^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(url.pathname)) {
        throw new Error('Invalid audio path');
    }
    return url.toString();
}
function isYouTubeUrl(value) {
    if (!value) {
        return false;
    }
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' &&
            (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')));
    }
    catch {
        return false;
    }
}
async function isTrustedAudioSender(sender) {
    if (sender.tab?.id === undefined || !isYouTubeUrl(sender.url ?? sender.tab.url)) {
        return false;
    }
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return activeTab?.id === sender.tab.id;
}
async function playAudio(message, sender) {
    try {
        if (!(await isTrustedAudioSender(sender))) {
            return { ok: false, request_id: message.request_id, error: 'invalid_request' };
        }
        await ensureOffscreenDocument();
        const command = {
            type: 'OFFSCREEN_AUDIO_PLAY',
            request_id: message.request_id,
            manifest_id: message.manifest_id,
            segment_id: message.segment_id,
            audio_url: resolveAudioUrl(message.audio_path),
            expected_duration_ms: message.expected_duration_ms,
            playback_rate: message.playback_rate,
            volume: message.volume,
        };
        return (await chrome.runtime.sendMessage(command));
    }
    catch {
        return { ok: false, request_id: message.request_id, error: 'play_failed' };
    }
}
async function stopAudio(message) {
    const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [documentUrl],
    });
    if (contexts.length === 0) {
        return { ok: true };
    }
    const command = {
        type: 'OFFSCREEN_AUDIO_STOP',
        ...(message.request_id ? { request_id: message.request_id } : {}),
    };
    await chrome.runtime.sendMessage(command);
    return { ok: true };
}
chrome.tabs.onActivated.addListener(() => {
    void stopAudio({ type: 'AUDIO_ENGINE_STOP' });
});
chrome.windows.onFocusChanged.addListener(() => {
    void stopAudio({ type: 'AUDIO_ENGINE_STOP' });
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!(0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isExtensionMessage)(message)) {
        return false;
    }
    if (message.type === 'PANEL_VISIBILITY_CHANGED') {
        void speakShortcut((0,_shared_accessibility_shortcut_speech__WEBPACK_IMPORTED_MODULE_4__.panelVisibilitySpeech)(message.visible)).then((spoken) => {
            sendResponse({ ok: true, spoken });
        });
        return true;
    }
    if (message.type === 'RUNTIME_STATUS_GET') {
        const response = {
            ok: true,
            schemaVersion: _shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_5__.SUPPORTED_SCHEMA_VERSION,
            extensionVersion: chrome.runtime.getManifest().version,
        };
        sendResponse(response);
        return false;
    }
    if (message.type === 'AUDIO_ENGINE_PING') {
        void ensureOffscreenDocument()
            .then(() => sendResponse({ ok: true }))
            .catch(() => sendResponse({ ok: false }));
        return true;
    }
    if (message.type === 'AUDIO_ENGINE_PLAY') {
        void playAudio(message, sender).then(sendResponse);
        return true;
    }
    if (message.type === 'AUDIO_ENGINE_STOP') {
        void stopAudio(message).then(sendResponse);
        return true;
    }
    if (message.type === 'JOB_STATUS_GET') {
        void jobClient.getStatus(message).then((status) => {
            void setJobBadge(status);
            void refreshReadyManifest(status);
            sendResponse(status);
        });
        return true;
    }
    if (message.type === 'JOB_CREATE') {
        void jobClient.create(message).then((status) => {
            void setJobBadge(status);
            void restoreJobMonitor();
            void refreshReadyManifest(status);
            sendResponse(status);
        });
        return true;
    }
    if (message.type === 'MANIFEST_GET') {
        void jobClient.getManifest(message).then(sendResponse);
        return true;
    }
    return false;
});

})();

/******/ })()
;
//# sourceMappingURL=background.js.map