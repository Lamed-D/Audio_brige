export const YOUTUBE_PROVIDER = 'youtube' as const;

export type YouTubeVideoIdentity = {
  provider: typeof YOUTUBE_PROVIDER;
  videoId: string;
  videoKey: `${typeof YOUTUBE_PROVIDER}:${string}`;
};

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = new Set(['embed', 'live', 'shorts']);

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'youtube.com' || host.endsWith('.youtube.com');
}

function validVideoId(value: string | null | undefined): value is string {
  return typeof value === 'string' && VIDEO_ID_PATTERN.test(value);
}

export function extractYouTubeVideoId(input: string | URL): string | null {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return null;
  }

  if (!isYouTubeHost(url.hostname)) {
    return null;
  }

  const queryVideoId = url.searchParams.get('v');
  if (url.pathname === '/watch' && validVideoId(queryVideoId)) {
    return queryVideoId;
  }

  const pathSegments = url.pathname.split('/').filter(Boolean);
  if (pathSegments.length >= 2 && PATH_PREFIXES.has(pathSegments[0])) {
    const pathVideoId = pathSegments[1];
    return validVideoId(pathVideoId) ? pathVideoId : null;
  }

  return null;
}

export function identifyYouTubeVideo(input: string | URL): YouTubeVideoIdentity | null {
  const videoId = extractYouTubeVideoId(input);
  if (!videoId) {
    return null;
  }

  return {
    provider: YOUTUBE_PROVIDER,
    videoId,
    videoKey: `${YOUTUBE_PROVIDER}:${videoId}`,
  };
}
