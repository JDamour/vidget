import type { ExtractedMedia, Extractor } from './types';

interface DailymotionMetadata {
  id?: string;
  title?: string;
  duration?: number;
  posters?: Record<string, string>;
  qualities?: Record<string, { type?: string; url?: string }[]>;
  error?: unknown;
}

export function parseDailymotionMetadata(data: DailymotionMetadata): ExtractedMedia | undefined {
  if (data.error) return undefined;
  const url = data.qualities?.auto?.find((entry) => entry.url)?.url;
  if (!url) return undefined;
  const posters = data.posters ?? {};
  return {
    id: `dailymotion-${data.id}`,
    title: data.title ?? '',
    durationSec: data.duration,
    thumbnail: posters['720'] ?? Object.values(posters).pop(),
    stream: { url, kind: 'hls' },
  };
}

export const dailymotion: Extractor = {
  id: 'dailymotion',
  matches: [/^https:\/\/(www\.)?dailymotion\.com\/video\/\w+/],
  async extract(ctx) {
    const id = new URL(ctx.url).pathname.split('/')[2];
    if (!id) return [];
    const text = await ctx.fetchText(`https://www.dailymotion.com/player/metadata/video/${id}`);
    const media = parseDailymotionMetadata(JSON.parse(text) as DailymotionMetadata);
    return media ? [media] : [];
  },
};
