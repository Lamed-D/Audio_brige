export const SUPPORTED_SCHEMA_VERSION = '1.1' as const;

export type PlaybackMode = 'overlay' | 'extended';
export type Importance = 'normal' | 'high';
export type SegmentSource = 'ocr' | 'vlm';
export type Confidence = 'low' | 'medium' | 'high';

export type AudioClip = {
  path: string;
  duration_ms: number;
  sha256: string;
};

type SegmentBase = {
  id: string;
  trigger_ms: number;
  text: string;
  importance: Importance;
  source: SegmentSource;
  confidence: Confidence;
  audio: AudioClip;
};

export type OverlaySegment = SegmentBase & {
  mode: 'overlay';
  deadline_ms: number;
};

export type ExtendedSegment = SegmentBase & {
  mode: 'extended';
};

export type DescriptionSegment = OverlaySegment | ExtendedSegment;

export type VoiceBridgeManifestV1_1 = {
  schema_version: typeof SUPPORTED_SCHEMA_VERSION;
  manifest_id: string;
  revision: number;
  video: {
    provider: string;
    video_id: string;
    duration_ms: number;
  };
  voice: {
    voice_id: string;
    format: string;
    sample_rate_hz: number;
  };
  playback: {
    duck_factor: number;
    preload_count: number;
    lookahead_ms: number;
    late_tolerance_ms: number;
    auto_pause_default: boolean;
    max_extended_duration_ms: number;
    min_extended_interval_ms: number;
  };
  segments: DescriptionSegment[];
};

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

type JsonRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ManifestValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'object expected');
  }
  return value as JsonRecord;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(path, 'non-empty string expected');
  }
  return value;
}

function integer(value: unknown, path: string, min = 0): number {
  if (!Number.isInteger(value) || (value as number) < min) {
    return fail(path, `integer greater than or equal to ${min} expected`);
  }
  return value as number;
}

function numberInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return fail(path, `number between ${min} and ${max} expected`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return fail(path, 'boolean expected');
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    return fail(path, `one of ${values.join(', ')} expected`);
  }
  return value as T[number];
}

function parseAudio(value: unknown, path: string): AudioClip {
  const input = record(value, path);
  const audioPath = string(input.path, `${path}.path`);
  const sha256 = string(input.sha256, `${path}.sha256`);

  if (!audioPath.startsWith('/v1/audio/') || audioPath.includes('://')) {
    fail(`${path}.path`, 'backend-relative /v1/audio/ path expected');
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    fail(`${path}.sha256`, '64-character hexadecimal digest expected');
  }

  return {
    path: audioPath,
    duration_ms: integer(input.duration_ms, `${path}.duration_ms`, 1),
    sha256,
  };
}

function parseSegment(value: unknown, index: number): DescriptionSegment {
  const path = `segments[${index}]`;
  const input = record(value, path);
  const mode = enumValue(input.mode, ['overlay', 'extended'] as const, `${path}.mode`);
  const importance = enumValue(
    input.importance,
    ['normal', 'high'] as const,
    `${path}.importance`,
  );
  const base: SegmentBase = {
    id: string(input.id, `${path}.id`),
    trigger_ms: integer(input.trigger_ms, `${path}.trigger_ms`),
    text: string(input.text, `${path}.text`),
    importance,
    source: enumValue(input.source, ['ocr', 'vlm'] as const, `${path}.source`),
    confidence: enumValue(
      input.confidence,
      ['low', 'medium', 'high'] as const,
      `${path}.confidence`,
    ),
    audio: parseAudio(input.audio, `${path}.audio`),
  };

  if (mode === 'overlay') {
    const deadlineMs = integer(input.deadline_ms, `${path}.deadline_ms`, 1);
    if (deadlineMs <= base.trigger_ms) {
      fail(`${path}.deadline_ms`, 'must be greater than trigger_ms');
    }
    if (base.audio.duration_ms > deadlineMs - base.trigger_ms) {
      fail(`${path}.audio.duration_ms`, 'audio exceeds the overlay window');
    }
    return { ...base, mode, deadline_ms: deadlineMs };
  }

  if ('deadline_ms' in input) {
    fail(`${path}.deadline_ms`, 'must be omitted for extended mode');
  }
  if (importance !== 'high') {
    fail(`${path}.importance`, 'extended mode requires high importance');
  }
  return { ...base, mode };
}

