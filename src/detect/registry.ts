import type { KnownMedia } from '@/src/extractors/tiktok';
import type { ExtractedMedia } from '@/src/extractors/types';
import { siteOf } from '@/src/shared/format';
import type { MediaInfo, MediaReport, TabState } from '@/src/shared/types';
import { type MediaKind, mediaKey } from './classify';
import type { MetaTrack } from './meta';
import { xMediaId } from './x';

export interface Minimums {
  minDurationSec: number;
  minSizeKb: number;
}

export function emptyTab(): TabState {
  return { items: [], drm: false };
}

export function hashId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function itemFromReport(report: MediaReport, kind: MediaKind, pageUrl: string): MediaInfo {
  const key = mediaKey(report.url);
  const streaming = kind !== 'direct';
  return {
    id: hashId(key),
    key,
    title: report.title ?? '',
    site: siteOf(pageUrl) || siteOf(report.url),
    durationSec: report.durationSec,
    thumbnail: report.thumbnail,
    protected: false,
    status: streaming ? 'parsing' : 'ready',
    pageUrl,
    source: report.source,
    // For a stream this would be the size of the manifest, not of the video.
    sizeBytes: streaming ? undefined : report.sizeBytes,
    variants: streaming
      ? []
      : [{ id: 'direct', kind: 'direct', url: report.url, sizeEstimate: report.sizeBytes }],
  };
}

function merge(existing: MediaInfo, incoming: MediaInfo): MediaInfo {
  return {
    ...existing,
    title: existing.title || incoming.title,
    durationSec: existing.durationSec ?? incoming.durationSec,
    thumbnail: existing.thumbnail ?? incoming.thumbnail,
    sizeBytes: Math.max(existing.sizeBytes ?? 0, incoming.sizeBytes ?? 0) || undefined,
    variants: existing.variants.length ? existing.variants : incoming.variants,
    status: existing.status === 'parsing' ? incoming.status : existing.status,
  };
}

function fileName(key: string): string {
  return key.split('/').pop() ?? '';
}

/** Mirrors serve one file from several hosts, so a matching name and size is a match. */
function isSameFile(a: MediaInfo, b: MediaInfo): boolean {
  return !!a.sizeBytes && a.sizeBytes === b.sizeBytes && fileName(a.key) === fileName(b.key);
}

/** Returns false when `item` is a duplicate that added nothing new to parse. */
export function upsert(state: TabState, item: MediaInfo): boolean {
  if (state.items.some((other) => other.childKeys?.includes(item.key))) return false;
  const index = state.items.findIndex(
    (other) => other.key === item.key || isSameFile(other, item),
  );
  if (index >= 0) {
    state.items[index] = merge(state.items[index]!, item);
    return false;
  }
  state.items.push(item);
  return true;
}

/** One video however many pieces of its tracks arrive, keeping the best video seen. */
export function addMetaTrack(state: TabState, track: MetaTrack, pageUrl: string): void {
  const key = `meta:${track.asset}`;
  let item = state.items.find((other) => other.key === key);
  if (!item) {
    item = {
      id: hashId(key),
      key,
      title: '',
      site: siteOf(pageUrl),
      protected: false,
      status: 'parsing',
      pageUrl,
      source: 'network',
      variants: [],
      tracks: {},
    };
    state.items.push(item);
  }
  const tracks = (item.tracks ??= {});
  if (track.audio) {
    tracks.audioUrl = track.url;
    for (const variant of item.variants) variant.audioUrl = track.url;
    return;
  }
  if (tracks.videoRank !== undefined && tracks.videoRank >= track.rank) return;
  tracks.videoRank = track.rank;
  item.status = 'ready';
  item.variants = [
    {
      id: `meta-${track.rank}`,
      kind: 'direct',
      url: track.url,
      audioUrl: tracks.audioUrl,
      height: track.height,
    },
  ];
}

const KNOWN_LIMIT = 100;
const FILE_KEY = 'tiktok-file:';

function knownItem(media: ExtractedMedia, pageUrl: string): MediaInfo {
  return {
    id: hashId(media.id),
    key: media.id,
    title: media.title,
    site: siteOf(pageUrl),
    durationSec: media.durationSec,
    thumbnail: media.thumbnail,
    protected: false,
    status: 'ready',
    pageUrl,
    source: 'network',
    variants: media.variants ?? [],
  };
}

function knownFor(state: TabState, fileId: string): ExtractedMedia | undefined {
  const mediaId = state.known?.files[fileId];
  return mediaId ? state.known?.media[mediaId] : undefined;
}

