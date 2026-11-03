/** Must match the name `companion/install.mjs` registers. */
export const COMPANION_HOST = 'com.vidget.companion';

/** Sent to the companion host. */
export type CompanionRequest =
  | { type: 'hello' }
  | { type: 'download'; jobId: string; url: string }
  | { type: 'cancel'; jobId: string; discard: boolean };

/** Sent by the companion host, plus `disconnected` when the port closes. */
export type CompanionEvent =
  | { type: 'hello'; version: string; ytDlp: string | null; ffmpeg: boolean }
  | {
      type: 'progress';
      jobId: string;
      stage: 'downloading' | 'merging';
      downloaded: number;
      total?: number;
      speed?: number;
      eta?: number;
    }
  | { type: 'done'; jobId: string; file: string; size: number }
  | { type: 'failed'; jobId: string; message: string }
  | { type: 'disconnected'; message: string };
