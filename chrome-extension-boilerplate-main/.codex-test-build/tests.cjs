/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/background/job-client.test.ts"
/*!*******************************************!*\
  !*** ./src/background/job-client.test.ts ***!
  \*******************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   runJobClientTests: () => (/* binding */ runJobClientTests)
/* harmony export */ });
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../../fixtures/manifest-v1.1.valid.json */ "./fixtures/manifest-v1.1.valid.json");
/* harmony import */ var _job_client__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./job-client */ "./src/background/job-client.ts");



function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
async function runJobClientTests() {
    const runtime = globalThis;
    const originalChrome = runtime.chrome;
    const originalFetch = globalThis.fetch;
    const storage = {};
    let fetchHandler = () => jsonResponse({}, 500);
    runtime.chrome = {
        storage: {
            local: {
                get: async (key) => ({ [key]: storage[key] }),
                set: async (items) => {
                    Object.assign(storage, items);
                },
            },
        },
    };
    globalThis.fetch = (async (input, init) => fetchHandler(String(input), init));
    try {
        const client = new _job_client__WEBPACK_IMPORTED_MODULE_2__.JobClient('http://127.0.0.1:5000');
        const target = {
            provider: 'youtube',
            video_id: 'dQw4w9WgXcQ',
            duration_ms: 213061,
        };
        fetchHandler = () => jsonResponse(_fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_1__);
        const ready = await client.getManifest(target);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(ready.status, 'ready');
        if (ready.status === 'ready') {
            node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(ready.manifest.manifest_id, _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_1__.manifest_id);
        }
        const durationMismatch = await client.getManifest({ ...target, duration_ms: 220000 });
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(durationMismatch, {
            status: 'unavailable',
            video_key: 'youtube:dQw4w9WgXcQ',
            reason: 'invalid_response',
        });
        fetchHandler = () => jsonResponse({
            status: 'processing',
            job_id: '0123456789abcdef0123456789abcdef',
            video_key: 'youtube:dQw4w9WgXcQ',
            stage: 'visual_analysis',
            progress_percent: 45,
            eta_seconds: null,
            eta_confidence: null,
            retry_after_ms: 1500,
            updated_at: '2026-08-18T12:00:00Z',
        }, 202);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(await client.getManifest(target), {
            status: 'pending',
            video_key: 'youtube:dQw4w9WgXcQ',
            retry_after_ms: 1500,
        });
        let postedBody = null;
        fetchHandler = (_url, init) => {
            postedBody = JSON.parse(String(init?.body));
            return jsonResponse({
                status: 'queued',
                job_id: 'fedcba9876543210fedcba9876543210',
                video_key: 'youtube:dQw4w9WgXcQ',
                stage: 'queued',
                progress_percent: 0,
                eta_seconds: null,
                eta_confidence: null,
                retry_after_ms: 1500,
                updated_at: '2026-08-18T12:00:00Z',
            }, 202);
        };
        const messageTarget = { type: 'JOB_CREATE', ...target };
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((await client.create(messageTarget)).status, 'queued');
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(postedBody, target);
        fetchHandler = () => jsonResponse({
            error: {
                code: 'MEDIA_MISMATCH',
                message: '영상 길이가 일치하지 않습니다.',
                retryable: false,
            },
        }, 409);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(await client.create(target), {
            status: 'unavailable',
            video_key: 'youtube:dQw4w9WgXcQ',
            reason: 'invalid_response',
        });
        console.log('job API client tests passed');
    }
    finally {
        globalThis.fetch = originalFetch;
        if (originalChrome === undefined) {
            Reflect.deleteProperty(runtime, 'chrome');
        }
        else {
            runtime.chrome = originalChrome;
        }
    }
}


/***/ },

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

/***/ "./src/content/playback/playback-coordinator.test.ts"
/*!***********************************************************!*\
  !*** ./src/content/playback/playback-coordinator.test.ts ***!
  \***********************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   runPlaybackCoordinatorTests: () => (/* binding */ runPlaybackCoordinatorTests)
/* harmony export */ });
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../../../fixtures/manifest-v1.1.valid.json */ "./fixtures/manifest-v1.1.valid.json");
/* harmony import */ var _shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../../shared/contracts/manifest */ "./src/shared/contracts/manifest.ts");
/* harmony import */ var _playback_coordinator__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./playback-coordinator */ "./src/content/playback/playback-coordinator.ts");




