import { shortTitle } from '@/src/shared/format';
import type { Variant } from '@/src/shared/types';
import { type Node, pageData, text, walk } from './pagedata';
import type { ExtractedMedia, Extractor } from './types';

interface VideoVersion {
  url?: string;
  width?: number;
  height?: number;
}

function codeFrom(url: string): string | undefined {
  return new URL(url).pathname.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/)?.[1];
}

/** Logged out, every version is the same quality and none states a size. */
function variantsOf(versions: VideoVersion[]): Variant[] {
  const byHeight = new Map<number, Variant>();
  for (const { url, width, height } of versions) {
    if (!url || byHeight.has(height ?? 0)) continue;
    byHeight.set(height ?? 0, { id: `instagram-${height ?? 'file'}`, kind: 'direct', url, width, height });
  }
  return [...byHeight.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
}

function titleOf(post: Node): string {
  const user = text((post.user as Node)?.username) ?? text((post.owner as Node)?.username);
  const caption = shortTitle(text((post.caption as Node)?.text) ?? '');
  if (user && caption) return `@${user} - ${caption}`;
  return user ? `@${user} video` : caption;
}

function thumbnailOf(media: Node): string | undefined {
  const candidates = (media.image_versions2 as Node)?.candidates as { url?: string }[] | undefined;
  return text(media.display_uri) ?? candidates?.[0]?.url;
}

/** A post can be a carousel, so its videos are looked for inside it. */
export function parseInstagramPage(html: string, code: string): ExtractedMedia[] {
  const media = new Map<string, ExtractedMedia>();
  for (const block of pageData(html, /video_versions/)) {
    walk(block, (post) => {
      if (post.code !== code) return;
      walk(post, (node) => {
        if (!Array.isArray(node.video_versions) || !node.video_versions.length) return;
        const variants = variantsOf(node.video_versions as VideoVersion[]);
        const id = `instagram-${text(node.pk) ?? variants[0]?.url}`;
        // A wrapper can repeat the code and come first, with no caption of its own.
        const title = titleOf(node) || titleOf(post);
        const known = media.get(id);
        if (known) known.title ||= title;
        if (known || !variants.length) return;
        media.set(id, {
          id,
          title,
          durationSec: typeof node.video_duration === 'number' ? node.video_duration : undefined,
          thumbnail: thumbnailOf(node),
          variants,
        });
      });
    });
  }
  return [...media.values()];
}

export const instagram: Extractor = {
  id: 'instagram',
  matches: [/^https:\/\/(www\.)?instagram\.com\/([^/]+\/)?(p|reel|reels|tv)\/[\w-]+/],
  async extract(ctx) {
    const code = codeFrom(ctx.url);
    if (!code) return [];
    return parseInstagramPage(await ctx.html((page) => page.includes(`"code":"${code}"`)), code);
  },
};
