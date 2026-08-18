export const PENDING_ACCESSIBILITY_ANNOUNCEMENT_STORAGE_KEY =
  'voiceBridgePendingAccessibilityAnnouncement';

export type FeedbackTone =
  | 'action'
  | 'success'
  | 'error'
  | 'toggle-on'
  | 'toggle-off';

export type PendingAccessibilityAnnouncement = {
  id: string;
  text: string;
  requested_at: number;
  urgency: 'polite' | 'assertive';
  tone: FeedbackTone;
  speech_handled: boolean;
};

export type PlaybackPosition = {
  current_time_ms: number;
  duration_ms: number | null;
  state: 'playing' | 'paused' | 'ended';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPendingAccessibilityAnnouncement(
  value: unknown,
): value is PendingAccessibilityAnnouncement {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0 &&
    Number.isInteger(value.requested_at) &&
    (value.requested_at as number) > 0 &&
    (value.urgency === 'polite' || value.urgency === 'assertive') &&
    (value.tone === 'action' ||
      value.tone === 'success' ||
      value.tone === 'error' ||
      value.tone === 'toggle-on' ||
      value.tone === 'toggle-off') &&
    typeof value.speech_handled === 'boolean'
  );
}

function durationForSpeech(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}시간`);
  if (minutes > 0) parts.push(`${minutes}분`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}초`);
  return parts.join(' ');
}

export function playbackPositionAnnouncement(position: PlaybackPosition): string {
  const stateLabel =
    position.state === 'playing'
      ? '재생 중'
      : position.state === 'paused'
        ? '일시정지 상태'
        : '재생 완료';
  const elapsed = durationForSpeech(position.current_time_ms);
  if (position.duration_ms === null) {
    return `${stateLabel}. 현재 ${elapsed} 지났습니다.`;
  }
  const remaining = durationForSpeech(
    Math.max(0, position.duration_ms - position.current_time_ms),
  );
  const total = durationForSpeech(position.duration_ms);
  return `${stateLabel}. 현재 ${elapsed}, 남은 시간 ${remaining}, 전체 ${total}입니다.`;
}
