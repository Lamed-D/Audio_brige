/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

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

/***/ "./src/content/playback/runtime-audio-gateway.ts"
/*!*******************************************************!*\
  !*** ./src/content/playback/runtime-audio-gateway.ts ***!
  \*******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   RuntimeAudioGateway: () => (/* binding */ RuntimeAudioGateway)
/* harmony export */ });
function isAudioEngineResponse(value) {
    if (typeof value !== 'object' || value === null || !('ok' in value)) {
        return false;
    }
    const response = value;
    if (typeof response.request_id !== 'string') {
        return false;
    }
    return response.ok === true
        ? Number.isInteger(response.elapsed_ms) && response.elapsed_ms >= 0
        : response.ok === false && typeof response.error === 'string';
}
class RuntimeAudioGateway {
    async play(input) {
        const request = { type: 'AUDIO_ENGINE_PLAY', ...input };
        const response = await chrome.runtime.sendMessage(request);
        if (!isAudioEngineResponse(response)) {
            return { ok: false, request_id: input.request_id, error: 'invalid_request' };
        }
        return response;
    }
    async stop(requestId) {
        const request = {
            type: 'AUDIO_ENGINE_STOP',
            ...(requestId ? { request_id: requestId } : {}),
        };
        await chrome.runtime.sendMessage(request);
    }
}


/***/ },

/***/ "./src/content/player-controller.ts"
/*!******************************************!*\
  !*** ./src/content/player-controller.ts ***!
  \******************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   YouTubePlayerController: () => (/* binding */ YouTubePlayerController)
/* harmony export */ });
/* harmony import */ var _player_youtube_player_adapter__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./player/youtube-player-adapter */ "./src/content/player/youtube-player-adapter.ts");
/* harmony import */ var _video_identifier_youtube__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./video-identifier/youtube */ "./src/content/video-identifier/youtube.ts");


