export type MediaKind = 'hls' | 'dash' | 'direct';

const HLS_TYPES = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl)|audio\/(x-)?mpegurl)/i;
const DASH_TYPES = /^application\/dash\+xml/i;
const SEGMENT_TYPES = /^video\/(mp2t|iso\.segment)/i;

const AD_HOSTS =
  /(^|\.)(doubleclick\.net|2mdn\.net|googlesyndication\.com|googleadservices\.com|adnxs\.com|moatads\.com|adsafeprotected\.com|amazon-adsystem\.com|imasdk\.googleapis\.com|taboola\.com|outbrain\.com|teads\.tv|springserve\.com|spotxchange\.com)$/i;
const AD_PATHS = /\/(ads?|adserver|preroll|midroll|vast)(\/|[-_.])|_video_ads\//i;

const YOUTUBE_HOSTS =
  /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|googlevideo\.com)$/i;

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Decide what a URL is from its MIME type, falling back to its extension. */
export function classify(url: string, contentType?: string): MediaKind | null {
  const parsed = parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return null;
  const type = contentType?.trim() ?? '';
  if (SEGMENT_TYPES.test(type)) return null;
  if (HLS_TYPES.test(type)) return 'hls';
  if (DASH_TYPES.test(type)) return 'dash';
  if (/^video\//i.test(type)) return 'direct';

  const path = parsed.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (/\.(mp4|webm|mov|mkv|m4v)$/.test(path)) return 'direct';
  return null;
}

export function isAd(url: string): boolean {
  const parsed = parse(url);
  return !parsed || AD_HOSTS.test(parsed.hostname) || AD_PATHS.test(parsed.pathname);
}

export function isYoutubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.test(hostname);
}

/** The query is dropped because signed CDN URLs differ only in their tokens. */
export function mediaKey(url: string): string {
  const parsed = parse(url);
  return parsed ? `${parsed.origin}${parsed.pathname}` : url;
}

export function totalSizeFrom(headers: { contentLength?: string; contentRange?: string }) {
  const total = headers.contentRange?.match(/\/(\d+)\s*$/)?.[1];
  const value = Number(total ?? headers.contentLength);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
