import assert from 'node:assert/strict';

import validManifest from '../../fixtures/manifest-v1.1.valid.json';
import type { JobTarget } from '../shared/contracts/messages';
import { JobClient } from './job-client';

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function runJobClientTests(): Promise<void> {
  const runtime = globalThis as typeof globalThis & { chrome?: typeof chrome };
  const originalChrome = runtime.chrome;
  const originalFetch = globalThis.fetch;
  const storage: Record<string, unknown> = {};
  let fetchHandler: FetchHandler = () => jsonResponse({}, 500);

  runtime.chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        },
      },
    },
  } as unknown as typeof chrome;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    fetchHandler(String(input), init)) as typeof fetch;

  try {
    const client = new JobClient('http://127.0.0.1:5000');
    const target: JobTarget = {
      provider: 'youtube',
      video_id: 'dQw4w9WgXcQ',
      duration_ms: 213061,
    };

    fetchHandler = () => jsonResponse(validManifest);
    const ready = await client.getManifest(target);
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.equal(ready.manifest.manifest_id, validManifest.manifest_id);
    }

    const durationMismatch = await client.getManifest({ ...target, duration_ms: 220000 });
    assert.deepEqual(durationMismatch, {
      status: 'unavailable',
      video_key: 'youtube:dQw4w9WgXcQ',
      reason: 'invalid_response',
    });

    fetchHandler = () =>
      jsonResponse(
        {
          status: 'processing',
          job_id: '0123456789abcdef0123456789abcdef',
          video_key: 'youtube:dQw4w9WgXcQ',
          stage: 'visual_analysis',
          progress_percent: 45,
          eta_seconds: null,
          eta_confidence: null,
          retry_after_ms: 1500,
          updated_at: '2026-08-18T12:00:00Z',
        },
        202,
      );
    assert.deepEqual(await client.getManifest(target), {
      status: 'pending',
      video_key: 'youtube:dQw4w9WgXcQ',
      retry_after_ms: 1500,
    });

    let postedBody: Record<string, unknown> | null = null;
    fetchHandler = (_url, init) => {
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(
        {
          status: 'queued',
          job_id: 'fedcba9876543210fedcba9876543210',
          video_key: 'youtube:dQw4w9WgXcQ',
          stage: 'queued',
          progress_percent: 0,
          eta_seconds: null,
          eta_confidence: null,
          retry_after_ms: 1500,
          updated_at: '2026-08-18T12:00:00Z',
        },
        202,
      );
    };
    const messageTarget = { type: 'JOB_CREATE', ...target } as JobTarget & {
      type: 'JOB_CREATE';
    };
    assert.equal((await client.create(messageTarget)).status, 'queued');
    assert.deepEqual(postedBody, target);

    fetchHandler = () =>
      jsonResponse(
        {
          error: {
            code: 'MEDIA_MISMATCH',
            message: '영상 길이가 일치하지 않습니다.',
            retryable: false,
          },
        },
        409,
      );
    assert.deepEqual(await client.create(target), {
      status: 'unavailable',
      video_key: 'youtube:dQw4w9WgXcQ',
      reason: 'invalid_response',
    });

    console.log('job API client tests passed');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) {
      Reflect.deleteProperty(runtime, 'chrome');
    } else {
      runtime.chrome = originalChrome;
    }
  }
}