const REFRESH_DELAY_MS = 100;
const URL_CHECK_INTERVAL_MS = 500;
const TIME_UPDATE_INTERVAL_MS = 500;
class YouTubePlayerController {
    onContext;
    adapter = null;
    identity = null;
    unsubscribePlayer = null;
    mutationObserver = null;
    refreshTimer = null;
    urlCheckTimer = null;
    lastUrl = '';
    lastTimeUpdateAt = 0;
    lastPublishedContext = '';
    constructor(onContext = () => undefined) {
        this.onContext = onContext;
    }
    start() {
        this.lastUrl = window.location.href;
        document.addEventListener('yt-navigate-finish', this.handleNavigation);
        window.addEventListener('popstate', this.handleNavigation);
        window.addEventListener('hashchange', this.handleNavigation);
        this.mutationObserver = new MutationObserver((records) => {
            const videoTreeChanged = records.some((record) => [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element
                ? node.matches('video') || node.querySelector('video') !== null
                : false));
            if (!this.adapter || !this.adapter.element.isConnected || videoTreeChanged) {
                this.scheduleRefresh();
            }
        });
        this.mutationObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
        this.urlCheckTimer = window.setInterval(() => {
            if (window.location.href !== this.lastUrl || !this.adapter?.element.isConnected) {
                this.scheduleRefresh();
            }
        }, URL_CHECK_INTERVAL_MS);
        this.refresh();
    }
    stop() {
        document.removeEventListener('yt-navigate-finish', this.handleNavigation);
        window.removeEventListener('popstate', this.handleNavigation);
        window.removeEventListener('hashchange', this.handleNavigation);
        this.mutationObserver?.disconnect();
        this.mutationObserver = null;
        if (this.refreshTimer !== null) {
            window.clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        if (this.urlCheckTimer !== null) {
            window.clearInterval(this.urlCheckTimer);
            this.urlCheckTimer = null;
        }
        this.detachPlayer();
    }
    getContext() {
        if (!this.identity) {
            return { available: false, reason: 'unsupported_page' };
        }
        if (!this.adapter) {
            return { available: false, reason: 'video_not_found' };
        }
        const snapshot = this.adapter.getSnapshot();
        const context = {
            available: true,
            provider: this.identity.provider,
            video_id: this.identity.videoId,
            video_key: this.identity.videoKey,
            title: this.getVideoTitle(),
            duration_ms: snapshot.durationMs,
            current_time_ms: snapshot.currentTimeMs,
            playback_rate: snapshot.playbackRate,
            volume: snapshot.volume,
            muted: snapshot.muted,
            state: snapshot.state,
        };
        return context;
    }
    async play() {
        if (!this.adapter) {
            return false;
        }
        try {
            await this.adapter.play();
            return true;
        }
        catch {
            return false;
        }
    }
    pause() {
        if (!this.adapter) {
            return false;
        }
        this.adapter.pause();
        return true;
    }
    setVolume(volume) {
        if (!this.adapter) {
            return false;
        }
        this.adapter.setVolume(volume);
        return true;
    }
    handleNavigation = () => {
        this.scheduleRefresh();
    };
    getVideoTitle() {
        const metadataTitle = document
            .querySelector('h1.ytd-watch-metadata yt-formatted-string')
            ?.textContent?.trim();
        if (metadataTitle) {
            return metadataTitle;
        }
        const documentTitle = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
        return documentTitle || 'YouTube 영상';
    }
    handlePlayerEvent = (event) => {
        if (event.type === 'timeupdate') {
            const now = Date.now();
            if (now - this.lastTimeUpdateAt < TIME_UPDATE_INTERVAL_MS) {
                return;
            }
            this.lastTimeUpdateAt = now;
        }
        this.publishContext(event.type);
    };
    scheduleRefresh() {
        if (this.refreshTimer !== null) {
            return;
        }
        this.refreshTimer = window.setTimeout(() => {
            this.refreshTimer = null;
            this.refresh();
        }, REFRESH_DELAY_MS);
    }
    refresh() {
        this.lastUrl = window.location.href;
        const nextIdentity = (0,_video_identifier_youtube__WEBPACK_IMPORTED_MODULE_1__.identifyYouTubeVideo)(this.lastUrl);
        const nextVideo = nextIdentity ? (0,_player_youtube_player_adapter__WEBPACK_IMPORTED_MODULE_0__.findPrimaryYouTubeVideo)() : null;
        if (!nextIdentity || !nextVideo) {
            this.identity = nextIdentity;
            this.detachPlayer();
            this.publishContext('videochange');
            return;
        }
        const isSamePlayer = this.adapter?.element === nextVideo && this.identity?.videoKey === nextIdentity.videoKey;
        this.identity = nextIdentity;
        if (!isSamePlayer) {
            this.detachPlayer();
            this.adapter = new _player_youtube_player_adapter__WEBPACK_IMPORTED_MODULE_0__.YouTubePlayerAdapter(nextVideo);
            this.unsubscribePlayer = this.adapter.subscribe(this.handlePlayerEvent);
        }
        this.publishContext(isSamePlayer ? 'sync' : 'videochange');
    }
    detachPlayer() {
        this.unsubscribePlayer?.();
        this.unsubscribePlayer = null;
        this.adapter?.destroy();
        this.adapter = null;
    }
    publishContext(reason) {
        const context = this.getContext();
        const serialized = JSON.stringify(context);
        if (serialized === this.lastPublishedContext &&
            (reason === 'timeupdate' || reason === 'sync')) {
            return;
        }
        this.lastPublishedContext = serialized;
        this.onContext(context, reason);
    }
}


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

/***/ "./src/content/player/youtube-player-adapter.ts"
/*!******************************************************!*\
  !*** ./src/content/player/youtube-player-adapter.ts ***!
  \******************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   YouTubePlayerAdapter: () => (/* binding */ YouTubePlayerAdapter),
/* harmony export */   findPrimaryYouTubeVideo: () => (/* binding */ findPrimaryYouTubeVideo)
/* harmony export */ });
/* harmony import */ var _html5_player_adapter__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ./html5-player-adapter */ "./src/content/player/html5-player-adapter.ts");

function visibleArea(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        return rect.width * rect.height;
    }
    return element.videoWidth * element.videoHeight;
}
function findPrimaryYouTubeVideo(root = document) {
    const mainVideo = root.querySelector('video.html5-main-video');
    if (mainVideo?.isConnected) {
        return mainVideo;
    }
    const videos = [...root.querySelectorAll('video')].filter((video) => video.isConnected);
    if (videos.length === 0) {
        return null;
    }
    return videos.reduce((largest, candidate) => visibleArea(candidate) > visibleArea(largest) ? candidate : largest);
}
class YouTubePlayerAdapter extends _html5_player_adapter__WEBPACK_IMPORTED_MODULE_0__.Html5PlayerAdapter {
}


/***/ },

