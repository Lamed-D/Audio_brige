"use strict";

const API_ORIGIN = "http://127.0.0.1:5000";
const API_TIMEOUT_MS = 5000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_JOB_POLL_MS = 1500;
const MAX_JOB_POLL_MS = 5000;
const MAX_MANIFEST_CACHE_ENTRIES = 20;
const OFFSCREEN_PATH = "offscreen.html";

const RUNTIME_STORAGE_KEY = "soundBridgeRuntimeV1";
const MANIFEST_STORAGE_KEY = "soundBridgeManifestCacheV1";
const SETTINGS_STORAGE_KEY = "soundBridgeSettingsV1";

const DEFAULT_DUCK_FACTOR = 0.35;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
const SEGMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

let runtimeState = createDefaultRuntimeState();
let settings = { duck_factor: DEFAULT_DUCK_FACTOR, auto_pause: true };
let manifestCache = {};
let initializationPromise = null;
let offscreenCreationPromise = null;
let healthSnapshot = { checked_at: 0, ok: false, detail: null };
const pollingJobs = new Map();

function createDefaultRuntimeState() {
  return {
    enabled: false,
    active_tab_id: null,
    status: "off",
    video_key: null,
    revision: null,
    segment_id: null,
    pending_job: null,
    error: null,
    updated_at: Date.now(),
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function makeRequestId(prefix = "req") {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function makeError(code, message, retryable = false, requestId = null) {
  return {
    type: "ERROR",
    error: { code, message, retryable },
    request_id: requestId,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function initialize() {
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    const [sessionData, localData] = await Promise.all([
      chrome.storage.session.get(RUNTIME_STORAGE_KEY),
      chrome.storage.local.get([MANIFEST_STORAGE_KEY, SETTINGS_STORAGE_KEY]),
    ]);

    const storedRuntime = sessionData[RUNTIME_STORAGE_KEY];
    if (isPlainObject(storedRuntime)) {
      runtimeState = { ...createDefaultRuntimeState(), ...storedRuntime };
    }

    const storedSettings = localData[SETTINGS_STORAGE_KEY];
    if (isPlainObject(storedSettings) && Number.isFinite(storedSettings.duck_factor)) {
      settings.duck_factor = clamp(storedSettings.duck_factor, 0.1, 1);
      if (typeof storedSettings.auto_pause === "boolean") settings.auto_pause = storedSettings.auto_pause;
    }

    const storedCache = localData[MANIFEST_STORAGE_KEY];
    if (isPlainObject(storedCache)) manifestCache = storedCache;

    if (runtimeState.enabled && runtimeState.pending_job) {
      const pending = runtimeState.pending_job;
      if (isPlainObject(pending) && pending.job_id && pending.video_key === runtimeState.video_key) {
        startJobPolling(pending, runtimeState.active_tab_id);
      }
    }
  })();
  return initializationPromise;
}

async function persistRuntimeState() {
  runtimeState.updated_at = Date.now();
  await chrome.storage.session.set({ [RUNTIME_STORAGE_KEY]: runtimeState });
}

async function persistManifestCache() {
  const entries = Object.entries(manifestCache);
  if (entries.length > MAX_MANIFEST_CACHE_ENTRIES) {
    entries
      .sort((a, b) => (b[1].cached_at || 0) - (a[1].cached_at || 0))
      .slice(MAX_MANIFEST_CACHE_ENTRIES)
      .forEach(([key]) => delete manifestCache[key]);
  }
  await chrome.storage.local.set({ [MANIFEST_STORAGE_KEY]: manifestCache });
}

async function persistSettings() {
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
}

function isYouTubeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "www.youtube.com" ||
        url.hostname === "m.youtube.com" ||
        url.hostname === "youtube.com" ||
        url.hostname === "youtu.be")
    );
  } catch (_error) {
    return false;
  }
}

function requireContentSender(sender, requestId) {
  if (!sender.tab || !Number.isInteger(sender.tab.id) || !isYouTubeUrl(sender.url || sender.tab.url || "")) {
    throw Object.assign(new Error("YouTube 콘텐츠 스크립트에서만 사용할 수 있습니다."), {
      code: "INVALID_SENDER",
      requestId,
    });
  }
  if (!runtimeState.enabled || runtimeState.active_tab_id !== sender.tab.id) {
    throw Object.assign(new Error("이 탭에서 화면해설이 활성화되지 않았습니다."), {
      code: "DISABLED",
      requestId,
    });
  }
  return sender.tab.id;
}

function buildVideoKey(provider, videoId) {
  return `${provider}:${videoId}`;
}

function validateManifestRequest(msg) {
  const requestId = typeof msg.request_id === "string" ? msg.request_id : makeRequestId("manifest");
  if (msg.provider !== "youtube") {
    throw Object.assign(new Error("지원하지 않는 provider입니다."), { code: "UNSUPPORTED_PROVIDER", requestId });
  }
  if (typeof msg.video_id !== "string" || !VIDEO_ID_RE.test(msg.video_id)) {
    throw Object.assign(new Error("YouTube video_id 형식이 올바르지 않습니다."), { code: "INVALID_VIDEO_ID", requestId });
  }
  if (!Number.isInteger(msg.duration_ms) || msg.duration_ms <= 0 || msg.duration_ms > 24 * 60 * 60 * 1000) {
    throw Object.assign(new Error("duration_ms는 유한한 양의 정수여야 합니다."), { code: "INVALID_DURATION", requestId });
  }
  return {
    provider: msg.provider,
    video_id: msg.video_id,
    duration_ms: msg.duration_ms,
    request_id: requestId,
    video_key: buildVideoKey(msg.provider, msg.video_id),
  };
}

