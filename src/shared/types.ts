import type { ExtractedMedia } from '@/src/extractors/types';

/** `external` is a page the companion app downloads with yt-dlp. */
export type VariantKind = 'direct' | 'hls' | 'dash' | 'external';

export interface Variant {
  id: string;
  kind: VariantKind;
  /** Direct file, HLS media playlist, DASH manifest URL, or an external page. */
  url: string;
  /** Audio that is not muxed into `url`: an HLS playlist, or a whole direct file. */
  audioUrl?: string;
  /** DASH representation keys, resolved again from the manifest when a job starts. */
  dashVideoKey?: string;
  dashAudioKey?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  codecs?: string;
  sizeEstimate?: number;
  /** Separate tracks in containers the browser pipeline cannot merge yet. */
  needsFfmpeg?: boolean;
}

export interface SubtitleTrack {
  url: string;
  language?: string;
  label?: string;
}

export type MediaStatus = 'parsing' | 'ready' | 'live' | 'error';

export interface MediaInfo {
  id: string;
  title: string;
  site: string;
  durationSec?: number;
  thumbnail?: string;
  protected: boolean;
  variants: Variant[];
  subtitles?: SubtitleTrack[];
  status: MediaStatus;
  pageUrl: string;
  /** Normalized URL used to spot the same media reported by several detectors. */
  key: string;
  source: 'network' | 'dom' | 'probe' | 'extractor';
  /** URLs of child playlists, so they are not listed as media of their own. */
  childKeys?: string[];
  sizeBytes?: number;
  /** The separate tracks seen so far of a video streamed as two files. */
  tracks?: { audioUrl?: string; videoRank?: number };
}

export type JobStatus = 'queued' | 'downloading' | 'merging' | 'done' | 'failed' | 'paused';

export type ErrorCode =
  | 'expired'
  | 'network'
  | 'disk'
  | 'protected'
  | 'unsupported'
  | 'canceled'
  | 'companion'
  | 'unknown';

export interface Job {
  id: string;
  mediaId: string;
  tabId?: number;
  sourceUrl: string;
  pageUrl: string;
  variant: Variant;
  status: JobStatus;
  segmentsTotal: number;
  segmentsDone: number;
  bytes: number;
  filename: string;
  error?: string;
  errorCode?: ErrorCode;
  createdAt: number;
  finishedAt?: number;
  title: string;
  site: string;
  quality: string;
  downloadId?: number;
  /** A direct file refused by the browser's downloader, now fetched by the worker. */
  viaWorker?: boolean;
  bytesPerSec?: number;
  etaSec?: number;
}

export interface HistoryEntry {
  jobId: string;
  title: string;
  site: string;
  filename: string;
  sizeBytes: number;
  downloadId?: number;
  finishedAt: number;
  status: 'done' | 'failed';
  sourceUrl: string;
  pageUrl: string;
  variant: Variant;
  quality: string;
  errorCode?: ErrorCode;
}

/** What a detector saw, before it is turned into a MediaInfo. */
export interface MediaReport {
  url: string;
  source: 'network' | 'dom' | 'probe';
  contentType?: string;
  sizeBytes?: number;
  durationSec?: number;
  thumbnail?: string;
  title?: string;
}

export interface PageHints {
  url: string;
  title?: string;
  ogTitle?: string;
  ogImage?: string;
  /** Duration and poster of the main video, for players on a blob: URL. */
  durationSec?: number;
  poster?: string;
  /** Post titles on the page, keyed by media id. */
  posts?: Record<string, string>;
}

export interface TabState {
  items: MediaInfo[];
  drm: boolean;
  hints?: PageHints;
  /** Every post seen, because a feed drops posts as they scroll away. */
  posts?: Record<string, string>;
  /**
   * TikTok posts from the feed's API, by id, and which post each file belongs to.
   * Kept when the address changes, because the feed does not fetch them again.
   */
  known?: { media: Record<string, ExtractedMedia>; files: Record<string, string> };
}