const manifest = (0,_shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_2__.parseManifestV1_1)(_fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_1__);
class FakePlayer {
    context = {
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
    volumeCalls = [];
    pauseCalls = 0;
    playCalls = 0;
    getContext() {
        return this.context;
    }
    async play() {
        this.playCalls += 1;
        this.context.state = 'playing';
        return true;
    }
    pause() {
        this.pauseCalls += 1;
        this.context.state = 'paused';
        return true;
    }
    setVolume(volume) {
        this.volumeCalls.push(volume);
        this.context.volume = volume;
        return true;
    }
}
class ImmediateAudioGateway {
    succeeds;
    stopCalls = [];
    playCalls = [];
    constructor(succeeds = true) {
        this.succeeds = succeeds;
    }
    async play(input) {
        this.playCalls.push(input);
        return this.succeeds
            ? { ok: true, request_id: input.request_id, elapsed_ms: input.expected_duration_ms }
            : { ok: false, request_id: input.request_id, error: 'play_failed' };
    }
    async stop(requestId) {
        this.stopCalls.push(requestId);
    }
}
class DeferredAudioGateway {
    stopCalls = [];
    resolvePlay = null;
    requestId = '';
    play(input) {
        this.requestId = input.request_id;
        return new Promise((resolve) => {
            this.resolvePlay = resolve;
        });
    }
    async stop(requestId) {
        this.stopCalls.push(requestId);
    }
    resolveSuccess() {
        this.resolvePlay?.({ ok: true, request_id: this.requestId, elapsed_ms: 3000 });
    }
    resolveCancelled() {
        this.resolvePlay?.({ ok: false, request_id: this.requestId, error: 'cancelled' });
    }
}
async function runPlaybackCoordinatorTests() {
    {
        const player = new FakePlayer();
        const audio = new ImmediateAudioGateway();
        const coordinator = new _playback_coordinator__WEBPACK_IMPORTED_MODULE_3__.PlaybackCoordinator(player, audio);
        await coordinator.playSegment(manifest.manifest_id, manifest.segments[0], manifest.playback.duck_factor, 1, 0.6);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.volumeCalls.length, 2);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().ok(Math.abs(player.volumeCalls[0] - 0.28) < 0.0001);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.volumeCalls[1], 0.8);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(audio.playCalls[0].volume, 0.6);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(coordinator.getStatus().audio_state, 'idle');
    }
    {
        const player = new FakePlayer();
        const coordinator = new _playback_coordinator__WEBPACK_IMPORTED_MODULE_3__.PlaybackCoordinator(player, new ImmediateAudioGateway());
        await coordinator.playSegment(manifest.manifest_id, manifest.segments[1], manifest.playback.duck_factor, 1, 1);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.pauseCalls, 1);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.playCalls, 1);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.context.state, 'playing');
    }
    {
        const player = new FakePlayer();
        const audio = new DeferredAudioGateway();
        const coordinator = new _playback_coordinator__WEBPACK_IMPORTED_MODULE_3__.PlaybackCoordinator(player, audio);
        const playback = coordinator.playSegment(manifest.manifest_id, manifest.segments[0], manifest.playback.duck_factor, 1, 1);
        await Promise.resolve();
        player.context.volume = 0.5;
        coordinator.handlePlayerContext(player.context, 'volumechange');
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.volumeCalls.at(-1), 0.175);
        audio.resolveSuccess();
        await playback;
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.volumeCalls.at(-1), 0.5);
    }
    {
        const player = new FakePlayer();
        const audio = new DeferredAudioGateway();
        const coordinator = new _playback_coordinator__WEBPACK_IMPORTED_MODULE_3__.PlaybackCoordinator(player, audio);
        const playback = coordinator.playSegment(manifest.manifest_id, manifest.segments[1], manifest.playback.duck_factor, 1, 1);
        await Promise.resolve();
        coordinator.handlePlayerContext(player.context, 'seeking');
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(audio.stopCalls.length, 1);
        audio.resolveCancelled();
        await playback;
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.playCalls, 0);
    }
    {
        const player = new FakePlayer();
        const audio = new DeferredAudioGateway();
        const coordinator = new _playback_coordinator__WEBPACK_IMPORTED_MODULE_3__.PlaybackCoordinator(player, audio);
        const playback = coordinator.playSegment(manifest.manifest_id, manifest.segments[1], manifest.playback.duck_factor, 1, 1);
        await Promise.resolve();
        coordinator.cancel('disabled', true);
        audio.resolveCancelled();
        await playback;
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.playCalls, 1);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.context.state, 'playing');
    }
    {
        const player = new FakePlayer();
        const coordinator = new _playback_coordinator__WEBPACK_IMPORTED_MODULE_3__.PlaybackCoordinator(player, new ImmediateAudioGateway(false));
        await coordinator.playSegment(manifest.manifest_id, manifest.segments[1], manifest.playback.duck_factor, 1, 1);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(player.playCalls, 1);
        node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(coordinator.getStatus().audio_state, 'error');
    }
    console.log('playback coordinator tests passed');
}


/***/ },

/***/ "./src/content/playback/playback-coordinator.ts"
/*!******************************************************!*\
  !*** ./src/content/playback/playback-coordinator.ts ***!
  \******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   PlaybackCoordinator: () => (/* binding */ PlaybackCoordinator)
/* harmony export */ });
const VOLUME_EPSILON = 0.005;
class PlaybackCoordinator {
    player;
    audio;
    active = null;
    audioState = 'idle';
    requestSequence = 0;
    constructor(player, audio) {
        this.player = player;
        this.audio = audio;
    }
    async playSegment(manifestId, segment, duckFactor, playbackRate, descriptionVolume) {
        this.cancel('superseded');
        const context = this.player.getContext();
        if (!context.available || context.state !== 'playing') {
            return;
        }
        const requestId = `${segment.id}:${Date.now()}:${this.requestSequence++}`;
        const active = {
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
        }
        else if (!this.player.pause()) {
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
        }
        catch {
            response = { ok: false, request_id: requestId, error: 'play_failed' };
        }
        if (this.active?.requestId !== requestId) {
            return;
        }
        await this.finish(active, response.request_id === requestId && response.ok);
    }
    handlePlayerContext(context, reason) {
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
            }
            else {
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
    cancel(_reason, resumeExtended = false) {
        const active = this.active;
        if (!active) {
            return;
        }
        this.active = null;
        this.audioState = 'idle';
        if (active.segment.mode === 'overlay') {
            this.player.setVolume(active.userVolume);
        }
        else if (resumeExtended) {
            const context = this.player.getContext();
            if (active.wasPlaying &&
                context.available &&
                context.video_key === active.videoKey &&
                context.state === 'paused') {
                void this.player.play().then((resumed) => {
                    if (!resumed) {
                        this.audioState = 'error';
                    }
                });
            }
        }
        void this.audio.stop(active.requestId).catch(() => undefined);
    }
    getStatus() {
        return {
            audio_state: this.audioState,
            active_segment_id: this.active?.segment.id ?? null,
            active_segment_text: this.active?.segment.text ?? null,
            active_mode: this.active?.segment.mode ?? null,
        };
    }
    cancelExtended(reason) {
        if (this.active?.segment.mode === 'extended') {
            this.cancel(reason, true);
        }
    }
    handleVolumeChange(active, reportedVolume) {
        if (active.expectedVolume !== null &&
            Math.abs(reportedVolume - active.expectedVolume) <= VOLUME_EPSILON) {
            return;
        }
        active.userVolume = reportedVolume;
        active.expectedVolume = reportedVolume * active.duckFactor;
        this.player.setVolume(active.expectedVolume);
    }
    failBeforePlayback(active) {
        if (this.active?.requestId !== active.requestId) {
            return;
        }
        this.active = null;
        this.audioState = 'error';
        if (active.segment.mode === 'overlay') {
            this.player.setVolume(active.userVolume);
        }
    }
    async finish(active, succeeded) {
        this.active = null;
        this.audioState = succeeded ? 'idle' : 'error';
        if (active.segment.mode === 'overlay') {
            this.player.setVolume(active.userVolume);
            return;
        }
        const context = this.player.getContext();
        if (active.wasPlaying &&
            context.available &&
            context.video_key === active.videoKey &&
            context.state === 'paused') {
            const resumed = await this.player.play();
            if (!resumed) {
                this.audioState = 'error';
            }
        }
    }
}


/***/ },

/***/ "./src/content/player/html5-player-adapter.test.ts"
/*!*********************************************************!*\
  !*** ./src/content/player/html5-player-adapter.test.ts ***!
  \*********************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _html5_player_adapter__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./html5-player-adapter */ "./src/content/player/html5-player-adapter.ts");