/** A file the player streamed, as its post when the feed has named it. */
export function addTikTokFile(
  state: TabState,
  fileId: string,
  report: MediaReport,
  pageUrl: string,
): void {
  const media = knownFor(state, fileId);
  if (media) {
    upsert(state, knownItem(media, pageUrl));
    return;
  }
  // Signatures differ between requests, so the file id is what tells copies apart.
  const key = `${FILE_KEY}${fileId}`;
  upsert(state, { ...itemFromReport(report, 'direct', pageUrl), id: hashId(key), key });
}

export function addKnownMedia(state: TabState, known: KnownMedia[]): void {
  const store = (state.known ??= { media: {}, files: {} });
  for (const { fileIds, media } of known) {
    store.media[media.id] = media;
    for (const fileId of fileIds) store.files[fileId] = media.id;
  }
  const ids = Object.keys(store.media);
  for (const old of ids.slice(0, Math.max(0, ids.length - KNOWN_LIMIT))) delete store.media[old];
  for (const [fileId, mediaId] of Object.entries(store.files)) {
    if (!store.media[mediaId]) delete store.files[fileId];
  }
  // Files the player streamed before the response that names them arrived.
  for (const item of [...state.items]) {
    const media = item.key.startsWith(FILE_KEY) && knownFor(state, item.key.slice(FILE_KEY.length));
    if (!media) continue;
    state.items.splice(state.items.indexOf(item), 1);
    upsert(state, knownItem(media, item.pageUrl));
  }
}

/** Apply a parsed master manifest, dropping its child playlists from the list. */
export function replaceItem(state: TabState, item: MediaInfo): void {
  const children = new Set(item.childKeys ?? []);
  state.items = state.items
    .filter((other) => !children.has(other.key))
    .map((other) => (other.id === item.id ? item : other));
}

function titleFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop() ?? '';
    return decodeURIComponent(name).replace(/\.[^.]+$/, '');
  } catch {
    return '';
  }
}

/** Some sites set og:title to their own name on every page. */
function isSiteName(title: string | undefined, site: string): boolean {
  return title?.toLowerCase() === site.split('.')[0]?.toLowerCase();
}

function titleOf(item: MediaInfo, state: TabState): string {
  const mediaId = xMediaId(item.key);
  const ogTitle = state.hints?.ogTitle;
  return (
    (mediaId && state.posts?.[mediaId]) ||
    item.title ||
    (!isSiteName(ogTitle, item.site) && ogTitle) ||
    state.hints?.title ||
    (mediaId && `X video ${mediaId}`) ||
    titleFromUrl(item.variants[0]?.url ?? item.key) ||
    item.site
  );
}

function withHints(item: MediaInfo, state: TabState, onlyItem: boolean): MediaInfo {
  const { hints } = state;
  return {
    ...item,
    title: titleOf(item, state),
    thumbnail: item.thumbnail ?? hints?.ogImage ?? hints?.poster,
    durationSec: item.durationSec ?? (onlyItem ? hints?.durationSec : undefined),
  };
}

function isTooSmall(item: MediaInfo, min: Minimums): boolean {
  if (item.durationSec !== undefined && item.durationSec < min.minDurationSec) return true;
  return item.sizeBytes !== undefined && item.sizeBytes < min.minSizeKb * 1024;
}

function isStream(item: MediaInfo): boolean {
  return item.status === 'parsing' || item.variants.some((variant) => variant.kind !== 'direct');
}

/**
 * A player working through a stream fetches its fMP4 segments as video/mp4, which
 * looks like a file of its own. The element's own source is the one kept, because
 * only that is known to be a separate video.
 */
function withoutSegments(items: MediaInfo[]): MediaInfo[] {
  if (!items.some(isStream)) return items;
  return items.filter((item) => isStream(item) || item.source === 'dom');
}

/**
 * The list the UI shows. Extractor results win over generic detection, and once
 * a page has used EME nothing on it is offered for download.
 */
export function presentItems(state: TabState, min: Minimums): MediaInfo[] {
  const extracted = state.items.filter((item) => item.source === 'extractor');
  const pool = extracted.length ? extracted : withoutSegments(state.items);
  const onlyItem = pool.length === 1;
  return pool
    .map((item) => withHints(item, state, onlyItem))
    .filter((item) => item.status !== 'error' && !isTooSmall(item, min))
    .map((item) => (state.drm ? { ...item, protected: true } : item));
}

export function downloadableCount(items: MediaInfo[]): number {
  return items.filter((item) => !item.protected && item.status === 'ready').length;
}
