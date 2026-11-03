import { JobError } from '@/src/shared/errors';
import { fileExtension } from '@/src/shared/format';
import type { ProgressUpdate, TrackPlan } from '@/src/shared/messages';
import { checkQuota, fileExists, jobDir, readFile, writeFile } from '@/src/storage/opfs';
import { assemble, type TrackFiles } from './assemble';
import type { Sink } from './boxes';
import { isEncryptedInit, readInit } from './boxes';
import { decryptAes128, ivFor } from './decrypt';
import { fetchBytes, openResponse } from './fetch';
import { resolveTracks } from './manifest';
import { type Segment, sectionStarts, type Track } from './track';

const PROGRESS_MS = 250;
const MAX_REFRESHES = 3;
/** Segments and the output coexist on disk until the merge ends. */
const DISK_OVERHEAD = 2.1;

interface Task {
  name: string;
  url: string;
  byteRange?: Segment['byteRange'];
  segment?: Segment;
  isInit: boolean;
  trackIndex: number;
  index: number;
}

export interface RunHooks {
  progress(update: ProgressUpdate): void;
  /** Called with every host the job will touch, before the first segment. */
  hosts(hosts: string[]): Promise<void>;
}

const segmentName = (track: number, index: number) => `t${track}-${index}.seg`;
const initName = (track: number) => `t${track}-init.seg`;

function tasksFor(tracks: Track[]): Task[] {
  const tasks: Task[] = [];
  tracks.forEach((track, trackIndex) => {
    if (track.init) {
      tasks.push({
        name: initName(trackIndex),
        url: track.init.url,
        byteRange: track.init.byteRange,
        isInit: true,
        trackIndex,
        index: -1,
      });
    }
    track.segments.forEach((segment, index) => {
      tasks.push({
        name: segmentName(trackIndex, index),
        url: segment.url,
        byteRange: segment.byteRange,
        segment,
        isInit: false,
        trackIndex,
        index,
      });
    });
  });
  return tasks;
}

function hostsOf(tracks: Track[], variant: TrackPlan['variant']): string[] {
  const hosts = new Set<string>();
  const add = (url: string) => hosts.add(new URL(url).hostname);
  // Playlist hosts stay listed because an expired job has to fetch them again.
  add(variant.url);
  if (variant.audioUrl) add(variant.audioUrl);
  for (const track of tracks) {
    if (track.init) add(track.init.url);
    for (const segment of track.segments) {
      add(segment.url);
      if (segment.key) add(segment.key.uri);
    }
  }
  return [...hosts];
}

function sinkFor(writable: FileSystemWritableFileStream): Sink {
  return {
    position: 0,
    async write(chunk) {
      await writable.write(chunk as Blob);
      this.position += chunk instanceof Blob ? chunk.size : chunk.length;
    },
  };
}

class Reporter {
  private startedAt = performance.now();
  private lastSent = 0;
  private fresh = 0;
  bytes = 0;
  done = 0;

  constructor(
    private jobId: string,
    private total: number,
    private hooks: RunHooks,
  ) {}

  /** Segments restored from a paused job count as done, but not toward speed. */
  restore(segments: number, bytes: number) {
    this.done += segments;
    this.bytes += bytes;
  }

  add(bytes: number) {
    this.done += 1;
    this.bytes += bytes;
    this.fresh += 1;
    this.send();
  }

  send(force = false) {
    const now = performance.now();
    if (!force && now - this.lastSent < PROGRESS_MS) return;
    this.lastSent = now;
    const seconds = (now - this.startedAt) / 1000;
    const rate = seconds > 0 ? this.fresh / seconds : 0;
    this.hooks.progress({
      jobId: this.jobId,
      status: 'downloading',
      segmentsDone: this.done,
      segmentsTotal: this.total,
      bytes: this.bytes,
      bytesPerSec: this.fresh && this.done ? (this.bytes / this.done) * rate : undefined,
      etaSec: rate ? (this.total - this.done) / rate : undefined,
    });
  }
}

/**
 * A direct file the browser's own downloader was refused. Its requests cannot
 * carry the page's Referer, but a fetch can, and streaming keeps memory flat.
 */
async function runDirect(plan: TrackPlan, hooks: RunHooks, signal: AbortSignal) {
  const { jobId, variant } = plan;
  await hooks.hosts(hostsOf([], variant));
  const response = await openResponse(variant.url, { signal });
  const total = Number(response.headers.get('content-length')) || 0;
  const { ok, available } = await checkQuota(total);
  if (!ok) throw new JobError('disk', `Needs ${total} bytes, ${available} available`);

  const dir = await jobDir(jobId);
  const handle = await dir.getFileHandle('output.bin', { create: true });
  const writable = await handle.createWritable();
  const startedAt = performance.now();
  let bytes = 0;
  let lastSent = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.length;
      controller.enqueue(chunk);
      const now = performance.now();
      if (now - lastSent < PROGRESS_MS) return;
      lastSent = now;
      const bytesPerSec = (bytes / (now - startedAt)) * 1000;
      hooks.progress({
        jobId,
        status: 'downloading',
        segmentsDone: bytes,
        segmentsTotal: total,
        bytes,
        bytesPerSec,
        etaSec: total ? (total - bytes) / bytesPerSec : undefined,
      });
    },
  });
  await response.body!.pipeThrough(counter).pipeTo(writable as WritableStream<Uint8Array>, { signal });
  return { file: await handle.getFile(), ext: fileExtension(variant.url) };
}

