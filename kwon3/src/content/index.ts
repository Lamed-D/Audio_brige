import {
  isExtensionMessage,
  type JobCreate,
  type JobStatusGet,
  type JobTarget,
  type ManifestGet,
  type PlayerContext,
} from '../shared/contracts/messages';
import { isJobStatus, shouldPollJob } from '../shared/contracts/job-status';
import { parseManifestV1_1 } from '../shared/contracts/manifest';
import {
  parseStoredPlaybackSettings,
  PLAYBACK_SETTINGS_STORAGE_KEY,
  type PlaybackSettings,
} from '../shared/settings/playback-settings';
import { YouTubePlayerController } from './player-controller';
import { PlaybackCoordinator } from './playback/playback-coordinator';
import { RuntimeAudioGateway } from './playback/runtime-audio-gateway';
import { DemoSchedulerRuntime } from './scheduler/demo-scheduler-runtime';
import type { AccessibilityAnnounce } from '../shared/contracts/messages';
import {
  ACCESSIBILITY_SETTINGS_STORAGE_KEY,
  parseStoredAccessibilitySettings,
} from '../shared/settings/accessibility-settings';
import { FeedbackSoundPlayer } from '../shared/accessibility/feedback-sound';

const CONTENT_MARKER = 'data-voice-bridge-content';
const LIVE_REGION_MARKER = 'data-voice-bridge-live-region';
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
  let schedulerRuntime: DemoSchedulerRuntime;
  let manifestSyncTimer: number | null = null;
  let manifestRequestInFlight = false;
  const automaticCreationRequested = new Set<string>();

  function scheduleManifestSync(delayMs = 0): void {
    if (manifestSyncTimer !== null) return;
    manifestSyncTimer = window.setTimeout(() => {
      manifestSyncTimer = null;
      void syncBackendManifest(controller.getContext());
    }, delayMs);
  }

  async function syncBackendManifest(context: PlayerContext): Promise<void> {
    if (
      manifestRequestInFlight ||
      !context.available ||
      context.duration_ms === null ||
      !schedulerRuntime.getStatus().settings.enabled ||
      schedulerRuntime.hasManifest(context.video_key)
    ) {
      return;
    }

    manifestRequestInFlight = true;
    const target: JobTarget = {
      provider: context.provider,
      video_id: context.video_id,
      duration_ms: context.duration_ms,
    };
    try {
      const manifestRequest: ManifestGet = { type: 'MANIFEST_GET', ...target };
      const manifestResponse: unknown = await chrome.runtime.sendMessage(manifestRequest);
      if (
        typeof manifestResponse === 'object' &&
        manifestResponse !== null &&
        !Array.isArray(manifestResponse) &&
        (manifestResponse as Record<string, unknown>).ok === true
      ) {
        const manifest = parseManifestV1_1(
          (manifestResponse as Record<string, unknown>).manifest,
        );
        if (
          `${manifest.video.provider}:${manifest.video.video_id}` === context.video_key &&
          Math.abs(manifest.video.duration_ms - context.duration_ms) <= 1000
        ) {
          schedulerRuntime.installManifest(manifest);
          automaticCreationRequested.delete(context.video_key);
          return;
        }
      }

      const statusRequest: JobStatusGet = { type: 'JOB_STATUS_GET', ...target };
      const status: unknown = await chrome.runtime.sendMessage(statusRequest);
      if (!isJobStatus(status) || status.video_key !== context.video_key) {
        scheduleManifestSync(5000);
        return;
      }
      if (status.status === 'not_started') {
        if (!automaticCreationRequested.has(context.video_key)) {
          automaticCreationRequested.add(context.video_key);
          const createRequest: JobCreate = { type: 'JOB_CREATE', ...target };
          const created: unknown = await chrome.runtime.sendMessage(createRequest);
          if (!isJobStatus(created) || created.video_key !== context.video_key) {
            automaticCreationRequested.delete(context.video_key);
            scheduleManifestSync(5000);
            return;
          }
          scheduleManifestSync(shouldPollJob(created) ? created.retry_after_ms : 500);
        }
        return;
      }
      if (shouldPollJob(status)) {
        scheduleManifestSync(status.retry_after_ms);
      } else if (status.status === 'ready') {
        scheduleManifestSync(300);
      } else if (status.status === 'unavailable') {
        scheduleManifestSync(5000);
      }
    } catch (error) {
      console.error('[VOICE BRIDGE] Failed to synchronize backend manifest.', error);
      scheduleManifestSync(5000);
    } finally {
      manifestRequestInFlight = false;
    }
  }

  controller = new YouTubePlayerController((context, reason) => {
    schedulerRuntime.handlePlayerContext(context, reason);
    scheduleManifestSync();
  });
  const playbackCoordinator = new PlaybackCoordinator(
    controller,
    new RuntimeAudioGateway(),
  );
  schedulerRuntime = new DemoSchedulerRuntime(
    () => controller.getContext(),
    playbackCoordinator,
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
      scheduleManifestSync();
      sendResponse(schedulerRuntime.getStatus());
      return false;
    }
    if (message.type === 'PLAYBACK_SETTINGS_SET') {
      applyAndPersistSettings(message.settings);
      scheduleManifestSync();
      sendResponse(schedulerRuntime.getStatus());
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
    if (manifestSyncTimer !== null) window.clearTimeout(manifestSyncTimer);
    chrome.storage.onChanged.removeListener(handleStorageChange);
    controller.stop();
    schedulerRuntime.stop();
  });

  const handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') {
      return;
    }
    if (changes[PLAYBACK_SETTINGS_STORAGE_KEY]) {
      const settings = parseStoredPlaybackSettings(
        changes[PLAYBACK_SETTINGS_STORAGE_KEY].newValue,
      );
      schedulerRuntime.updateSettings(settings);
      if (settings.enabled) scheduleManifestSync();
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