function trustedAudioUrl(path, sha256) {
  if (typeof path !== "string" || !SHA256_RE.test(sha256 || "")) {
    throw new Error("오디오 경로 또는 sha256 형식이 올바르지 않습니다.");
  }
  const url = new URL(path, `${API_ORIGIN}/`);
  const expectedPath = `/v1/audio/${sha256.toLowerCase()}.wav`;
  if (
    url.origin !== API_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.toLowerCase() !== expectedPath
  ) {
    throw new Error("허용되지 않은 오디오 경로입니다.");
  }
  return `${API_ORIGIN}${expectedPath}`;
}

function validateManifestForCache(raw, request) {
  if (!isPlainObject(raw) || raw.schema_version !== "1.1") {
    throw new Error("schema_version 1.1 매니페스트가 아닙니다.");
  }
  if (typeof raw.manifest_id !== "string" || !raw.manifest_id) throw new Error("manifest_id가 없습니다.");
  if (!Number.isInteger(raw.revision) || raw.revision < 1) throw new Error("revision이 올바르지 않습니다.");
  if (!isPlainObject(raw.video)) throw new Error("video 메타데이터가 없습니다.");
  if (raw.video.provider !== request.provider || raw.video.video_id !== request.video_id) {
    throw new Error("요청한 영상과 매니페스트의 영상 식별자가 다릅니다.");
  }
  if (raw.manifest_id !== `${request.provider}:${request.video_id}:r${raw.revision}`) {
    throw new Error("manifest_id가 요청 provider/video_id와 일치하지 않습니다.");
  }
  if (!Number.isInteger(raw.video.duration_ms) || Math.abs(raw.video.duration_ms - request.duration_ms) > 1000) {
    throw new Error("현재 영상과 매니페스트 duration 차이가 1000ms를 초과합니다.");
  }
  if (!isPlainObject(raw.playback) || !Array.isArray(raw.segments)) {
    throw new Error("playback 또는 segments가 없습니다.");
  }
  if (typeof raw.playback.auto_pause_default !== "boolean") throw new Error("auto_pause_default가 없습니다.");
  if (!Number.isInteger(raw.playback.max_extended_duration_ms) || raw.playback.max_extended_duration_ms > 8000) {
    throw new Error("max_extended_duration_ms가 올바르지 않습니다.");
  }

  const seen = new Set();
  for (const segment of raw.segments) {
    if (!isPlainObject(segment) || typeof segment.id !== "string" || !SEGMENT_ID_RE.test(segment.id)) {
      throw new Error("segment id 형식이 올바르지 않습니다.");
    }
    if (seen.has(segment.id)) throw new Error(`중복 segment id: ${segment.id}`);
    seen.add(segment.id);
    if (segment.mode !== "overlay" && segment.mode !== "extended") throw new Error(`segment ${segment.id}의 mode가 올바르지 않습니다.`);
    if (!Number.isInteger(segment.trigger_ms) || segment.trigger_ms < 0) throw new Error(`segment ${segment.id}의 trigger_ms가 올바르지 않습니다.`);
    if (segment.mode === "overlay" && (!Number.isInteger(segment.deadline_ms) || segment.deadline_ms <= segment.trigger_ms)) {
      throw new Error(`segment ${segment.id}의 deadline_ms가 올바르지 않습니다.`);
    }
    if (segment.mode === "extended" && segment.importance !== "high") throw new Error(`segment ${segment.id}의 중요도가 올바르지 않습니다.`);
    if (!isPlainObject(segment.audio)) throw new Error(`segment ${segment.id}의 audio가 없습니다.`);
    trustedAudioUrl(segment.audio.path, segment.audio.sha256);
  }
  return raw;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw new Error(`API가 JSON이 아닌 응답을 반환했습니다. (HTTP ${response.status})`);
  }
}

async function checkHealth(force = false) {
  if (!force && Date.now() - healthSnapshot.checked_at < 10000) return healthSnapshot;
  try {
    const response = await fetchWithTimeout(`${API_ORIGIN}/v1/health`, {
      headers: { Accept: "application/json" },
    });
    const detail = await responseJson(response);
    healthSnapshot = { checked_at: Date.now(), ok: response.ok, detail };
  } catch (error) {
    healthSnapshot = { checked_at: Date.now(), ok: false, detail: { error: errorMessage(error) } };
  }
  return healthSnapshot;
}

function manifestUrl(request) {
  return `${API_ORIGIN}/v1/manifests/${encodeURIComponent(request.provider)}/${encodeURIComponent(request.video_id)}`;
}

