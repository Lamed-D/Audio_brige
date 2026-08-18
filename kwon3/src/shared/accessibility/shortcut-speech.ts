import type { JobProcessingStage, JobStatus } from '../contracts/job-status';

const STAGE_LABELS: Record<JobProcessingStage | 'queued', string> = {
  queued: '분석 대기 중',
  media_preparation: '영상 준비 중',
  audio_analysis: '음성과 대사 분석 중',
  visual_analysis: '화면 글자와 장면 분석 중',
  description_generation: '화면해설 문장 생성 중',
  speech_synthesis: '화면해설 음성 생성 중',
  validation: '음성 길이와 재생 시점 확인 중',
};

function etaForSpeech(seconds: number | null): string {
  if (seconds === null) return '예상 시간 계산 중입니다';
  if (seconds < 60) return '약 1분 이내 남았습니다';
  return `약 ${Math.max(1, Math.round(seconds / 60))}분 남았습니다`;
}

export function jobStatusSpeech(status: JobStatus): string {
  if (status.status === 'queued' || status.status === 'processing') {
    return `화면해설 생성 ${status.progress_percent}퍼센트 완료. ${STAGE_LABELS[status.stage]}. ${etaForSpeech(status.eta_seconds)}.`;
  }
  if (status.status === 'ready') {
    return '화면해설 생성이 완료되었습니다. 바로 재생할 수 있습니다.';
  }
  if (status.status === 'failed') {
    return status.error.retryable
      ? '화면해설을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.'
      : '이 영상의 화면해설을 현재 만들 수 없습니다.';
  }
  if (status.status === 'not_started') {
    return '이 영상은 아직 화면해설이 없습니다.';
  }
  return status.reason === 'unsupported_page'
    ? '지원하는 유튜브 영상에서 현재 상태를 확인할 수 있습니다.'
    : '화면해설 생성 상태를 확인하지 못했습니다.';
}

export function shouldCreateJobFromShortcut(status: JobStatus): boolean {
  return (
    status.status === 'not_started' ||
    (status.status === 'failed' && status.error.retryable)
  );
}

export function panelVisibilitySpeech(visible: boolean): string {
  return visible
    ? '보이스 브리지 패널이 열렸습니다. 현재 패널을 조작할 수 있습니다.'
    : '보이스 브리지 패널이 닫혔습니다. 영상 화면으로 돌아왔습니다.';
}
