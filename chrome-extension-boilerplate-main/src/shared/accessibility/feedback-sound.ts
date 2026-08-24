import type { FeedbackTone } from './announcements';

export type InteractionSound = FeedbackTone | 'focus' | 'adjust';

export type ToneStep = {
  frequency: number;
  duration_ms: number;
  delay_ms: number;
};

export function feedbackTonePattern(
  sound: InteractionSound,
  normalizedValue = 0.5,
): ToneStep[] {
  const value = Math.min(1, Math.max(0, normalizedValue));
  switch (sound) {
    case 'focus':
      return [{ frequency: 720, duration_ms: 28, delay_ms: 0 }];
    case 'adjust':
      return [{ frequency: 360 + value * 720, duration_ms: 34, delay_ms: 0 }];
    case 'toggle-on':
      return [
        { frequency: 520, duration_ms: 42, delay_ms: 0 },
        { frequency: 780, duration_ms: 55, delay_ms: 48 },
      ];
    case 'toggle-off':
      return [
        { frequency: 700, duration_ms: 42, delay_ms: 0 },
        { frequency: 440, duration_ms: 55, delay_ms: 48 },
      ];
    case 'success':
      return [
        { frequency: 520, duration_ms: 55, delay_ms: 0 },
        { frequency: 660, duration_ms: 55, delay_ms: 60 },
        { frequency: 880, duration_ms: 75, delay_ms: 120 },
      ];
    case 'error':
      return [
        { frequency: 260, duration_ms: 85, delay_ms: 0 },
        { frequency: 210, duration_ms: 105, delay_ms: 95 },
      ];
    case 'action':
      return [{ frequency: 620, duration_ms: 48, delay_ms: 0 }];
  }
}

export class FeedbackSoundPlayer {
  private context: AudioContext | null = null;
  private enabled = true;
  private volume = 0.8;
  private lastSoundAt = 0;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
  }

  async unlock(): Promise<void> {
    if (!this.enabled || this.volume === 0) return;
    const context = this.getContext();
    if (context.state === 'suspended') {
      await context.resume();
    }
  }

  play(sound: InteractionSound, normalizedValue = 0.5): void {
    if (!this.enabled || this.volume === 0) return;
    const nowMilliseconds = performance.now();
    if ((sound === 'focus' || sound === 'adjust') && nowMilliseconds - this.lastSoundAt < 45) {
      return;
    }
    this.lastSoundAt = nowMilliseconds;
    const context = this.getContext();
    if (context.state !== 'running') return;

    const start = context.currentTime;
    for (const step of feedbackTonePattern(sound, normalizedValue)) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const stepStart = start + step.delay_ms / 1000;
      const stepEnd = stepStart + step.duration_ms / 1000;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(step.frequency, stepStart);
      gain.gain.setValueAtTime(0.0001, stepStart);
      gain.gain.exponentialRampToValueAtTime(0.18 * this.volume, stepStart + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, stepEnd);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(stepStart);
      oscillator.stop(stepEnd + 0.01);
    }
  }

  private getContext(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }
}
