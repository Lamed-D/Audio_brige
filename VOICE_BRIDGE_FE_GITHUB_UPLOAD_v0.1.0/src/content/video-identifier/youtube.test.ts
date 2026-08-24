import assert from 'node:assert/strict';

import { extractYouTubeVideoId, identifyYouTubeVideo } from './youtube';

const videoId = 'dQw4w9WgXcQ';

assert.equal(extractYouTubeVideoId(`https://www.youtube.com/watch?v=${videoId}`), videoId);
assert.equal(extractYouTubeVideoId(`https://m.youtube.com/shorts/${videoId}`), videoId);
assert.equal(extractYouTubeVideoId(`https://www.youtube.com/embed/${videoId}`), videoId);
assert.equal(extractYouTubeVideoId(`https://www.youtube.com/live/${videoId}`), videoId);
assert.equal(extractYouTubeVideoId('https://www.youtube.com/'), null);
assert.equal(extractYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
assert.equal(extractYouTubeVideoId('https://www.youtube.com/watch?v=too-short'), null);
assert.equal(extractYouTubeVideoId('not-a-url'), null);

assert.deepEqual(identifyYouTubeVideo(`https://www.youtube.com/watch?v=${videoId}`), {
  provider: 'youtube',
  videoId,
  videoKey: `youtube:${videoId}`,
});

console.log('YouTube video identifier tests passed');
