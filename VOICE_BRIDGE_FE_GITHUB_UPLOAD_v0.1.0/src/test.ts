import './content/player/html5-player-adapter.test';
import './content/scheduler/description-scheduler.test';
import './content/video-identifier/youtube.test';
import './shared/contracts/manifest.test';
import './shared/contracts/demo-audio.test';
import './shared/contracts/job-status.test';
import './shared/contracts/messages.test';
import './shared/settings/playback-settings.test';
import './sidepanel/job-progress.test';
import { runPlaybackCoordinatorTests } from './content/playback/playback-coordinator.test';

void runPlaybackCoordinatorTests()
  .then(() => {
    console.log('VOICE BRIDGE frontend tests passed');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