/***/ "./src/content/scheduler/demo-scheduler-runtime.ts"
/*!*********************************************************!*\
  !*** ./src/content/scheduler/demo-scheduler-runtime.ts ***!
  \*********************************************************/
(__unused_webpack_module, __webpack_exports__, __webpack_require__) {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   ManifestSchedulerRuntime: () => (/* binding */ ManifestSchedulerRuntime)
/* harmony export */ });
/* harmony import */ var _shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../../shared/settings/playback-settings */ "./src/shared/settings/playback-settings.ts");
/* harmony import */ var _description_scheduler__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ./description-scheduler */ "./src/content/scheduler/description-scheduler.ts");


const SCHEDULER_TICK_MS = 50;
const MANIFEST_DURATION_TOLERANCE_MS = 1000;
class ManifestSchedulerRuntime {
    getPlayerContext;
    playback;
    isPageVisible;
    scheduler = new _description_scheduler__WEBPACK_IMPORTED_MODULE_1__.DescriptionScheduler();
    manifests = new Map();
    activeVideoKey = null;
    inactiveReason = 'no_video';
    timer = null;
    settings = { ..._shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_0__.DEFAULT_PLAYBACK_SETTINGS };
    lastPlaybackEvent = null;
    constructor(getPlayerContext, playback, isPageVisible = () => true) {
        this.getPlayerContext = getPlayerContext;
        this.playback = playback;
        this.isPageVisible = isPageVisible;
    }
    hasManifest(videoKey) {
        return this.manifests.has(videoKey);
    }
    installManifest(manifest) {
        const videoKey = `${manifest.video.provider}:${manifest.video.video_id}`;
        const current = this.manifests.get(videoKey);
        if (current && current.revision >= manifest.revision) {
            return false;
        }
        this.manifests.set(videoKey, manifest);
        const context = this.getPlayerContext();
        if (context.available && context.video_key === videoKey) {
            this.playback.cancel('manifest-update', true);
            this.activeVideoKey = null;
            this.handlePlayerContext(context, 'sync');
        }
        return true;
    }
    removeManifest(videoKey) {
        this.manifests.delete(videoKey);
        if (this.activeVideoKey === videoKey) {
            this.playback.cancel('manifest-refresh', true);
            this.deactivate('no_manifest');
        }
    }
    handleVisibilityChange() {
        this.handlePlayerContext(this.getPlayerContext(), 'sync');
    }
    start() {
        if (this.timer !== null) {
            return;
        }
        this.handlePlayerContext(this.getPlayerContext(), 'sync');
        this.timer = window.setInterval(() => {
            this.tick();
        }, SCHEDULER_TICK_MS);
    }
    stop() {
        if (this.timer !== null) {
            window.clearInterval(this.timer);
            this.timer = null;
        }
        this.playback.cancel('runtime-stop', true);
        this.activeVideoKey = null;
        this.scheduler.unload();
    }
    handlePlayerContext(context, reason) {
        this.playback.handlePlayerContext(context, reason);
        if (!context.available) {
            this.deactivate('no_video');
            return;
        }
        if (context.video_key !== this.activeVideoKey) {
            const manifest = this.manifests.get(context.video_key);
            if (!manifest || !this.manifestMatchesContext(manifest, context)) {
                if (manifest) {
                    this.manifests.delete(context.video_key);
                }
                this.deactivate('no_manifest');
                return;
            }
            this.activeVideoKey = context.video_key;
            this.scheduler.load(manifest, context.current_time_ms);
            this.lastPlaybackEvent = null;
        }
        if (!this.isPageVisible()) {
            this.playback.cancel('page-hidden', true);
            this.scheduler.setPlaying(false);
            return;
        }
        this.scheduler.setPlaying(this.settings.enabled && context.state === 'playing');
        if (reason === 'seeking' || reason === 'seeked') {
            this.recordEvents(this.scheduler.seek(context.current_time_ms));
        }
    }
    setEnabled(enabled) {
        this.updateSettings({ ...this.settings, enabled });
    }
    updateSettings(settings) {
        const wasEnabled = this.settings.enabled;
        const autoPauseTurnedOff = this.settings.auto_pause_enabled && !settings.auto_pause_enabled;
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
        this.scheduler.setPlaying(context.available && this.isPageVisible() && context.state === 'playing');
    }
    getStatus() {
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
    tick() {
        const context = this.getPlayerContext();
        if (!context.available || context.video_key !== this.activeVideoKey) {
            this.handlePlayerContext(context, 'sync');
            return;
        }
        this.scheduler.setPlaying(this.settings.enabled && this.isPageVisible() && context.state === 'playing');
        this.recordEvents(this.scheduler.tick(context.current_time_ms));
    }
    deactivate(reason) {
        this.playback.cancel(reason);
        this.activeVideoKey = null;
        this.inactiveReason = reason;
        this.lastPlaybackEvent = null;
        this.scheduler.unload();
    }
    manifestMatchesContext(manifest, context) {
        return (manifest.video.provider === context.provider &&
            manifest.video.video_id === context.video_id &&
            (context.duration_ms === null ||
                Math.abs(manifest.video.duration_ms - context.duration_ms) <=
                    MANIFEST_DURATION_TOLERANCE_MS));
    }
    recordEvents(events) {
        for (const event of events) {
            const detail = event.type === 'skip' ? ` (${event.reason})` : '';
            console.info(`[VOICE BRIDGE] Scheduler ${event.type}: ${event.segment.id}${detail}`);
            this.lastPlaybackEvent = {
                type: event.type,
                segment_id: event.segment.id,
                mode: event.segment.mode,
                at_ms: event.atMs,
                ...(event.type === 'skip' ? { reason: event.reason } : {}),
            };
            if (event.type === 'trigger' &&
                event.segment.mode === 'extended' &&
                !this.settings.auto_pause_enabled) {
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
                    void this.playback.playSegment(manifest.manifest_id, event.segment, this.settings.duck_factor, context.playback_rate, this.settings.description_volume);
                }
            }
        }
    }
}


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

