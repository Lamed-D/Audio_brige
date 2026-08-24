import {
  ensureMonotonicProgress,
  isBackendJobStatus,
  JOB_TRACKING_STORAGE_KEY,
  type BackendJobStatus,
  type JobStatus,
} from '../shared/contracts/job-status';
import { parseManifestV1_1 } from '../shared/contracts/manifest';
import type { JobTarget } from '../shared/contracts/messages';

const API_TIMEOUT_MS = 5000;

type StoredJob = {
  job_id: string;
  last_progress_percent: number;
  status: 'queued' | 'processing' | 'failed';
};

type StoredJobs = Record<string, StoredJob>;

function videoKey(target: JobTarget): string {
  return `${target.provider}:${target.video_id}`;
}

function isStoredJob(value: unknown): value is StoredJob {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as StoredJob).job_id === 'string' &&
    /^[A-Za-z0-9._:-]+$/.test((value as StoredJob).job_id) &&
    Number.isInteger((value as StoredJob).last_progress_percent) &&
    (value as StoredJob).last_progress_percent >= 0 &&
    (value as StoredJob).last_progress_percent <= 100 &&
    ((value as StoredJob).status === 'queued' ||
      (value as StoredJob).status === 'processing' ||
      (value as StoredJob).status === 'failed')
  );
}

function parseStoredJobs(value: unknown): StoredJobs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const result: StoredJobs = {};
  for (const [key, job] of Object.entries(value)) {
    if (/^youtube:[A-Za-z0-9_-]{11}$/.test(key) && isStoredJob(job)) {
      result[key] = job;
    }
  }
  return result;
}

async function readStoredJobs(): Promise<StoredJobs> {
  const stored = await chrome.storage.local.get(JOB_TRACKING_STORAGE_KEY);
  return parseStoredJobs(stored[JOB_TRACKING_STORAGE_KEY]);
}

async function writeStoredJobs(jobs: StoredJobs): Promise<void> {
  await chrome.storage.local.set({ [JOB_TRACKING_STORAGE_KEY]: jobs });
}

async function fetchWithTimeout(path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class JobClient {
  constructor(private readonly baseUrl: string) {}

  async listPollingTargets(): Promise<JobTarget[]> {
    const jobs = await readStoredJobs();
    return Object.entries(jobs)
      .filter(([, job]) => job.status === 'queued' || job.status === 'processing')
      .map(([key]) => {
        const [, videoId] = key.split(':');
        return { provider: 'youtube' as const, video_id: videoId, duration_ms: null };
      });
  }

  async getStatus(target: JobTarget): Promise<JobStatus> {
    const key = videoKey(target);
    const jobs = await readStoredJobs();
    const storedJob = jobs[key];
    try {
      if (storedJob) {
        const tracked = await this.fetchTrackedJob(key, storedJob, jobs);
        if (tracked) {
          return tracked;
        }
      }
      return await this.fetchManifestStatus(target, jobs);
    } catch {
      return { status: 'unavailable', video_key: key, reason: 'network' };
    }
  }

  async create(target: JobTarget): Promise<JobStatus> {
    const key = videoKey(target);
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target),
      });
      if (response.status !== 202 && response.status !== 200 && response.status !== 409) {
        return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
      }
      const value = await parseJson(response);
      if (!isBackendJobStatus(value) || value.video_key !== key) {
        return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
      }
      return await this.persistProgress(value);
    } catch {
      return { status: 'unavailable', video_key: key, reason: 'network' };
    }
  }

  private async fetchTrackedJob(
    key: string,
    storedJob: StoredJob,
    jobs: StoredJobs,
  ): Promise<JobStatus | null> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/v1/jobs/${encodeURIComponent(storedJob.job_id)}`,
    );
    if (response.status === 404) {
      delete jobs[key];
      await writeStoredJobs(jobs);
      return null;
    }
    if (!response.ok) {
      return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
    }
    const value = await parseJson(response);
    if (!isBackendJobStatus(value) || value.video_key !== key) {
      return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
    }
    return this.persistProgress(value, storedJob.last_progress_percent);
  }

  private async fetchManifestStatus(
    target: JobTarget,
    jobs: StoredJobs,
  ): Promise<JobStatus> {
    const key = videoKey(target);
    const response = await fetchWithTimeout(
      `${this.baseUrl}/v1/manifests/${target.provider}/${encodeURIComponent(target.video_id)}`,
    );
    if (response.status === 404) {
      return { status: 'not_started', video_key: key };
    }
    if (response.status === 202) {
      const value = await parseJson(response);
      if (!isBackendJobStatus(value) || value.video_key !== key) {
        return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
      }
      return this.persistProgress(value);
    }
    if (!response.ok) {
      return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
    }
    try {
      const manifest = parseManifestV1_1(await parseJson(response));
      if (`${manifest.video.provider}:${manifest.video.video_id}` !== key) {
        return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
      }
      delete jobs[key];
      await writeStoredJobs(jobs);
      return {
        status: 'ready',
        job_id: null,
        video_key: key,
        progress_percent: 100,
        manifest_id: manifest.manifest_id,
        revision: manifest.revision,
        updated_at: new Date().toISOString(),
      };
    } catch {
      return { status: 'unavailable', video_key: key, reason: 'invalid_response' };
    }
  }

  private async persistProgress(
    status: BackendJobStatus,
    previousPercent: number | null = null,
  ): Promise<BackendJobStatus> {
    const jobs = await readStoredJobs();
    const previous = jobs[status.video_key];
    const normalized = ensureMonotonicProgress(
      previousPercent ?? previous?.last_progress_percent ?? null,
      status,
    );
    if (normalized.status === 'ready') {
      delete jobs[normalized.video_key];
    } else {
      jobs[normalized.video_key] = {
        job_id: normalized.job_id,
        last_progress_percent: normalized.progress_percent,
        status: normalized.status,
      };
    }
    await writeStoredJobs(jobs);
    return normalized;
  }
}
