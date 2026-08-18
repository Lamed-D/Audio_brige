import {
  isPlayerContext,
  isSchedulerStatus,
  type BackendHealthGet,
  type JobCreate,
  type JobStatusGet,
  type JobTarget,
  type PlayerContext,
  type PlayerContextGet,
  type PlaybackSettingsSet,
  type PanelVisibilityChanged,
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
  ACCESSIBILITY_SETTINGS_STORAGE_KEY,
  DEFAULT_ACCESSIBILITY_SETTINGS,
  parseStoredAccessibilitySettings,
  type AccessibilitySettings,
} from '../shared/settings/accessibility-settings';
import {
  isPendingAccessibilityAnnouncement,
  PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY,
  playbackPositionAnnouncement,
  type FeedbackTone,
} from '../shared/accessibility/announcements';
import {
  JobAnnouncementTracker,
  jobProgressView,
} from './job-progress';
import { FeedbackSoundPlayer } from '../shared/accessibility/feedback-sound';

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
const descriptionToggleElement =
  document.querySelector<HTMLButtonElement>('#description-toggle');
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
const accessibilityAlertElement =
  document.querySelector<HTMLElement>('#accessibility-alert');
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
const jobRegenerateElement =
  document.querySelector<HTMLButtonElement>('#job-regenerate');
const backendStatusElement = document.querySelector<HTMLElement>('#backend-status');
const backendRetryElement = document.querySelector<HTMLButtonElement>('#backend-retry');
const interactionSoundsEnabledElement =
  document.querySelector<HTMLInputElement>('#interaction-sounds-enabled');
const interactionSoundVolumeElement =
  document.querySelector<HTMLInputElement>('#interaction-sound-volume');
const interactionSoundVolumeOutputElement =
  document.querySelector<HTMLOutputElement>('#interaction-sound-volume-output');
const shortcutSpeechEnabledElement =
  document.querySelector<HTMLInputElement>('#shortcut-speech-enabled');
const positionAnnounceElement =
  document.querySelector<HTMLButtonElement>('#position-announce');

let activeTabId: number | null = null;
let playerRequestInFlight = false;
let contentConnected = false;
let settingsRequestVersion = 0;
let settingsInteractionActive = false;
let currentSettings: PlaybackSettings = { ...DEFAULT_PLAYBACK_SETTINGS };
let currentAccessibilitySettings: AccessibilitySettings = {
  ...DEFAULT_ACCESSIBILITY_SETTINGS,
};
let lastPlayerContext: PlayerContext | null = null;
let lastAudioState: SchedulerStatus['audio_state'] = 'idle';
let activeJobTarget: JobTarget | null = null;
let currentJobStatus: JobStatus | null = null;
let jobRequestInFlight = false;
let toggleRequestInFlight = false;
let nextJobPollAt = 0;
let announcementTimer: number | null = null;
let alertTimer: number | null = null;
let keyboardFocusCuePending = false;
const jobAnnouncementTracker = new JobAnnouncementTracker();
const PENDING_ANNOUNCEMENT_MAX_AGE_MS = 10000;
const feedbackSoundPlayer = new FeedbackSoundPlayer();

const PLAYBACK_STATE_LABELS = {
  playing: '재생 중',
  paused: '일시정지',
  ended: '재생 완료',
} as const;

function announce(
  text: string,
  options: {
    urgency?: 'polite' | 'assertive';
    tone?: FeedbackTone;
  } = {},
): void {
  const urgency = options.urgency ?? 'polite';
  const target =
    urgency === 'assertive'
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
    } else {
      announcementTimer = null;
    }
  }, 40);
  if (urgency === 'assertive') {
    alertTimer = timer;
  } else {
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

async function loadBackendHealth(): Promise<void> {
  if (backendRetryElement) backendRetryElement.disabled = true;
  if (backendStatusElement) {
    backendStatusElement.textContent = '로컬 API 확인 중';
    backendStatusElement.dataset.state = 'loading';
  }
  try {
    const request: BackendHealthGet = { type: 'BACKEND_HEALTH_GET' };
    const response: unknown = await chrome.runtime.sendMessage(request);
    const ok =
      typeof response === 'object' &&
      response !== null &&
      (response as Record<string, unknown>).ok === true;
    if (backendStatusElement) {
      backendStatusElement.textContent = ok ? '로컬 API 연결됨' : '로컬 API 연결 안 됨';
      backendStatusElement.dataset.state = ok ? 'ready' : 'error';
    }
  } catch {
    if (backendStatusElement) {
      backendStatusElement.textContent = '로컬 API 연결 안 됨';
      backendStatusElement.dataset.state = 'error';
    }
  } finally {
    if (backendRetryElement) backendRetryElement.disabled = false;
  }
}

function renderPlayerContext(context: PlayerContext): void {
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
    positionElement.textContent = `${formatTime(context.current_time_ms)} / ${formatTime(
      context.duration_ms,
    )}`;
  }
  if (playbackRateElement) {
    playbackRateElement.textContent = `${context.playback_rate}x`;
  }
  renderSettings(currentSettings);
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
  input.setAttribute('aria-valuetext', `${input.value}퍼센트`);
}