class FakeVideoElement extends EventTarget {
    currentTime = 12.345;
    duration = 90.5;
    playbackRate = 1.25;
    volume = 0.8;
    muted = false;
    paused = false;
    ended = false;
    pauseCalls = 0;
    async play() {
        this.paused = false;
    }
    pause() {
        this.pauseCalls += 1;
        this.paused = true;
    }
}
const fakeVideo = new FakeVideoElement();
const adapter = new _html5_player_adapter__WEBPACK_IMPORTED_MODULE_1__.Html5PlayerAdapter(fakeVideo);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(adapter.getSnapshot(), {
    currentTimeMs: 12345,
    durationMs: 90500,
    playbackRate: 1.25,
    volume: 0.8,
    muted: false,
    state: 'playing',
});
const receivedEvents = [];
const unsubscribe = adapter.subscribe((event) => {
    receivedEvents.push(event.type);
});
fakeVideo.dispatchEvent(new Event('seeking'));
fakeVideo.dispatchEvent(new Event('ratechange'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(receivedEvents, ['seeking', 'ratechange']);
adapter.setVolume(2);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(fakeVideo.volume, 1);
adapter.setVolume(-1);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(fakeVideo.volume, 0);
adapter.pause();
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(fakeVideo.pauseCalls, 1);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(adapter.getSnapshot().state, 'paused');
unsubscribe();
fakeVideo.dispatchEvent(new Event('seeked'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(receivedEvents, ['seeking', 'ratechange']);
adapter.destroy();
console.log('HTML5 player adapter tests passed');


/***/ },

/***/ "./src/content/player/html5-player-adapter.ts"
/*!****************************************************!*\
  !*** ./src/content/player/html5-player-adapter.ts ***!
  \****************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Html5PlayerAdapter: () => (/* binding */ Html5PlayerAdapter)
/* harmony export */ });
const MEDIA_EVENTS = [
    'play',
    'pause',
    'ended',
    'seeking',
    'seeked',
    'ratechange',
    'volumechange',
    'loadedmetadata',
    'durationchange',
    'timeupdate',
];
function secondsToMilliseconds(value) {
    if (!Number.isFinite(value) || value < 0) {
        return 0;
    }
    return Math.round(value * 1000);
}
function durationToMilliseconds(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.round(value * 1000);
}
function clampVolume(value) {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.min(1, Math.max(0, value));
}
class Html5PlayerAdapter {
    element;
    listeners = new Set();
    handleMediaEvent = (event) => {
        const playerEvent = {
            type: event.type,
            snapshot: this.getSnapshot(),
        };
        for (const listener of this.listeners) {
            listener(playerEvent);
        }
    };
    constructor(element) {
        this.element = element;
        for (const eventName of MEDIA_EVENTS) {
            this.element.addEventListener(eventName, this.handleMediaEvent);
        }
    }
    getSnapshot() {
        const playbackRate = Number.isFinite(this.element.playbackRate) && this.element.playbackRate > 0
            ? this.element.playbackRate
            : 1;
        return {
            currentTimeMs: secondsToMilliseconds(this.element.currentTime),
            durationMs: durationToMilliseconds(this.element.duration),
            playbackRate,
            volume: clampVolume(this.element.volume),
            muted: this.element.muted,
            state: this.element.ended ? 'ended' : this.element.paused ? 'paused' : 'playing',
        };
    }
    async play() {
        await this.element.play();
    }
    pause() {
        this.element.pause();
    }
    setVolume(volume) {
        this.element.volume = clampVolume(volume);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    destroy() {
        this.listeners.clear();
        for (const eventName of MEDIA_EVENTS) {
            this.element.removeEventListener(eventName, this.handleMediaEvent);
        }
    }
}


/***/ },

/***/ "./src/content/scheduler/description-scheduler.test.ts"
/*!*************************************************************!*\
  !*** ./src/content/scheduler/description-scheduler.test.ts ***!
  \*************************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../../../fixtures/manifest-v1.1.valid.json */ "./fixtures/manifest-v1.1.valid.json");
/* harmony import */ var _shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../../shared/contracts/manifest */ "./src/shared/contracts/manifest.ts");
/* harmony import */ var _description_scheduler__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./description-scheduler */ "./src/content/scheduler/description-scheduler.ts");




const manifest = (0,_shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_2__.parseManifestV1_1)(_fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_1__);
function createScheduler(currentTimeMs = 0) {
    const scheduler = new _description_scheduler__WEBPACK_IMPORTED_MODULE_3__.DescriptionScheduler();
    scheduler.load(manifest, currentTimeMs);
    scheduler.setPlaying(true);
    return scheduler;
}
{
    const scheduler = createScheduler();
    const events = scheduler.tick(12400);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events.length, 1);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events[0].type, 'trigger');
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events[0].segment.id, 'seg-001');
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(scheduler.tick(12400), []);
}
{
    const scheduler = createScheduler();
    const events = scheduler.tick(12651);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events.length, 1);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events[0].type, 'skip');
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events[0].type === 'skip' ? events[0].reason : null, 'late');
}
{
    const scheduler = createScheduler();
    scheduler.setPlaying(false);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(scheduler.tick(12400), []);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(scheduler.getSnapshot()?.handled_segments, 0);
}
{
    const scheduler = createScheduler();
    const events = scheduler.seek(20000);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events.length, 1);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events[0].type === 'skip' ? events[0].reason : null, 'seek');
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(scheduler.getSnapshot()?.next_segment_id, 'seg-002');
}
{
    const scheduler = createScheduler();
    scheduler.tick(12400);
    scheduler.seek(5000);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(scheduler.tick(12400), []);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(scheduler.getSnapshot()?.handled_segments, 1);
}
{
    const scheduler = createScheduler();
    scheduler.seek(32800);
    const events = scheduler.tick(32800);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events.length, 1);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(events[0].segment.mode, 'extended');
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual(scheduler.tick(32800), []);
}
{
    const scheduler = createScheduler(20000);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(scheduler.getSnapshot()?.handled_segments, 1);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(scheduler.getSnapshot()?.next_segment_id, 'seg-002');
}
console.log('description scheduler tests passed');


/***/ },

/***/ "./src/content/scheduler/description-scheduler.ts"
/*!********************************************************!*\
  !*** ./src/content/scheduler/description-scheduler.ts ***!
  \********************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   DescriptionScheduler: () => (/* binding */ DescriptionScheduler)