export function parseManifestV1_1(value: unknown): VoiceBridgeManifestV1_1 {
  const input = record(value, 'manifest');
  const schemaVersion = string(input.schema_version, 'schema_version');
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fail('schema_version', `unsupported version ${schemaVersion}`);
  }

  const videoInput = record(input.video, 'video');
  const provider = string(videoInput.provider, 'video.provider');
  if (!/^[a-z0-9_-]+$/.test(provider)) {
    fail('video.provider', 'lowercase provider enum expected');
  }
  const videoId = string(videoInput.video_id, 'video.video_id');
  const videoDurationMs = integer(videoInput.duration_ms, 'video.duration_ms', 1);
  const revision = integer(input.revision, 'revision');
  const manifestId = string(input.manifest_id, 'manifest_id');
  if (manifestId !== `${provider}:${videoId}:r${revision}`) {
    fail('manifest_id', 'must match provider:video_id:revision');
  }

  const voiceInput = record(input.voice, 'voice');
  const playbackInput = record(input.playback, 'playback');
  const playback = {
    duck_factor: numberInRange(playbackInput.duck_factor, 'playback.duck_factor', 0, 1),
    preload_count: integer(playbackInput.preload_count, 'playback.preload_count'),
    lookahead_ms: integer(playbackInput.lookahead_ms, 'playback.lookahead_ms'),
    late_tolerance_ms: integer(
      playbackInput.late_tolerance_ms,
      'playback.late_tolerance_ms',
    ),
    auto_pause_default: boolean(
      playbackInput.auto_pause_default,
      'playback.auto_pause_default',
    ),
    max_extended_duration_ms: integer(
      playbackInput.max_extended_duration_ms,
      'playback.max_extended_duration_ms',
      1,
    ),
    min_extended_interval_ms: integer(
      playbackInput.min_extended_interval_ms,
      'playback.min_extended_interval_ms',
    ),
  };

  if (!Array.isArray(input.segments)) {
    fail('segments', 'array expected');
  }
  const segments = input.segments.map(parseSegment);
  const ids = new Set<string>();
  let previousTrigger = -1;
  let previousOverlayDeadline = -1;
  let previousExtendedTrigger = Number.NEGATIVE_INFINITY;

  for (const [index, segment] of segments.entries()) {
    if (ids.has(segment.id)) {
      fail(`segments[${index}].id`, 'duplicate segment id');
    }
    ids.add(segment.id);

    if (segment.trigger_ms < previousTrigger) {
      fail(`segments[${index}].trigger_ms`, 'segments must be sorted');
    }
    if (segment.trigger_ms >= videoDurationMs) {
      fail(`segments[${index}].trigger_ms`, 'must be inside video duration');
    }
    previousTrigger = segment.trigger_ms;

    if (segment.mode === 'overlay') {
      if (segment.deadline_ms > videoDurationMs) {
        fail(`segments[${index}].deadline_ms`, 'must be inside video duration');
      }
      if (segment.trigger_ms < previousOverlayDeadline) {
        fail(`segments[${index}]`, 'overlay windows must not overlap');
      }
      previousOverlayDeadline = segment.deadline_ms;
      continue;
    }

    if (segment.audio.duration_ms > playback.max_extended_duration_ms) {
      fail(`segments[${index}].audio.duration_ms`, 'extended duration exceeds playback limit');
    }
    if (
      segment.trigger_ms - previousExtendedTrigger <
      playback.min_extended_interval_ms
    ) {
      fail(`segments[${index}].trigger_ms`, 'extended segments are too close together');
    }
    previousExtendedTrigger = segment.trigger_ms;
  }

  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    manifest_id: manifestId,
    revision,
    video: {
      provider,
      video_id: videoId,
      duration_ms: videoDurationMs,
    },
    voice: {
      voice_id: string(voiceInput.voice_id, 'voice.voice_id'),
      format: string(voiceInput.format, 'voice.format'),
      sample_rate_hz: integer(voiceInput.sample_rate_hz, 'voice.sample_rate_hz', 1),
    },
    playback,
    segments,
  };
}
