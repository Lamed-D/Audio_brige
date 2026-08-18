import assert from 'node:assert/strict';

import invalidFixture from '../../../fixtures/manifest-v1.1.invalid.json';
import validFixture from '../../../fixtures/manifest-v1.1.valid.json';
import {
  ManifestValidationError,
  parseManifestV1_1,
  SUPPORTED_SCHEMA_VERSION,
} from './manifest';

const manifest = parseManifestV1_1(validFixture);

assert.equal(manifest.schema_version, SUPPORTED_SCHEMA_VERSION);
assert.equal(manifest.segments.length, 2);
assert.equal(manifest.segments[0].mode, 'overlay');
assert.equal(manifest.segments[1].mode, 'extended');

assert.throws(
  () => parseManifestV1_1(invalidFixture),
  (error: unknown) =>
    error instanceof ManifestValidationError &&
    error.message.includes('audio exceeds the overlay window'),
);

assert.throws(
  () => parseManifestV1_1({ ...validFixture, schema_version: '1.0' }),
  (error: unknown) =>
    error instanceof ManifestValidationError && error.message.includes('unsupported version'),
);

assert.throws(
  () => parseManifestV1_1({ ...validFixture, manifest_id: 'youtube:other:r1' }),
  (error: unknown) =>
    error instanceof ManifestValidationError && error.message.includes('must match'),
);

console.log('manifest v1.1 contract tests passed');
