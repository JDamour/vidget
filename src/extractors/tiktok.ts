import { shortTitle } from '@/src/shared/format';
import type { Variant } from '@/src/shared/types';
import { pageData } from './pagedata';
import type { ExtractedMedia, Extractor } from './types';

const DETAIL_KEY = 'webapp.video-detail';

interface Encoding {
  Bitrate?: number;
  CodecType?: string;
  PlayAddr?: { DataSize?: string; Width?: number; Height?: number; UrlList?: string[] };
}

interface TikTokItem {
  id?: string;
  desc?: string;
  author?: { uniqueId?: string };
  video?: { duration?: number; cover?: string; playAddr?: string; bitrateInfo?: Encoding[] };
}

type Rehydration = {
  __DEFAULT_SCOPE__?: Record<string, { itemInfo?: { itemStruct?: TikTokItem } } | undefined>;
};

function idFrom(url: string): string | undefined {
  return new URL(url).pathname.match(/\/video\/(\d+)/)?.[1];
}

/**
 * One encoding per height. H.264 comes first even at a lower height, because the
 * first variant is the default, and many players cannot open H.265 at all.
 */
function variantsOf({ bitrateInfo = [], playAddr }: NonNullable<TikTokItem['video']>): Variant[] {
  const byHeight = new Map<number, { variant: Variant; h264: boolean }>();
  for (const { Bitrate, CodecType, PlayAddr } of bitrateInfo) {
    const url = PlayAddr?.UrlList?.[0];
    if (!url) continue;
    // Portrait videos state 1080x1920, but people call that 1080p.
    const height = Math.min(PlayAddr?.Width ?? 0, PlayAddr?.Height ?? 0);
    const h264 = CodecType === 'h264';
    const current = byHeight.get(height);
    if (current && (current.h264 || !h264)) continue;
    byHeight.set(height, {
      h264,
      variant: {
        id: `tiktok-${height}`,
        kind: 'direct',
        url,
        height: height || undefined,
        bitrate: Bitrate,
        codecs: CodecType,
        sizeEstimate: Number(PlayAddr?.DataSize) || undefined,
      },
    });
  }
  const variants = [...byHeight.values()]
    .sort(
      (a, b) =>
        Number(b.h264) - Number(a.h264) || (b.variant.height ?? 0) - (a.variant.height ?? 0),
    )
    .map((entry) => entry.variant);
  if (variants.length || !playAddr) return variants;
  return [{ id: 'tiktok-play', kind: 'direct', url: playAddr }];
}

function mediaOf(item: TikTokItem): ExtractedMedia | undefined {
  if (!item.id || !item.video) return undefined;
  const variants = variantsOf(item.video);
  if (!variants.length) return undefined; // A photo post.
  const handle = item.author?.uniqueId;
  const body = shortTitle(item.desc ?? '');
  return {
    id: `tiktok-${item.id}`,
    title: handle ? `@${handle} - ${body || 'video'}` : body,
    durationSec: item.video.duration,
    thumbnail: item.video.cover,
    variants,
  };
}

/** `id` guards against a page reached without a reload, which keeps its old data. */
export function parseTikTokPage(html: string, id: string): ExtractedMedia[] {
  for (const block of pageData(html, /webapp\.video-detail/) as Rehydration[]) {
    const item = block.__DEFAULT_SCOPE__?.[DETAIL_KEY]?.itemInfo?.itemStruct;
    const media = item?.id === id ? mediaOf(item) : undefined;
    if (media) return [media];
  }
  return [];
}

const FILE_ID = /\/video\/tos\/[^/]+\/[^/]+\/([^/?]+)/;

/**
 * Every encoding of a video is a file with an id in its path. The rest of the URL
 * is a signature that changes between requests for the same file.
 */
export function tiktokFileId(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const { hostname, pathname } = new URL(url);
  return /tiktok/i.test(hostname) ? pathname.match(FILE_ID)?.[1] : undefined;
}

/** A post from the feed, with the ids of every file the player may stream for it. */
export interface KnownMedia {
  fileIds: string[];
  media: ExtractedMedia;
}

/**
 * The feed's own API responses name each post's files, which is how a stream the
 * player picked is tied back to its post, its caption and an H.264 encoding.
 */
export function tiktokFeedMedia(text: string): KnownMedia[] {
  let data: { itemList?: TikTokItem[]; itemInfo?: { itemStruct?: TikTokItem } };
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const items = [...(data.itemList ?? []), ...(data.itemInfo?.itemStruct ? [data.itemInfo.itemStruct] : [])];
  return items.flatMap((item) => {
    const media = mediaOf(item);
    const urls = [
      ...(item.video?.bitrateInfo ?? []).flatMap((encoding) => encoding.PlayAddr?.UrlList ?? []),
      item.video?.playAddr ?? '',
    ];
    const fileIds = [...new Set(urls.map(tiktokFileId).filter((id): id is string => !!id))];
    return media && fileIds.length ? [{ fileIds, media }] : [];
  });
}

export const tiktok: Extractor = {
  id: 'tiktok',
  matches: [/^https:\/\/(www\.|m\.)?tiktok\.com\/@[^/]+\/video\/\d+/],
  async extract(ctx) {
    const id = idFrom(ctx.url);
    if (!id) return [];
    return parseTikTokPage(await ctx.html((page) => page.includes(`"id":"${id}"`)), id);
  },
};
