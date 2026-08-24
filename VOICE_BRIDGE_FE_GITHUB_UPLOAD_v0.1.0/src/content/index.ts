import { isExtensionMessage } from '../shared/contracts/messages';
import {
  parseStoredPlaybackSettings,
  PLAYBACK_SETTINGS_STORAGE_KEY,
  type PlaybackSettings,
} from '../shared/settings/playback-settings';
import { YouTubePlayerController } from './player-controller';
import { PlaybackCoordinator } from './playback/playback-coordinator';
import { RuntimeAudioGateway } from './playback/runtime-audio-gateway';
import { DemoSchedulerRuntime } from './scheduler/demo-scheduler-runtime';

const CONTENT_MARKER = 'data-voice-bridge-content';

if (!document.documentElement.hasAttribute(CONTENT_MARKER)) {
  document.documentElement.setAttribute(CONTENT_MARKER, 'ready');

  let controller: YouTubePlayerController;
  let schedulerRuntime: DemoSchedulerRuntime;
  controller = new YouTubePlayerController((context, reason) => {
    schedulerRuntime.handlePlayerContext(context, reason);
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
      sendResponse(schedulerRuntime.getStatus());
      return false;
    }
    if (message.type === 'PLAYBACK_SETTINGS_SET') {
      applyAndPersistSettings(message.settings);
      sendResponse(schedulerRuntime.getStatus());
      return false;
    }
    return false;
  });

  window.addEventListener('beforeunload', () => {
    chrome.storage.onChanged.removeListener(handleStorageChange);
    controller.stop();
    schedulerRuntime.stop();
  });

  const handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local' || !changes[PLAYBACK_SETTINGS_STORAGE_KEY]) {
      return;
    }
    schedulerRuntime.updateSettings(
      parseStoredPlaybackSettings(changes[PLAYBACK_SETTINGS_STORAGE_KEY].newValue),
    );
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
