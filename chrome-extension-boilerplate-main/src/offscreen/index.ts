import {
  isOffscreenAudioPlayCommand,
  isOffscreenAudioStopCommand,
  type AudioEngineResponse,
  type OffscreenAudioPlayCommand,
} from '../shared/contracts/messages';

type ActiveAudio = {
  requestId: string;
  audio: HTMLAudioElement;
  settle: (response: AudioEngineResponse) => void;
};

class OffscreenAudioEngine {
  private active: ActiveAudio | null = null;

  play(command: OffscreenAudioPlayCommand): Promise<AudioEngineResponse> {
    this.stop();
    return new Promise((resolve) => {
      const audio = new Audio(command.audio_url);
      const startedAt = performance.now();
      let settled = false;
      let timeoutId = 0;

      const settle = (response: AudioEngineResponse): void => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeoutId);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if (this.active?.requestId === command.request_id) {
          this.active = null;
        }
        resolve(response);
      };

      this.active = { requestId: command.request_id, audio, settle };
      audio.preload = 'auto';
      audio.playbackRate = command.playback_rate;
      audio.volume = command.volume;
      audio.addEventListener(
        'ended',
        () => {
          settle({
            ok: true,
            request_id: command.request_id,
            elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
          });
        },
        { once: true },
      );
      audio.addEventListener(
        'error',
        () => {
          settle({ ok: false, request_id: command.request_id, error: 'load_failed' });
        },
        { once: true },
      );

      const timeoutMs = Math.max(
        5000,
        Math.ceil(command.expected_duration_ms / command.playback_rate) + 3000,
      );
      timeoutId = window.setTimeout(() => {
        settle({ ok: false, request_id: command.request_id, error: 'timeout' });
      }, timeoutMs);

      void audio.play().catch(() => {
        settle({ ok: false, request_id: command.request_id, error: 'play_failed' });
      });
    });
  }

  stop(requestId?: string): void {
    if (!this.active || (requestId && this.active.requestId !== requestId)) {
      return;
    }
    const active = this.active;
    active.settle({ ok: false, request_id: active.requestId, error: 'cancelled' });
  }
}

const audioEngine = new OffscreenAudioEngine();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (isOffscreenAudioPlayCommand(message)) {
    void audioEngine.play(message).then(sendResponse);
    return true;
  }
  if (isOffscreenAudioStopCommand(message)) {
    audioEngine.stop(message.request_id);
    sendResponse({ ok: true });
  }
  return false;
});
