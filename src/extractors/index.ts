import { dailymotion } from './dailymotion';
import { facebook } from './facebook';
import { instagram } from './instagram';
import { reddit } from './reddit';
import { tiktok } from './tiktok';
import type { Extractor } from './types';
import { vimeo } from './vimeo';
import { youtube } from './youtube';

export const EXTRACTORS: Extractor[] = [
  vimeo,
  reddit,
  dailymotion,
  facebook,
  instagram,
  tiktok,
  // Store builds must not download from YouTube at all.
  ...(__FEATURE_COMPANION__ ? [youtube] : []),
];

export function findExtractor(url: string, disabled: string[] = []): Extractor | undefined {
  return EXTRACTORS.find(
    (extractor) =>
      !disabled.includes(extractor.id) && extractor.matches.some((pattern) => pattern.test(url)),
  );
}
