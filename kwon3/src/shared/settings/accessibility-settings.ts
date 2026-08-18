export const ACCESSIBILITY_SETTINGS_STORAGE_KEY = 'voiceBridgeAccessibilitySettings';

export type AccessibilitySettings = {
  interaction_sounds_enabled: boolean;
  interaction_sound_volume: number;
  shortcut_speech_enabled: boolean;
};

export const DEFAULT_ACCESSIBILITY_SETTINGS: AccessibilitySettings = {
  interaction_sounds_enabled: true,
  interaction_sound_volume: 0.8,
  shortcut_speech_enabled: true,
};

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function parseStoredAccessibilitySettings(value: unknown): AccessibilitySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_ACCESSIBILITY_SETTINGS };
  }
  const settings = value as Record<string, unknown>;
  return {
    interaction_sounds_enabled:
      typeof settings.interaction_sounds_enabled === 'boolean'
        ? settings.interaction_sounds_enabled
        : DEFAULT_ACCESSIBILITY_SETTINGS.interaction_sounds_enabled,
    interaction_sound_volume: isUnitInterval(settings.interaction_sound_volume)
      ? settings.interaction_sound_volume
      : DEFAULT_ACCESSIBILITY_SETTINGS.interaction_sound_volume,
    shortcut_speech_enabled:
      typeof settings.shortcut_speech_enabled === 'boolean'
        ? settings.shortcut_speech_enabled
        : DEFAULT_ACCESSIBILITY_SETTINGS.shortcut_speech_enabled,
  };
}