function renderSettings(settings: PlaybackSettings): void {
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

function renderAccessibilitySettings(settings: AccessibilitySettings): void {
  currentAccessibilitySettings = { ...settings };
  feedbackSoundPlayer.setEnabled(settings.interaction_sounds_enabled);
  feedbackSoundPlayer.setVolume(settings.interaction_sound_volume);
  if (interactionSoundsEnabledElement) {
    interactionSoundsEnabledElement.checked = settings.interaction_sounds_enabled;
  }
  if (interactionSoundVolumeElement) {
    interactionSoundVolumeElement.value = String(
      Math.round(settings.interaction_sound_volume * 100),
    );
  }
  if (shortcutSpeechEnabledElement) {
    shortcutSpeechEnabledElement.checked = settings.shortcut_speech_enabled;
  }
  renderRangeValue(
    interactionSoundVolumeElement,
    interactionSoundVolumeOutputElement,
  );
}

function jobAnnouncementTone(status: JobStatus): FeedbackTone {
  if (status.status === 'ready') return 'success';
  if (status.status === 'failed' || status.status === 'unavailable') return 'error';
  return 'action';
}

function announceJobStatus(status: JobStatus, message: string): void {
  const isError = status.status === 'failed' || status.status === 'unavailable';
  announce(message, {
    tone: jobAnnouncementTone(status),
    urgency: isError ? 'assertive' : 'polite',
  });
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
  setHidden(jobRegenerateElement, true);
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
    activeJobTarget?.duration_ms != null &&
    (status.status === 'not_started' ||
      (status.status === 'failed' && status.error.retryable));
  setHidden(jobCreateElement, !canCreate);
  setHidden(
    jobStatusCheckElement,
    status.status !== 'queued' && status.status !== 'processing',
  );
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
      announceJobStatus(status, message);
    }
  }
}

function setJobButtonsBusy(busy: boolean): void {
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

async function loadJobStatus(force = false, announceManually = false): Promise<void> {
  const target = activeJobTarget;
  if (!target || (jobRequestInFlight && !force)) {
    if (announceManually && currentJobStatus) {
      const message = jobAnnouncementTracker.next(currentJobStatus, true);
      if (message) announceJobStatus(currentJobStatus, message);
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
      if (message) announceJobStatus(response, message);
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
      if (message) announceJobStatus(unavailable, message);
    }
    nextJobPollAt = Date.now() + 5000;
  } finally {
    jobRequestInFlight = false;
    setJobButtonsBusy(false);
  }
}

async function createJob(force = false): Promise<void> {
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
  const request: JobCreate = { type: 'JOB_CREATE', ...target, ...(force ? { force: true } : {}) };
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
      renderJobStatus(currentJobStatus, false);
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

function saveAccessibilitySettings(settings: AccessibilitySettings): void {
  renderAccessibilitySettings(settings);
  void chrome.storage.local
    .set({ [ACCESSIBILITY_SETTINGS_STORAGE_KEY]: settings })
    .catch((error: unknown) => {
      console.error('[VOICE BRIDGE] Failed to save accessibility settings.', error);
      announce('접근성 설정을 저장하지 못했습니다.', {
        urgency: 'assertive',
        tone: 'error',
      });
    });
}

function announceCurrentPlaybackPosition(): void {
  if (!lastPlayerContext?.available) {
    announce('지원하는 유튜브 영상을 찾지 못했습니다.', {
      urgency: 'assertive',
      tone: 'error',
    });
    return;
  }
  announce(playbackPositionAnnouncement(lastPlayerContext), { tone: 'action' });
}

document.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Tab') {
      keyboardFocusCuePending = true;
    }
    void feedbackSoundPlayer.unlock().catch(() => undefined);
  },
  true,
);

document.addEventListener(
  'pointerdown',
  () => {
    keyboardFocusCuePending = false;
    void feedbackSoundPlayer.unlock().catch(() => undefined);
  },
  true,
);

document.addEventListener('focusin', (event) => {
  if (!keyboardFocusCuePending) return;
  keyboardFocusCuePending = false;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.matches('button, input, summary, a[href], [tabindex]:not([tabindex="-1"])')
  ) {
    feedbackSoundPlayer.play('focus');
  }
});