/* harmony export */ });
class DescriptionScheduler {
    manifest = null;
    handledSegmentIds = new Set();
    nextIndex = 0;
    playing = false;
    lastEvent = null;
    load(manifest, currentTimeMs) {
        this.manifest = manifest;
        this.handledSegmentIds.clear();
        this.lastEvent = null;
        this.playing = false;
        const firstCurrentIndex = this.findFirstTriggerAtOrAfter(currentTimeMs);
        for (let index = 0; index < firstCurrentIndex; index += 1) {
            this.handledSegmentIds.add(manifest.segments[index].id);
        }
        this.nextIndex = firstCurrentIndex;
    }
    unload() {
        this.manifest = null;
        this.handledSegmentIds.clear();
        this.nextIndex = 0;
        this.playing = false;
        this.lastEvent = null;
    }
    setPlaying(playing) {
        this.playing = playing;
    }
    tick(currentTimeMs) {
        if (!this.manifest || !this.playing) {
            return [];
        }
        const events = [];
        while (this.nextIndex < this.manifest.segments.length) {
            const segment = this.manifest.segments[this.nextIndex];
            if (segment.trigger_ms > currentTimeMs) {
                break;
            }
            if (this.handledSegmentIds.has(segment.id)) {
                this.nextIndex += 1;
                continue;
            }
            const event = currentTimeMs <= segment.trigger_ms + this.manifest.playback.late_tolerance_ms
                ? this.createTrigger(segment, currentTimeMs)
                : this.createSkip(segment, currentTimeMs, 'late');
            events.push(event);
            this.markHandled(event);
        }
        return events;
    }
    seek(currentTimeMs) {
        if (!this.manifest) {
            return [];
        }
        const events = [];
        for (const segment of this.manifest.segments) {
            if (segment.trigger_ms >= currentTimeMs) {
                break;
            }
            if (this.handledSegmentIds.has(segment.id)) {
                continue;
            }
            const event = this.createSkip(segment, currentTimeMs, 'seek');
            events.push(event);
            this.markHandled(event, false);
        }
        this.nextIndex = this.findNextUnhandledIndex();
        return events;
    }
    getSnapshot() {
        if (!this.manifest) {
            return null;
        }
        const nextSegment = this.manifest.segments[this.findNextUnhandledIndex()] ?? null;
        return {
            manifest_id: this.manifest.manifest_id,
            revision: this.manifest.revision,
            total_segments: this.manifest.segments.length,
            handled_segments: this.handledSegmentIds.size,
            next_segment_id: nextSegment?.id ?? null,
            next_trigger_ms: nextSegment?.trigger_ms ?? null,
            last_event: this.lastEvent,
        };
    }
    findFirstTriggerAtOrAfter(currentTimeMs) {
        const segments = this.manifest?.segments ?? [];
        let low = 0;
        let high = segments.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (segments[middle].trigger_ms < currentTimeMs) {
                low = middle + 1;
            }
            else {
                high = middle;
            }
        }
        return low;
    }
    findNextUnhandledIndex() {
        if (!this.manifest) {
            return 0;
        }
        const index = this.manifest.segments.findIndex((segment) => !this.handledSegmentIds.has(segment.id));
        return index === -1 ? this.manifest.segments.length : index;
    }
    createTrigger(segment, atMs) {
        return { type: 'trigger', segment, atMs };
    }
    createSkip(segment, atMs, reason) {
        return { type: 'skip', segment, atMs, reason };
    }
    markHandled(event, advanceIndex = true) {
        this.handledSegmentIds.add(event.segment.id);
        this.lastEvent = {
            type: event.type,
            segment_id: event.segment.id,
            mode: event.segment.mode,
            at_ms: event.atMs,
            ...(event.type === 'skip' ? { reason: event.reason } : {}),
        };
        if (advanceIndex) {
            this.nextIndex += 1;
        }
    }
}


/***/ },

/***/ "./src/content/video-identifier/youtube.test.ts"
/*!******************************************************!*\
  !*** ./src/content/video-identifier/youtube.test.ts ***!
  \******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _youtube__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./youtube */ "./src/content/video-identifier/youtube.ts");


const videoId = 'dQw4w9WgXcQ';
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)(`https://www.youtube.com/watch?v=${videoId}`), videoId);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)(`https://m.youtube.com/shorts/${videoId}`), videoId);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)(`https://www.youtube.com/embed/${videoId}`), videoId);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)(`https://www.youtube.com/live/${videoId}`), videoId);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)('https://www.youtube.com/'), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)('https://example.com/watch?v=dQw4w9WgXcQ'), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)('https://www.youtube.com/watch?v=too-short'), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.extractYouTubeVideoId)('not-a-url'), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual((0,_youtube__WEBPACK_IMPORTED_MODULE_1__.identifyYouTubeVideo)(`https://www.youtube.com/watch?v=${videoId}`), {
    provider: 'youtube',
    videoId,
    videoKey: `youtube:${videoId}`,
});
console.log('YouTube video identifier tests passed');


/***/ },

/***/ "./src/content/video-identifier/youtube.ts"
/*!*************************************************!*\
  !*** ./src/content/video-identifier/youtube.ts ***!
  \*************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   YOUTUBE_PROVIDER: () => (/* binding */ YOUTUBE_PROVIDER),
/* harmony export */   extractYouTubeVideoId: () => (/* binding */ extractYouTubeVideoId),
/* harmony export */   identifyYouTubeVideo: () => (/* binding */ identifyYouTubeVideo)
/* harmony export */ });
const YOUTUBE_PROVIDER = 'youtube';
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = new Set(['embed', 'live', 'shorts']);
function isYouTubeHost(hostname) {
    const host = hostname.toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com');
}
function validVideoId(value) {
    return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}
function extractYouTubeVideoId(input) {
    let url;
    try {
        url = input instanceof URL ? input : new URL(input);
    }
    catch {
        return null;
    }
    if (!isYouTubeHost(url.hostname)) {
        return null;
    }
    const queryVideoId = url.searchParams.get('v');
    if (url.pathname === '/watch' && validVideoId(queryVideoId)) {
        return queryVideoId;
    }
    const pathSegments = url.pathname.split('/').filter(Boolean);
    if (pathSegments.length >= 2 && PATH_PREFIXES.has(pathSegments[0])) {
        const pathVideoId = pathSegments[1];
        return validVideoId(pathVideoId) ? pathVideoId : null;
    }
    return null;
}
function identifyYouTubeVideo(input) {
    const videoId = extractYouTubeVideoId(input);
    if (!videoId) {
        return null;
    }
    return {
        provider: YOUTUBE_PROVIDER,
        videoId,
        videoKey: `${YOUTUBE_PROVIDER}:${videoId}`,
    };
}


/***/ },

/***/ "./src/shared/accessibility/announcements.test.ts"
/*!********************************************************!*\
  !*** ./src/shared/accessibility/announcements.test.ts ***!
  \********************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _announcements__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./announcements */ "./src/shared/accessibility/announcements.ts");


