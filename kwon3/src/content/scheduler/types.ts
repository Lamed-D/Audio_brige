import type {
  DescriptionSegment,
  PlaybackMode,
  VoiceBridgeManifestV1_1,
} from '../../shared/contracts/manifest';

export type SchedulerSkipReason = 'late' | 'seek' | 'auto_pause_disabled';

export type SchedulerTriggerEvent = {
  type: 'trigger';
  segment: DescriptionSegment;
  atMs: number;
};

export type SchedulerSkipEvent = {
  type: 'skip';
  segment: DescriptionSegment;
  atMs: number;
  reason: SchedulerSkipReason;
};

export type SchedulerEvent = SchedulerTriggerEvent | SchedulerSkipEvent;

export type SchedulerLastEvent = {
  type: SchedulerEvent['type'];
  segment_id: string;
  mode: PlaybackMode;
  at_ms: number;
  reason?: SchedulerSkipReason;
};

export type SchedulerSnapshot = {
  manifest_id: string;
  revision: number;
  total_segments: number;
  handled_segments: number;
  next_segment_id: string | null;
  next_trigger_ms: number | null;
  last_event: SchedulerLastEvent | null;
};

export type SchedulerManifest = VoiceBridgeManifestV1_1;
