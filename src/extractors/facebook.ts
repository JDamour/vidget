import { shortTitle } from '@/src/shared/format';
import type { Variant } from '@/src/shared/types';
import { type Node, pageData, pageTitle, text, walk } from './pagedata';
import type { ExtractedMedia, Extractor } from './types';

/** A caption can sit in a different block from the video it belongs to. */
const PAGE_DATA = /browser_native_|playable_url|progressive_urls|creation_story/;

interface Found {
  id?: string;
  hd?: string;
  sd?: string;
}

function progressiveUrl(node: Node, quality: string): string | undefined {
  const urls = Array.isArray(node.progressive_urls) ? (node.progressive_urls as Node[]) : [];
  const entry = urls.find((url) => (url.metadata as Node | undefined)?.quality === quality);
  return text(entry?.progressive_url);
}

function findVideo(node: Node): Found | undefined {
  const hd =
    text(node.browser_native_hd_url) ??
    text(node.playable_url_quality_hd) ??
    progressiveUrl(node, 'HD');
  const sd =
    text(node.browser_native_sd_url) ?? text(node.playable_url) ?? progressiveUrl(node, 'SD');
  if (!hd && !sd) return undefined;
  return { id: text(node.id) ?? text(node.videoId) ?? text(node.video_id), hd, sd };
}

function variantOf(id: string, url: string): Variant {
  const bitrate = Number(new URL(url).searchParams.get('bitrate')) || undefined;
  return { id, kind: 'direct', url, bitrate };
}

export function facebookVideoId(url: string): string | undefined {
  const { pathname, searchParams } = new URL(url);
  return pathname.match(/\/(?:videos|reel)\/(?:[^/]+\/)?(\d+)/)?.[1] ?? searchParams.get('v') ?? undefined;
}

/** `videoId` guards against a page reached without a reload, which keeps its old data. */
export function parseFacebookPage(html: string, videoId?: string): ExtractedMedia[] {
  const found = new Map<string, Found>();
  const captions = new Map<string, string>();
  const durations = new Map<string, number>();

  for (const block of pageData(html, PAGE_DATA)) {
    walk(block, (node) => {
      const video = findVideo(node);
      if (video) found.set(video.id ?? video.hd ?? video.sd!, video);
      const id = text(node.id);
      if (!id) return;
      const caption = text(((node.creation_story as Node)?.message as Node)?.text);
      if (caption) captions.set(id, caption);
      if (typeof node.playable_duration_in_ms === 'number') {
        durations.set(id, node.playable_duration_in_ms / 1000);
      }
    });
  }

  const videos = [...found.values()].filter((video) => !video.id || !videoId || video.id === videoId);
  const heading = pageTitle(html)?.replace(/\s*\|\s*Facebook$/, '');
  return videos.map((video) => {
    const id = video.id ?? video.hd ?? video.sd!;
    const variants: Variant[] = [];
    if (video.hd) variants.push(variantOf('facebook-hd', video.hd));
    if (video.sd) variants.push(variantOf('facebook-sd', video.sd));
    return {
      id: `facebook-${id}`,
      title: shortTitle(captions.get(id) ?? heading ?? ''),
      durationSec: durations.get(id),
      variants,
    };
  });
}

export const facebook: Extractor = {
  id: 'facebook',
  matches: [
    /^https:\/\/(www\.|web\.|m\.)?facebook\.com\/(watch\/?\?|reel\/\d|videos\/|[^/]+\/videos\/|[^/]+\/posts\/|permalink\.php)/,
  ],
  async extract(ctx) {
    const videoId = facebookVideoId(ctx.url);
    const html = await ctx.html((page) => !videoId || page.includes(videoId));
    return parseFacebookPage(html, videoId);
  },
};
