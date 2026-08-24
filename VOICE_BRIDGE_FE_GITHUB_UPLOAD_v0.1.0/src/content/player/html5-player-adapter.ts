import type {
  PlayerAdapter,
  PlayerEventListener,
  PlayerEventType,
  PlayerSnapshot,
} from './types';

const MEDIA_EVENTS: readonly PlayerEventType[] = [
  'play',
  'pause',
  'ended',
  'seeking',
  'seeked',
  'ratechange',
  'volumechange',
  'loadedmetadata',
  'durationchange',
  'timeupdate',
];

function secondsToMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value * 1000);
}

function durationToMilliseconds(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value * 1000);
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

export class Html5PlayerAdapter implements PlayerAdapter {
  readonly element: HTMLVideoElement;

  private readonly listeners = new Set<PlayerEventListener>();

  private readonly handleMediaEvent = (event: Event): void => {
    const playerEvent = {
      type: event.type as PlayerEventType,
      snapshot: this.getSnapshot(),
    };
    for (const listener of this.listeners) {
      listener(playerEvent);
    }
  };

  constructor(element: HTMLVideoElement) {
    this.element = element;
    for (const eventName of MEDIA_EVENTS) {
      this.element.addEventListener(eventName, this.handleMediaEvent);
    }
  }

  getSnapshot(): PlayerSnapshot {
    const playbackRate =
      Number.isFinite(this.element.playbackRate) && this.element.playbackRate > 0
        ? this.element.playbackRate
        : 1;

    return {
      currentTimeMs: secondsToMilliseconds(this.element.currentTime),
      durationMs: durationToMilliseconds(this.element.duration),
      playbackRate,
      volume: clampVolume(this.element.volume),
      muted: this.element.muted,
      state: this.element.ended ? 'ended' : this.element.paused ? 'paused' : 'playing',
    };
  }

  async play(): Promise<void> {
    await this.element.play();
  }

  pause(): void {
    this.element.pause();
  }

  setVolume(volume: number): void {
    this.element.volume = clampVolume(volume);
  }

  subscribe(listener: PlayerEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  destroy(): void {
    this.listeners.clear();
    for (const eventName of MEDIA_EVENTS) {
      this.element.removeEventListener(eventName, this.handleMediaEvent);
    }
  }
}
