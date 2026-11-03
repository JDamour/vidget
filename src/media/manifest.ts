import type { ParsedManifest } from '@/src/shared/messages';
import type { Variant } from '@/src/shared/types';
import { loadDashTracks, parseDash } from './dash';
import { fetchText } from './fetch';
import { loadHlsTracks, parseHls } from './hls';
import type { Track } from './track';

export async function parseManifest(url: string, kind: 'hls' | 'dash'): Promise<ParsedManifest> {
  const response = await fetchText(url);
  return kind === 'hls'
    ? parseHls(response.text, response.url, (next) => fetchText(next))
    : parseDash(response.text, response.url);
}

function wholeFile(url: string, role: Track['role']): Track {
  return { role, segments: [{ url, mediaSequence: 0, durationSec: 0 }] };
}

export async function resolveTracks(variant: Variant, signal: AbortSignal): Promise<Track[]> {
  if (variant.kind === 'direct') {
    return [wholeFile(variant.url, 'video'), wholeFile(variant.audioUrl!, 'audio')];
  }
  if (variant.kind === 'hls') {
    return loadHlsTracks(variant, (url) => fetchText(url, signal));
  }
  const { text, url } = await fetchText(variant.url, signal);
  return loadDashTracks(text, url, variant);
}
