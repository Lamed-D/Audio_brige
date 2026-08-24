import {
  isExtensionMessage,
  type AudioEnginePlayRequest,
  type AudioEngineResponse,
  type AudioEngineStopRequest,
  type OffscreenAudioPlayCommand,
  type OffscreenAudioStopCommand,
  type RuntimeStatusResponse,
  isSchedulerStatus,
} from '../shared/contracts/messages';
import {
  PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY,
  shouldPollJob,
  type JobStatus,
  type PendingProgressAnnouncement,
} from '../shared/contracts/job-status';
import { SUPPORTED_SCHEMA_VERSION } from '../shared/contracts/manifest';
import { API_BASE_URL } from '../shared/config/constants';
import { isPlayerContext, type JobTarget, type PlayerContextGet } from '../shared/contracts/messages';
import { JobClient } from './job-client';

const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const BACKEND_ORIGIN = new URL(API_BASE_URL).origin;
const PROGRESS_ANNOUNCEMENT_MAX_AGE_MS = 10000;
const JOB_MONITOR_ALARM = 'voice-bridge-job-monitor';
const JOB_NOTIFICATION_PREFIX = 'voice-bridge-job:';
const DEMO_MANIFEST_ID = 'youtube:dQw4w9WgXcQ:r1';
const DEMO_AUDIO_PATHS = new Map<string, string>([
  ['/v1/audio/seg-001.wav', 'demo-audio/seg-001.wav'],
  ['/v1/audio/seg-002.wav', 'demo-audio/seg-002.wav'],
]);

let creatingOffscreenDocument: Promise<void> | null = null;
const jobClient = new JobClient(API_BASE_URL);

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
  }
  const pending: PendingProgressAnnouncement = {
    video_key: job.video_key,
    requested_at: Date.now(),
    job,
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
  if (command !== 'announce-progress') {
    return;
  }
  if (tab?.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
    void queueProgressAnnouncement(tab);
    return;
  }
  void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([activeTab]) => {
    if (!activeTab) {
      return;
    }
    if (activeTab.windowId !== undefined) {
      void chrome.sidePanel.open({ windowId: activeTab.windowId });
    }
    void queueProgressAnnouncement(activeTab);
  });
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

function resolveAudioUrl(audioPath: string, manifestId: string): string {
  const demoPath =
    manifestId === DEMO_MANIFEST_ID ? DEMO_AUDIO_PATHS.get(audioPath) : undefined;
  if (demoPath) {
    return chrome.runtime.getURL(demoPath);
  }
  const url = new URL(audioPath, API_BASE_URL);
  if (url.origin !== BACKEND_ORIGIN || !url.pathname.startsWith('/v1/audio/')) {
    throw new Error('Invalid audio path');
  }
  return url.toString();
}

async function playAudio(message: AudioEnginePlayRequest): Promise<AudioEngineResponse> {
  try {
    await ensureOffscreenDocument();
    const command: OffscreenAudioPlayCommand = {
      type: 'OFFSCREEN_AUDIO_PLAY',
      request_id: message.request_id,
      manifest_id: message.manifest_id,
      segment_id: message.segment_id,
      audio_url: resolveAudioUrl(message.audio_path, message.manifest_id),
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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) {
    return false;
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
    void playAudio(message).then(sendResponse);
    return true;
  }
  if (message.type === 'AUDIO_ENGINE_STOP') {
    void stopAudio(message).then(sendResponse);
    return true;
  }
  if (message.type === 'JOB_STATUS_GET') {
    void jobClient.getStatus(message).then((status) => {
      void setJobBadge(status);
      sendResponse(status);
    });
    return true;
  }
  if (message.type === 'JOB_CREATE') {
    void jobClient.create(message).then((status) => {
      void setJobBadge(status);
      void restoreJobMonitor();
      sendResponse(status);
    });
    return true;
  }
  return false;
});