node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_announcements__WEBPACK_IMPORTED_MODULE_1__.playbackPositionAnnouncement)({
    current_time_ms: 135000,
    duration_ms: 600000,
    state: 'playing',
}), '재생 중. 현재 2분 15초, 남은 시간 7분 45초, 전체 10분입니다.');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_announcements__WEBPACK_IMPORTED_MODULE_1__.playbackPositionAnnouncement)({
    current_time_ms: 5000,
    duration_ms: null,
    state: 'paused',
}), '일시정지 상태. 현재 5초 지났습니다.');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_announcements__WEBPACK_IMPORTED_MODULE_1__.isPendingAccessibilityAnnouncement)({
    id: 'request-1',
    text: '화면해설을 켰습니다.',
    requested_at: Date.now(),
    urgency: 'polite',
    tone: 'toggle-on',
    speech_handled: true,
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_announcements__WEBPACK_IMPORTED_MODULE_1__.isPendingAccessibilityAnnouncement)({
    id: 'request-1',
    text: '',
    requested_at: Date.now(),
    urgency: 'polite',
    tone: 'toggle-on',
    speech_handled: false,
}), false);
console.log('accessibility announcement tests passed');


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

/***/ "./src/shared/accessibility/shortcut-speech.test.ts"
/*!**********************************************************!*\
  !*** ./src/shared/accessibility/shortcut-speech.test.ts ***!
  \**********************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _shortcut_speech__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./shortcut-speech */ "./src/shared/accessibility/shortcut-speech.ts");


node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_shortcut_speech__WEBPACK_IMPORTED_MODULE_1__.jobStatusSpeech)({
    status: 'processing',
    job_id: 'job-1',
    video_key: 'youtube:dQw4w9WgXcQ',
    progress_percent: 50,
    eta_seconds: 120,
    eta_confidence: 'medium',
    retry_after_ms: 3000,
    updated_at: '2026-08-18T00:00:00.000Z',
    stage: 'visual_analysis',
}), '화면해설 생성 50퍼센트 완료. 화면 글자와 장면 분석 중. 약 2분 남았습니다.');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_shortcut_speech__WEBPACK_IMPORTED_MODULE_1__.jobStatusSpeech)({
    status: 'not_started',
    video_key: 'youtube:dQw4w9WgXcQ',
}), '이 영상은 아직 화면해설이 없습니다.');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().match((0,_shortcut_speech__WEBPACK_IMPORTED_MODULE_1__.panelVisibilitySpeech)(true), /열렸습니다/);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().match((0,_shortcut_speech__WEBPACK_IMPORTED_MODULE_1__.panelVisibilitySpeech)(false), /닫혔습니다/);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_shortcut_speech__WEBPACK_IMPORTED_MODULE_1__.shouldCreateJobFromShortcut)({
    status: 'not_started',
    video_key: 'youtube:dQw4w9WgXcQ',
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_shortcut_speech__WEBPACK_IMPORTED_MODULE_1__.shouldCreateJobFromShortcut)({
    status: 'unavailable',
    video_key: 'youtube:dQw4w9WgXcQ',
    reason: 'network',
}), false);
console.log('shortcut speech tests passed');


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

/***/ "./src/shared/contracts/demo-audio.test.ts"
/*!*************************************************!*\
  !*** ./src/shared/contracts/demo-audio.test.ts ***!
  \*************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var node_crypto__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! node:crypto */ "node:crypto");
/* harmony import */ var node_crypto__WEBPACK_IMPORTED_MODULE_1___default = /*#__PURE__*/__webpack_require__.n(node_crypto__WEBPACK_IMPORTED_MODULE_1__);
/* harmony import */ var node_fs__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! node:fs */ "node:fs");
/* harmony import */ var node_fs__WEBPACK_IMPORTED_MODULE_2___default = /*#__PURE__*/__webpack_require__.n(node_fs__WEBPACK_IMPORTED_MODULE_2__);
/* harmony import */ var node_path__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! node:path */ "node:path");
/* harmony import */ var node_path__WEBPACK_IMPORTED_MODULE_3___default = /*#__PURE__*/__webpack_require__.n(node_path__WEBPACK_IMPORTED_MODULE_3__);
/* harmony import */ var _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ../../../fixtures/manifest-v1.1.valid.json */ "./fixtures/manifest-v1.1.valid.json");
/* harmony import */ var _manifest__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./manifest */ "./src/shared/contracts/manifest.ts");






function getWavDurationMs(buffer) {
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= buffer.length) {
        const chunkId = buffer.toString('ascii', offset, offset + 4);
        const chunkSize = buffer.readUInt32LE(offset + 4);
        if (chunkId === 'fmt ') {
            byteRate = buffer.readUInt32LE(offset + 16);
        }
        if (chunkId === 'data') {
            dataSize = chunkSize;
            break;
        }
        offset += 8 + chunkSize + (chunkSize % 2);
    }
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().ok(byteRate > 0 && dataSize > 0, 'valid WAV chunks expected');
    return Math.round((dataSize / byteRate) * 1000);
}
const manifest = (0,_manifest__WEBPACK_IMPORTED_MODULE_5__.parseManifestV1_1)(_fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_4__);
for (const segment of manifest.segments) {
    const audioFile = (0,node_path__WEBPACK_IMPORTED_MODULE_3__.resolve)('extension', 'demo-audio', `${segment.id}.wav`);
    const buffer = (0,node_fs__WEBPACK_IMPORTED_MODULE_2__.readFileSync)(audioFile);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(getWavDurationMs(buffer), segment.audio.duration_ms);
    node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,node_crypto__WEBPACK_IMPORTED_MODULE_1__.createHash)('sha256').update(buffer).digest('hex'), segment.audio.sha256);
}
console.log('demo audio fixture tests passed');


/***/ },

/***/ "./src/shared/contracts/job-status.test.ts"
/*!*************************************************!*\
  !*** ./src/shared/contracts/job-status.test.ts ***!
  \*************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _job_status__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./job-status */ "./src/shared/contracts/job-status.ts");


const processing = {
    status: 'processing',
    job_id: 'job-123',
    video_key: 'youtube:dQw4w9WgXcQ',
    stage: 'visual_analysis',
    progress_percent: 47,
    eta_seconds: 210,
    eta_confidence: 'medium',
    retry_after_ms: 3000,
    updated_at: '2026-08-18T18:30:00+09:00',
};
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isBackendJobStatus)(processing), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isJobStatus)(processing), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.shouldPollJob)(processing), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isBackendJobStatus)({ ...processing, progress_percent: 101 }), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isBackendJobStatus)({ ...processing, retry_after_ms: 300 }), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isBackendJobStatus)({ ...processing, stage: 'unknown' }), false);
const ready = {
    status: 'ready',
    job_id: 'job-123',
    video_key: 'youtube:dQw4w9WgXcQ',
    progress_percent: 100,
    manifest_id: 'youtube:dQw4w9WgXcQ:r3',
    revision: 3,
    updated_at: '2026-08-18T18:35:00+09:00',
};
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isBackendJobStatus)(ready), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.shouldPollJob)(ready), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.ensureMonotonicProgress)(52, { ...processing, progress_percent: 47 }).progress_percent, 52);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.ensureMonotonicProgress)(52, ready).progress_percent, 100);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isPendingProgressAnnouncement)({
    video_key: processing.video_key,
    requested_at: Date.now(),
    job: processing,
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isJobStatus)({ status: 'not_started', video_key: 'youtube:dQw4w9WgXcQ' }), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_status__WEBPACK_IMPORTED_MODULE_1__.isJobStatus)({ status: 'unavailable', video_key: null, reason: 'unsupported_page' }), true);
console.log('job status contract tests passed');


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