async function cacheManifest(request, manifest, etag = null) {
  const validated = validateManifestForCache(manifest, request);
  const entry = {
    video_key: request.video_key,
    provider: request.provider,
    video_id: request.video_id,
    revision: validated.revision,
    etag,
    manifest: validated,
    cached_at: Date.now(),
  };
  manifestCache[request.video_key] = entry;
  await persistManifestCache();
  return entry;
}

function cachedManifestFor(request) {
  const entry = manifestCache[request.video_key];
  if (!entry) return null;
  try {
    validateManifestForCache(entry.manifest, request);
    return entry;
  } catch (_error) {
    delete manifestCache[request.video_key];
    void persistManifestCache();
    return null;
  }
}

function manifestReady(entry, request, stale = false) {
  return {
    type: "MANIFEST_READY",
    request_id: request.request_id,
    video_key: request.video_key,
    revision: entry.revision,
    manifest: entry.manifest,
    cached: !!stale,
  };
}

async function getManifestResponse(request, useEtag = true) {
  const cached = cachedManifestFor(request);
  const headers = { Accept: "application/json", "X-Request-ID": request.request_id };
  if (useEtag && cached && cached.etag) headers["If-None-Match"] = cached.etag;

  let response;
  try {
    response = await fetchWithTimeout(manifestUrl(request), { headers });
  } catch (error) {
    if (cached) return { kind: "ready", entry: cached, stale: true };
    throw error;
  }

  if (response.status === 304 && cached) return { kind: "ready", entry: cached, stale: false };
  const body = await responseJson(response);
  if (response.ok && response.status !== 202) {
    const manifest = isPlainObject(body.manifest) ? body.manifest : body;
    const entry = await cacheManifest(request, manifest, response.headers.get("ETag"));
    return { kind: "ready", entry, stale: false };
  }
  if (response.status === 202) {
    const jobId = body.job_id || (body.job && body.job.job_id);
    if (!jobId) throw new Error("202 응답에 job_id가 없습니다.");
    return {
      kind: "processing",
      job_id: String(jobId),
      retry_after_ms: normalizeRetryAfter(body.retry_after_ms),
    };
  }
  if (response.status === 404) return { kind: "missing" };
  const apiError = body.error && body.error.message ? body.error.message : `매니페스트 조회 실패 (HTTP ${response.status})`;
  throw new Error(apiError);
}

function normalizeRetryAfter(value) {
  return Number.isFinite(value) ? clamp(Math.round(value), 250, MAX_JOB_POLL_MS) : DEFAULT_JOB_POLL_MS;
}

async function createJob(request, force = false) {
  const response = await fetchWithTimeout(`${API_ORIGIN}/v1/jobs`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Request-ID": request.request_id,
    },
    body: JSON.stringify({
      provider: request.provider,
      video_id: request.video_id,
      duration_ms: request.duration_ms,
      force,
    }),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    const message = body.error && body.error.message ? body.error.message : `작업 생성 실패 (HTTP ${response.status})`;
    throw new Error(message);
  }
  if (body.schema_version === "1.1" || isPlainObject(body.manifest)) {
    const manifest = isPlainObject(body.manifest) ? body.manifest : body;
    const entry = await cacheManifest(request, manifest, response.headers.get("ETag"));
    return { kind: "ready", entry };
  }
  const jobId = body.job_id || (body.job && body.job.job_id);
  if (!jobId) throw new Error("작업 생성 응답에 job_id가 없습니다.");
  return {
    kind: "processing",
    job_id: String(jobId),
    retry_after_ms: normalizeRetryAfter(body.retry_after_ms),
    status: body.status || "queued",
    stage: body.stage || "queued",
    progress_percent: Number.isFinite(body.progress_percent) ? body.progress_percent : 0,
    eta_seconds: Number.isFinite(body.eta_seconds) ? body.eta_seconds : null,
  };
}

function processingMessage(pending) {
  return {
    type: "PROCESSING",
    request_id: pending.request_id,
    video_key: pending.video_key,
    job_id: pending.job_id,
    status: pending.status || "processing",
    stage: pending.stage || "queued",
    progress_percent: Number.isFinite(pending.progress_percent) ? pending.progress_percent : 0,
    eta_seconds: Number.isFinite(pending.eta_seconds) ? pending.eta_seconds : null,
    retry_after_ms: pending.retry_after_ms,
  };
}

async function setPendingJob(request, job) {
  const pending = {
    ...request,
    job_id: job.job_id,
    status: job.status || "queued",
    stage: job.stage || "queued",
    progress_percent: Number.isFinite(job.progress_percent) ? job.progress_percent : 0,
    eta_seconds: Number.isFinite(job.eta_seconds) ? job.eta_seconds : null,
    retry_after_ms: job.retry_after_ms,
    started_at: Date.now(),
  };
  runtimeState.pending_job = pending;
  runtimeState.status = "processing";
  runtimeState.error = null;
  await persistRuntimeState();
  chrome.alarms.create("voice-bridge-job", { periodInMinutes: 1 });
  return pending;
}

function startJobPolling(pending, tabId) {
  if (!pending || pollingJobs.has(pending.video_key)) return;
  const promise = pollJob(pending, tabId)
    .catch((error) => notifyManifestError(tabId, pending, error, true))
    .finally(() => pollingJobs.delete(pending.video_key));
  pollingJobs.set(pending.video_key, promise);
}

