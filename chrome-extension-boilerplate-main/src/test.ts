import './content/player/html5-player-adapter.test';
import './content/scheduler/description-scheduler.test';
import './content/video-identifier/youtube.test';
import './shared/contracts/manifest.test';
import './shared/contracts/demo-audio.test';
import './shared/contracts/job-status.test';
import './shared/contracts/messages.test';
import './shared/accessibility/announcements.test';
import './shared/accessibility/shortcut-speech.test';
import './shared/settings/accessibility-settings.test';
import './shared/settings/playback-settings.test';
import './sidepanel/feedback-sound.test';
import './sidepanel/job-progress.test';
import { runPlaybackCoordinatorTests } from './content/playback/playback-coordinator.test';
import { runJobClientTests } from './background/job-client.test';

void runPlaybackCoordinatorTests()
  .then(() => runJobClientTests())
  .then(() => {
    console.log('VOICE BRIDGE frontend tests passed');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
