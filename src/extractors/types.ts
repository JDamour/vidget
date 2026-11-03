import type { SubtitleTrack, Variant } from '@/src/shared/types';

export interface PageContext {
  url: string;
  fetchText(url: string): Promise<string>;
  /**
   * The open page's HTML, if `hasData` accepts it. A site that navigates without
   * reloading keeps its first page's data, so when the user is asking, the page is
   * fetched again instead. Otherwise this is empty, to avoid a fetch per scroll.
   */
  html(hasData: (html: string) => boolean): Promise<string>;
}

/** Stream URLs are expanded into variants by the same parser generic detection uses. */
export interface ExtractedMedia {
  id: string;
  title: string;
  durationSec?: number;
  thumbnail?: string;
  protected?: boolean;
  /** Ready-made variants, usually direct files. */
  variants?: Variant[];
  stream?: { url: string; kind: 'hls' | 'dash' };
  subtitles?: SubtitleTrack[];
}

export interface Extractor {
  id: string;
  matches: RegExp[];
  extract(ctx: PageContext): Promise<ExtractedMedia[]>;
}