async function pollJob(pending, tabId) {
  let retryMs = normalizeRetryAfter(pending.retry_after_ms);
  const startedAt = Number.isFinite(pending.started_at) ? pending.started_at : Date.now();

  while (Date.now() - startedAt < JOB_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    await initialize();
    if (!runtimeState.enabled || runtimeState.active_tab_id !== tabId || runtimeState.video_key !== pending.video_key) return;

    let response;
    try {
      response = await fetchWithTimeout(`${API_ORIGIN}/v1/jobs/${encodeURIComponent(pending.job_id)}`, {
        headers: { Accept: "application/json", "X-Request-ID": pending.request_id },
      });
    } catch (_error) {
      retryMs = clamp(Math.round(retryMs * 1.5), 500, MAX_JOB_POLL_MS);
      continue;
    }

    const body = await responseJson(response);
    if (!response.ok) {
      if (response.status >= 500) {
        retryMs = clamp(Math.round(retryMs * 1.5), 500, MAX_JOB_POLL_MS);
        continue;
      }
      throw new Error(body.error && body.error.message ? body.error.message : `작업 조회 실패 (HTTP ${response.status})`);
    }

    if (body.schema_version === "1.1" || isPlainObject(body.manifest)) {
      const manifest = isPlainObject(body.manifest) ? body.manifest : body;
      const entry = await cacheManifest(pending, manifest, response.headers.get("ETag"));
      await finishManifestReady(tabId, pending, entry);
      return;
    }

    const status = body.status || (body.job && body.job.status);
    if (status === "ready") {
      const result = await getManifestResponse(pending, false);
      if (result.kind !== "ready") throw new Error("작업은 ready이지만 매니페스트를 가져오지 못했습니다.");
      await finishManifestReady(tabId, pending, result.entry);
      return;
    }
    if (status === "failed") {
      throw new Error(body.error && body.error.message ? body.error.message : "화면해설 생성 작업이 실패했습니다.");
    }
    if (status !== "queued" && status !== "processing") {
      throw new Error(`알 수 없는 작업 상태: ${String(status)}`);
    }

    retryMs = normalizeRetryAfter(body.retry_after_ms || retryMs);
    pending.status = status;
    pending.stage = body.stage || pending.stage || "queued";
    pending.progress_percent = Number.isFinite(body.progress_percent) ? body.progress_percent : pending.progress_percent || 0;
    pending.eta_seconds = Number.isFinite(body.eta_seconds) ? body.eta_seconds : null;
    pending.retry_after_ms = retryMs;
    runtimeState.pending_job = pending;
    runtimeState.status = "processing";
    await persistRuntimeState();
    await safeTabMessage(tabId, processingMessage(pending));
    void broadcastPanelState();
  }

  throw new Error("화면해설 생성 작업 대기 시간이 초과되었습니다.");
}

async function finishManifestReady(tabId, request, entry) {
  if (runtimeState.video_key !== request.video_key || runtimeState.active_tab_id !== tabId) return;
  runtimeState.pending_job = null;
  runtimeState.revision = entry.revision;
  runtimeState.status = "ready";
  runtimeState.error = null;
  await persistRuntimeState();
  await chrome.alarms.clear("voice-bridge-job");
  chrome.notifications.create(`voice-bridge-ready-${request.video_key}`, {
    type: "basic",
    iconUrl: "icon128.svg",
    title: "VOICE BRIDGE",
    message: "화면해설 준비가 완료되었습니다.",
  }).catch(() => {});
  await safeTabMessage(tabId, manifestReady(entry, request));
  void broadcastPanelState();
}

async function notifyManifestError(tabId, request, error, retryable) {
  if (runtimeState.active_tab_id === tabId && runtimeState.video_key === request.video_key) {
    runtimeState.pending_job = null;
    runtimeState.status = "error";
    runtimeState.error = errorMessage(error);
    await persistRuntimeState();
  }
  await chrome.alarms.clear("voice-bridge-job");
  chrome.notifications.create(`voice-bridge-failed-${request.video_key}`, {
    type: "basic",
    iconUrl: "icon128.svg",
    title: "VOICE BRIDGE 처리 실패",
    message: errorMessage(error),
  }).catch(() => {});
  await safeTabMessage(tabId, makeError("MANIFEST_FAILED", errorMessage(error), retryable, request.request_id));
  void broadcastPanelState();
}

async function handleManifestGet(msg, sender) {
  await initialize();
  const request = validateManifestRequest(msg);
  const tabId = requireContentSender(sender, request.request_id);

  if (runtimeState.video_key && runtimeState.video_key !== request.video_key) {
    await sendEngineMessage({ type: "STOP", reason: "video-replace", request_id: request.request_id }, false).catch(() => {});
  }
  runtimeState.video_key = request.video_key;
  runtimeState.revision = null;
  runtimeState.segment_id = null;
  runtimeState.status = "loading";
  runtimeState.error = null;
  await persistRuntimeState();
  void broadcastPanelState();

  const pending = runtimeState.pending_job;
  if (pending && pending.video_key === request.video_key && pending.job_id) {
    startJobPolling(pending, tabId);
    return processingMessage(pending);
  }

  let result = await getManifestResponse(request, true);
  if (result.kind === "missing") result = await createJob(request);

  if (result.kind === "ready") {
    runtimeState.pending_job = null;
    runtimeState.revision = result.entry.revision;
    runtimeState.status = "ready";
    await persistRuntimeState();
    void broadcastPanelState();
    return manifestReady(result.entry, request, result.stale);
  }

  const newPending = await setPendingJob(request, result);
  startJobPolling(newPending, tabId);
  void broadcastPanelState();
  return processingMessage(newPending);
}