// kwon2/backend binds to the IPv4 loopback interface by default. Keep this
// value in sync with extension/manifest.json host_permissions.
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
/*!******************************!*\
  !*** ./src/content/index.ts ***!
  \******************************/
__webpack_require__.r(__webpack_exports__);
/* harmony import */ var _shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(/*! ../shared/contracts/messages */ "./src/shared/contracts/messages.ts");
/* harmony import */ var _shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(/*! ../shared/settings/playback-settings */ "./src/shared/settings/playback-settings.ts");
/* harmony import */ var _player_controller__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./player-controller */ "./src/content/player-controller.ts");
/* harmony import */ var _playback_playback_coordinator__WEBPACK_IMPORTED_MODULE_3__ = __webpack_require__(/*! ./playback/playback-coordinator */ "./src/content/playback/playback-coordinator.ts");
/* harmony import */ var _playback_runtime_audio_gateway__WEBPACK_IMPORTED_MODULE_4__ = __webpack_require__(/*! ./playback/runtime-audio-gateway */ "./src/content/playback/runtime-audio-gateway.ts");
/* harmony import */ var _scheduler_demo_scheduler_runtime__WEBPACK_IMPORTED_MODULE_5__ = __webpack_require__(/*! ./scheduler/demo-scheduler-runtime */ "./src/content/scheduler/demo-scheduler-runtime.ts");
/* harmony import */ var _shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_6__ = __webpack_require__(/*! ../shared/contracts/manifest */ "./src/shared/contracts/manifest.ts");
/* harmony import */ var _shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_7__ = __webpack_require__(/*! ../shared/settings/accessibility-settings */ "./src/shared/settings/accessibility-settings.ts");
/* harmony import */ var _shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_8__ = __webpack_require__(/*! ../shared/accessibility/feedback-sound */ "./src/shared/accessibility/feedback-sound.ts");









const CONTENT_MARKER = 'data-voice-bridge-content';
const LIVE_REGION_MARKER = 'data-voice-bridge-live-region';
const MANIFEST_RETRY_DEFAULT_MS = 5000;
const MANIFEST_RETRY_NOT_FOUND_MS = 15000;
const MANIFEST_RETRY_INVALID_MS = 30000;
const pageFeedbackSoundPlayer = new _shared_accessibility_feedback_sound__WEBPACK_IMPORTED_MODULE_8__.FeedbackSoundPlayer();
const pageAccessibilitySettingsReady = chrome.storage.local
    .get(_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_7__.ACCESSIBILITY_SETTINGS_STORAGE_KEY)
    .then((stored) => {
    const settings = (0,_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_7__.parseStoredAccessibilitySettings)(stored[_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_7__.ACCESSIBILITY_SETTINGS_STORAGE_KEY]);
    pageFeedbackSoundPlayer.setEnabled(settings.interaction_sounds_enabled);
    pageFeedbackSoundPlayer.setVolume(settings.interaction_sound_volume);
})
    .catch(() => undefined);
