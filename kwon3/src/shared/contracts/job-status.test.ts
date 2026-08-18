import assert from 'node:assert/strict';

import {
  ensureMonotonicProgress,
  isBackendJobStatus,
  isJobStatus,
  isPendingProgressAnnouncement,
  shouldPollJob,
} from './job-status';

const processing = {
  status: 'processing',
  job_id: 'job-123',
  video_key: 'youtube:dQw4w9WgXcQ',
  stage: 'visual_analysis',
  progress_percent: 47,
  eta_seconds: 210,
  eta_confidence: 'medium',
  retry_after_ms: 3000,
  updated_at: '2026-08-18T18:30:00+09:00',
} as const;

assert.equal(isBackendJobStatus(processing), true);
assert.equal(isJobStatus(processing), true);
assert.equal(shouldPollJob(processing), true);
assert.equal(isBackendJobStatus({ ...processing, progress_percent: 101 }), false);
assert.equal(isBackendJobStatus({ ...processing, retry_after_ms: 300 }), false);
assert.equal(isBackendJobStatus({ ...processing, stage: 'unknown' }), false);

const ready = {
  status: 'ready',
  job_id: 'job-123',
  video_key: 'youtube:dQw4w9WgXcQ',
  progress_percent: 100,
  manifest_id: 'youtube:dQw4w9WgXcQ:r3',
  revision: 3,
  updated_at: '2026-08-18T18:35:00+09:00',
} as const;

assert.equal(isBackendJobStatus(ready), true);
assert.equal(shouldPollJob(ready), false);
assert.equal(
  ensureMonotonicProgress(52, { ...processing, progress_percent: 47 }).progress_percent,
  52,
);
assert.equal(ensureMonotonicProgress(52, ready).progress_percent, 100);
assert.equal(
  isPendingProgressAnnouncement({
    video_key: processing.video_key,
    requested_at: Date.now(),
    job: processing,
  }),
  true,
);
assert.equal(
  isJobStatus({ status: 'not_started', video_key: 'youtube:dQw4w9WgXcQ' }),
  true,
);
assert.equal(
  isJobStatus({ status: 'unavailable', video_key: null, reason: 'unsupported_page' }),
  true,
);

console.log('job status contract tests passed');
