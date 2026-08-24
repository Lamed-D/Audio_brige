import assert from 'node:assert/strict';

import { Html5PlayerAdapter } from './html5-player-adapter';

class FakeVideoElement extends EventTarget {
  currentTime = 12.345;
  duration = 90.5;
  playbackRate = 1.25;
  volume = 0.8;
  muted = false;
  paused = false;
  ended = false;
  pauseCalls = 0;

  async play(): Promise<void> {
    this.paused = false;
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
}

const fakeVideo = new FakeVideoElement();
const adapter = new Html5PlayerAdapter(fakeVideo as unknown as HTMLVideoElement);

assert.deepEqual(adapter.getSnapshot(), {
  currentTimeMs: 12345,
  durationMs: 90500,
  playbackRate: 1.25,
  volume: 0.8,
  muted: false,
  state: 'playing',
});

const receivedEvents: string[] = [];
const unsubscribe = adapter.subscribe((event) => {
  receivedEvents.push(event.type);
});
fakeVideo.dispatchEvent(new Event('seeking'));
fakeVideo.dispatchEvent(new Event('ratechange'));
assert.deepEqual(receivedEvents, ['seeking', 'ratechange']);

adapter.setVolume(2);
assert.equal(fakeVideo.volume, 1);
adapter.setVolume(-1);
assert.equal(fakeVideo.volume, 0);

adapter.pause();
assert.equal(fakeVideo.pauseCalls, 1);
assert.equal(adapter.getSnapshot().state, 'paused');

unsubscribe();
fakeVideo.dispatchEvent(new Event('seeked'));
assert.deepEqual(receivedEvents, ['seeking', 'ratechange']);

adapter.destroy();
console.log('HTML5 player adapter tests passed');
