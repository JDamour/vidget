import { JobError } from '@/src/shared/errors';

/** ISO-BMFF box handling. Works on disk-backed Blobs so memory stays flat. */

export interface BoxRef {
  type: string;
  start: number;
  size: number;
  headerSize: number;
}

const textDecoder = new TextDecoder('latin1');

function fourcc(bytes: Uint8Array, offset: number): string {
  return textDecoder.decode(bytes.subarray(offset, offset + 4));
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readHeader(bytes: Uint8Array, start: number, end: number): BoxRef {
  const data = view(bytes.subarray(0, 16));
  const size32 = data.getUint32(0);
  let size = size32;
  let headerSize = 8;
  if (size32 === 1) {
    size = Number(data.getBigUint64(8));
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - start;
  }
  return { type: fourcc(bytes, 4), start, size, headerSize };
}

/** Top-level or nested boxes in an in-memory range. */
export function* boxesIn(bytes: Uint8Array, start = 0, end = bytes.length): Generator<BoxRef> {
  let position = start;
  while (position + 8 <= end) {
    const box = readHeader(bytes.subarray(position, Math.min(position + 16, end)), position, end);
    if (box.size < box.headerSize || position + box.size > end) return;
    yield box;
    position += box.size;
  }
}

/** Top-level boxes of a file, reading only their headers. */
export async function* boxesInBlob(blob: Blob): AsyncGenerator<BoxRef> {
  let position = 0;
  while (position + 8 <= blob.size) {
    const head = new Uint8Array(await blob.slice(position, position + 16).arrayBuffer());
    const box = readHeader(head, position, blob.size);
    if (box.size < box.headerSize || position + box.size > blob.size) return;
    yield box;
    position += box.size;
  }
}

export type StreamFormat = 'fmp4' | 'ts' | 'aac' | 'webm' | 'unknown';

export function detectFormat(bytes: Uint8Array): StreamFormat {
  if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return 'ts';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm';
  }
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'aac';
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0) return 'aac';
  if (bytes.length >= 8) {
    const type = fourcc(bytes, 4);
    if (['ftyp', 'styp', 'moof', 'sidx', 'moov', 'free', 'skip'].includes(type)) return 'fmp4';
  }
  return 'unknown';
}

function containsType(bytes: Uint8Array, type: string): boolean {
  const code = [...type].map((char) => char.charCodeAt(0));
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      bytes[i] === code[0] &&
      bytes[i + 1] === code[1] &&
      bytes[i + 2] === code[2] &&
      bytes[i + 3] === code[3]
    ) {
      return true;
    }
  }
  return false;
}

/** CENC streams announce themselves in the init segment, whatever the manifest said. */
export function isEncryptedInit(init: Uint8Array): boolean {
  return ['encv', 'enca', 'pssh'].some((type) => containsType(init, type));
}

