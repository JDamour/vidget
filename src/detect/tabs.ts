import { browser } from 'wxt/browser';
import type { TabState } from '@/src/shared/types';
import { emptyTab } from './registry';

const keyOf = (tabId: number) => `tab:${tabId}`;

/** Per-tab state, written through to session storage to survive worker restarts. */
export class TabStore {
  private cache = new Map<number, TabState>();
  private queues = new Map<number, Promise<unknown>>();

  async get(tabId: number): Promise<TabState> {
    const cached = this.cache.get(tabId);
    if (cached) return cached;
    const key = keyOf(tabId);
    const stored = (await browser.storage.session.get(key))[key] as TabState | undefined;
    const state = stored ?? emptyTab();
    this.cache.set(tabId, state);
    return state;
  }

  /** Updates to one tab run in order, so concurrent reports cannot lose writes. */
  update<T>(tabId: number, change: (state: TabState) => T): Promise<T> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const state = await this.get(tabId);
        const result = change(state);
        await browser.storage.session.set({ [keyOf(tabId)]: state });
        return result;
      });
    this.queues.set(tabId, next);
    return next;
  }

  clear(tabId: number): Promise<void> {
    return this.update(tabId, (state) => {
      state.items = [];
      state.drm = false;
      state.hints = undefined;
      state.posts = undefined;
    });
  }

  async remove(tabId: number): Promise<void> {
    this.cache.delete(tabId);
    this.queues.delete(tabId);
    await browser.storage.session.remove(keyOf(tabId));
  }
}
