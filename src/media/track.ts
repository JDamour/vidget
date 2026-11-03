export interface ByteRange {
  offset: number;
  length: number;
}

export interface SegmentKey {
  uri: string;
  /** 16 explicit bytes; otherwise the IV is derived from the media sequence. */
  iv?: Uint8Array;
}

export interface Segment {
  url: string;
  byteRange?: ByteRange;
  key?: SegmentKey;
  mediaSequence: number;
  durationSec: number;
  /** This segment starts a spliced-in section with a clock of its own. */
  discontinuity?: boolean;
}

export interface Track {
  role: 'muxed' | 'video' | 'audio';
  init?: { url: string; byteRange?: ByteRange };
  segments: Segment[];
}

/** Where each spliced-in section starts: segment index to seconds into the track. */
export function sectionStarts(track: Track): Map<number, number> {
  const starts = new Map<number, number>();
  let elapsed = 0;
  track.segments.forEach((segment, index) => {
    if (segment.discontinuity) starts.set(index, elapsed);
    elapsed += segment.durationSec;
  });
  return starts;
}
