import { pageTitle } from './pagedata';
import type { Extractor } from './types';

/**
 * YouTube is never downloaded by the extension itself. In the companion build this
 * offers the page to the companion app, which runs yt-dlp; store builds leave it out.
 */
export function youtubeVideoId(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const { hostname, pathname, searchParams } = new URL(url);
  if (/(^|\.)youtu\.be$/.test(hostname)) return pathname.match(/^\/([\w-]{11})/)?.[1];
  if (!/(^|\.)youtube\.com$/.test(hostname)) return undefined;
  const id = searchParams.get('v') ?? pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

/** Page titles read `(3) Title - YouTube`, and just `YouTube` while loading. */
export function cleanYoutubeTitle(title: string | undefined): string {
  const plain = (title ?? '').replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();
  return plain === 'YouTube' ? '' : plain;
}

export const youtube: Extractor = {
  id: 'youtube',
  matches: [
    /^https:\/\/(www\.|m\.|music\.)?youtube\.com\/(watch\?|shorts\/|live\/)/,
    /^https:\/\/youtu\.be\//,
  ],
  async extract(ctx) {
    const id = youtubeVideoId(ctx.url);
    if (!id) return [];
    const title = cleanYoutubeTitle(pageTitle(await ctx.html(() => true)));
    return [
      {
        id: `youtube-${id}`,
        title,
        variants: [{ id: 'yt-dlp', kind: 'external', url: `https://www.youtube.com/watch?v=${id}` }],
      },
    ];
  },
};
