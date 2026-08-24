import assert from 'node:assert/strict';

import type { JobProcessingStage, JobStatus } from '../shared/contracts/job-status';
import {
  formatEta,
  formatJobAnnouncement,
  JobAnnouncementTracker,
  jobProgressView,
} from './job-progress';

function processing(
  progress: number,
  stage: JobProcessingStage = 'visual_analysis',
  eta = 180,
): JobStatus {
  return {
    status: 'processing',
    job_id: 'job-123',
    video_key: 'youtube:dQw4w9WgXcQ',
    stage,
    progress_percent: progress,
    eta_seconds: eta,
    eta_confidence: 'medium',
    retry_after_ms: 3000,
    updated_at: '2026-08-18T18:30:00+09:00',
  };
}

assert.equal(formatEta(null), '예상 시간 계산 중');
assert.equal(formatEta(40), '약 1분 이내 남음');
assert.equal(formatEta(181), '약 3분 남음');
assert.equal(jobProgressView(processing(47)).percent, 47);
assert.match(formatJobAnnouncement(processing(47)), /47% 완료/);

const tracker = new JobAnnouncementTracker();
assert.notEqual(tracker.next(processing(10)), null);
assert.equal(tracker.next(processing(11)), null);
assert.notEqual(tracker.next(processing(25)), null);
assert.equal(tracker.next(processing(26)), null);
assert.notEqual(tracker.next(processing(26, 'speech_synthesis')), null);
assert.notEqual(tracker.next(processing(26, 'speech_synthesis'), true), null);
assert.notEqual(
  tracker.next({
    status: 'ready',
    job_id: 'job-123',
    video_key: 'youtube:dQw4w9WgXcQ',
    progress_percent: 100,
    manifest_id: 'youtube:dQw4w9WgXcQ:r1',
    revision: 1,
    updated_at: '2026-08-18T18:35:00+09:00',
  }),
  null,
);

console.log('job progress announcement tests passed');
