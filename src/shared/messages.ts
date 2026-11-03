import type { KnownMedia } from '@/src/extractors/tiktok';
import type { Job, MediaInfo, MediaReport, PageHints, Variant } from './types';

export interface TrackPlan {
  jobId: string;
  variant: Variant;
  pageUrl: string;
  workers: number;
}

export interface ParsedManifest {
  variants: Variant[];
  durationSec?: number;
  protected: boolean;
  live: boolean;
  childUrls: string[];
  subtitles?: MediaInfo['subtitles'];
}

/** Sent by content scripts. */
export type ContentMessage =
  | { type: 'media:report'; reports: MediaReport[] }
  | { type: 'media:drm' }
  | { type: 'media:known'; media: KnownMedia[] }
  | { type: 'page:hints'; hints: PageHints };

/** Sent by extension pages and the in-page button. */
export type UiMessage =
  | { type: 'tab:get'; tabId?: number }
  | { type: 'job:start'; mediaId: string; tabId?: number; variantId?: string }
  | { type: 'job:pause' | 'job:resume' | 'job:cancel' | 'job:retry'; jobId: string }
  | { type: 'jobs:list' }
  | { type: 'history:list' }
  | { type: 'history:clear' }
  | { type: 'history:retry'; jobId: string }
  | { type: 'history:show'; downloadId: number };

/** Sent by the service worker to the heavy worker host. */
export type HeavyRequest =
  | { target: 'heavy'; type: 'parse'; url: string; kind: 'hls' | 'dash' }
  | { target: 'heavy'; type: 'run'; plan: TrackPlan }
  | { target: 'heavy'; type: 'abort'; jobId: string; reason: 'pause' | 'cancel' }
  | { target: 'heavy'; type: 'release'; jobId: string }
  | { target: 'heavy'; type: 'save'; url: string; filename: string }
  | { target: 'heavy'; type: 'active' };

export interface ProgressUpdate {
  jobId: string;
  status: 'downloading' | 'merging';
  segmentsDone: number;
  segmentsTotal: number;
  bytes: number;
  bytesPerSec?: number;
  etaSec?: number;
}

/** Sent by the heavy worker host to the service worker. */
export type HeavyEvent =
  | { target: 'background'; type: 'heavy:progress'; update: ProgressUpdate }
  | { target: 'background'; type: 'heavy:hosts'; jobId: string; hosts: string[] }
  | {
      target: 'background';
      type: 'heavy:done';
      jobId: string;
      blobUrl: string;
      sizeBytes: number;
      ext: string;
    }
  | {
      target: 'background';
      type: 'heavy:failed';
      jobId: string;
      code: Job['errorCode'];
      message: string;
    };

/** Pushed over the `ui` port to open extension pages. */
export type UiPush =
  | { type: 'job'; job: Job }
  | { type: 'job:removed'; jobId: string }
  | { type: 'tab'; tabId: number };

export const UI_PORT = 'vidget-ui';
