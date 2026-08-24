import assert from 'node:assert/strict';

import {
  isPendingAccessibilityAnnouncement,
  playbackPositionAnnouncement,
} from './announcements';

assert.equal(
  playbackPositionAnnouncement({
    current_time_ms: 135000,
    duration_ms: 600000,
    state: 'playing',
  }),
  '재생 중. 현재 2분 15초, 남은 시간 7분 45초, 전체 10분입니다.',
);
assert.equal(
  playbackPositionAnnouncement({
    current_time_ms: 5000,
    duration_ms: null,
    state: 'paused',
  }),
  '일시정지 상태. 현재 5초 지났습니다.',
);
assert.equal(
  isPendingAccessibilityAnnouncement({
    id: 'request-1',
    text: '화면해설을 켰습니다.',
    requested_at: Date.now(),
    urgency: 'polite',
    tone: 'toggle-on',
    speech_handled: true,
  }),
  true,
);
assert.equal(
  isPendingAccessibilityAnnouncement({
    id: 'request-1',
    text: '',
    requested_at: Date.now(),
    urgency: 'polite',
    tone: 'toggle-on',
    speech_handled: false,
  }),
  false,
);

console.log('accessibility announcement tests passed');
