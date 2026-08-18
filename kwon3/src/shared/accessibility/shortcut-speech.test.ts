import assert from 'node:assert/strict';

import {
  jobStatusSpeech,
  panelVisibilitySpeech,
  shouldCreateJobFromShortcut,
} from './shortcut-speech';

assert.equal(
  jobStatusSpeech({
    status: 'processing',
    job_id: 'job-1',
    video_key: 'youtube:dQw4w9WgXcQ',
    progress_percent: 50,
    eta_seconds: 120,
    eta_confidence: 'medium',
    retry_after_ms: 3000,
    updated_at: '2026-08-18T00:00:00.000Z',
    stage: 'visual_analysis',
  }),
  '화면해설 생성 50퍼센트 완료. 화면 글자와 장면 분석 중. 약 2분 남았습니다.',
);
assert.equal(
  jobStatusSpeech({
    status: 'not_started',
    video_key: 'youtube:dQw4w9WgXcQ',
  }),
  '이 영상은 아직 화면해설이 없습니다.',
);
assert.match(panelVisibilitySpeech(true), /열렸습니다/);
assert.match(panelVisibilitySpeech(false), /닫혔습니다/);
assert.equal(
  shouldCreateJobFromShortcut({
    status: 'not_started',
    video_key: 'youtube:dQw4w9WgXcQ',
  }),
  true,
);
assert.equal(
  shouldCreateJobFromShortcut({
    status: 'unavailable',
    video_key: 'youtube:dQw4w9WgXcQ',
    reason: 'network',
  }),
  false,
);

console.log('shortcut speech tests passed');
