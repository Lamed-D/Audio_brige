export const PLAYBACK_SETTINGS_STORAGE_KEY = 'voiceBridgePlaybackSettings';

export type PlaybackSettings = {
  enabled: boolean;
  description_volume: number;
  duck_factor: number;
  auto_pause_enabled: boolean;
};

export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  enabled: true,
  description_volume: 1,
  duck_factor: 0.35,
  auto_pause_enabled: true,
};

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isPlaybackSettings(value: unknown): value is PlaybackSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const settings = value as Record<string, unknown>;
  return (
    typeof settings.enabled === 'boolean' &&
    isUnitInterval(settings.description_volume) &&
    isUnitInterval(settings.duck_factor) &&
    typeof settings.auto_pause_enabled === 'boolean'
  );
}

export function parseStoredPlaybackSettings(value: unknown): PlaybackSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_PLAYBACK_SETTINGS };
  }
  const settings = value as Record<string, unknown>;
  return {
    enabled:
      typeof settings.enabled === 'boolean'
        ? settings.enabled
        : DEFAULT_PLAYBACK_SETTINGS.enabled,
    description_volume: isUnitInterval(settings.description_volume)
      ? settings.description_volume
      : DEFAULT_PLAYBACK_SETTINGS.description_volume,
    duck_factor: isUnitInterval(settings.duck_factor)
      ? settings.duck_factor
      : DEFAULT_PLAYBACK_SETTINGS.duck_factor,
    auto_pause_enabled:
      typeof settings.auto_pause_enabled === 'boolean'
        ? settings.auto_pause_enabled
        : DEFAULT_PLAYBACK_SETTINGS.auto_pause_enabled,
  };
}
