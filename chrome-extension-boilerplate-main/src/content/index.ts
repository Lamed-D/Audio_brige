import {
  isExtensionMessage,
  isManifestFetchResponse,
  type AccessibilityAnnounce,
  type ManifestGet,
  type PlayerContext,
} from '../shared/contracts/messages';
import {
  parseStoredPlaybackSettings,
  PLAYBACK_SETTINGS_STORAGE_KEY,
  type PlaybackSettings,
} from '../shared/settings/playback-settings';
import { YouTubePlayerController } from './player-controller';
import { PlaybackCoordinator } from './playback/playback-coordinator';
import { RuntimeAudioGateway } from './playback/runtime-audio-gateway';
import { ManifestSchedulerRuntime } from './scheduler/demo-scheduler-runtime';
import { parseManifestV1_1 } from '../shared/contracts/manifest';
import {
  ACCESSIBILITY_SETTINGS_STORAGE_KEY,
  parseStoredAccessibilitySettings,
} from '../shared/settings/accessibility-settings';
import { FeedbackSoundPlayer } from '../shared/accessibility/feedback-sound';

const CONTENT_MARKER = 'data-voice-bridge-content';
const LIVE_REGION_MARKER = 'data-voice-bridge-live-region';
const MANIFEST_RETRY_DEFAULT_MS = 5000;
const MANIFEST_RETRY_NOT_FOUND_MS = 15000;
const MANIFEST_RETRY_INVALID_MS = 30000;
const pageFeedbackSoundPlayer = new FeedbackSoundPlayer();
const pageAccessibilitySettingsReady = chrome.storage.local
  .get(ACCESSIBILITY_SETTINGS_STORAGE_KEY)
  .then((stored) => {
    const settings = parseStoredAccessibilitySettings(
      stored[ACCESSIBILITY_SETTINGS_STORAGE_KEY],
    );
    pageFeedbackSoundPlayer.setEnabled(settings.interaction_sounds_enabled);
    pageFeedbackSoundPlayer.setVolume(settings.interaction_sound_volume);
  })
  .catch(() => undefined);

function createLiveRegion(urgency: AccessibilityAnnounce['urgency']): HTMLElement {
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

function announceOnPage(message: AccessibilityAnnounce): void {
  if (!message.speech_handled) {
    const selector = `[${LIVE_REGION_MARKER}="${message.urgency}"]`;
    const element =
      document.querySelector<HTMLElement>(selector) ?? createLiveRegion(message.urgency);
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

  let controller: YouTubePlayerController;
  let schedulerRuntime: ManifestSchedulerRuntime;
  const manifestRequests = new Map<string, Promise<void>>();
  const manifestRetryTimers = new Map<string, number>();

  function clearManifestRetry(videoKey: string): void {
    const timer = manifestRetryTimers.get(videoKey);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      manifestRetryTimers.delete(videoKey);
    }
  }

  function scheduleManifestRetry(videoKey: string, delayMs: number): void {
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

  function ensureManifest(context: PlayerContext, force = false): Promise<void> {
    if (!context.available || (!force && schedulerRuntime.hasManifest(context.video_key))) {
      return Promise.resolve();
    }
    const inFlight = manifestRequests.get(context.video_key);
    if (inFlight) {
      return inFlight;
    }

    const request: ManifestGet = {
      type: 'MANIFEST_GET',
      provider: context.provider,
      video_id: context.video_id,
      duration_ms: context.duration_ms,
    };
    const promise = chrome.runtime
      .sendMessage(request)
      .then((response: unknown) => {
        if (!isManifestFetchResponse(response) || response.video_key !== context.video_key) {
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
          scheduleManifestRetry(
            context.video_key,
            response.reason === 'network'
              ? MANIFEST_RETRY_DEFAULT_MS
              : MANIFEST_RETRY_INVALID_MS,
          );
          return;
        }

        const manifest = parseManifestV1_1(response.manifest);
        const latestContext = controller.getContext();
        if (!latestContext.available || latestContext.video_key !== response.video_key) {
          return;
        }
        if (
          latestContext.duration_ms !== null &&
          Math.abs(manifest.video.duration_ms - latestContext.duration_ms) > 1000
        ) {
          scheduleManifestRetry(response.video_key, MANIFEST_RETRY_INVALID_MS);
          return;
        }
        clearManifestRetry(response.video_key);
        schedulerRuntime.installManifest(manifest);
      })
      .catch((error: unknown) => {
        console.error('[VOICE BRIDGE] Manifest load failed.', error);
        scheduleManifestRetry(context.video_key, MANIFEST_RETRY_DEFAULT_MS);
      })
      .finally(() => {
        manifestRequests.delete(context.video_key);
      });
    manifestRequests.set(context.video_key, promise);
    return promise;
  }

  controller = new YouTubePlayerController((context, reason) => {
    schedulerRuntime.handlePlayerContext(context, reason);
    void ensureManifest(context);
  });
  const playbackCoordinator = new PlaybackCoordinator(
    controller,
    new RuntimeAudioGateway(),
  );
  schedulerRuntime = new ManifestSchedulerRuntime(
    () => controller.getContext(),
    playbackCoordinator,
    () => document.visibilityState === 'visible',
  );

  function applyAndPersistSettings(settings: PlaybackSettings): void {
    schedulerRuntime.updateSettings(settings);
    void chrome.storage.local
      .set({ [PLAYBACK_SETTINGS_STORAGE_KEY]: settings })
      .catch((error: unknown) => {
        console.error('[VOICE BRIDGE] Failed to save playback settings.', error);
      });
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isExtensionMessage(message)) {
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

  const handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') {
      return;
    }
    if (changes[PLAYBACK_SETTINGS_STORAGE_KEY]) {
      schedulerRuntime.updateSettings(
        parseStoredPlaybackSettings(changes[PLAYBACK_SETTINGS_STORAGE_KEY].newValue),
      );
    }
    if (changes[ACCESSIBILITY_SETTINGS_STORAGE_KEY]) {
      const settings = parseStoredAccessibilitySettings(
        changes[ACCESSIBILITY_SETTINGS_STORAGE_KEY].newValue,
      );
      pageFeedbackSoundPlayer.setEnabled(settings.interaction_sounds_enabled);
      pageFeedbackSoundPlayer.setVolume(settings.interaction_sound_volume);
    }
  };
  chrome.storage.onChanged.addListener(handleStorageChange);

  void chrome.storage.local
    .get(PLAYBACK_SETTINGS_STORAGE_KEY)
    .then((stored) => {
      schedulerRuntime.updateSettings(
        parseStoredPlaybackSettings(stored[PLAYBACK_SETTINGS_STORAGE_KEY]),
      );
    })
    .catch((error: unknown) => {
      console.error('[VOICE BRIDGE] Failed to load playback settings.', error);
    })
    .finally(() => {
      controller.start();
      schedulerRuntime.start();
      console.info('[VOICE BRIDGE] YouTube player adapter and scheduler ready.');
    });
}
