import { browser } from 'wxt/browser';

export type DefaultQuality = 'best' | '1080' | '720' | '480' | 'ask';

export interface Settings {
  defaultQuality: DefaultQuality;
  filenameTemplate: string;
  segmentWorkers: number;
  concurrentJobs: number;
  minDurationSec: number;
  minSizeKb: number;
  inPageButton: boolean;
  /** Hostnames where the in-page button is turned off. */
  inPageButtonOff: string[];
  siteSubfolders: boolean;
  historyDays: number;
  rightsAccepted: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultQuality: 'best',
  filenameTemplate: '{title} ({quality})',
  segmentWorkers: 6,
  concurrentJobs: 2,
  minDurationSec: 5,
  minSizeKb: 300,
  inPageButton: true,
  inPageButtonOff: [],
  siteSubfolders: false,
  historyDays: 0,
  rightsAccepted: false,
};

export const SEGMENT_WORKERS_MIN = 1;
export const SEGMENT_WORKERS_MAX = 16;

export async function loadSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ settings: next });
  return next;
}
