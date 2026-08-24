import {
  isPlayerContext,
  isSchedulerStatus,
  type JobCreate,
  type JobStatusGet,
  type JobTarget,
  type PlayerContext,
  type PlayerContextGet,
  type PlaybackSettingsSet,
  type RuntimeStatusRequest,
  type RuntimeStatusResponse,
  type SchedulerStatus,
  type SchedulerStatusGet,
} from '../shared/contracts/messages';
import {
  isJobStatus,
  isPendingProgressAnnouncement,
  PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY,
  shouldPollJob,
  type JobStatus,
} from '../shared/contracts/job-status';
import {
  DEFAULT_PLAYBACK_SETTINGS,
  parseStoredPlaybackSettings,
  PLAYBACK_SETTINGS_STORAGE_KEY,
  type PlaybackSettings,
} from '../shared/settings/playback-settings';
import {
  JobAnnouncementTracker,
  jobProgressView,
} from './job-progress';

const statusElement = document.querySelector<HTMLElement>('#runtime-status');
const versionElement = document.querySelector<HTMLElement>('#extension-version');
const schemaElement = document.querySelector<HTMLElement>('#schema-version');
const playerStatusElement = document.querySelector<HTMLElement>('#player-status');
const playerTitleElement = document.querySelector<HTMLElement>('#player-title');
const providerElement = document.querySelector<HTMLElement>('#player-provider');
const videoIdElement = document.querySelector<HTMLElement>('#player-video-id');
const playbackStateElement = document.querySelector<HTMLElement>('#player-state');
const positionElement = document.querySelector<HTMLElement>('#player-position');
const playbackRateElement = document.querySelector<HTMLElement>('#player-rate');
const schedulerStatusElement = document.querySelector<HTMLElement>('#scheduler-status');
const manifestIdElement = document.querySelector<HTMLElement>('#scheduler-manifest-id');
const progressElement = document.querySelector<HTMLElement>('#scheduler-progress');
const nextSegmentElement = document.querySelector<HTMLElement>('#scheduler-next');
const lastEventElement = document.querySelector<HTMLElement>('#scheduler-last-event');
const audioStateElement = document.querySelector<HTMLElement>('#scheduler-audio-state');
const descriptionEnabledElement =
  document.querySelector<HTMLInputElement>('#description-enabled');
const descriptionVolumeElement =
  document.querySelector<HTMLInputElement>('#description-volume');
const descriptionVolumeOutputElement =
  document.querySelector<HTMLOutputElement>('#description-volume-output');
const duckFactorElement = document.querySelector<HTMLInputElement>('#duck-factor');
const duckFactorOutputElement =
  document.querySelector<HTMLOutputElement>('#duck-factor-output');
const autoPauseEnabledElement =
  document.querySelector<HTMLInputElement>('#auto-pause-enabled');
const currentDescriptionElement =
  document.querySelector<HTMLElement>('#current-description-text');
const accessibilityAnnouncementElement =
  document.querySelector<HTMLElement>('#accessibility-announcement');
const generationStatusElement =
  document.querySelector<HTMLElement>('#generation-status');
const jobSummaryElement = document.querySelector<HTMLElement>('#job-summary');
const jobProgressContentElement =
  document.querySelector<HTMLElement>('#job-progress-content');
const jobStageElement = document.querySelector<HTMLElement>('#job-stage');
const jobProgressElement = document.querySelector<HTMLProgressElement>('#job-progress');
const jobProgressOutputElement =
  document.querySelector<HTMLOutputElement>('#job-progress-output');
const jobEtaElement = document.querySelector<HTMLElement>('#job-eta');
const jobCreateElement = document.querySelector<HTMLButtonElement>('#job-create');
const jobStatusCheckElement =
  document.querySelector<HTMLButtonElement>('#job-status-check');
const jobRetryElement = document.querySelector<HTMLButtonElement>('#job-retry');

let activeTabId: number | null = null;
let playerRequestInFlight = false;
let contentConnected = false;
let settingsRequestVersion = 0;
let settingsInteractionActive = false;
let currentSettings: PlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
let lastAudioState: SchedulerStatus['audio_state'] = 'idle';
let activeJobTarget: JobTarget | null = null;
let currentJobStatus: JobStatus | null = null;
let jobRequestInFlight = false;
let nextJobPollAt = 0;
let announcementTimer: number | null = null;
const jobAnnouncementTracker = new JobAnnouncementTracker();
const PENDING_ANNOUNCEMENT_MAX_AGE_MS = 10000;

