import assert from 'node:assert/strict';

import {
  DEFAULT_ACCESSIBILITY_SETTINGS,
  parseStoredAccessibilitySettings,
} from './accessibility-settings';

assert.deepEqual(parseStoredAccessibilitySettings(undefined), DEFAULT_ACCESSIBILITY_SETTINGS);
assert.deepEqual(
  parseStoredAccessibilitySettings({
    interaction_sounds_enabled: false,
    interaction_sound_volume: 1,
    shortcut_speech_enabled: false,
  }),
  {
    interaction_sounds_enabled: false,
    interaction_sound_volume: 1,
    shortcut_speech_enabled: false,
  },
);
assert.deepEqual(
  parseStoredAccessibilitySettings({
    interaction_sounds_enabled: 'yes',
    interaction_sound_volume: 2,
    shortcut_speech_enabled: 'yes',
  }),
  DEFAULT_ACCESSIBILITY_SETTINGS,
);

console.log('accessibility settings tests passed');
