import type { DefaultQuality } from '@/src/shared/settings';
import type { Job, MediaInfo, Variant } from '@/src/shared/types';

const RUNNING: Job['status'][] = ['downloading', 'merging'];

export function isRunning(job: Job): boolean {
  return RUNNING.includes(job.status);
}

/** Queued jobs that can start now, oldest first, within the concurrency limit. */
export function nextToStart(jobs: Job[], limit: number): Job[] {
  const free = limit - jobs.filter(isRunning).length;
  if (free <= 0) return [];
  return jobs
    .filter((job) => job.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, free);
}

/** Variants are sorted best first, so the first one at or below the cap wins. */
export function pickVariant(item: MediaInfo, quality: DefaultQuality): Variant | undefined {
  const usable = item.variants.filter((variant) => !variant.needsFfmpeg);
  const pool = usable.length ? usable : item.variants;
  if (quality === 'best' || quality === 'ask') return pool[0];
  const cap = Number(quality);
  return pool.find((variant) => (variant.height ?? 0) <= cap) ?? pool[pool.length - 1];
}
