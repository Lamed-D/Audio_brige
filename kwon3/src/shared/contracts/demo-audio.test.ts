import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import validFixture from '../../../fixtures/manifest-v1.1.valid.json';
import { parseManifestV1_1 } from './manifest';

function getWavDurationMs(buffer: Buffer): number {
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      byteRate = buffer.readUInt32LE(offset + 16);
    }
    if (chunkId === 'data') {
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  assert.ok(byteRate > 0 && dataSize > 0, 'valid WAV chunks expected');
  return Math.round((dataSize / byteRate) * 1000);
}

const manifest = parseManifestV1_1(validFixture);
for (const segment of manifest.segments) {
  const audioFile = resolve('extension', 'demo-audio', basename(segment.audio.path));
  const buffer = readFileSync(audioFile);
  assert.equal(getWavDurationMs(buffer), segment.audio.duration_ms);
  assert.equal(createHash('sha256').update(buffer).digest('hex'), segment.audio.sha256);
}

console.log('demo audio fixture tests passed');
