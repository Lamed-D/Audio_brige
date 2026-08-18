export const JOB_PROCESSING_STAGES = [
  'media_preparation',
  'audio_analysis',
  'visual_analysis',
  'description_generation',
  'speech_synthesis',
  'validation',
] as const;

export type JobProcessingStage = (typeof JOB_PROCESSING_STAGES)[number];
export type EtaConfidence = 'low' | 'medium' | 'high';

type JobProgressBase = {
  job_id: string;
  video_key: string;
  progress_percent: number;
  eta_seconds: number | null;
  eta_confidence: EtaConfidence | null;
  retry_after_ms: number;
  updated_at: string;
};

export type JobQueuedStatus = JobProgressBase & {
  status: 'queued';
  stage: 'queued';
};

export type JobProcessingStatus = JobProgressBase & {
  status: 'processing';
  stage: JobProcessingStage;
};

export type JobReadyStatus = {
  status: 'ready';
  job_id: string | null;
  video_key: string;
  progress_percent: 100;
  manifest_id: string;
  revision: number;
  updated_at: string;
};

export type JobFailedStatus = {
  status: 'failed';
  job_id: string;
  video_key: string;
  progress_percent: number;
  error: {
    code: string;
    retryable: boolean;
  };
  updated_at: string;
};

export type BackendJobStatus =
  | JobQueuedStatus
  | JobProcessingStatus
  | JobReadyStatus
  | JobFailedStatus;

export type JobNotStartedStatus = {
  status: 'not_started';
  video_key: string;
};

export type JobUnavailableStatus = {
  status: 'unavailable';
  video_key: string | null;
  reason: 'unsupported_page' | 'network' | 'invalid_response';
};

export type JobStatus = BackendJobStatus | JobNotStartedStatus | JobUnavailableStatus;

export type PendingProgressAnnouncement = {
  video_key: string | null;
  requested_at: number;
  job: JobStatus;
  speech_handled?: boolean;
};

export const JOB_TRACKING_STORAGE_KEY = 'voice_bridge_job_tracking_v1';
export const PENDING_PROGRESS_ANNOUNCEMENT_STORAGE_KEY =
  'voice_bridge_pending_progress_announcement_v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isVideoKey(value: unknown): value is string {
  return typeof value === 'string' && /^youtube:[A-Za-z0-9_-]{11}$/.test(value);
}

function isEta(value: Record<string, unknown>): boolean {
  const secondsValid =
    value.eta_seconds === null || isIntegerInRange(value.eta_seconds, 0, 86400);
  const confidenceValid =
    value.eta_confidence === null ||
    value.eta_confidence === 'low' ||
    value.eta_confidence === 'medium' ||
    value.eta_confidence === 'high';
  return secondsValid && confidenceValid;
}

export function isBackendJobStatus(value: unknown): value is BackendJobStatus {
  if (
    !isRecord(value) ||
    !isVideoKey(value.video_key) ||
    !isTimestamp(value.updated_at) ||
    !isIntegerInRange(value.progress_percent, 0, 100)
  ) {
    return false;
  }

  if (value.status === 'ready') {
    return (
      (value.job_id === null || isJobId(value.job_id)) &&
      value.progress_percent === 100 &&
      typeof value.manifest_id === 'string' &&
      value.manifest_id.length > 0 &&
      Number.isInteger(value.revision) &&
      (value.revision as number) >= 0
    );
  }

  if (value.status === 'failed') {
    return (
      isJobId(value.job_id) &&
      isRecord(value.error) &&
      typeof value.error.code === 'string' &&
      /^[A-Z0-9_]+$/.test(value.error.code) &&
      typeof value.error.retryable === 'boolean'
    );
  }

  if (
    !isJobId(value.job_id) ||
    !isEta(value) ||
    !isIntegerInRange(value.retry_after_ms, 1000, 30000) ||
    value.progress_percent >= 100
  ) {
    return false;
  }

  if (value.status === 'queued') {
    return value.stage === 'queued';
  }

  return (
    value.status === 'processing' &&
    typeof value.stage === 'string' &&
    JOB_PROCESSING_STAGES.includes(value.stage as JobProcessingStage)
  );
}

export function isJobStatus(value: unknown): value is JobStatus {
  if (isBackendJobStatus(value)) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.status === 'not_started') {
    return isVideoKey(value.video_key);
  }
  return (
    value.status === 'unavailable' &&
    (value.video_key === null || isVideoKey(value.video_key)) &&
    (value.reason === 'unsupported_page' ||
      value.reason === 'network' ||
      value.reason === 'invalid_response')
  );
}

export function isPendingProgressAnnouncement(
  value: unknown,
): value is PendingProgressAnnouncement {
  return (
    isRecord(value) &&
    (value.video_key === null || isVideoKey(value.video_key)) &&
    Number.isInteger(value.requested_at) &&
    (value.requested_at as number) > 0 &&
    (value.speech_handled === undefined || typeof value.speech_handled === 'boolean') &&
    isJobStatus(value.job)
  );
}

export function ensureMonotonicProgress(
  previousPercent: number | null,
  status: BackendJobStatus,
): BackendJobStatus {
  if (
    previousPercent === null ||
    status.status === 'ready' ||
    status.progress_percent >= previousPercent
  ) {
    return status;
  }
  return { ...status, progress_percent: previousPercent };
}

export function shouldPollJob(status: JobStatus): status is JobQueuedStatus | JobProcessingStatus {
  return status.status === 'queued' || status.status === 'processing';
}