const PLAYBACK_STATE_LABELS = {
  playing: '재생 중',
  paused: '일시정지',
  ended: '재생 완료',
} as const;

function announce(text: string): void {
  if (!accessibilityAnnouncementElement) {
    return;
  }
  if (announcementTimer !== null) {
    window.clearTimeout(announcementTimer);
  }
  accessibilityAnnouncementElement.textContent = '';
  announcementTimer = window.setTimeout(() => {
    accessibilityAnnouncementElement.textContent = text;
    announcementTimer = null;
  }, 40);
}

function setHidden(element: HTMLElement | null, hidden: boolean): void {
  if (element) {
    element.hidden = hidden;
  }
}

function activeVideoKey(): string | null {
  return activeJobTarget
    ? `${activeJobTarget.provider}:${activeJobTarget.video_id}`
    : null;
}

function formatTime(milliseconds: number | null): string {
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

function renderFailure(): void {
  if (statusElement) {
    statusElement.textContent = '연결 오류';
    statusElement.dataset.state = 'error';
  }
}

async function loadRuntimeStatus(): Promise<void> {
  const request: RuntimeStatusRequest = { type: 'RUNTIME_STATUS_GET' };
  const response = (await chrome.runtime.sendMessage(request)) as RuntimeStatusResponse | undefined;

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

function renderPlayerContext(context: PlayerContext): void {
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
    positionElement.textContent = `${formatTime(context.current_time_ms)} / ${formatTime(
      context.duration_ms,
    )}`;
  }
  if (playbackRateElement) {
    playbackRateElement.textContent = `${context.playback_rate}x`;
  }
}

function unavailableSchedulerStatus(): SchedulerStatus {
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

function renderRangeValue(
  input: HTMLInputElement | null,
  output: HTMLOutputElement | null,
): void {
  if (!input || !output) {
    return;
  }
  const text = `${input.value}%`;
  output.textContent = text;
  input.setAttribute('aria-valuetext', text);
}

function renderSettings(settings: PlaybackSettings): void {
  currentSettings = { ...settings };
  if (descriptionEnabledElement) {
    descriptionEnabledElement.checked = settings.enabled;
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

function hideGenerationStatus(): void {
  setHidden(generationStatusElement, true);
  if (generationStatusElement) {
    generationStatusElement.setAttribute('aria-busy', 'false');
  }
}

function renderJobLoading(): void {
  setHidden(generationStatusElement, false);
  setHidden(jobProgressContentElement, true);
  setHidden(jobCreateElement, true);
  setHidden(jobStatusCheckElement, true);
  setHidden(jobRetryElement, true);
  if (jobSummaryElement) {
    jobSummaryElement.textContent = '화면해설 생성 상태 확인 중';
  }
  if (generationStatusElement) {
    generationStatusElement.setAttribute('aria-busy', 'true');
  }
}

function renderJobStatus(status: JobStatus, allowAutomaticAnnouncement = true): void {
  currentJobStatus = status;
  const view = jobProgressView(status);
  setHidden(generationStatusElement, false);
  setHidden(jobProgressContentElement, view.percent === null);
  const canCreate =
    status.status === 'not_started' ||
    (status.status === 'failed' && status.error.retryable);
  setHidden(jobCreateElement, !canCreate);
  setHidden(
    jobStatusCheckElement,
    status.status !== 'queued' && status.status !== 'processing',
  );
  setHidden(jobRetryElement, status.status !== 'unavailable');

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
    } else {
      jobProgressElement.removeAttribute('aria-valuetext');
    }
  }
  if (jobProgressOutputElement) {
    jobProgressOutputElement.textContent = view.percent === null ? '' : `${view.percent}%`;
  }
  if (generationStatusElement) {
    generationStatusElement.setAttribute(
      'aria-busy',
      status.status === 'queued' || status.status === 'processing' ? 'true' : 'false',
    );
  }

  if (schedulerStatusElement) {
    if (status.status === 'queued' || status.status === 'processing') {
      schedulerStatusElement.textContent = '화면해설 생성 중';
      schedulerStatusElement.dataset.state = 'processing';
    } else if (status.status === 'failed') {
      schedulerStatusElement.textContent = '화면해설 생성 실패';
      schedulerStatusElement.dataset.state = 'error';
    } else if (status.status === 'unavailable') {
      schedulerStatusElement.textContent = '생성 상태 확인 오류';
      schedulerStatusElement.dataset.state = 'error';
    } else if (status.status === 'ready') {
      schedulerStatusElement.textContent = currentSettings.enabled
        ? '화면해설 준비됨'
        : '화면해설 꺼짐';
      schedulerStatusElement.dataset.state = currentSettings.enabled ? 'ready' : 'loading';
    }
  }

  if (allowAutomaticAnnouncement) {
    const message = jobAnnouncementTracker.next(status);
    if (message) {
      announce(message);
    }
  }
}

function setJobButtonsBusy(busy: boolean): void {
  for (const button of [jobCreateElement, jobStatusCheckElement, jobRetryElement]) {
    if (button && !button.hidden) {
      button.disabled = busy;
    }
  }
}

async function loadJobStatus(force = false, announceManually = false): Promise<void> {
  const target = activeJobTarget;
  if (!target || (jobRequestInFlight && !force)) {
    if (announceManually && currentJobStatus) {
      const message = jobAnnouncementTracker.next(currentJobStatus, true);
      if (message) announce(message);
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
  const request: JobStatusGet = { type: 'JOB_STATUS_GET', ...target };
  try {
    const response: unknown = await chrome.runtime.sendMessage(request);
    if (!isJobStatus(response) || response.video_key !== activeVideoKey()) {
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
      if (message) announce(message);
    }
    nextJobPollAt = shouldPollJob(response)
      ? Date.now() + response.retry_after_ms
      : Number.POSITIVE_INFINITY;
  } catch {
    const unavailable: JobStatus = {
      status: 'unavailable',
      video_key: activeVideoKey(),
      reason: 'network',
    };
    renderJobStatus(unavailable, !announceManually);
    if (announceManually) {
      const message = jobAnnouncementTracker.next(unavailable, true);
      if (message) announce(message);
    }
    nextJobPollAt = Date.now() + 5000;
  } finally {
    jobRequestInFlight = false;
    setJobButtonsBusy(false);
  }
}

async function createJob(): Promise<void> {
  const target = activeJobTarget;
  if (!target || jobRequestInFlight) {
    return;
  }
  jobRequestInFlight = true;
  setJobButtonsBusy(true);
  announce('화면해설 생성을 요청했습니다.');
  const request: JobCreate = { type: 'JOB_CREATE', ...target };
  try {
    const response: unknown = await chrome.runtime.sendMessage(request);
    if (!isJobStatus(response) || response.video_key !== activeVideoKey()) {
      renderJobStatus({
        status: 'unavailable',
        video_key: activeVideoKey(),
        reason: 'invalid_response',
      });
      return;
    }
    renderJobStatus(response);
    nextJobPollAt = shouldPollJob(response)
      ? Date.now() + response.retry_after_ms
      : Number.POSITIVE_INFINITY;
  } catch {
    renderJobStatus({ status: 'unavailable', video_key: activeVideoKey(), reason: 'network' });
  } finally {
    jobRequestInFlight = false;
    setJobButtonsBusy(false);
  }
}

function renderSchedulerStatus(status: SchedulerStatus): void {
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
    currentDescriptionElement.setAttribute(
      'aria-busy',
      status.audio_state === 'playing' ? 'true' : 'false',
    );
  }
  if (
    status.audio_state === 'error' &&
    lastAudioState !== 'error'
  ) {
    announce('화면해설 음성을 재생하지 못했습니다.');
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
    } else {
      const action = status.last_event.type === 'trigger' ? '발화 요청' : '건너뜀';
      const reason =
        status.last_event.reason === 'late'
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

async function loadPlayerContext(): Promise<void> {
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

    const request: PlayerContextGet = { type: 'PLAYER_CONTEXT_GET' };
    const response: unknown = await chrome.tabs.sendMessage(activeTabId, request);
    contentConnected = true;
    const playerContext: PlayerContext = isPlayerContext(response)
      ? response
      : { available: false, reason: 'unsupported_page' };
    renderPlayerContext(playerContext);

    const schedulerRequest: SchedulerStatusGet = { type: 'SCHEDULER_STATUS_GET' };
    const schedulerResponse: unknown = await chrome.tabs.sendMessage(
      activeTabId,
      schedulerRequest,
    );
    const schedulerStatus = isSchedulerStatus(schedulerResponse)
      ? schedulerResponse
      : unavailableSchedulerStatus();
    renderSchedulerStatus(schedulerStatus);

    if (!playerContext.available) {
      activeJobTarget = null;
      currentJobStatus = null;
      hideGenerationStatus();
      return;
    }

    const nextTarget: JobTarget = {
      provider: playerContext.provider,
      video_id: playerContext.video_id,
      duration_ms: playerContext.duration_ms,
    };
    const nextVideoKey = `${nextTarget.provider}:${nextTarget.video_id}`;
    if (nextVideoKey !== activeVideoKey()) {
      activeJobTarget = nextTarget;
      currentJobStatus = null;
      nextJobPollAt = 0;
    } else {
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
      hideGenerationStatus();
      return;
    }

    if (currentJobStatus?.video_key === nextVideoKey) {
      renderJobStatus(currentJobStatus, false);
    } else {
      renderJobLoading();
    }
    void loadJobStatus();
  } catch {
    contentConnected = false;
    activeJobTarget = null;
    currentJobStatus = null;
    hideGenerationStatus();
    renderPlayerContext({ available: false, reason: 'unsupported_page' });
    renderSchedulerStatus(unavailableSchedulerStatus());
  } finally {
    playerRequestInFlight = false;
  }
}

function sendSettings(settings: PlaybackSettings): void {
  currentSettings = { ...settings };
  renderSettings(currentSettings);
  const requestVersion = ++settingsRequestVersion;
  const tabId = activeTabId;
  const request: PlaybackSettingsSet = {
    type: 'PLAYBACK_SETTINGS_SET',
    settings,
  };
  const contentUpdate =
    tabId !== null && contentConnected
      ? chrome.tabs.sendMessage(tabId, request).catch(() => undefined)
      : Promise.resolve(undefined);
  void Promise.all([
    chrome.storage.local.set({ [PLAYBACK_SETTINGS_STORAGE_KEY]: settings }),
    contentUpdate,
  ])
    .then(([, response]: [void, unknown]) => {
      if (requestVersion === settingsRequestVersion && isSchedulerStatus(response)) {
        renderSchedulerStatus(response);
      }
    })
    .catch((error: unknown) => {
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

descriptionEnabledElement?.addEventListener('change', () => {
  sendSettings({ ...currentSettings, enabled: descriptionEnabledElement.checked });
});

descriptionVolumeElement?.addEventListener('input', () => {
  settingsInteractionActive = true;
  currentSettings.description_volume = Number(descriptionVolumeElement.value) / 100;
  renderRangeValue(descriptionVolumeElement, descriptionVolumeOutputElement);
});
descriptionVolumeElement?.addEventListener('change', () => {
  sendSettings({ ...currentSettings });
});

duckFactorElement?.addEventListener('input', () => {
  settingsInteractionActive = true;
  currentSettings.duck_factor = Number(duckFactorElement.value) / 100;
  renderRangeValue(duckFactorElement, duckFactorOutputElement);
});
duckFactorElement?.addEventListener('change', () => {
  sendSettings({ ...currentSettings });
});

autoPauseEnabledElement?.addEventListener('change', () => {
  sendSettings({
    ...currentSettings,
    auto_pause_enabled: autoPauseEnabledElement.checked,
  });
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

async function consumePendingProgressAnnouncement(value: unknown): Promise<void> {
  if (!isPendingProgressAnnouncement(value)) {
    return;
  }
  await chrome.storage.session.remove(PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY);
  if (Date.now() - value.requested_at > PENDING_ANNOUNCEMENT_MAX_AGE_MS) {
    return;
  }
  if (value.video_key !== null && activeVideoKey() !== null && value.video_key !== activeVideoKey()) {
    return;
  }
  renderJobStatus(value.job, false);
  const message = jobAnnouncementTracker.next(value.job, true);
  if (message) {
    announce(message);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session') {
    return;
  }
  const pending = changes[PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY]?.newValue;
  if (pending !== undefined) {
    void consumePendingProgressAnnouncement(pending);
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

void loadRuntimeStatus().catch((error: unknown) => {
  console.error('[VOICE BRIDGE] Runtime status request failed.', error);
  renderFailure();
});

void chrome.storage.local
  .get(PLAYBACK_SETTINGS_STORAGE_KEY)
  .then((stored) => {
    renderSettings(parseStoredPlaybackSettings(stored[PLAYBACK_SETTINGS_STORAGE_KEY]));
  })
  .catch((error: unknown) => {
    console.error('[VOICE BRIDGE] Failed to load settings.', error);
    renderSettings(DEFAULT_PLAYBACK_SETTINGS);
  });

void chrome.storage.session
  .get(PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY)
  .then((stored) =>
    consumePendingProgressAnnouncement(
      stored[PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY],
    ),
  )
  .catch((error: unknown) => {
    console.error('[VOICE BRIDGE] Failed to restore progress announcement.', error);
  });

void loadPlayerContext();
window.setInterval(() => {
  void loadPlayerContext();
}, 1000);
