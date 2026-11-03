import { browser } from 'wxt/browser';
import type { HeavyRequest } from '@/src/shared/messages';
import { request } from '@/src/shared/messaging';

const PAGE = 'offscreen.html';

/** Where long fetch and mux work runs: an offscreen document, or a tab on Firefox. */
export interface HeavyWorker {
  send<T>(message: HeavyRequest): Promise<T>;
  /** Whether the host page is already up, without starting it. */
  isOpen(): Promise<boolean>;
  close(): Promise<void>;
}

class OffscreenWorker implements HeavyWorker {
  private creating: Promise<void> | undefined;

  async isOpen() {
    return browser.offscreen.hasDocument();
  }

  private async ensure() {
    if (await this.isOpen()) return;
    this.creating ??= browser.offscreen
      .createDocument({
        url: PAGE,
        reasons: ['WORKERS', 'BLOBS'],
        justification: 'Download, decrypt and merge video segments in the background.',
      })
      .finally(() => {
        this.creating = undefined;
      });
    await this.creating;
  }

  async send<T>(message: HeavyRequest) {
    await this.ensure();
    return request<T>(message);
  }

  async close() {
    if (await this.isOpen()) await browser.offscreen.closeDocument();
  }
}

/** Firefox has no offscreen API and event pages get suspended; a pinned tab does not. */
class HiddenTabWorker implements HeavyWorker {
  private async find() {
    const url = browser.runtime.getURL(`/${PAGE}`);
    return (await browser.tabs.query({ url }))[0];
  }

  async isOpen() {
    return !!(await this.find());
  }

  private async ensure() {
    if (await this.find()) return;
    await new Promise<void>((resolve) => {
      const onUpdated = (_: number, info: { status?: string }, tab: { url?: string }) => {
        if (info.status === 'complete' && tab.url?.endsWith(PAGE)) {
          browser.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      browser.tabs.onUpdated.addListener(onUpdated);
      void browser.tabs.create({ url: `/${PAGE}`, active: false, pinned: true });
    });
  }

  async send<T>(message: HeavyRequest) {
    await this.ensure();
    return request<T>(message);
  }

  async close() {
    const tab = await this.find();
    if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
  }
}

export function createHeavyWorker(): HeavyWorker {
  return import.meta.env.FIREFOX ? new HiddenTabWorker() : new OffscreenWorker();
}
