declare module 'mux.js/lib/mp4/transmuxer.js' {
  export interface TransmuxedSegment {
    initSegment: Uint8Array;
    data: Uint8Array;
  }

  export class Transmuxer {
    constructor(options?: { keepOriginalTimestamps?: boolean; remux?: boolean });
    on(event: 'data', listener: (segment: TransmuxedSegment) => void): void;
    on(event: 'done', listener: () => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
  }
}

declare module 'm3u8-parser' {
  export class Parser {
    manifest: unknown;
    push(chunk: string): void;
    end(): void;
  }
}

declare module 'mpd-parser' {
  export function parse(text: string, options: { manifestUri: string }): unknown;
}
