import type { Variant } from '@/src/shared/types';
import type { ExtractedMedia, Extractor, PageContext } from './types';

interface VimeoConfig {
  video?: { id?: number; title?: string; duration?: number; thumbs?: Record<string, string> };
  request?: {
    files?: {
      progressive?: { url: string; width?: number; height?: number }[];
      hls?: { cdns?: Record<string, { url?: string }>; default_cdn?: string };
    };
  };
}

function idFrom(url: string): string | undefined {
  return new URL(url).pathname.match(/(?:^|\/)(\d{6,})(?:\/|$)/)?.[1];
}

export function parseVimeoConfig(config: VimeoConfig, id: string): ExtractedMedia | undefined {
  const files = config.request?.files;
  const thumbs = config.video?.thumbs ?? {};
  const base: ExtractedMedia = {
    id: `vimeo-${id}`,
    title: config.video?.title ?? '',
    durationSec: config.video?.duration,
    thumbnail: thumbs['1280'] ?? thumbs.base ?? Object.values(thumbs)[0],
  };

  const progressive = files?.progressive ?? [];
  if (progressive.length) {
    const variants: Variant[] = progressive
      .map((file) => ({
        id: `vimeo-${file.height ?? file.url}`,
        kind: 'direct' as const,
        url: file.url,
        width: file.width,
        height: file.height,
      }))
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    return { ...base, variants };
  }

  const cdns = files?.hls?.cdns ?? {};
  const cdn = cdns[files?.hls?.default_cdn ?? ''] ?? Object.values(cdns)[0];
  return cdn?.url ? { ...base, stream: { url: cdn.url, kind: 'hls' } } : undefined;
}

export const vimeo: Extractor = {
  id: 'vimeo',
  matches: [/^https:\/\/(www\.|player\.)?vimeo\.com\/(video\/)?\d{6,}/],
  async extract(ctx: PageContext) {
    const id = idFrom(ctx.url);
    if (!id) return [];
    const text = await ctx.fetchText(`https://player.vimeo.com/video/${id}/config`);
    const media = parseVimeoConfig(JSON.parse(text) as VimeoConfig, id);
    return media ? [media] : [];
  },
};