function createLiveRegion(urgency) {
    const element = document.createElement('p');
    element.setAttribute(LIVE_REGION_MARKER, urgency);
    element.setAttribute('role', urgency === 'assertive' ? 'alert' : 'status');
    element.setAttribute('aria-live', urgency);
    element.setAttribute('aria-atomic', 'true');
    Object.assign(element.style, {
        position: 'fixed',
        width: '1px',
        height: '1px',
        padding: '0',
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: '0',
    });
    document.body.append(element);
    return element;
}
function announceOnPage(message) {
    if (!message.speech_handled) {
        const selector = `[${LIVE_REGION_MARKER}="${message.urgency}"]`;
        const element = document.querySelector(selector) ?? createLiveRegion(message.urgency);
        element.textContent = '';
        window.setTimeout(() => {
            element.textContent = message.text;
        }, 40);
    }
    void pageAccessibilitySettingsReady
        .then(() => pageFeedbackSoundPlayer.unlock())
        .then(() => pageFeedbackSoundPlayer.play(message.tone))
        .catch(() => undefined);
}
if (!document.documentElement.hasAttribute(CONTENT_MARKER)) {
    document.documentElement.setAttribute(CONTENT_MARKER, 'ready');
    let controller;
    let schedulerRuntime;
    const manifestRequests = new Map();
    const manifestRetryTimers = new Map();
    function clearManifestRetry(videoKey) {
        const timer = manifestRetryTimers.get(videoKey);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            manifestRetryTimers.delete(videoKey);
        }
    }
    function scheduleManifestRetry(videoKey, delayMs) {
        clearManifestRetry(videoKey);
        const timer = window.setTimeout(() => {
            manifestRetryTimers.delete(videoKey);
            const context = controller.getContext();
            if (context.available && context.video_key === videoKey) {
                void ensureManifest(context, true);
            }
        }, delayMs);
        manifestRetryTimers.set(videoKey, timer);
    }
    function ensureManifest(context, force = false) {
        if (!context.available || (!force && schedulerRuntime.hasManifest(context.video_key))) {
            return Promise.resolve();
        }
        const inFlight = manifestRequests.get(context.video_key);
        if (inFlight) {
            return inFlight;
        }
        const request = {
            type: 'MANIFEST_GET',
            provider: context.provider,
            video_id: context.video_id,
            duration_ms: context.duration_ms,
        };
        const promise = chrome.runtime
            .sendMessage(request)
            .then((response) => {
            if (!(0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isManifestFetchResponse)(response) || response.video_key !== context.video_key) {
                scheduleManifestRetry(context.video_key, MANIFEST_RETRY_INVALID_MS);
                return;
            }
            if (response.status === 'pending') {
                scheduleManifestRetry(context.video_key, response.retry_after_ms);
                return;
            }
            if (response.status === 'not_found') {
                scheduleManifestRetry(context.video_key, MANIFEST_RETRY_NOT_FOUND_MS);
                return;
            }
            if (response.status === 'unavailable') {
                scheduleManifestRetry(context.video_key, response.reason === 'network'
                    ? MANIFEST_RETRY_DEFAULT_MS
                    : MANIFEST_RETRY_INVALID_MS);
                return;
            }
            const manifest = (0,_shared_contracts_manifest__WEBPACK_IMPORTED_MODULE_6__.parseManifestV1_1)(response.manifest);
            const latestContext = controller.getContext();
            if (!latestContext.available || latestContext.video_key !== response.video_key) {
                return;
            }
            if (latestContext.duration_ms !== null &&
                Math.abs(manifest.video.duration_ms - latestContext.duration_ms) > 1000) {
                scheduleManifestRetry(response.video_key, MANIFEST_RETRY_INVALID_MS);
                return;
            }
            clearManifestRetry(response.video_key);
            schedulerRuntime.installManifest(manifest);
        })
            .catch((error) => {
            console.error('[VOICE BRIDGE] Manifest load failed.', error);
            scheduleManifestRetry(context.video_key, MANIFEST_RETRY_DEFAULT_MS);
        })
            .finally(() => {
            manifestRequests.delete(context.video_key);
        });
        manifestRequests.set(context.video_key, promise);
        return promise;
    }
    controller = new _player_controller__WEBPACK_IMPORTED_MODULE_2__.YouTubePlayerController((context, reason) => {
        schedulerRuntime.handlePlayerContext(context, reason);
        void ensureManifest(context);
    });
    const playbackCoordinator = new _playback_playback_coordinator__WEBPACK_IMPORTED_MODULE_3__.PlaybackCoordinator(controller, new _playback_runtime_audio_gateway__WEBPACK_IMPORTED_MODULE_4__.RuntimeAudioGateway());
    schedulerRuntime = new _scheduler_demo_scheduler_runtime__WEBPACK_IMPORTED_MODULE_5__.ManifestSchedulerRuntime(() => controller.getContext(), playbackCoordinator, () => document.visibilityState === 'visible');
    function applyAndPersistSettings(settings) {
        schedulerRuntime.updateSettings(settings);
        void chrome.storage.local
            .set({ [_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.PLAYBACK_SETTINGS_STORAGE_KEY]: settings })
            .catch((error) => {
            console.error('[VOICE BRIDGE] Failed to save playback settings.', error);
        });
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!(0,_shared_contracts_messages__WEBPACK_IMPORTED_MODULE_0__.isExtensionMessage)(message)) {
            return false;
        }
        if (message.type === 'PLAYER_CONTEXT_GET') {
            sendResponse(controller.getContext());
            return false;
        }
        if (message.type === 'SCHEDULER_STATUS_GET') {
            sendResponse(schedulerRuntime.getStatus());
            return false;
        }
        if (message.type === 'DESCRIPTION_ENABLED_SET') {
            applyAndPersistSettings({
                ...schedulerRuntime.getStatus().settings,
                enabled: message.enabled,
            });
            sendResponse(schedulerRuntime.getStatus());
            return false;
        }
        if (message.type === 'PLAYBACK_SETTINGS_SET') {
            applyAndPersistSettings(message.settings);
            sendResponse(schedulerRuntime.getStatus());
            return false;
        }
        if (message.type === 'MANIFEST_REFRESH') {
            const context = controller.getContext();
            if (context.available && context.video_key === message.video_key) {
                clearManifestRetry(message.video_key);
                void ensureManifest(context, true);
            }
            sendResponse({ ok: true });
            return false;
        }
        if (message.type === 'ACCESSIBILITY_ANNOUNCE') {
            announceOnPage(message);
            sendResponse({ ok: true });
            return false;
        }
        return false;
    });
    window.addEventListener('beforeunload', () => {
        chrome.storage.onChanged.removeListener(handleStorageChange);
        for (const timer of manifestRetryTimers.values()) {
            window.clearTimeout(timer);
        }
        manifestRetryTimers.clear();
        controller.stop();
        schedulerRuntime.stop();
    });
    document.addEventListener('visibilitychange', () => {
        schedulerRuntime.handleVisibilityChange();
        const context = controller.getContext();
        if (document.visibilityState === 'visible') {
            void ensureManifest(context);
        }
    });
    const handleStorageChange = (changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        if (changes[_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.PLAYBACK_SETTINGS_STORAGE_KEY]) {
            schedulerRuntime.updateSettings((0,_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.parseStoredPlaybackSettings)(changes[_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.PLAYBACK_SETTINGS_STORAGE_KEY].newValue));
        }
        if (changes[_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_7__.ACCESSIBILITY_SETTINGS_STORAGE_KEY]) {
            const settings = (0,_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_7__.parseStoredAccessibilitySettings)(changes[_shared_settings_accessibility_settings__WEBPACK_IMPORTED_MODULE_7__.ACCESSIBILITY_SETTINGS_STORAGE_KEY].newValue);
            pageFeedbackSoundPlayer.setEnabled(settings.interaction_sounds_enabled);
            pageFeedbackSoundPlayer.setVolume(settings.interaction_sound_volume);
        }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    void chrome.storage.local
        .get(_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.PLAYBACK_SETTINGS_STORAGE_KEY)
        .then((stored) => {
        schedulerRuntime.updateSettings((0,_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.parseStoredPlaybackSettings)(stored[_shared_settings_playback_settings__WEBPACK_IMPORTED_MODULE_1__.PLAYBACK_SETTINGS_STORAGE_KEY]));
    })
        .catch((error) => {
        console.error('[VOICE BRIDGE] Failed to load playback settings.', error);
    })
        .finally(() => {
        controller.start();
        schedulerRuntime.start();
        console.info('[VOICE BRIDGE] YouTube player adapter and scheduler ready.');
    });
}

})();

/******/ })()
;
//# sourceMappingURL=content.js.map