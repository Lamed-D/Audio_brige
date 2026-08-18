import { Html5PlayerAdapter } from './html5-player-adapter';

function visibleArea(element: HTMLVideoElement): number {
  const rect = element.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return rect.width * rect.height;
  }
  return element.videoWidth * element.videoHeight;
}

export function findPrimaryYouTubeVideo(root: ParentNode = document): HTMLVideoElement | null {
  const mainVideo = root.querySelector<HTMLVideoElement>('video.html5-main-video');
  if (mainVideo?.isConnected) {
    return mainVideo;
  }

  const videos = [...root.querySelectorAll<HTMLVideoElement>('video')].filter(
    (video) => video.isConnected,
  );
  if (videos.length === 0) {
    return null;
  }

  return videos.reduce((largest, candidate) =>
    visibleArea(candidate) > visibleArea(largest) ? candidate : largest,
  );
}

export class YouTubePlayerAdapter extends Html5PlayerAdapter {}
