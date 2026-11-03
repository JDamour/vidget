import type { ExtractedMedia, Extractor } from './types';

interface RedditVideo {
  hls_url?: string;
  dash_url?: string;
  duration?: number;
}

interface RedditPost {
  id?: string;
  title?: string;
  thumbnail?: string;
  secure_media?: { reddit_video?: RedditVideo };
  crosspost_parent_list?: RedditPost[];
}

type RedditListing = { data?: { children?: { data?: RedditPost }[] } }[];

export function parseRedditListing(listing: RedditListing): ExtractedMedia | undefined {
  const post = listing[0]?.data?.children?.[0]?.data;
  if (!post) return undefined;
  const source = post.secure_media?.reddit_video ? post : post.crosspost_parent_list?.[0];
  const video = source?.secure_media?.reddit_video;
  const url = video?.dash_url ?? video?.hls_url;
  if (!url) return undefined;
  return {
    id: `reddit-${post.id}`,
    title: post.title ?? '',
    durationSec: video?.duration,
    thumbnail: post.thumbnail?.startsWith('http') ? post.thumbnail : undefined,
    stream: { url, kind: video?.dash_url ? 'dash' : 'hls' },
  };
}

export const reddit: Extractor = {
  id: 'reddit',
  matches: [/^https:\/\/(www\.|old\.|new\.)?reddit\.com\/r\/[^/]+\/comments\/\w+/],
  async extract(ctx) {
    const url = new URL(ctx.url);
    const path = url.pathname.replace(/\/$/, '');
    const text = await ctx.fetchText(`https://www.reddit.com${path}.json?raw_json=1`);
    const media = parseRedditListing(JSON.parse(text) as RedditListing);
    return media ? [media] : [];
  },
};