async function offscreenDocumentExists() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await offscreenDocumentExists()) return;
  if (offscreenCreationPromise) return offscreenCreationPromise;
  offscreenCreationPromise = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "검증된 화면해설 음원을 미리 불러오고 영상 시점에 맞춰 재생합니다.",
    })
    .catch((error) => {
      const message = errorMessage(error).toLowerCase();
      if (!message.includes("single offscreen") && !message.includes("already exists")) throw error;
    })
    .finally(() => {
      offscreenCreationPromise = null;
    });
  return offscreenCreationPromise;
}

async function sendEngineMessage(message, create = true) {
  if (create) await ensureOffscreen();
  return chrome.runtime.sendMessage(message);
}

function cachedEntryForAudio(videoKey, revision) {
  const entry = manifestCache[videoKey];
  if (!entry || entry.revision !== revision || runtimeState.video_key !== videoKey || runtimeState.revision !== revision) {
    throw new Error("현재 매니페스트 revision과 오디오 요청이 일치하지 않습니다.");
  }
  return entry;
}

function trustedSegment(entry, segmentId) {
  if (typeof segmentId !== "string" || !SEGMENT_ID_RE.test(segmentId)) throw new Error("segment_id가 올바르지 않습니다.");
  const segment = entry.manifest.segments.find((item) => item.id === segmentId);
  if (!segment) throw new Error("캐시된 매니페스트에 없는 segment_id입니다.");
  return {
    segment_id: segment.id,
    audio_url: trustedAudioUrl(segment.audio.path, segment.audio.sha256),
    sha256: segment.audio.sha256.toLowerCase(),
    duration_ms: segment.audio.duration_ms,
  };
}

async function handleAudioPreload(msg, sender) {
  await initialize();
  const requestId = typeof msg.request_id === "string" ? msg.request_id : makeRequestId("preload");
  requireContentSender(sender, requestId);
  if (!Array.isArray(msg.segment_ids) || msg.segment_ids.length > 10) {
    return makeError("INVALID_SEGMENTS", "segment_ids는 최대 10개 배열이어야 합니다.", false, requestId);
  }
  const entry = cachedEntryForAudio(msg.video_key, msg.revision);
  const uniqueIds = [...new Set(msg.segment_ids)];
  const loaded = [];
  const failed = [];

  await Promise.all(
    uniqueIds.map(async (segmentId) => {
      try {
        const clip = trustedSegment(entry, segmentId);
        const response = await sendEngineMessage({
          type: "CLIP_LOAD",
          video_key: msg.video_key,
          revision: msg.revision,
          request_id: requestId,
          ...clip,
        });
        if (!response || response.type !== "READY") throw new Error(response && response.error ? response.error.message : "preload 실패");
        loaded.push(segmentId);
      } catch (error) {
        failed.push({ segment_id: segmentId, error: errorMessage(error) });
      }
    })
  );

  return { type: "PRELOAD_RESULT", request_id: requestId, loaded, failed };
}

async function handleAudioPlay(msg, sender) {
  await initialize();
  const requestId = typeof msg.request_id === "string" ? msg.request_id : makeRequestId("play");
  requireContentSender(sender, requestId);
  const entry = cachedEntryForAudio(msg.video_key, msg.revision);
  const clip = trustedSegment(entry, msg.segment_id);
  const delayMs = Number.isFinite(msg.delay_ms) ? clamp(Math.round(msg.delay_ms), 0, 10000) : 0;
  const playbackRate = Number.isFinite(msg.playback_rate) ? clamp(msg.playback_rate, 0.25, 4) : 1;
  const response = await sendEngineMessage({
    type: "PLAY",
    video_key: msg.video_key,
    revision: msg.revision,
    request_id: requestId,
    delay_ms: delayMs,
    playback_rate: playbackRate,
    ...clip,
  });
  if (!response || response.type !== "STARTED") {
    return { ...makeError("AUDIO_PLAY_FAILED", response && response.error ? response.error.message : "오디오 엔진 재생 실패", true, requestId), type: "AUDIO_ERROR", segment_id: msg.segment_id };
  }
  runtimeState.status = "scheduled";
  runtimeState.segment_id = msg.segment_id;
  await persistRuntimeState();
  void broadcastPanelState();
  return {
    type: "AUDIO_STARTED",
    request_id: requestId,
    segment_id: msg.segment_id,
    scheduled: true,
    delay_ms: response.delay_ms,
  };
}

