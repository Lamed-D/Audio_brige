import {
  isExtensionMessage,
  type AudioEnginePlayRequest,
  type AudioEngineResponse,
  type AudioEngineStopRequest,
  type OffscreenAudioPlayCommand,
  type OffscreenAudioStopCommand,
  type RuntimeStatusResponse,
  isSchedulerStatus,
  type ManifestRefresh,
} from '../shared/contracts/messages';
import {
  PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY,
  shouldPollJob,
  type JobStatus,
  type PendingProgressAnnouncement,
} from '../shared/contracts/job-status';
import {
  PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY,
  playbackPositionAnnouncement,
  type FeedbackTone,
  type PendingAccessibilityAnnouncement,
} from '../shared/accessibility/announcements';
import {
  ACCESSIBILITY_SETTINGS_STORAGE_KEY,
  parseStoredAccessibilitySettings,
} from '../shared/settings/accessibility-settings';
import {
  jobStatusSpeech,
  panelVisibilitySpeech,
  shouldCreateJobFromShortcut,
} from '../shared/accessibility/shortcut-speech';
import { SUPPORTED_SCHEMA_VERSION } from '../shared/contracts/manifest';
import { API_BASE_URL } from '../shared/config/constants';
import {
  isPlayerContext,
  type AccessibilityAnnounce,
  type DescriptionEnabledSet,
  type JobTarget,
  type PlayerContextGet,
  type SchedulerStatusGet,
} from '../shared/contracts/messages';
import { JobClient } from './job-client';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const BACKEND_ORIGIN = new URL(API_BASE_URL).origin;
const PROGRESS_ANNOUNCEMENT_MAX_AGE_MS = 10000;
const ACCESSIBILITY_ANNOUNCEMENT_MAX_AGE_MS = 10000;
const JOB_MONITOR_ALARM = 'voice-bridge-job-monitor';
const JOB_NOTIFICATION_PREFIX = 'voice-bridge-job:';

let creatingOffscreenDocument: Promise<void> | null = null;
const jobClient = new JobClient(API_BASE_URL);

async function speakShortcut(text: string): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(ACCESSIBILITY_SETTINGS_STORAGE_KEY);
    const settings = parseStoredAccessibilitySettings(
      stored[ACCESSIBILITY_SETTINGS_STORAGE_KEY],
    );
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
  } catch (error: unknown) {
    console.error('[VOICE BRIDGE] Shortcut TTS failed.', error);
    return false;
  }
}

async function configureSidePanel(): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