/***/ "./src/shared/contracts/manifest.test.ts"
/*!***********************************************!*\
  !*** ./src/shared/contracts/manifest.test.ts ***!
  \***********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _fixtures_manifest_v1_1_invalid_json__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../../../fixtures/manifest-v1.1.invalid.json */ "./fixtures/manifest-v1.1.invalid.json");
/* harmony import */ var _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../../../fixtures/manifest-v1.1.valid.json */ "./fixtures/manifest-v1.1.valid.json");
/* harmony import */ var _manifest__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./manifest */ "./src/shared/contracts/manifest.ts");




const manifest = (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)(_fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(manifest.schema_version, _manifest__WEBPACK_IMPORTED_MODULE_3__.SUPPORTED_SCHEMA_VERSION);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(manifest.segments.length, 2);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(manifest.segments[0].mode, 'overlay');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(manifest.segments[1].mode, 'extended');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().throws(() => (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)(_fixtures_manifest_v1_1_invalid_json__WEBPACK_IMPORTED_MODULE_1__), (error) => error instanceof _manifest__WEBPACK_IMPORTED_MODULE_3__.ManifestValidationError &&
    error.message.includes('audio exceeds the overlay window'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().throws(() => (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)({ ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__, schema_version: '1.0' }), (error) => error instanceof _manifest__WEBPACK_IMPORTED_MODULE_3__.ManifestValidationError && error.message.includes('unsupported version'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().throws(() => (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)({ ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__, manifest_id: 'youtube:other:r1' }), (error) => error instanceof _manifest__WEBPACK_IMPORTED_MODULE_3__.ManifestValidationError && error.message.includes('must match'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().throws(() => (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)({ ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__, revision: 0 }), (error) => error instanceof _manifest__WEBPACK_IMPORTED_MODULE_3__.ManifestValidationError && error.message.includes('revision'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().throws(() => (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)({
    ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__,
    voice: { ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__.voice, format: 'audio/mpeg' },
}), (error) => error instanceof _manifest__WEBPACK_IMPORTED_MODULE_3__.ManifestValidationError && error.message.includes('voice.format'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().throws(() => (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)({
    ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__,
    segments: [
        {
            ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__.segments[0],
            confidence: 'medium',
        },
    ],
}), (error) => error instanceof _manifest__WEBPACK_IMPORTED_MODULE_3__.ManifestValidationError && error.message.includes('confidence'));
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().throws(() => (0,_manifest__WEBPACK_IMPORTED_MODULE_3__.parseManifestV1_1)({
    ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__,
    segments: [
        {
            ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__.segments[0],
            audio: {
                ..._fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__.segments[0].audio,
                path: '/v1/audio/not-the-hash.wav',
            },
        },
    ],
}), (error) => error instanceof _manifest__WEBPACK_IMPORTED_MODULE_3__.ManifestValidationError && error.message.includes('must match'));
console.log('manifest v1.1 contract tests passed');


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

/***/ "./src/shared/contracts/messages.test.ts"
/*!***********************************************!*\
  !*** ./src/shared/contracts/messages.test.ts ***!
  \***********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _messages__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./messages */ "./src/shared/contracts/messages.ts");
/* harmony import */ var _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ../../../fixtures/manifest-v1.1.valid.json */ "./fixtures/manifest-v1.1.valid.json");



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
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isPlayerContext)(readyContext), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isPlayerContext)({ ...readyContext, video_key: 'youtube:other' }), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isPlayerContext)({ available: false, reason: 'unsupported_page' }), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isPlayerContext)({ available: false, reason: 'unknown' }), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({ type: 'PLAYER_CONTEXT_GET' }), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({ type: 'SCHEDULER_STATUS_GET' }), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({
    type: 'ACCESSIBILITY_ANNOUNCE',
    text: '현재 2분 지났습니다.',
    urgency: 'polite',
    tone: 'action',
    speech_handled: true,
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({
    type: 'MANIFEST_GET',
    provider: 'youtube',
    video_id: 'dQw4w9WgXcQ',
    duration_ms: 213061,
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({
    type: 'MANIFEST_REFRESH',
    video_key: 'youtube:dQw4w9WgXcQ',
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isManifestFetchResponse)({
    status: 'ready',
    video_key: 'youtube:dQw4w9WgXcQ',
    manifest: _fixtures_manifest_v1_1_valid_json__WEBPACK_IMPORTED_MODULE_2__,
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isManifestFetchResponse)({
    status: 'pending',
    video_key: 'youtube:dQw4w9WgXcQ',
    retry_after_ms: 1500,
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({
    type: 'ACCESSIBILITY_ANNOUNCE',
    text: '',
    urgency: 'polite',
    tone: 'action',
    speech_handled: false,
}), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({ type: 'PANEL_VISIBILITY_CHANGED', visible: true }), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({
    type: 'JOB_STATUS_GET',
    provider: 'youtube',
    video_id: 'dQw4w9WgXcQ',
    duration_ms: 90000,
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({
    type: 'JOB_CREATE',
    provider: 'youtube',
    video_id: 'invalid',
    duration_ms: 90000,
}), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)({ type: 'PLAYER_CONTEXT_UPDATED', payload: readyContext }), false);
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
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isSchedulerStatus)(schedulerStatus), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isSchedulerStatus)({
    active: false,
    enabled: true,
    audio_state: 'idle',
    active_segment_id: null,
    active_segment_text: null,
    active_mode: null,
    settings: schedulerStatus.settings,
    reason: 'no_manifest',
}), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isSchedulerStatus)({
    ...schedulerStatus,
    last_event: { ...schedulerStatus.last_event, type: 'skip' },
}), false);
const audioPlayRequest = {
    type: 'AUDIO_ENGINE_PLAY',
    request_id: 'seg-001:1',
    manifest_id: 'youtube:dQw4w9WgXcQ:r1',
    segment_id: 'seg-001',
    audio_path: '/v1/audio/89cc07fa802c26cdb0c4b6911e2de88fc49cfc34df99ba22330d62af7eb1b476.wav',
    expected_duration_ms: 3300,
    playback_rate: 1,
    volume: 1,
};
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isAudioEnginePlayRequest)(audioPlayRequest), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isExtensionMessage)(audioPlayRequest), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isAudioEnginePlayRequest)({ ...audioPlayRequest, audio_path: 'https://evil.test/a' }), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_messages__WEBPACK_IMPORTED_MODULE_1__.isAudioEnginePlayRequest)({ ...audioPlayRequest, playback_rate: 8 }), false);
console.log('extension message contract tests passed');


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

/***/ "./src/shared/settings/accessibility-settings.test.ts"
/*!************************************************************!*\
  !*** ./src/shared/settings/accessibility-settings.test.ts ***!
  \************************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _accessibility_settings__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./accessibility-settings */ "./src/shared/settings/accessibility-settings.ts");


node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual((0,_accessibility_settings__WEBPACK_IMPORTED_MODULE_1__.parseStoredAccessibilitySettings)(undefined), _accessibility_settings__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_ACCESSIBILITY_SETTINGS);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual((0,_accessibility_settings__WEBPACK_IMPORTED_MODULE_1__.parseStoredAccessibilitySettings)({
    interaction_sounds_enabled: false,
    interaction_sound_volume: 1,
    shortcut_speech_enabled: false,
}), {
    interaction_sounds_enabled: false,
    interaction_sound_volume: 1,
    shortcut_speech_enabled: false,
});
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual((0,_accessibility_settings__WEBPACK_IMPORTED_MODULE_1__.parseStoredAccessibilitySettings)({
    interaction_sounds_enabled: 'yes',
    interaction_sound_volume: 2,
    shortcut_speech_enabled: 'yes',
}), _accessibility_settings__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_ACCESSIBILITY_SETTINGS);
console.log('accessibility settings tests passed');


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

/***/ "./src/shared/settings/playback-settings.test.ts"
/*!*******************************************************!*\
  !*** ./src/shared/settings/playback-settings.test.ts ***!
  \*******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _playback_settings__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./playback-settings */ "./src/shared/settings/playback-settings.ts");


node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_playback_settings__WEBPACK_IMPORTED_MODULE_1__.isPlaybackSettings)(_playback_settings__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_PLAYBACK_SETTINGS), true);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_playback_settings__WEBPACK_IMPORTED_MODULE_1__.isPlaybackSettings)({ ..._playback_settings__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_PLAYBACK_SETTINGS, description_volume: 1.2 }), false);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual((0,_playback_settings__WEBPACK_IMPORTED_MODULE_1__.parseStoredPlaybackSettings)(null), _playback_settings__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_PLAYBACK_SETTINGS);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().deepEqual((0,_playback_settings__WEBPACK_IMPORTED_MODULE_1__.parseStoredPlaybackSettings)({
    enabled: false,
    description_volume: 0.7,
    duck_factor: 'invalid',
    auto_pause_enabled: false,
}), {
    enabled: false,
    description_volume: 0.7,
    duck_factor: _playback_settings__WEBPACK_IMPORTED_MODULE_1__.DEFAULT_PLAYBACK_SETTINGS.duck_factor,
    auto_pause_enabled: false,
});
console.log('playback settings tests passed');


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

