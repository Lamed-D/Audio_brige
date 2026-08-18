import assert from 'node:assert/strict';

import validFixture from '../../../fixtures/manifest-v1.1.valid.json';
import { parseManifestV1_1 } from '../../shared/contracts/manifest';
import { DescriptionScheduler } from './description-scheduler';

const manifest = parseManifestV1_1(validFixture);

function createScheduler(currentTimeMs = 0): DescriptionScheduler {
  const scheduler = new DescriptionScheduler();
  scheduler.load(manifest, currentTimeMs);
  scheduler.setPlaying(true);
  return scheduler;
}

{
  const scheduler = createScheduler();
  const events = scheduler.tick(12400);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'trigger');
  assert.equal(events[0].segment.id, 'seg-001');
  assert.deepEqual(scheduler.tick(12400), []);
}

{
  const scheduler = createScheduler();
  const events = scheduler.tick(12651);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'skip');
  assert.equal(events[0].type === 'skip' ? events[0].reason : null, 'late');
}

{
  const scheduler = createScheduler();
  scheduler.setPlaying(false);
  assert.deepEqual(scheduler.tick(12400), []);
  assert.equal(scheduler.getSnapshot()?.handled_segments, 0);
}

{
  const scheduler = createScheduler();
  const events = scheduler.seek(20000);
  assert.equal(events.length, 1);
  assert.equal(events[0].type === 'skip' ? events[0].reason : null, 'seek');
  assert.equal(scheduler.getSnapshot()?.next_segment_id, 'seg-002');
}

{
  const scheduler = createScheduler();
  scheduler.tick(12400);
  scheduler.seek(5000);
  assert.deepEqual(scheduler.tick(12400), []);
  assert.equal(scheduler.getSnapshot()?.handled_segments, 1);
}

{
  const scheduler = createScheduler();
  scheduler.seek(32800);
  const events = scheduler.tick(32800);
  assert.equal(events.length, 1);
  assert.equal(events[0].segment.mode, 'extended');
  assert.deepEqual(scheduler.tick(32800), []);
}

{
  const scheduler = createScheduler(20000);
  assert.equal(scheduler.getSnapshot()?.handled_segments, 1);
  assert.equal(scheduler.getSnapshot()?.next_segment_id, 'seg-002');
}

console.log('description scheduler tests passed');
