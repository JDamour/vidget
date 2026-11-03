import { JobError } from '@/src/shared/errors';
import type { ByteRange } from './track';

const RETRIES = 3;
const BACKOFF_MS = 500;

interface FetchOptions {
  signal?: AbortSignal;
  byteRange?: ByteRange;
  backoffMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Uses the user's own session, and retries with exponential backoff. */
async function request(url: string, options: FetchOptions): Promise<Response> {
  const { signal, byteRange, backoffMs = BACKOFF_MS } = options;
  const headers: Record<string, string> = {};
  if (byteRange) {
    headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await delay(backoffMs * 2 ** (attempt - 1), signal);
    try {
      const response = await fetch(url, { credentials: 'include', headers, signal });
      if (response.ok) return response;
      if ([401, 403, 404, 410].includes(response.status)) {
        throw new JobError('expired', `HTTP ${response.status}`);
      }
      lastError = new JobError('network', `HTTP ${response.status}`);
    } catch (err) {
      if (err instanceof JobError && err.code === 'expired') throw err;
      if ((err as DOMException).name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError instanceof JobError
    ? lastError
    : new JobError('network', lastError instanceof Error ? lastError.message : String(lastError));
}

export { request as openResponse };

export async function fetchBytes(url: string, options: FetchOptions = {}): Promise<Uint8Array> {
  return new Uint8Array(await (await request(url, options)).arrayBuffer());
}

export interface TextResponse {
  text: string;
  /** Final URL after redirects, the base that relative URIs resolve against. */
  url: string;
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<TextResponse> {
  const response = await request(url, { signal });
  return { text: await response.text(), url: response.url || url };
}