descriptionToggleElement?.addEventListener('click', () => {
  if (toggleRequestInFlight || !lastPlayerContext?.available) return;
  const enabled = !currentSettings.enabled;
  toggleRequestInFlight = true;
  feedbackSoundPlayer.play(enabled ? 'toggle-on' : 'toggle-off');
  sendSettings({ ...currentSettings, enabled });
  announce(enabled ? '화면해설을 켰습니다.' : '화면해설을 껐습니다.', {
    tone: enabled ? 'toggle-on' : 'toggle-off',
  });
  if (
    enabled &&
    (currentJobStatus?.status === 'not_started' ||
      (currentJobStatus?.status === 'failed' && currentJobStatus.error.retryable))
  ) {
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
  feedbackSoundPlayer.play(
    autoPauseEnabledElement.checked ? 'toggle-on' : 'toggle-off',
  );
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
  } else {
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
  feedbackSoundPlayer.setVolume(
    currentAccessibilitySettings.interaction_sound_volume,
  );
  renderRangeValue(
    interactionSoundVolumeElement,
    interactionSoundVolumeOutputElement,
  );
  feedbackSoundPlayer.play(
    'adjust',
    currentAccessibilitySettings.interaction_sound_volume,
  );
});

interactionSoundVolumeElement?.addEventListener('change', () => {
  saveAccessibilitySettings({ ...currentAccessibilitySettings });
});

shortcutSpeechEnabledElement?.addEventListener('change', () => {
  feedbackSoundPlayer.play(
    shortcutSpeechEnabledElement.checked ? 'toggle-on' : 'toggle-off',
  );
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
    if (value.speech_handled) {
      void feedbackSoundPlayer
        .unlock()
        .then(() => feedbackSoundPlayer.play(jobAnnouncementTone(value.job)))
        .catch(() => undefined);
    } else {
      announceJobStatus(value.job, message);
    }
  }
}

async function consumePendingAccessibilityAnnouncement(value: unknown): Promise<void> {
  if (!isPendingAccessibilityAnnouncement(value)) {
    return;
  }
  await chrome.storage.session.remove(
    PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY,
  );
  if (Date.now() - value.requested_at > PENDING_ANNOUNCEMENT_MAX_AGE_MS) {
    return;
  }
  if (value.speech_handled) {
    void feedbackSoundPlayer
      .unlock()
      .then(() => feedbackSoundPlayer.play(value.tone))
      .catch(() => undefined);
  } else {
    announce(value.text, { urgency: value.urgency, tone: value.tone });
  }
  void loadPlayerContext();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'session') {
    return;
  }
  const pending = changes[PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY]?.newValue;
  if (pending !== undefined) {
    void consumePendingProgressAnnouncement(pending);
  }
  const accessibilityPending =
    changes[PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY]?.newValue;
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

function reportPanelVisibility(visible: boolean): void {
  if (visible === panelReportedVisible) {
    return;
  }
  panelReportedVisible = visible;
  const message: PanelVisibilityChanged = {
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

void loadRuntimeStatus().catch((error: unknown) => {
  console.error('[VOICE BRIDGE] Runtime status request failed.', error);
  renderFailure();
});
void loadBackendHealth();

void chrome.storage.local
  .get(PLAYBACK_SETTINGS_STORAGE_KEY)
  .then((stored) => {
    renderSettings(parseStoredPlaybackSettings(stored[PLAYBACK_SETTINGS_STORAGE_KEY]));
  })
  .catch((error: unknown) => {
    console.error('[VOICE BRIDGE] Failed to load settings.', error);
    renderSettings(DEFAULT_PLAYBACK_SETTINGS);
  });

const accessibilitySettingsReady = chrome.storage.local
  .get(ACCESSIBILITY_SETTINGS_STORAGE_KEY)
  .then((stored) => {
    renderAccessibilitySettings(
      parseStoredAccessibilitySettings(
        stored[ACCESSIBILITY_SETTINGS_STORAGE_KEY],
      ),
    );
  })
  .catch((error: unknown) => {
    console.error('[VOICE BRIDGE] Failed to load accessibility settings.', error);
    renderAccessibilitySettings(DEFAULT_ACCESSIBILITY_SETTINGS);
  });

void accessibilitySettingsReady;

void chrome.storage.session
  .get([
    PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY,
    PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY,
  ])
  .then(async (stored) => {
    await accessibilitySettingsReady;
    await consumePendingProgressAnnouncement(
      stored[PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY],
    );
    await consumePendingAccessibilityAnnouncement(
      stored[PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY],
    );
  })
  .catch((error: unknown) => {
    console.error('[VOICE BRIDGE] Failed to restore progress announcement.', error);
  });

void loadPlayerContext();
window.setInterval(() => {
  void loadPlayerContext();
}, 1000);