/** Fetch every segment to OPFS, assemble them, and return the finished file. */
export async function runJob(
  plan: TrackPlan,
  hooks: RunHooks,
  signal: AbortSignal,
): Promise<{ file: File; ext: string }> {
  if (plan.variant.kind === 'direct' && !plan.variant.audioUrl) return runDirect(plan, hooks, signal);
  const { jobId, variant, workers } = plan;
  let tracks = await resolveTracks(variant, signal);
  await hooks.hosts(hostsOf(tracks, variant));

  if (variant.sizeEstimate) {
    const needed = Math.round(variant.sizeEstimate * DISK_OVERHEAD);
    const { ok, available } = await checkQuota(needed);
    if (!ok) throw new JobError('disk', `Needs ${needed} bytes, ${available} available`);
  }

  const dir = await jobDir(jobId);
  const tasks = tasksFor(tracks);
  const reporter = new Reporter(jobId, tasks.length, hooks);
  const keys = new Map<string, Promise<Uint8Array>>();
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);

  const keyFor = (uri: string) => {
    let key = keys.get(uri);
    if (!key) {
      key = fetchBytes(uri, { signal: workSignal });
      keys.set(uri, key);
    }
    return key;
  };

  // Signed URLs can expire mid-job. One refresh serves every task waiting on it.
  let refreshes = 0;
  let refreshing: Promise<void> | undefined;
  const refresh = () => {
    refreshing ??= (async () => {
      if (++refreshes > MAX_REFRESHES) throw new JobError('expired');
      keys.clear();
      tracks = await resolveTracks(variant, workSignal);
      await hooks.hosts(hostsOf(tracks, variant));
      const fresh = tasksFor(tracks);
      fresh.forEach((task, index) => {
        const stale = tasks[index];
        if (stale?.name === task.name) {
          stale.url = task.url;
          stale.byteRange = task.byteRange;
          stale.segment = task.segment;
        }
      });
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  const fetchTask = async (task: Task): Promise<Uint8Array> => {
    const data = await fetchBytes(task.url, { signal: workSignal, byteRange: task.byteRange });
    const key = task.segment?.key;
    if (!key) return data;
    return decryptAes128(data, await keyFor(key.uri), ivFor(key, task.segment!.mediaSequence));
  };

  const runTask = async (task: Task) => {
    for (;;) {
      try {
        const data = await fetchTask(task);
        if (task.isInit && isEncryptedInit(data)) throw new JobError('protected');
        await writeFile(dir, task.name, data);
        reporter.add(data.length);
        return;
      } catch (err) {
        if (!(err instanceof JobError) || err.code !== 'expired') throw err;
        await refresh();
      }
    }
  };

  // A complete file from an earlier run means that segment is already done.
  const remaining: Task[] = [];
  for (const task of tasks) {
    if (await fileExists(dir, task.name)) {
      reporter.restore(1, (await readFile(dir, task.name)).size);
    } else remaining.push(task);
  }
  reporter.send(true);

  let cursor = 0;
  let failure: unknown;
  const worker = async () => {
    try {
      while (cursor < remaining.length) {
        workSignal.throwIfAborted();
        await runTask(remaining[cursor++]!);
      }
    } catch (err) {
      failure ??= err;
      controller.abort(err);
    }
  };
  // Wait for all of them: the caller may delete this folder once we return.
  await Promise.all(Array.from({ length: Math.max(1, workers) }, worker));
  if (failure) throw failure;

  hooks.progress({
    jobId,
    status: 'merging',
    segmentsDone: tasks.length,
    segmentsTotal: tasks.length,
    bytes: reporter.bytes,
  });

  const files = await Promise.all(
    tracks.map(async (track, trackIndex): Promise<TrackFiles> => ({
      init: track.init ? await readFile(dir, initName(trackIndex)) : undefined,
      count: track.segments.length,
      segment: (index) => readFile(dir, segmentName(trackIndex, index)),
      sections: sectionStarts(track),
    })),
  );

  // Without EXT-X-MAP the moov sits in the first segment; check that one too.
  const first = files[0];
  if (first && !first.init) {
    const init = await readInit(await first.segment(0));
    if (init && isEncryptedInit(init)) throw new JobError('protected');
  }

  const handle = await dir.getFileHandle('output.bin', { create: true });
  const writable = await handle.createWritable();
  let ext: string;
  try {
    ext = await assemble(files, sinkFor(writable));
    await writable.close();
  } catch (err) {
    await writable.abort();
    throw err;
  }
  return { file: await handle.getFile(), ext };
}
