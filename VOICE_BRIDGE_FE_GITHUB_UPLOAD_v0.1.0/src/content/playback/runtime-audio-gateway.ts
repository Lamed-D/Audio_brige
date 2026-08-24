import type {
  AudioEnginePlayRequest,
  AudioEngineResponse,
  AudioEngineStopRequest,
} from '../../shared/contracts/messages';

export type AudioPlayInput = Omit<AudioEnginePlayRequest, 'type'>;

export interface AudioGateway {
  play(input: AudioPlayInput): Promise<AudioEngineResponse>;
  stop(requestId?: string): Promise<void>;
}

function isAudioEngineResponse(value: unknown): value is AudioEngineResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  if (typeof response.request_id !== 'string') {
    return false;
  }
  return response.ok === true
    ? Number.isInteger(response.elapsed_ms) && (response.elapsed_ms as number) >= 0
    : response.ok === false && typeof response.error === 'string';
}

export class RuntimeAudioGateway implements AudioGateway {
  async play(input: AudioPlayInput): Promise<AudioEngineResponse> {
    const request: AudioEnginePlayRequest = { type: 'AUDIO_ENGINE_PLAY', ...input };
    const response: unknown = await chrome.runtime.sendMessage(request);
    if (!isAudioEngineResponse(response)) {
      return { ok: false, request_id: input.request_id, error: 'invalid_request' };
    }
    return response;
  }

  async stop(requestId?: string): Promise<void> {
    const request: AudioEngineStopRequest = {
      type: 'AUDIO_ENGINE_STOP',
      ...(requestId ? { request_id: requestId } : {}),
    };
    await chrome.runtime.sendMessage(request);
  }
}
