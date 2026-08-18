import assert from 'node:assert/strict';

import {
  DEFAULT_PLAYBACK_SETTINGS,
  isPlaybackSettings,
  parseStoredPlaybackSettings,
} from './playback-settings';

assert.equal(isPlaybackSettings(DEFAULT_PLAYBACK_SETTINGS), true);
assert.equal(DEFAULT_PLAYBACK_SETTINGS.enabled, false);
assert.equal(
  isPlaybackSettings({ ...DEFAULT_PLAYBACK_SETTINGS, description_volume: 1.2 }),
  false,
);
assert.deepEqual(parseStoredPlaybackSettings(null), DEFAULT_PLAYBACK_SETTINGS);
assert.deepEqual(
  parseStoredPlaybackSettings({
    enabled: false,
    description_volume: 0.7,
    duck_factor: 'invalid',
    auto_pause_enabled: false,
  }),
  {
    enabled: false,
    description_volume: 0.7,
    duck_factor: DEFAULT_PLAYBACK_SETTINGS.duck_factor,
    auto_pause_enabled: false,
  },
);

console.log('playback settings tests passed');