void configureSidePanel().catch((error: unknown) => {
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

async function activeJobTarget(tab: chrome.tabs.Tab): Promise<JobTarget | null> {
  if (tab.id === undefined) {
    return null;
  }
  try {
    const request: PlayerContextGet = { type: 'PLAYER_CONTEXT_GET' };
    const context: unknown = await chrome.tabs.sendMessage(tab.id, request);
    if (!isPlayerContext(context) || !context.available) {
      return null;
    }
    return {
      provider: context.provider,
      video_id: context.video_id,
      duration_ms: context.duration_ms,
    };
  } catch {
    return null;
  }
}

async function queueProgressAnnouncement(tab: chrome.tabs.Tab): Promise<void> {
  const target = await activeJobTarget(tab);
  let job: JobStatus = {
    status: 'unavailable',
    video_key: null,
    reason: 'unsupported_page',
  };
  let creationRequested = false;
  let waitingForMetadata = false;
  if (target) {
    try {
      const scheduler: unknown =
        tab.id === undefined
          ? null
          : await chrome.tabs.sendMessage(tab.id, { type: 'SCHEDULER_STATUS_GET' });
      job =
        isSchedulerStatus(scheduler) && scheduler.active
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
    } catch {
      job = await jobClient.getStatus(target);
    }
    if (shouldCreateJobFromShortcut(job)) {
      if (target.duration_ms === null) {
        waitingForMetadata = true;
      } else {
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
      ? `화면해설 생성을 요청했습니다. ${jobStatusSpeech(job)}`
      : jobStatusSpeech(job);
  const speechHandled = await speakShortcut(speechText);
  const pending: PendingProgressAnnouncement = {
    video_key: job.video_key,
    requested_at: Date.now(),
    job,
    speech_handled: speechHandled,
  };
  await chrome.storage.session.set({
    [PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY]: pending,
  });
  globalThis.setTimeout(() => {
    void chrome.storage.session.get(PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY).then((stored) => {
      const value = stored[PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY] as
        | PendingProgressAnnouncement
        | undefined;
      if (value && Date.now() - value.requested_at >= PROGRESS_ANNOUNCEMENT_MAX_AGE_MS) {
        void chrome.storage.session.remove(PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY);
      }
    });
  }, PROGRESS_ANNOUNCEMENT_MAX_AGE_MS);
}

async function queueAccessibilityAnnouncement(
  text: string,
  tone: FeedbackTone,
  urgency: PendingAccessibilityAnnouncement['urgency'] = 'polite',
  speechHandled = false,
): Promise<void> {
  const pending: PendingAccessibilityAnnouncement = {
    id: crypto.randomUUID(),
    text,
    requested_at: Date.now(),
    urgency,
    tone,
    speech_handled: speechHandled,
  };
  await chrome.storage.session.set({
    [PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY]: pending,
  });
  globalThis.setTimeout(() => {
    void chrome.storage.session
      .get(PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY)
      .then((stored) => {
        const value = stored[PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY] as
          | PendingAccessibilityAnnouncement
          | undefined;
        if (value?.id === pending.id) {
          void chrome.storage.session.remove(
            PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY,
          );
        }
      });
  }, ACCESSIBILITY_ANNOUNCEMENT_MAX_AGE_MS);
}

async function openSidePanel(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

async function deliverAccessibilityAnnouncement(
  tab: chrome.tabs.Tab,
  text: string,
  tone: FeedbackTone,
  urgency: PendingAccessibilityAnnouncement['urgency'] = 'polite',
): Promise<void> {
  const speechHandled = await speakShortcut(text);
  if (tab.id !== undefined) {
    try {
      const message: AccessibilityAnnounce = {
        type: 'ACCESSIBILITY_ANNOUNCE',
        text,
        urgency,
        tone,
        speech_handled: speechHandled,
      };
      const response: unknown = await chrome.tabs.sendMessage(tab.id, message);
      if (
        typeof response === 'object' &&
        response !== null &&
        (response as Record<string, unknown>).ok === true
      ) {
        return;
      }
    } catch {
      // Fall back to the extension Side Panel when the active page has no content script.
    }
  }
  await openSidePanel(tab);
  await queueAccessibilityAnnouncement(text, tone, urgency, speechHandled);
}

async function announcePlaybackPosition(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) {
    await deliverAccessibilityAnnouncement(
      tab,
      '현재 영상 정보를 확인할 수 없습니다.',
      'error',
      'assertive',
    );
    return;
  }
  try {
    const request: PlayerContextGet = { type: 'PLAYER_CONTEXT_GET' };
    const context: unknown = await chrome.tabs.sendMessage(tab.id, request);
    if (!isPlayerContext(context) || !context.available) {
      throw new Error('Player unavailable');
    }
    await deliverAccessibilityAnnouncement(
      tab,
      playbackPositionAnnouncement(context),
      'action',
    );
  } catch {
    await deliverAccessibilityAnnouncement(
      tab,
      '지원하는 유튜브 영상을 찾지 못했습니다.',
      'error',
      'assertive',
    );
  }
}

async function toggleDescription(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) {
    await deliverAccessibilityAnnouncement(
      tab,
      '화면해설 설정을 변경할 수 없습니다.',
      'error',
      'assertive',
    );
    return;
  }
  try {
    const statusRequest: SchedulerStatusGet = { type: 'SCHEDULER_STATUS_GET' };
    const current: unknown = await chrome.tabs.sendMessage(tab.id, statusRequest);
    if (!isSchedulerStatus(current)) {
      throw new Error('Scheduler unavailable');
    }
    const enabled = !current.settings.enabled;
    const updateRequest: DescriptionEnabledSet = {
      type: 'DESCRIPTION_ENABLED_SET',
      enabled,
    };
    const updated: unknown = await chrome.tabs.sendMessage(tab.id, updateRequest);
    if (!isSchedulerStatus(updated) || updated.settings.enabled !== enabled) {
      throw new Error('Setting update failed');
    }
    await deliverAccessibilityAnnouncement(
      tab,
      enabled ? '화면해설을 켰습니다.' : '화면해설을 껐습니다.',
      enabled ? 'toggle-on' : 'toggle-off',
    );
  } catch {
    await deliverAccessibilityAnnouncement(
      tab,
      '화면해설 설정을 변경하지 못했습니다.',
      'error',
      'assertive',
    );
  }
}

async function setJobBadge(status: JobStatus | null): Promise<void> {
  if (status && shouldPollJob(status)) {
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

async function refreshReadyManifest(status: JobStatus): Promise<void> {
  if (status.status !== 'ready') {
    return;
  }
  const message: ManifestRefresh = {
    type: 'MANIFEST_REFRESH',
    video_key: status.video_key,
  };
  const tabs = await chrome.tabs.query({ active: true });
  await Promise.allSettled(
    tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => chrome.tabs.sendMessage(tab.id as number, message)),
  );
}

async function notifyTerminalStatus(status: JobStatus): Promise<void> {
  if (status.status !== 'ready' && status.status !== 'failed') {
    return;
  }
  const title = status.status === 'ready' ? '화면해설 준비 완료' : '화면해설 생성 실패';
  const message =
    status.status === 'ready'
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

async function restoreJobMonitor(): Promise<void> {
  const targets = await jobClient.listPollingTargets();
  if (targets.length === 0) {
    await chrome.alarms.clear(JOB_MONITOR_ALARM);
    await setJobBadge(null);
    return;
  }
  await chrome.alarms.create(JOB_MONITOR_ALARM, { periodInMinutes: 1 });
}

async function monitorJobs(): Promise<void> {
  const targets = await jobClient.listPollingTargets();
  if (targets.length === 0) {
    await restoreJobMonitor();
    return;
  }
  let badgeStatus: JobStatus | null = null;
  for (const target of targets) {
    const status = await jobClient.getStatus(target);
    if (shouldPollJob(status)) {
      badgeStatus = status;
    } else if (status.status === 'ready' || status.status === 'failed') {
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
    } else if (command === 'announce-current-video-time') {
      await announcePlaybackPosition(activeTab);
    } else if (command === 'toggle-audio-description') {
      await toggleDescription(activeTab);
    }
  })();
});

async function ensureOffscreenDocument(): Promise<void> {
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

function resolveAudioUrl(audioPath: string): string {
  const url = new URL(audioPath, API_BASE_URL);
  if (
    url.origin !== BACKEND_ORIGIN ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !/^\/v1\/audio\/[a-f0-9]{64}\.wav$/.test(url.pathname)
  ) {
    throw new Error('Invalid audio path');
  }
  return url.toString();
}

function isYouTubeUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'))
    );
  } catch {
    return false;
  }
}

async function isTrustedAudioSender(sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (sender.tab?.id === undefined || !isYouTubeUrl(sender.url ?? sender.tab.url)) {
    return false;
  }
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id === sender.tab.id;
}

async function playAudio(
  message: AudioEnginePlayRequest,
  sender: chrome.runtime.MessageSender,
): Promise<AudioEngineResponse> {
  try {
    if (!(await isTrustedAudioSender(sender))) {
      return { ok: false, request_id: message.request_id, error: 'invalid_request' };
    }
    await ensureOffscreenDocument();
    const command: OffscreenAudioPlayCommand = {
      type: 'OFFSCREEN_AUDIO_PLAY',
      request_id: message.request_id,
      manifest_id: message.manifest_id,
      segment_id: message.segment_id,
      audio_url: resolveAudioUrl(message.audio_path),
      expected_duration_ms: message.expected_duration_ms,
      playback_rate: message.playback_rate,
      volume: message.volume,
    };
    return (await chrome.runtime.sendMessage(command)) as AudioEngineResponse;
  } catch {
    return { ok: false, request_id: message.request_id, error: 'play_failed' };
  }
}

async function stopAudio(message: AudioEngineStopRequest): Promise<{ ok: true }> {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [documentUrl],
  });
  if (contexts.length === 0) {
    return { ok: true };
  }
  const command: OffscreenAudioStopCommand = {
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

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isExtensionMessage(message)) {
    return false;
  }
  if (message.type === 'PANEL_VISIBILITY_CHANGED') {
    void speakShortcut(panelVisibilitySpeech(message.visible)).then((spoken) => {
      sendResponse({ ok: true, spoken });
    });
    return true;
  }
  if (message.type === 'RUNTIME_STATUS_GET') {
    const response: RuntimeStatusResponse = {
      ok: true,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
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