async function handleAudioPause(msg, sender) {
  await initialize();
  const requestId = typeof msg.request_id === "string" ? msg.request_id : makeRequestId("pause");
  requireContentSender(sender, requestId);
  if (runtimeState.segment_id !== msg.segment_id) {
    return { ...makeError("SEGMENT_MISMATCH", "현재 재생 중인 segment_id가 아닙니다.", false, requestId), type: "AUDIO_ERROR", segment_id: msg.segment_id };
  }
  const response = await sendEngineMessage({ type: "PAUSE", segment_id: msg.segment_id, request_id: requestId });
  if (!response || response.type !== "PAUSED") {
    return { ...makeError("AUDIO_PAUSE_FAILED", "오디오 일시정지에 실패했습니다.", true, requestId), type: "AUDIO_ERROR", segment_id: msg.segment_id };
  }
  runtimeState.status = "paused";
  await persistRuntimeState();
  void broadcastPanelState();
  return { type: "AUDIO_PAUSED", request_id: requestId, segment_id: msg.segment_id, offset_ms: response.offset_ms };
}

async function handleAudioResume(msg, sender) {
  await initialize();
  const requestId = typeof msg.request_id === "string" ? msg.request_id : makeRequestId("resume");
  requireContentSender(sender, requestId);
  const entry = cachedEntryForAudio(runtimeState.video_key, runtimeState.revision);
  const clip = trustedSegment(entry, msg.segment_id);
  const offsetMs = Number.isFinite(msg.offset_ms) ? Math.max(0, Math.round(msg.offset_ms)) : 0;
  const playbackRate = Number.isFinite(msg.playback_rate) ? clamp(msg.playback_rate, 0.25, 4) : 1;
  const response = await sendEngineMessage({
    type: "RESUME",
    video_key: runtimeState.video_key,
    revision: runtimeState.revision,
    request_id: requestId,
    offset_ms: offsetMs,
    playback_rate: playbackRate,
    ...clip,
  });
  if (!response || response.type !== "STARTED") {
    return { ...makeError("AUDIO_RESUME_FAILED", "오디오 재개에 실패했습니다.", true, requestId), type: "AUDIO_ERROR", segment_id: msg.segment_id };
  }
  runtimeState.status = "playing";
  runtimeState.segment_id = msg.segment_id;
  await persistRuntimeState();
  void broadcastPanelState();
  return { type: "AUDIO_STARTED", request_id: requestId, segment_id: msg.segment_id, scheduled: false, offset_ms: offsetMs };
}

async function handleAudioStop(msg, sender) {
  await initialize();
  const requestId = typeof msg.request_id === "string" ? msg.request_id : makeRequestId("stop");
  requireContentSender(sender, requestId);
  await sendEngineMessage({ type: "STOP", reason: String(msg.reason || "content-stop"), request_id: requestId }, false).catch(() => null);
  runtimeState.segment_id = null;
  runtimeState.status = runtimeState.enabled ? "ready" : "off";
  await persistRuntimeState();
  void broadcastPanelState();
  return { type: "AUDIO_STOPPED", request_id: requestId, reason: String(msg.reason || "content-stop") };
}

async function handleEngineState(msg, sender) {
  await initialize();
  if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL(OFFSCREEN_PATH))) return { ok: false };
  const tabId = runtimeState.active_tab_id;
  if (!runtimeState.enabled || !Number.isInteger(tabId)) return { ok: true };

  let outgoing = null;
  if (msg.state === "started") {
    runtimeState.status = "playing";
    runtimeState.segment_id = msg.segment_id;
    outgoing = { type: "AUDIO_STARTED", segment_id: msg.segment_id, offset_ms: msg.offset_ms || 0, scheduled: false };
  } else if (msg.state === "ended") {
    runtimeState.status = "ready";
    runtimeState.segment_id = null;
    outgoing = { type: "AUDIO_ENDED", segment_id: msg.segment_id };
  } else if (msg.state === "paused") {
    runtimeState.status = "paused";
    outgoing = { type: "AUDIO_PAUSED", segment_id: msg.segment_id, offset_ms: msg.offset_ms || 0 };
  } else if (msg.state === "stopped") {
    runtimeState.status = "ready";
    runtimeState.segment_id = null;
    outgoing = { type: "AUDIO_STOPPED", segment_id: msg.segment_id, reason: msg.reason };
  } else if (msg.state === "error") {
    if (msg.operation === "CLIP_LOAD") return { ok: true };
    runtimeState.status = "error";
    runtimeState.error = msg.error_code || "AUDIO_ENGINE_ERROR";
    runtimeState.segment_id = null;
    outgoing = {
      type: "AUDIO_ERROR",
      segment_id: msg.segment_id,
      error: { code: msg.error_code || "AUDIO_ENGINE_ERROR", message: msg.message || "오디오 엔진 오류", retryable: true },
    };
  }

  if (outgoing) {
    await persistRuntimeState();
    await safeTabMessage(tabId, outgoing);
    void broadcastPanelState();
  }
  return { ok: true };
}