/** Pull ftyp + moov out of a segment file. */
export async function readInit(blob: Blob): Promise<Uint8Array | undefined> {
  let end = 0;
  let hasMoov = false;
  for await (const box of boxesInBlob(blob)) {
    if (box.type === 'moof' || box.type === 'mdat') break;
    end = box.start + box.size;
    if (box.type === 'moov') {
      hasMoov = true;
      break;
    }
  }
  if (!hasMoov) return undefined;
  return new Uint8Array(await blob.slice(0, end).arrayBuffer());
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function wrapBox(type: string, children: Uint8Array[]): Uint8Array {
  const body = concat(children);
  const out = new Uint8Array(8 + body.length);
  view(out).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function child(bytes: Uint8Array, parent: BoxRef, type: string): BoxRef | undefined {
  for (const box of boxesIn(bytes, parent.start + parent.headerSize, parent.start + parent.size)) {
    if (box.type === type) return box;
  }
  return undefined;
}

function sliceBox(bytes: Uint8Array, box: BoxRef): Uint8Array {
  return bytes.slice(box.start, box.start + box.size);
}

interface InitParts {
  ftyp?: Uint8Array;
  mvhd: Uint8Array;
  mehd?: Uint8Array;
  trak: Uint8Array;
  trex: Uint8Array;
}

function splitInit(init: Uint8Array): InitParts {
  const top = [...boxesIn(init)];
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) throw new JobError('unsupported', 'Track has no moov box');
  const mvhd = child(init, moov, 'mvhd');
  const mvex = child(init, moov, 'mvex');
  if (!mvhd || !mvex) throw new JobError('unsupported', 'Track is not fragmented MP4');
  const traks = [...boxesIn(init, moov.start + moov.headerSize, moov.start + moov.size)].filter(
    (box) => box.type === 'trak',
  );
  const trex = child(init, mvex, 'trex');
  if (traks.length !== 1 || !trex) {
    throw new JobError('unsupported', 'Expected exactly one track per stream');
  }
  const ftyp = top.find((box) => box.type === 'ftyp');
  const mehd = child(init, mvex, 'mehd');
  return {
    ftyp: ftyp && sliceBox(init, ftyp),
    mvhd: sliceBox(init, mvhd),
    mehd: mehd && sliceBox(init, mehd),
    trak: sliceBox(init, traks[0]!),
    trex: sliceBox(init, trex),
  };
}

function setTrackIdInTrak(trak: Uint8Array, id: number): void {
  const root = [...boxesIn(trak)][0]!;
  const tkhd = child(trak, root, 'tkhd');
  if (!tkhd) throw new JobError('unsupported', 'Track has no tkhd box');
  const data = view(trak);
  const version = trak[tkhd.start + tkhd.headerSize];
  const offset = tkhd.start + tkhd.headerSize + 4 + (version === 1 ? 16 : 8);
  data.setUint32(offset, id);
}

/** Combine single-track init segments; track ids become 1..n in input order. */
export function mergeInits(inits: Uint8Array[]): Uint8Array {
  const parts = inits.map(splitInit);
  const first = parts[0]!;
  const mvhd = first.mvhd.slice();
  view(mvhd).setUint32(mvhd.length - 4, parts.length + 1); // next_track_ID

  const traks = parts.map((part, index) => {
    const trak = part.trak.slice();
    setTrackIdInTrak(trak, index + 1);
    return trak;
  });
  const trexes = parts.map((part, index) => {
    const trex = part.trex.slice();
    view(trex).setUint32(12, index + 1);
    return trex;
  });

  const mvex = wrapBox('mvex', [...(first.mehd ? [first.mehd] : []), ...trexes]);
  const moov = wrapBox('moov', [mvhd, ...traks, mvex]);
  return first.ftyp ? concat([first.ftyp, moov]) : moov;
}

function trackTimescales(init: Uint8Array): Map<number, number> {
  const data = view(init);
  const scales = new Map<number, number>();
  const moov = [...boxesIn(init)].find((box) => box.type === 'moov');
  if (!moov) return scales;
  for (const trak of boxesIn(init, moov.start + moov.headerSize, moov.start + moov.size)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(init, trak, 'tkhd');
    const mdia = child(init, trak, 'mdia');
    const mdhd = mdia && child(init, mdia, 'mdhd');
    if (!tkhd || !mdhd) continue;
    const idAt = tkhd.start + tkhd.headerSize + 4 + (init[tkhd.start + tkhd.headerSize] === 1 ? 16 : 8);
    const scaleAt = mdhd.start + mdhd.headerSize + 4 + (init[mdhd.start + mdhd.headerSize] === 1 ? 16 : 8);
    scales.set(data.getUint32(idAt), data.getUint32(scaleAt));
  }
  return scales;
}

/**
 * Keeps decode times moving forward through a spliced stream. A section such as an
 * intro or an ad has its own clock, usually from zero, so everything after a splice
 * is shifted to start where the playlist says that section begins.
 */
export class Timeline {
  private scales: Map<number, number>;
  private tracks = new Map<number, { first: bigint; shift: bigint }>();
  private restart?: { seconds: number; placed: Set<number> };

  constructor(init: Uint8Array) {
    this.scales = trackTimescales(init);
  }

  restartAt(seconds: number): void {
    this.restart = { seconds, placed: new Set() };
  }

  place(trackId: number, time: bigint): bigint {
    let track = this.tracks.get(trackId);
    if (!track) {
      track = { first: time, shift: 0n };
      this.tracks.set(trackId, track);
    }
    const scale = this.scales.get(trackId);
    if (this.restart && scale && !this.restart.placed.has(trackId)) {
      this.restart.placed.add(trackId);
      track.shift = track.first + BigInt(Math.round(this.restart.seconds * scale)) - time;
    }
    return time + track.shift;
  }
}

const TFHD_BASE_DATA_OFFSET = 0x000001;

export interface RetagOptions {
  /** New track id; left alone when a source holds several tracks. */
  trackId?: number;
  sequence: number;
  /** How far this moof moved, for tfhd boxes that hold absolute file offsets. */
  moved: number;
  timeline?: Timeline;
}

function placeFragment(moof: Uint8Array, traf: BoxRef, trackId: number, timeline: Timeline): void {
  const tfdt = child(moof, traf, 'tfdt');
  if (!tfdt) return;
  const data = view(moof);
  const fields = tfdt.start + tfdt.headerSize;
  if (moof[fields] === 1) {
    data.setBigUint64(fields + 4, timeline.place(trackId, data.getBigUint64(fields + 4)));
  } else {
    data.setUint32(fields + 4, Number(timeline.place(trackId, BigInt(data.getUint32(fields + 4)))));
  }
}

/** Rewrite a moof in place so its fragment belongs in the merged file. */
export function retagMoof(moof: Uint8Array, options: RetagOptions): void {
  const data = view(moof);
  const root = [...boxesIn(moof)][0]!;
  for (const box of boxesIn(moof, root.headerSize, root.size)) {
    if (box.type === 'mfhd') {
      data.setUint32(box.start + box.headerSize + 4, options.sequence);
    } else if (box.type === 'traf') {
      const tfhd = child(moof, box, 'tfhd');
      if (!tfhd) continue;
      const fields = tfhd.start + tfhd.headerSize;
      const flags = data.getUint32(fields) & 0xffffff;
      if (options.timeline) placeFragment(moof, box, data.getUint32(fields + 4), options.timeline);
      if (options.trackId !== undefined) data.setUint32(fields + 4, options.trackId);
      if (flags & TFHD_BASE_DATA_OFFSET) {
        const base = data.getBigUint64(fields + 8);
        data.setBigUint64(fields + 8, base + BigInt(options.moved));
      }
    }
  }
}

export interface Sink {
  position: number;
  write(chunk: Uint8Array | Blob): Promise<void>;
}

const DROPPED = new Set(['ftyp', 'moov', 'styp', 'sidx', 'ssix', 'mfra', 'free', 'skip', 'prft']);

/** Copy the moof/mdat pairs of a segment to `sink`, and return the next sequence. */
export async function copyFragments(
  segment: Blob,
  sink: Sink,
  options: { trackId?: number; sequence: number; timeline?: Timeline },
): Promise<number> {
  let { sequence } = options;
  for await (const box of boxesInBlob(segment)) {
    if (DROPPED.has(box.type)) continue;
    const slice = segment.slice(box.start, box.start + box.size);
    if (box.type === 'moof') {
      const moof = new Uint8Array(await slice.arrayBuffer());
      retagMoof(moof, {
        trackId: options.trackId,
        sequence,
        moved: sink.position - box.start,
        timeline: options.timeline,
      });
      sequence += 1;
      await sink.write(moof);
    } else {
      await sink.write(slice);
    }
  }
  return sequence;
}
