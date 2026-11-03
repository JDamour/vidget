/**
 * Facebook and Instagram stream separate video and audio files, asking for each
 * piece with bytestart and byteend in the query. Without those two parameters the
 * same URL is the whole file. efg is base64 JSON that says what a file holds, and
 * its asset id is shared by every track of one video.
 */

const META_CDN = /(^|\.)(fbcdn\.net|cdninstagram\.com)$/i;
const AUDIO_TAG = /audio|aac/i;

export interface MetaTrack {
  asset: string;
  /** The whole file, whichever piece was reported. */
  url: string;
  audio: boolean;
  height?: number;
  /** Higher is better. A tag names a height, or a numbered encoding where 1 is best. */
  rank: number;
}

function describeFile(url: URL): { vencode_tag?: string; xpv_asset_id?: number | string } {
  try {
    return JSON.parse(atob(url.searchParams.get('efg') ?? ''));
  } catch {
    return {};
  }
}

export function metaTrack(raw: string): MetaTrack | undefined {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (!META_CDN.test(url.hostname)) return undefined;
  const { vencode_tag: tag, xpv_asset_id: asset } = describeFile(url);
  if (!tag || !asset) return undefined;
  // A progressive file already holds both tracks, so a whole one needs no help.
  if (tag.includes('progressive') && !url.searchParams.has('bytestart')) return undefined;

  url.searchParams.delete('bytestart');
  url.searchParams.delete('byteend');
  const height = Number(tag.match(/(\d{3,4})p/)?.[1]) || undefined;
  const encoding = Number(tag.match(/baseline_(\d+)/)?.[1]);
  return {
    asset: String(asset),
    url: url.href,
    audio: AUDIO_TAG.test(tag),
    height,
    rank: height ?? (encoding ? -encoding : -100),
  };
}