async function safeTabMessage(tabId, message) {
  if (!Number.isInteger(tabId)) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_error) {
    return null;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

async function pingTab(tabId) {
  const response = await safeTabMessage(tabId, { type: "PANEL_PING" });
  return response && response.supported ? response : null;
}

async function panelStateForTab(tab, includeHealth = false) {
  const tabId = tab && Number.isInteger(tab.id) ? tab.id : null;
  const ping = tabId === null ? null : await pingTab(tabId);
  const health = includeHealth ? await checkHealth(false) : healthSnapshot;
  const isActive = runtimeState.enabled && runtimeState.active_tab_id === tabId;
  return {
    type: "PANEL_STATE",
    tab_id: tabId,
    supported: !!ping,
    enabled: isActive,
    status: isActive ? runtimeState.status : "off",
    video_id: ping ? ping.video_id : null,
    title: ping ? ping.title : null,
    video_key: isActive ? runtimeState.video_key : null,
    revision: isActive ? runtimeState.revision : null,
    segment_id: isActive ? runtimeState.segment_id : null,
    error: isActive ? runtimeState.error : null,
    job: isActive ? runtimeState.pending_job : null,
    duck_factor: settings.duck_factor,
    auto_pause: settings.auto_pause,
    api_origin: API_ORIGIN,
    backend_ok: health.ok,
  };
}

async function broadcastPanelState() {
  await initialize();
  const tab = await activeTab();
  const panelState = await panelStateForTab(tab, false);
  const progress = panelState.job && Number.isFinite(panelState.job.progress_percent)
    ? String(Math.round(panelState.job.progress_percent))
    : panelState.status === "error" ? "!" : "";
  await chrome.action.setBadgeText({ text: progress });
  if (progress) await chrome.action.setBadgeBackgroundColor({ color: panelState.status === "error" ? "#B42318" : "#075985" });
  chrome.runtime.sendMessage(panelState).catch(() => {});
  return panelState;
}

async function handlePanelStateGet() {
  await initialize();
  const tab = await activeTab();
  return panelStateForTab(tab, true);
}

async function handlePanelToggle(msg) {
  await initialize();
  const tab = await activeTab();
  if (!tab || !Number.isInteger(tab.id)) return makeError("NO_ACTIVE_TAB", "활성 탭을 찾지 못했습니다.");
  const ping = await pingTab(tab.id);
  if (!ping) return makeError("UNSUPPORTED_PAGE", "지원되는 YouTube 영상 페이지를 여세요.");
  const enable = !!msg.enabled;

  if (enable) {
    if (runtimeState.enabled && runtimeState.active_tab_id !== tab.id) {
      await safeTabMessage(runtimeState.active_tab_id, { type: "FEATURE_DISABLE", reason: "active-tab-changed" });
      await sendEngineMessage({ type: "STOP", reason: "active-tab-changed", request_id: makeRequestId("stop") }, false).catch(() => {});
    }
    runtimeState = {
      ...createDefaultRuntimeState(),
      enabled: true,
      active_tab_id: tab.id,
      status: "loading",
    };
    await persistRuntimeState();
    const response = await safeTabMessage(tab.id, {
      type: "FEATURE_ENABLE",
      duck_factor: settings.duck_factor,
      auto_pause: settings.auto_pause,
    });
    if (!response || response.ok === false) {
      runtimeState.status = "error";
      runtimeState.error = response && response.error ? response.error : "콘텐츠 스크립트를 시작하지 못했습니다.";
      await persistRuntimeState();
    }
  } else if (runtimeState.active_tab_id === tab.id) {
    await safeTabMessage(tab.id, { type: "FEATURE_DISABLE", reason: "user-disabled" });
    await sendEngineMessage({ type: "STOP", reason: "disable", request_id: makeRequestId("stop") }, false).catch(() => {});
    runtimeState = createDefaultRuntimeState();
    await persistRuntimeState();
  }

  return broadcastPanelState();
}

async function handleDuckFactorSet(msg) {
  await initialize();
  if (!Number.isFinite(msg.duck_factor)) return makeError("INVALID_DUCK_FACTOR", "duck factor가 올바르지 않습니다.");
  settings.duck_factor = clamp(Math.round(msg.duck_factor * 100) / 100, 0.1, 1);
  await persistSettings();
  if (runtimeState.enabled) {
    await safeTabMessage(runtimeState.active_tab_id, { type: "SETTINGS_UPDATED", duck_factor: settings.duck_factor });
  }
  return broadcastPanelState();
}

async function handlePanelRegenerate() {
  await initialize();
  const tab = await activeTab();
  if (!tab || !Number.isInteger(tab.id)) {
    return makeError("NO_ACTIVE_TAB", "활성 탭을 찾지 못했습니다.");
  }
  const ping = await pingTab(tab.id);
  if (!ping || !runtimeState.enabled || runtimeState.active_tab_id !== tab.id) {
    return makeError("FEATURE_DISABLED", "현재 YouTube 탭에서 화면해설을 먼저 켜세요.");
  }

  const videoKey = runtimeState.video_key || buildVideoKey("youtube", ping.video_id);
  const cached = manifestCache[videoKey];
  if (!cached || !cached.manifest || !cached.manifest.video) {
    return makeError("MANIFEST_NOT_READY", "기존 화면해설이 준비된 뒤 다시 생성할 수 있습니다.");
  }
  const request = {
    provider: "youtube",
    video_id: ping.video_id,
    duration_ms: cached.manifest.video.duration_ms,
    request_id: makeRequestId("regenerate"),
    video_key: videoKey,
  };
  const result = await createJob(request, true);
  if (result.kind === "ready") {
    return makeError("REGENERATE_NOT_STARTED", "새 분석 작업을 시작하지 못했습니다.", true);
  }
  const pending = await setPendingJob(request, result);
  startJobPolling(pending, tab.id);
  await safeTabMessage(tab.id, processingMessage(pending));
  return broadcastPanelState();
}

async function handleAutoPauseSet(msg) {
  await initialize();
  settings.auto_pause = !!msg.auto_pause;
  await persistSettings();
  if (runtimeState.enabled) {
    await safeTabMessage(runtimeState.active_tab_id, {
      type: "SETTINGS_UPDATED",
      auto_pause: settings.auto_pause,
    });
  }
  return broadcastPanelState();
}

async function handleStateGet(sender) {
  await initialize();
  const tabId = sender.tab && sender.tab.id;
  return {
    enabled: runtimeState.enabled && runtimeState.active_tab_id === tabId,
    status: runtimeState.active_tab_id === tabId ? runtimeState.status : "off",
    duck_factor: settings.duck_factor,
    auto_pause: settings.auto_pause,
  };
}

async function handleContentStatus(msg, sender) {
  await initialize();
  if (!sender.tab || sender.tab.id !== runtimeState.active_tab_id) return { ok: false };
  if (typeof msg.status === "string") runtimeState.status = msg.status;
  if (typeof msg.error === "string") runtimeState.error = msg.error;
  if (msg.error === null) runtimeState.error = null;
  await persistRuntimeState();
  void broadcastPanelState();
  return { ok: true };
}

const MESSAGE_HANDLERS = {
  MANIFEST_GET: handleManifestGet,
  AUDIO_PRELOAD: handleAudioPreload,
  AUDIO_PLAY: handleAudioPlay,
  AUDIO_PAUSE: handleAudioPause,
  AUDIO_RESUME: handleAudioResume,
  AUDIO_STOP: handleAudioStop,
  ENGINE_STATE: handleEngineState,
  PANEL_STATE_GET: handlePanelStateGet,
  PANEL_TOGGLE: handlePanelToggle,
  PANEL_REGENERATE: handlePanelRegenerate,
  PANEL_DUCK_SET: handleDuckFactorSet,
  PANEL_AUTO_PAUSE_SET: handleAutoPauseSet,
  STATE_GET: (_msg, sender) => handleStateGet(sender),
  CONTENT_STATUS: handleContentStatus,
  HEALTH_CHECK: () => checkHealth(true).then(() => broadcastPanelState()),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  const handler = MESSAGE_HANDLERS[msg.type];
  if (!handler) return undefined;

  Promise.resolve(handler(msg, sender))
    .then((response) => sendResponse(response))
    .catch((error) => {
      const requestId = error.requestId || msg.request_id || null;
      sendResponse(makeError(error.code || "EXTENSION_ERROR", errorMessage(error), true, requestId));
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void initialize().then(async () => {
    if (runtimeState.active_tab_id !== tabId) return;
    await sendEngineMessage({ type: "STOP", reason: "tab-closed", request_id: makeRequestId("stop") }, false).catch(() => {});
    runtimeState = createDefaultRuntimeState();
    await persistRuntimeState();
    void broadcastPanelState();
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void initialize().then(async () => {
    if (runtimeState.enabled && runtimeState.active_tab_id !== tabId) {
      const previousTabId = runtimeState.active_tab_id;
      await safeTabMessage(previousTabId, { type: "FEATURE_DISABLE", reason: "tab-switched" });
      await sendEngineMessage({ type: "STOP", reason: "active-tab-changed", request_id: makeRequestId("stop") }, false).catch(() => {});
      runtimeState = createDefaultRuntimeState();
      await persistRuntimeState();
    }
    void broadcastPanelState();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  void initialize().then(async () => {
    if (runtimeState.active_tab_id !== tabId || isYouTubeUrl(changeInfo.url)) return;
    await sendEngineMessage({ type: "STOP", reason: "navigation", request_id: makeRequestId("stop") }, false).catch(() => {});
    runtimeState = createDefaultRuntimeState();
    await persistRuntimeState();
    void broadcastPanelState();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "voice-bridge-job") return;
  void initialize().then(() => {
    const pending = runtimeState.pending_job;
    if (runtimeState.enabled && pending && Number.isInteger(runtimeState.active_tab_id)) {
      startJobPolling(pending, runtimeState.active_tab_id);
    }
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "announce-progress") return;
  void initialize().then(() => {
    const pending = runtimeState.pending_job;
    const message = pending
      ? `${pending.stage || "처리 중"}, ${Math.round(pending.progress_percent || 0)}퍼센트`
      : runtimeState.status === "ready" ? "화면해설 준비 완료" : "진행 중인 작업이 없습니다.";
    return chrome.notifications.create("voice-bridge-progress", {
      type: "basic",
      iconUrl: "icon128.svg",
      title: "VOICE BRIDGE 진행 상태",
      message,
    });
  }).catch(() => {});
});

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (chrome.sidePanel && chrome.sidePanel.open) {
  chrome.action.onClicked.addListener((tab) => {
    if (tab && Number.isInteger(tab.id)) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  });
}

void initialize();
