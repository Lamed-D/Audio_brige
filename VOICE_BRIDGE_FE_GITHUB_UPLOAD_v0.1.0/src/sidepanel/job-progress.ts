import type { JobProcessingStage, JobStatus } from '../shared/contracts/job-status';

const STAGE_LABELS: Record<JobProcessingStage | 'queued', string> = {
  queued: '분석 대기 중',
  media_preparation: '영상 준비 중',
  audio_analysis: '음성과 대사 분석 중',
  visual_analysis: '화면 글자와 장면 분석 중',
  description_generation: '화면해설 문장 생성 중',
  speech_synthesis: '화면해설 음성 생성 중',
  validation: '음성 길이와 재생 시점 확인 중',
};

export type JobProgressView = {
  summary: string;
  stage: string | null;
  percent: number | null;
  eta: string | null;
  progressValueText: string | null;
};

export function formatEta(seconds: number | null): string {
  if (seconds === null) {
    return '예상 시간 계산 중';
  }
  if (seconds < 60) {
    return '약 1분 이내 남음';
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `약 ${minutes}분 남음`;
}

export function jobProgressView(status: JobStatus): JobProgressView {
  if (status.status === 'not_started') {
    return {
      summary: '이 영상은 아직 화면해설이 없습니다.',
      stage: null,
      percent: null,
      eta: null,
      progressValueText: null,
    };
  }
  if (status.status === 'unavailable') {
    return {
      summary:
        status.reason === 'unsupported_page'
          ? '지원되는 영상에서 현재 상태를 확인할 수 있습니다.'
          : '화면해설 생성 상태를 확인하지 못했습니다.',
      stage: null,
      percent: null,
      eta: null,
      progressValueText: null,
    };
  }
  if (status.status === 'ready') {
    return {
      summary: '화면해설 준비 완료',
      stage: '바로 재생할 수 있습니다.',
      percent: 100,
      eta: null,
      progressValueText: '화면해설 생성 100% 완료',
    };
  }
  if (status.status === 'failed') {
    return {
      summary: '화면해설 생성 실패',
      stage: status.error.retryable
        ? '잠시 후 다시 시도할 수 있습니다.'
        : '이 영상은 현재 처리할 수 없습니다.',
      percent: status.progress_percent,
      eta: null,
      progressValueText: `화면해설 생성 ${status.progress_percent}%에서 중단됨`,
    };
  }

  const stage = STAGE_LABELS[status.stage];
  const eta = formatEta(status.eta_seconds);
  return {
    summary: status.status === 'queued' ? '화면해설 생성 대기 중' : '화면해설 생성 중',
    stage,
    percent: status.progress_percent,
    eta,
    progressValueText: `화면해설 생성 ${status.progress_percent}% 완료, ${stage}, ${eta}`,
  };
}

export function formatJobAnnouncement(status: JobStatus): string {
  const view = jobProgressView(status);
  if (status.status === 'queued' || status.status === 'processing') {
    return `화면해설 생성 ${status.progress_percent}% 완료. ${view.stage}. ${view.eta}.`;
  }
  if (status.status === 'ready') {
    return '화면해설 생성이 완료되었습니다. 바로 재생할 수 있습니다.';
  }
  if (status.status === 'failed') {
    return status.error.retryable
      ? '화면해설을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.'
      : '이 영상의 화면해설을 현재 만들 수 없습니다.';
  }
  return view.summary;
}

function milestone(percent: number): number {
  if (percent >= 75) return 75;
  if (percent >= 50) return 50;
  if (percent >= 25) return 25;
  return 0;
}

function materialEtaChange(previous: number | null, current: number | null): boolean {
  if (previous === null || current === null) {
    return previous !== current;
  }
  const difference = Math.abs(previous - current);
  return difference >= 60 || difference / Math.max(previous, 1) >= 0.3;
}

export class JobAnnouncementTracker {
  private videoKey: string | null = null;
  private status: JobStatus['status'] | null = null;
  private stage: string | null = null;
  private milestone = 0;
  private etaSeconds: number | null = null;

  next(value: JobStatus, manual = false): string | null {
    if (manual) {
      this.capture(value);
      return formatJobAnnouncement(value);
    }

    const videoChanged = value.video_key !== this.videoKey;
    const statusChanged = value.status !== this.status;
    const nextStage =
      value.status === 'queued' || value.status === 'processing' ? value.stage : null;
    const stageChanged = nextStage !== this.stage;
    const nextMilestone =
      value.status === 'queued' || value.status === 'processing'
        ? milestone(value.progress_percent)
        : 0;
    const milestoneChanged = nextMilestone > this.milestone;
    const nextEta =
      value.status === 'queued' || value.status === 'processing' ? value.eta_seconds : null;
    const etaChanged = materialEtaChange(this.etaSeconds, nextEta);

    this.capture(value);

    if (
      videoChanged ||
      statusChanged ||
      stageChanged ||
      milestoneChanged ||
      (etaChanged && nextEta !== null)
    ) {
      return formatJobAnnouncement(value);
    }
    return null;
  }

  private capture(value: JobStatus): void {
    this.videoKey = value.video_key;
    this.status = value.status;
    if (value.status === 'queued' || value.status === 'processing') {
      this.stage = value.stage;
      this.milestone = milestone(value.progress_percent);
      this.etaSeconds = value.eta_seconds;
      return;
    }
    this.stage = null;
    this.milestone = 0;
    this.etaSeconds = null;
  }
}
