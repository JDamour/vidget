import { browser } from 'wxt/browser';
import type { ErrorCode } from '@/src/shared/types';

export const t = (key: string, ...subs: string[]): string =>
  browser.i18n.getMessage(key as 'extName', subs) || key;

const ERROR_KEYS: Record<ErrorCode, string> = {
  expired: 'errorExpired',
  network: 'errorNetwork',
  disk: 'errorDisk',
  protected: 'errorProtected',
  unsupported: 'errorUnsupported',
  canceled: 'errorCanceled',
  companion: 'errorCompanion',
  unknown: 'errorUnknown',
};

export const errorText = (code: ErrorCode | undefined): string =>
  t(ERROR_KEYS[code ?? 'unknown']);
