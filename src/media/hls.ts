import { Parser } from 'm3u8-parser';
import { JobError } from '@/src/shared/errors';
import type { ParsedManifest } from '@/src/shared/messages';
import type { Variant } from '@/src/shared/types';
import type { TextResponse } from './fetch';
import type { Segment, Track } from './track';

interface HlsPlaylist {
  uri: string;
  attributes?: {
    BANDWIDTH?: number;
    'AVERAGE-BANDWIDTH'?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
    AUDIO?: string;
  };
}

interface HlsSegment {
  uri: string;
  duration: number;
  discontinuity?: boolean;
  byterange?: { length: number; offset: number };
  key?: { method?: string; uri: string; iv?: Uint32Array };
  map?: { uri: string; byterange?: { length: number; offset: number } };
}

interface HlsManifest {
  playlists?: HlsPlaylist[];
  mediaGroups?: { AUDIO?: Record<string, Record<string, { default?: boolean; uri?: string }>> };
  segments?: HlsSegment[];
  mediaSequence?: number;
  endList?: boolean;
}

function parseText(text: string): HlsManifest {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  return parser.manifest as HlsManifest;
}

/**
 * Only clear-key AES-128 is downloadable. SAMPLE-AES and any non-identity
 * KEYFORMAT mean Widevine, PlayReady or FairPlay.
 */
export function isProtectedPlaylist(text: string): boolean {
  for (const line of text.split('\n')) {
    if (!/^#EXT-X-(SESSION-)?KEY:/i.test(line)) continue;
    const method = line.match(/METHOD=([^,\s]+)/i)?.[1]?.toUpperCase();
    if (method === 'NONE') continue;
    const format = line.match(/KEYFORMAT="?([^",\s]+)/i)?.[1]?.toLowerCase();
    if (method !== 'AES-128' || (format && format !== 'identity')) return true;
  }
  return false;
}

function uint32ToBytes(iv: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, iv[i] ?? 0);
  return bytes;
}

function toSegments(manifest: HlsManifest, baseUrl: string): Segment[] {
  const first = manifest.mediaSequence ?? 0;
  return (manifest.segments ?? []).map((segment, index) => ({
    url: new URL(segment.uri, baseUrl).href,
    byteRange: segment.byterange,
    durationSec: segment.duration,
    mediaSequence: first + index,
    discontinuity: segment.discontinuity,
    key: segment.key?.uri
      ? {
          uri: new URL(segment.key.uri, baseUrl).href,
          iv: segment.key.iv ? uint32ToBytes(segment.key.iv) : undefined,
        }
      : undefined,
  }));
}

export function parseMediaPlaylist(
  text: string,
  baseUrl: string,
  role: Track['role'],
): Track & { live: boolean } {
  const manifest = parseText(text);
  const map = manifest.segments?.[0]?.map;
  return {
    role,
    live: !manifest.endList,
    segments: toSegments(manifest, baseUrl),
    init: map
      ? { url: new URL(map.uri, baseUrl).href, byteRange: map.byterange }
      : undefined,
  };
}

type Fetcher = (url: string) => Promise<TextResponse>;

function audioUrlFor(manifest: HlsManifest, playlist: HlsPlaylist, baseUrl: string) {
  const group = playlist.attributes?.AUDIO;
  const renditions = Object.values(manifest.mediaGroups?.AUDIO?.[group ?? ''] ?? {});
  const chosen = renditions.find((entry) => entry.default && entry.uri) ?? renditions.find((entry) => entry.uri);
  return chosen?.uri ? new URL(chosen.uri, baseUrl).href : undefined;
}

/** Every playlist a master names, including the ones no variant ended up using. */
function childUrlsOf(manifest: HlsManifest, baseUrl: string): string[] {
  const audio = Object.values(manifest.mediaGroups?.AUDIO ?? {}).flatMap(Object.values);
  return [...(manifest.playlists ?? []), ...audio].flatMap((entry) =>
    entry.uri ? [new URL(entry.uri, baseUrl).href] : [],
  );
}

function variantsFromMaster(manifest: HlsManifest, baseUrl: string): Variant[] {
  const byHeight = new Map<string, Variant>();
  for (const playlist of manifest.playlists ?? []) {
    const attributes = playlist.attributes ?? {};
    const bitrate = attributes.BANDWIDTH ?? attributes['AVERAGE-BANDWIDTH'];
    const height = attributes.RESOLUTION?.height;
    const url = new URL(playlist.uri, baseUrl).href;
    const variant: Variant = {
      id: `hls-${height ?? 'x'}-${bitrate ?? 0}`,
      kind: 'hls',
      url,
      audioUrl: audioUrlFor(manifest, playlist, baseUrl),
      width: attributes.RESOLUTION?.width,
      height,
      bitrate,
      codecs: attributes.CODECS,
    };
    const slot = String(height ?? url);
    const current = byHeight.get(slot);
    if (!current || (bitrate ?? 0) > (current.bitrate ?? 0)) byHeight.set(slot, variant);
  }
  return [...byHeight.values()].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0),
  );
}

export async function parseHls(
  text: string,
  url: string,
  fetchPlaylist: Fetcher,
): Promise<ParsedManifest> {
  const manifest = parseText(text);
  const variants = variantsFromMaster(manifest, url);
  const isMaster = variants.length > 0;

  // A master says nothing about encryption or length; its playlists do.
  const first = isMaster ? await fetchPlaylist(variants[0]!.url) : { text, url };
  const media = parseMediaPlaylist(first.text, first.url, 'muxed');
  const durationSec = media.segments.reduce((sum, segment) => sum + segment.durationSec, 0);

  const result: ParsedManifest = {
    variants: isMaster ? variants : [{ id: 'hls-single', kind: 'hls', url }],
    durationSec: media.live ? undefined : durationSec,
    protected: isProtectedPlaylist(text) || isProtectedPlaylist(first.text),
    live: media.live,
    childUrls: childUrlsOf(manifest, url),
  };
  if (durationSec) {
    for (const variant of result.variants) {
      if (variant.bitrate) variant.sizeEstimate = Math.round((variant.bitrate / 8) * durationSec);
    }
  }
  return result;
}

export async function loadHlsTracks(variant: Variant, fetchPlaylist: Fetcher): Promise<Track[]> {
  const load = async (url: string, role: Track['role']) => {
    const { text, url: finalUrl } = await fetchPlaylist(url);
    if (isProtectedPlaylist(text)) throw new JobError('protected');
    const track = parseMediaPlaylist(text, finalUrl, role);
    if (track.live) throw new JobError('unsupported', 'Live streams are not supported yet');
    if (!track.segments.length) throw new JobError('unsupported', 'Empty playlist');
    return track;
  };
  if (!variant.audioUrl) return [await load(variant.url, 'muxed')];
  return Promise.all([load(variant.url, 'video'), load(variant.audioUrl, 'audio')]);
}
