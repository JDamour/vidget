import { Transmuxer } from 'mux.js/lib/mp4/transmuxer.js';
import { JobError } from '@/src/shared/errors';
import {
  copyFragments,
  detectFormat,
  isEncryptedInit,
  mergeInits,
  readInit,
  type Sink,
  type StreamFormat,
  Timeline,
} from './boxes';

/** One track's downloaded files, in order. */
export interface TrackFiles {
  init?: Blob;
  count: number;
  segment(index: number): Promise<Blob>;
  /** Segment index to seconds into the track, for each section spliced into it. */
  sections?: Map<number, number>;
}

interface Source {
  init: Uint8Array;
  total: number;
  done: number;
  /** Set when the fragment just returned starts a new section. */
  sectionStart?: number;
  /** Yields the next fragment, or undefined at the end. */
  next(): Promise<Blob | undefined>;
}

async function sniff(files: TrackFiles): Promise<StreamFormat> {
  const blob = files.init ?? (await files.segment(0));
  return detectFormat(new Uint8Array(await blob.slice(0, 256).arrayBuffer()));
}

async function fmp4Source(files: TrackFiles): Promise<Source> {
  const blob = files.init ?? (await files.segment(0));
  const init = await readInit(blob);
  if (!init) throw new JobError('unsupported', 'No init segment found');
  if (isEncryptedInit(init)) throw new JobError('protected');
  let index = 0;
  const source: Source = {
    init,
    total: files.count,
    done: 0,
    async next() {
      if (index >= files.count) return undefined;
      source.done = index + 1;
      source.sectionStart = files.sections?.get(index);
      return files.segment(index++);
    },
  };
  return source;
}

async function transmuxSource(files: TrackFiles, keepTimestamps: boolean): Promise<Source> {
  let init: Uint8Array | undefined;
  let pending: Uint8Array[] = [];
  const newTransmuxer = () => {
    const fresh = new Transmuxer({ keepOriginalTimestamps: keepTimestamps });
    fresh.on('data', (segment) => {
      init ??= segment.initSegment.slice();
      pending.push(segment.data.slice());
    });
    return fresh;
  };
  let transmuxer = newTransmuxer();

  let index = 0;
  let sectionStart: number | undefined;
  const pump = async (): Promise<Blob | undefined> => {
    while (index < files.count && !pending.length) {
      sectionStart = files.sections?.get(index);
      // mux.js carries timing between segments, which a new clock would confuse.
      if (sectionStart !== undefined) transmuxer = newTransmuxer();
      const blob = await files.segment(index++);
      transmuxer.push(new Uint8Array(await blob.arrayBuffer()));
      transmuxer.flush();
    }
    if (!pending.length) return undefined;
    const chunk = new Blob(pending as Uint8Array<ArrayBuffer>[]);
    pending = [];
    return chunk;
  };

  const first = await pump();
  if (!init || !first) throw new JobError('unsupported', 'Could not read MPEG-TS stream');
  let buffered: Blob | undefined = first;
  const source: Source = {
    init,
    total: files.count,
    done: 0,
    async next() {
      source.done = index;
      if (buffered) {
        const chunk = buffered;
        buffered = undefined;
        return chunk;
      }
      const chunk = await pump();
      source.sectionStart = sectionStart;
      return chunk;
    },
  };
  return source;
}

async function concatAll(files: TrackFiles, sink: Sink): Promise<void> {
  if (files.init) await sink.write(files.init);
  for (let i = 0; i < files.count; i++) await sink.write(await files.segment(i));
}

/** The source that is furthest behind goes next, which keeps tracks interleaved. */
function nextSource(sources: Source[]): Source | undefined {
  let best: Source | undefined;
  let bestProgress = Infinity;
  for (const source of sources) {
    const progress = source.done / source.total;
    if (progress < bestProgress) {
      best = source;
      bestProgress = progress;
    }
  }
  return best;
}

/**
 * Rebuild a track list into one file without re-encoding, and return its
 * extension. fMP4 is merged here; only WebM+WebM pairs need ffmpeg.
 */
export async function assemble(tracks: TrackFiles[], sink: Sink): Promise<string> {
  const formats = await Promise.all(tracks.map(sniff));
  const single = tracks.length === 1;

  if (formats.includes('unknown')) {
    throw new JobError('unsupported', 'Unrecognized stream format');
  }
  if (formats.includes('webm')) {
    if (!single) throw new JobError('unsupported', 'Merging WebM tracks needs ffmpeg');
    await concatAll(tracks[0]!, sink);
    return 'webm';
  }

  const sources = await Promise.all(
    tracks.map((files, index) =>
      formats[index] === 'fmp4'
        ? fmp4Source(files)
        : transmuxSource(files, !single || !!files.sections?.size),
    ),
  );
  const timelines = new Map(sources.map((source) => [source, new Timeline(source.init)]));

  const initPayload = single ? sources[0]!.init : mergeInits(sources.map((source) => source.init));
  await sink.write(initPayload);

  const trackIds = new Map(sources.map((source, index) => [source, index + 1]));
  const active = [...sources];
  let sequence = 1;
  while (active.length) {
    const source = nextSource(active)!;
    const chunk = await source.next();
    if (!chunk) {
      active.splice(active.indexOf(source), 1);
      continue;
    }
    const timeline = timelines.get(source)!;
    if (source.sectionStart !== undefined) timeline.restartAt(source.sectionStart);
    source.sectionStart = undefined;
    sequence = await copyFragments(chunk, sink, {
      trackId: single ? undefined : trackIds.get(source),
      sequence,
      timeline,
    });
  }
  return 'mp4';
}
