export type PlayerState = 'playing' | 'paused' | 'ended';

export type PlayerEventType =
  | 'play'
  | 'pause'
  | 'ended'
  | 'seeking'
  | 'seeked'
  | 'ratechange'
  | 'volumechange'
  | 'loadedmetadata'
  | 'durationchange'
  | 'timeupdate';

export type PlayerSnapshot = {
  currentTimeMs: number;
  durationMs: number | null;
  playbackRate: number;
  volume: number;
  muted: boolean;
  state: PlayerState;
};

export type PlayerEvent = {
  type: PlayerEventType;
  snapshot: PlayerSnapshot;
};

export type PlayerEventListener = (event: PlayerEvent) => void;

export interface PlayerAdapter {
  readonly element: HTMLVideoElement;
  getSnapshot(): PlayerSnapshot;
  play(): Promise<void>;
  pause(): void;
  setVolume(volume: number): void;
  subscribe(listener: PlayerEventListener): () => void;
  destroy(): void;
}