/***/ "./src/sidepanel/feedback-sound.test.ts"
/*!**********************************************!*\
  !*** ./src/sidepanel/feedback-sound.test.ts ***!
  \**********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/accessibility/feedback-sound */ "./src/shared/accessibility/feedback-sound.ts");


node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('focus').length, 1);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('success').length, 3);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('error').length, 2);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().ok((0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('adjust', 1)[0].frequency >
    (0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('adjust', 0)[0].frequency);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().ok((0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('toggle-on')[1].frequency > (0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('toggle-on')[0].frequency);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().ok((0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('toggle-off')[1].frequency < (0,_shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_1__.feedbackTonePattern)('toggle-off')[0].frequency);
console.log('feedback sound tests passed');


/***/ },

/***/ "./src/sidepanel/job-progress.test.ts"
/*!********************************************!*\
  !*** ./src/sidepanel/job-progress.test.ts ***!
  \********************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! node:assert/strict */ "node:assert/strict");
/* harmony import */ var node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default = /*#__PURE__*/__webpack_require__.n(node_assert_strict__WEBPACK_IMPORTED_MODULE_0__);
/* harmony import */ var _job_progress__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./job-progress */ "./src/sidepanel/job-progress.ts");


function processing(progress, stage = 'visual_analysis', eta = 180) {
    return {
        status: 'processing',
        job_id: 'job-123',
        video_key: 'youtube:dQw4w9WgXcQ',
        stage,
        progress_percent: progress,
        eta_seconds: eta,
        eta_confidence: 'medium',
        retry_after_ms: 3000,
        updated_at: '2026-08-18T18:30:00+09:00',
    };
}
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_progress__WEBPACK_IMPORTED_MODULE_1__.formatEta)(null), '예상 시간 계산 중');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_progress__WEBPACK_IMPORTED_MODULE_1__.formatEta)(40), '약 1분 이내 남음');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_progress__WEBPACK_IMPORTED_MODULE_1__.formatEta)(181), '약 3분 남음');
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal((0,_job_progress__WEBPACK_IMPORTED_MODULE_1__.jobProgressView)(processing(47)).percent, 47);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().match((0,_job_progress__WEBPACK_IMPORTED_MODULE_1__.formatJobAnnouncement)(processing(47)), /47% 완료/);
const tracker = new _job_progress__WEBPACK_IMPORTED_MODULE_1__.JobAnnouncementTracker();
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().notEqual(tracker.next(processing(10)), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(tracker.next(processing(11)), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().notEqual(tracker.next(processing(25)), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().equal(tracker.next(processing(26)), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().notEqual(tracker.next(processing(26, 'speech_synthesis')), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().notEqual(tracker.next(processing(26, 'speech_synthesis'), true), null);
node_assert_strict__WEBPACK_IMPORTED_MODULE_0___default().notEqual(tracker.next({
    status: 'ready',
    job_id: 'job-123',
    video_key: 'youtube:dQw4w9WgXcQ',
    progress_percent: 100,
    manifest_id: 'youtube:dQw4w9WgXcQ:r1',
    revision: 1,
    updated_at: '2026-08-18T18:35:00+09:00',
}), null);
console.log('job progress announcement tests passed');


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


/***/ },

/***/ "node:assert/strict"
/*!*************************************!*\
  !*** external "node:assert/strict" ***!
  \*************************************/
(module) {

module.exports = require("node:assert/strict");

/***/ },

/***/ "node:crypto"
/*!******************************!*\
  !*** external "node:crypto" ***!
  \******************************/
(module) {

module.exports = require("node:crypto");

/***/ },

/***/ "node:fs"
/*!**************************!*\
  !*** external "node:fs" ***!
  \**************************/
(module) {

module.exports = require("node:fs");

/***/ },

/***/ "node:path"
/*!****************************!*\
  !*** external "node:path" ***!
  \****************************/
(module) {

module.exports = require("node:path");

/***/ },

/***/ "./fixtures/manifest-v1.1.invalid.json"
/*!*********************************************!*\
  !*** ./fixtures/manifest-v1.1.invalid.json ***!
  \*********************************************/
(module) {

module.exports = /*#__PURE__*/JSON.parse('{"schema_version":"1.1","manifest_id":"youtube:broken:r1","revision":1,"video":{"provider":"youtube","video_id":"broken","duration_ms":120000},"voice":{"voice_id":"ko-KR-poc","format":"audio/wav","sample_rate_hz":24000},"playback":{"duck_factor":0.35,"preload_count":3,"lookahead_ms":500,"late_tolerance_ms":250,"auto_pause_default":true,"max_extended_duration_ms":8000,"min_extended_interval_ms":15000},"segments":[{"id":"seg-broken","mode":"overlay","trigger_ms":12400,"deadline_ms":16200,"text":"이 음성은 허용된 구간보다 길다","importance":"normal","source":"ocr","confidence":"high","audio":{"path":"/v1/audio/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.wav","duration_ms":5000,"sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}]}');

/***/ },

/***/ "./fixtures/manifest-v1.1.valid.json"
/*!*******************************************!*\
  !*** ./fixtures/manifest-v1.1.valid.json ***!
  \*******************************************/
(module) {

module.exports = /*#__PURE__*/JSON.parse('{"schema_version":"1.1","manifest_id":"youtube:dQw4w9WgXcQ:r1","revision":1,"video":{"provider":"youtube","video_id":"dQw4w9WgXcQ","duration_ms":213061},"voice":{"voice_id":"ko-KR-poc","format":"audio/wav","sample_rate_hz":24000},"playback":{"duck_factor":0.35,"preload_count":3,"lookahead_ms":500,"late_tolerance_ms":250,"auto_pause_default":true,"max_extended_duration_ms":8000,"min_extended_interval_ms":15000},"segments":[{"id":"seg-001","mode":"overlay","trigger_ms":12400,"deadline_ms":16200,"text":"화면에 표, 3분기 매출 3억","importance":"normal","source":"ocr","confidence":"high","audio":{"path":"/v1/audio/89cc07fa802c26cdb0c4b6911e2de88fc49cfc34df99ba22330d62af7eb1b476.wav","duration_ms":3300,"sha256":"89cc07fa802c26cdb0c4b6911e2de88fc49cfc34df99ba22330d62af7eb1b476"}},{"id":"seg-002","mode":"extended","trigger_ms":32800,"text":"강사가 표의 붉은 막대를 가리킨다","importance":"high","source":"vlm","confidence":"high","audio":{"path":"/v1/audio/5c25d73681ae4243e60ef75f977029bcfaa785ff4715915f03c8dc2b9c5b910e.wav","duration_ms":3196,"sha256":"5c25d73681ae4243e60ef75f977029bcfaa785ff4715915f03c8dc2b9c5b910e"}}]}');

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
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	(() => {
/******/ 		// getDefaultExport function for compatibility with non-harmony modules
/******/ 		__webpack_require__.n = (module) => {
/******/ 			const getter = module && module.__esModule ?
/******/ 				() => (module['default']) :
/******/ 				() => (module);
/******/ 			__webpack_require__.d(getter, { a: getter });
/******/ 			return getter;
/******/ 		};
/******/ 	})();
/******/ 	
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
/*!*********************!*\
  !*** ./src/test.ts ***!
  \*********************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _content_player_html5_player_adapter_test__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./content/player/html5-player-adapter.test */ "./src/content/player/html5-player-adapter.test.ts");
/* harmony import */ var _content_scheduler_description_scheduler_test__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./content/scheduler/description-scheduler.test */ "./src/content/scheduler/description-scheduler.test.ts");
/* harmony import */ var _content_video_identifier_youtube_test__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./content/video-identifier/youtube.test */ "./src/content/video-identifier/youtube.test.ts");
/* harmony import */ var _shared_contracts_manifest_test__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./shared/contracts/manifest.test */ "./src/shared/contracts/manifest.test.ts");
/* harmony import */ var _shared_contracts_demo_audio_test__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ./shared/contracts/demo-audio.test */ "./src/shared/contracts/demo-audio.test.ts");
/* harmony import */ var _shared_contracts_job_status_test__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./shared/contracts/job-status.test */ "./src/shared/contracts/job-status.test.ts");
/* harmony import */ var _shared_contracts_messages_test__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(/*! ./shared/contracts/messages.test */ "./src/shared/contracts/messages.test.ts");
/* harmony import */ var _shared_accessibility_announcements_test__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(/*! ./shared/accessibility/announcements.test */ "./src/shared/accessibility/announcements.test.ts");
/* harmony import */ var _shared_accessibility_shortcut_speech_test__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(/*! ./shared/accessibility/shortcut-speech.test */ "./src/shared/accessibility/shortcut-speech.test.ts");
/* harmony import */ var _shared_settings_accessibility_settings_test__WEBPACK_IMPORTED_MODULE_9__ = __webpack_require__(/*! ./shared/settings/accessibility-settings.test */ "./src/shared/settings/accessibility-settings.test.ts");
/* harmony import */ var _shared_settings_playback_settings_test__WEBPACK_IMPORTED_MODULE_10__ = __webpack_require__(/*! ./shared/settings/playback-settings.test */ "./src/shared/settings/playback-settings.test.ts");
/* harmony import */ var _sidepanel_feedback_sound_test__WEBPACK_IMPORTED_MODULE_11__ = __webpack_require__(/*! ./sidepanel/feedback-sound.test */ "./src/sidepanel/feedback-sound.test.ts");
/* harmony import */ var _sidepanel_job_progress_test__WEBPACK_IMPORTED_MODULE_12__ = __webpack_require__(/*! ./sidepanel/job-progress.test */ "./src/sidepanel/job-progress.test.ts");
/* harmony import */ var _content_playback_playback_coordinator_test__WEBPACK_IMPORTED_MODULE_13__ = __webpack_require__(/*! ./content/playback/playback-coordinator.test */ "./src/content/playback/playback-coordinator.test.ts");
/* harmony import */ var _background_job_client_test__WEBPACK_IMPORTED_MODULE_14__ = __webpack_require__(/*! ./background/job-client.test */ "./src/background/job-client.test.ts");















void (0,_content_playback_playback_coordinator_test__WEBPACK_IMPORTED_MODULE_13__.runPlaybackCoordinatorTests)()
    .then(() => (0,_background_job_client_test__WEBPACK_IMPORTED_MODULE_14__.runJobClientTests)())
    .then(() => {
    console.log('VOICE BRIDGE frontend tests passed');
})
    .catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

})();

/******/ })()
;