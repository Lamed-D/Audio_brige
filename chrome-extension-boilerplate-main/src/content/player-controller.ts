import type { PlayerContext, PlayerContextReady } from '../shared/contracts/messages';
import { findPrimaryYouTubeVideo, YouTubePlayerAdapter } from './player/youtube-player-adapter';
import type { PlayerEvent, PlayerEventType } from './player/types';
import { identifyYouTubeVideo, type YouTubeVideoIdentity } from './video-identifier/youtube';

const REFRESH_DELAY_MS = 100;
const URL_CHECK_INTERVAL_MS = 500;
const TIME_UPDATE_INTERVAL_MS = 500;

export type PlayerContextUpdateReason = PlayerEventType | 'videochange' | 'sync';
export type PlayerContextListener = (
  context: PlayerContext,
  reason: PlayerContextUpdateReason,
) => void;

export class YouTubePlayerController {
  private adapter: YouTubePlayerAdapter | null = null;
  private identity: YouTubeVideoIdentity | null = null;
  private unsubscribePlayer: (() => void) | null = null;
  private mutationObserver: MutationObserver | null = null;
  private refreshTimer: number | null = null;
  private urlCheckTimer: number | null = null;
  private lastUrl = '';
  private lastTimeUpdateAt = 0;
  private lastPublishedContext = '';

  constructor(private readonly onContext: PlayerContextListener = () => undefined) {}

  start(): void {
    this.lastUrl = window.location.href;
    document.addEventListener('yt-navigate-finish', this.handleNavigation);
    window.addEventListener('popstate', this.handleNavigation);
    window.addEventListener('hashchange', this.handleNavigation);

    this.mutationObserver = new MutationObserver((records) => {
      const videoTreeChanged = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some((node) =>
          node instanceof Element
            ? node.matches('video') || node.querySelector('video') !== null
            : false,
        ),
      );
      if (!this.adapter || !this.adapter.element.isConnected || videoTreeChanged) {
        this.scheduleRefresh();
      }
    });
    this.mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    this.urlCheckTimer = window.setInterval(() => {
      if (window.location.href !== this.lastUrl || !this.adapter?.element.isConnected) {
        this.scheduleRefresh();
      }
    }, URL_CHECK_INTERVAL_MS);

    this.refresh();
  }

  stop(): void {
    document.removeEventListener('yt-navigate-finish', this.handleNavigation);
    window.removeEventListener('popstate', this.handleNavigation);
    window.removeEventListener('hashchange', this.handleNavigation);
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;

    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.urlCheckTimer !== null) {
      window.clearInterval(this.urlCheckTimer);
      this.urlCheckTimer = null;
    }
    this.detachPlayer();
  }

  getContext(): PlayerContext {
    if (!this.identity) {
      return { available: false, reason: 'unsupported_page' };
    }
    if (!this.adapter) {
      return { available: false, reason: 'video_not_found' };
    }

    const snapshot = this.adapter.getSnapshot();
    const context: PlayerContextReady = {
      available: true,
      provider: this.identity.provider,
      video_id: this.identity.videoId,
      video_key: this.identity.videoKey,
      title: this.getVideoTitle(),
      duration_ms: snapshot.durationMs,
      current_time_ms: snapshot.currentTimeMs,
      playback_rate: snapshot.playbackRate,
      volume: snapshot.volume,
      muted: snapshot.muted,
      state: snapshot.state,
    };
    return context;
  }

  async play(): Promise<boolean> {
    if (!this.adapter) {
      return false;
    }
    try {
      await this.adapter.play();
      return true;
    } catch {
      return false;
    }
  }

  pause(): boolean {
    if (!this.adapter) {
      return false;
    }
    this.adapter.pause();
    return true;
  }

  setVolume(volume: number): boolean {
    if (!this.adapter) {
      return false;
    }
    this.adapter.setVolume(volume);
    return true;
  }

  private readonly handleNavigation = (): void => {
    this.scheduleRefresh();
  };

  private getVideoTitle(): string {
    const metadataTitle = document
      .querySelector<HTMLElement>('h1.ytd-watch-metadata yt-formatted-string')
      ?.textContent?.trim();
    if (metadataTitle) {
      return metadataTitle;
    }
    const documentTitle = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
    return documentTitle || 'YouTube 영상';
  }

  private readonly handlePlayerEvent = (event: PlayerEvent): void => {
    if (event.type === 'timeupdate') {
      const now = Date.now();
      if (now - this.lastTimeUpdateAt < TIME_UPDATE_INTERVAL_MS) {
        return;
      }
      this.lastTimeUpdateAt = now;
    }
    this.publishContext(event.type);
  };

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, REFRESH_DELAY_MS);
  }

  private refresh(): void {
    this.lastUrl = window.location.href;
    const nextIdentity = identifyYouTubeVideo(this.lastUrl);
    const nextVideo = nextIdentity ? findPrimaryYouTubeVideo() : null;

    if (!nextIdentity || !nextVideo) {
      this.identity = nextIdentity;
      this.detachPlayer();
      this.publishContext('videochange');
      return;
    }

    const isSamePlayer =
      this.adapter?.element === nextVideo && this.identity?.videoKey === nextIdentity.videoKey;
    this.identity = nextIdentity;

    if (!isSamePlayer) {
      this.detachPlayer();
      this.adapter = new YouTubePlayerAdapter(nextVideo);
      this.unsubscribePlayer = this.adapter.subscribe(this.handlePlayerEvent);
    }

    this.publishContext(isSamePlayer ? 'sync' : 'videochange');
  }

  private detachPlayer(): void {
    this.unsubscribePlayer?.();
    this.unsubscribePlayer = null;
    this.adapter?.destroy();
    this.adapter = null;
  }

  private publishContext(reason: PlayerContextUpdateReason): void {
    const context = this.getContext();
    const serialized = JSON.stringify(context);
    if (
      serialized === this.lastPublishedContext &&
      (reason === 'timeupdate' || reason === 'sync')
    ) {
      return;
    }
    this.lastPublishedContext = serialized;
    this.onContext(context, reason);
  }
}
