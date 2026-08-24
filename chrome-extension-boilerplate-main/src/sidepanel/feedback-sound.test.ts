import assert from 'node:assert/strict';

import { feedbackTonePattern } from '../shared/accessibility/feedback-sound';

assert.equal(feedbackTonePattern('focus').length, 1);
assert.equal(feedbackTonePattern('success').length, 3);
assert.equal(feedbackTonePattern('error').length, 2);
assert.ok(
  feedbackTonePattern('adjust', 1)[0].frequency >
    feedbackTonePattern('adjust', 0)[0].frequency,
);
assert.ok(feedbackTonePattern('toggle-on')[1].frequency > feedbackTonePattern('toggle-on')[0].frequency);
assert.ok(feedbackTonePattern('toggle-off')[1].frequency < feedbackTonePattern('toggle-off')[0].frequency);

console.log('feedback sound tests passed');
