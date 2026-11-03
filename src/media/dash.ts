import { parse } from 'mpd-parser';
import { JobError } from '@/src/shared/errors';
import type { ParsedManifest } from '@/src/shared/messages';
import type { Variant } from '@/src/shared/types';
import type { Segment, Track } from './track';

interface DashSegment {
  resolvedUri: string;
  duration: number;
  number: number;
  map?: { resolvedUri: string; byterange?: { offset: number; length: number } };
  byterange?: { offset: number; length: number };
}

interface DashPlaylist {
  attributes: {
    NAME?: string;
    BANDWIDTH?: number;
    RESOLUTION?: { width: number; height: number };
    CODECS?: string;
  };
  segments: DashSegment[];
  sidx?: { resolvedUri: string; duration?: number };
  contentProtection?: unknown;
}

interface DashManifest {
  playlists?: DashPlaylist[];
  duration?: number;
  mediaGroups?: {
    AUDIO?: { audio?: Record<string, { default?: boolean; playlists: DashPlaylist[] }> };
  };
}

const PROTECTED = /<(?:[\w-]+:)?ContentProtection\b/;
const LIVE = /<(?:[\w-]+:)?MPD\b[^>]*\btype\s*=\s*["']dynamic["']/;

export function isProtectedMpd(text: string): boolean {
  return PROTECTED.test(text);
}

function keyOf(playlist: DashPlaylist): string {
  return `${playlist.attributes.NAME ?? ''}|${playlist.attributes.BANDWIDTH ?? 0}`;
}

function firstUrl(playlist: DashPlaylist): string {
  return playlist.segments[0]?.resolvedUri ?? playlist.sidx?.resolvedUri ?? '';
}

function isWebm(playlist: DashPlaylist): boolean {
  if (/\.webm(\?|$)/i.test(firstUrl(playlist))) return true;
  return /^(vp8|vp9|vorbis|opus)/i.test(playlist.attributes.CODECS ?? '');
}

function audioPlaylists(manifest: DashManifest): DashPlaylist[] {
  const groups = Object.values(manifest.mediaGroups?.AUDIO?.audio ?? {});
  const chosen = groups.find((group) => group.default) ?? groups[0];
  return [...(chosen?.playlists ?? [])].sort(
    (a, b) => (b.attributes.BANDWIDTH ?? 0) - (a.attributes.BANDWIDTH ?? 0),
  );
}

function durationOf(playlist: DashPlaylist | undefined, manifest: DashManifest): number | undefined {
  const summed = playlist?.segments.reduce((sum, segment) => sum + segment.duration, 0);
  return summed || playlist?.sidx?.duration || manifest.duration;
}

export function parseDash(text: string, url: string): ParsedManifest {
  const manifest = parse(text, { manifestUri: url }) as DashManifest;
  const video = manifest.playlists ?? [];
  const audio = audioPlaylists(manifest);
  const durationSec = durationOf(video[0] ?? audio[0], manifest);

  const pairs = video.length
    ? video
    : audio.slice(0, 1); // An audio-only manifest has a single useful choice.

  const variants: Variant[] = pairs.map((playlist) => {
    const pairedAudio = video.length
      ? (audio.find((candidate) => isWebm(candidate) === isWebm(playlist)) ?? audio[0])
      : undefined;
    const bitrate = (playlist.attributes.BANDWIDTH ?? 0) + (pairedAudio?.attributes.BANDWIDTH ?? 0);
    return {
      id: `dash-${playlist.attributes.NAME ?? playlist.attributes.BANDWIDTH}`,
      kind: 'dash',
      url,
      dashVideoKey: keyOf(playlist),
      dashAudioKey: pairedAudio ? keyOf(pairedAudio) : undefined,
      width: playlist.attributes.RESOLUTION?.width,
      height: playlist.attributes.RESOLUTION?.height,
      bitrate: bitrate || undefined,
      codecs: playlist.attributes.CODECS,
      sizeEstimate: bitrate && durationSec ? Math.round((bitrate / 8) * durationSec) : undefined,
      // Only fMP4 tracks can be merged without ffmpeg; a lone WebM track is fine.
      needsFfmpeg: !!pairedAudio && (isWebm(playlist) || isWebm(pairedAudio)),
    };
  });

  variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));

  return {
    variants: variants.some((variant) => !variant.needsFfmpeg)
      ? variants.filter((variant) => !variant.needsFfmpeg)
      : variants,
    durationSec,
    protected: isProtectedMpd(text),
    live: LIVE.test(text),
    childUrls: [],
  };
}

function toTrack(playlist: DashPlaylist, role: Track['role']): Track {
  // SegmentBase: the sidx only indexes one file, so fetch that whole file.
  if (!playlist.segments.length && playlist.sidx) {
    return {
      role,
      segments: [
        {
          url: playlist.sidx.resolvedUri,
          mediaSequence: 0,
          durationSec: playlist.sidx.duration ?? 0,
        },
      ],
    };
  }
  const map = playlist.segments[0]?.map;
  const segments: Segment[] = playlist.segments.map((segment, index) => ({
    url: segment.resolvedUri,
    byteRange: segment.byterange,
    durationSec: segment.duration,
    mediaSequence: segment.number ?? index,
  }));
  return {
    role,
    segments,
    init: map ? { url: map.resolvedUri, byteRange: map.byterange } : undefined,
  };
}

export function loadDashTracks(text: string, url: string, variant: Variant): Track[] {
  if (isProtectedMpd(text)) throw new JobError('protected');
  if (LIVE.test(text)) throw new JobError('unsupported', 'Live streams are not supported yet');
  const manifest = parse(text, { manifestUri: url }) as DashManifest;
  const video = manifest.playlists ?? [];
  const audio = audioPlaylists(manifest);
  const find = (list: DashPlaylist[], key: string | undefined) =>
    key ? list.find((playlist) => keyOf(playlist) === key) : undefined;

  const videoPlaylist = find(video, variant.dashVideoKey);
  const audioPlaylist = find(audio, variant.dashAudioKey);
  if (videoPlaylist && audioPlaylist) {
    return [toTrack(videoPlaylist, 'video'), toTrack(audioPlaylist, 'audio')];
  }
  const only = videoPlaylist ?? find(audio, variant.dashVideoKey);
  if (!only) throw new JobError('expired', 'Representation is gone from the manifest');
  return [toTrack(only, 'muxed')];
}
