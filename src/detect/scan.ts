import type { MediaReport } from '@/src/shared/types';
import { classify } from './classify';

/** Every <video> in the document, including inside open shadow roots. */
export function findVideos(root: ParentNode = document): HTMLVideoElement[] {
  const videos = [...root.querySelectorAll('video')];
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) videos.push(...findVideos(element.shadowRoot));
  }
  return videos;
}

function isHttp(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

function clean(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function reportsFor(video: HTMLVideoElement): MediaReport[] {
  const urls = new Set<string>();
  if (video.currentSrc) urls.add(video.currentSrc);
  if (video.src) urls.add(video.src);
  // A playing element has already chosen one <source>; the others are unused.
  if (!video.currentSrc) {
    for (const source of video.querySelectorAll('source')) if (source.src) urls.add(source.src);
  }
  return [...urls].filter(isHttp).map((url) => ({
    url,
    source: 'dom',
    durationSec: clean(video.duration),
    thumbnail: video.poster || undefined,
    title: video.getAttribute('aria-label') || video.title || undefined,
  }));
}

/**
 * What the page already requested. When the scripts arrive late, a running
 * player has fetched its manifest and will not fetch it again.
 */
export function reportsFromTiming(entries: { name: string }[]): MediaReport[] {
  return entries
    .filter((entry) => classify(entry.name))
    .map((entry) => ({ url: entry.name, source: 'probe' }));
}

/** The biggest on-screen video stands in for the page's main player. */
export function mainVideo(videos: HTMLVideoElement[]): HTMLVideoElement | undefined {
  let best: HTMLVideoElement | undefined;
  let bestArea = 0;
  for (const video of videos) {
    const { width, height } = video.getBoundingClientRect();
    const area = width * height;
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }
  return best;
}
