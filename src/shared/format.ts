import type { Variant } from './types';

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function qualityLabel(variant: Variant): string {
  if (variant.height) return `${variant.height}p`;
  if (variant.bitrate) return `${Math.round(variant.bitrate / 1000)} kbps`;
  return 'Original';
}

const MAX_TITLE = 90;

/** A post's text as a title: no links, one line, and cut at a word. */
export function shortTitle(text: string): string {
  const clean = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_TITLE) return clean;
  return `${clean.slice(0, MAX_TITLE).replace(/\s+\S*$/, '')}…`;
}

export function fileExtension(url: string): string {
  const match = new URL(url).pathname.toLowerCase().match(/\.(mp4|webm|mov|mkv|m4v)$/);
  return match?.[1] ?? 'mp4';
}

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
