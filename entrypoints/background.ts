import { browser } from 'wxt/browser';
import { AccessGate } from '@/src/detect/access';
import { classify, isAd, isYoutubeHost, mediaKey, totalSizeFrom } from '@/src/detect/classify';
import {
  addKnownMedia,
  addMetaTrack,
  addTikTokFile,
  downloadableCount,
  hashId,
  itemFromReport,
  presentItems,
  replaceItem,
  upsert,
} from '@/src/detect/registry';
import { Companion } from '@/src/companion/client';
import { COMPANION_HOST } from '@/src/companion/protocol';
import { metaTrack } from '@/src/detect/meta';
import { TabStore } from '@/src/detect/tabs';
import { findExtractor } from '@/src/extractors';
import { tiktokFileId } from '@/src/extractors/tiktok';
import type { ExtractedMedia } from '@/src/extractors/types';
import { JobError } from '@/src/shared/errors';
import { siteOf } from '@/src/shared/format';
import type {
  ContentMessage,
  HeavyEvent,
  ParsedManifest,
  UiMessage,
  UiPush,
} from '@/src/shared/messages';
import { UI_PORT } from '@/src/shared/messages';
import { listen } from '@/src/shared/messaging';
import { isBlocked, loadRemoteConfig, refreshRemoteConfig } from '@/src/shared/remote-config';
import { loadSettings } from '@/src/shared/settings';
import type { MediaInfo, MediaReport, PageHints } from '@/src/shared/types';
import { createHeavyWorker } from '@/src/queue/heavy';
import { type DownloadState, JobManager, type Platform } from '@/src/queue/manager';
import { clearReferer, setReferer } from '@/src/queue/referer';
import { pickVariant } from '@/src/queue/scheduler';
import * as db from '@/src/storage/db';
import { removeJobDir, sweepOrphans } from '@/src/storage/opfs';

/** Narrower than <all_urls>: Chrome's "On all sites" setting does not cover file:. */
const HOST_ACCESS = '*://*/*';
const DETECTOR_SCRIPT = '/content-scripts/detector.js';
const PROBE_SCRIPT = '/content-scripts/probe.js';
const MEDIA_RESOURCE_TYPES = ['media', 'xmlhttprequest', 'object', 'other'] as const;
const IDLE_CLOSE_MS = 30_000;
const TICK_MS = 1000;
const ANCHOR_TIMEOUT_MS = 5000;

export default defineBackground({
  type: 'module',
  main() {
    const heavy = createHeavyWorker();
    const tabs = new TabStore();
    const ports = new Set<ReturnType<typeof browser.runtime.connect>>();
    const popupPorts = new Set<ReturnType<typeof browser.runtime.connect>>();
    const namesToApply = new Map<string, string>();
    const awaitingCreation = new Map<string, (downloadId: number) => void>();
    const redirectedFrom = new Map<string, string>();

    const push = (message: UiPush) => {
      for (const port of ports) port.postMessage(message);
    };

    const t = (key: string, ...subs: string[]) => browser.i18n.getMessage(key as 'extName', subs);

    const platform: Platform = {
      settings: loadSettings,
      saveJob: db.putJob,
      deleteJob: db.deleteJob,
      addHistory: db.addHistory,
      removeWorkDir: removeJobDir,
      setReferer,
      clearReferer,
      heavyRun: (job, workers) =>
        heavy.send({
          target: 'heavy',
          type: 'run',
          plan: { jobId: job.id, variant: job.variant, pageUrl: job.pageUrl, workers },
        }),
      heavyAbort: (jobId, reason) => heavy.send({ target: 'heavy', type: 'abort', jobId, reason }),
      heavyRelease: (jobId) => heavy.send({ target: 'heavy', type: 'release', jobId }),
      heavyActive: async () =>
        (await heavy.isOpen()) ? heavy.send({ target: 'heavy', type: 'active' }) : [],
      download: async (url, filename) => {
        namesToApply.set(url, filename);
        const id = await browser.downloads.download({
          url,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        startTicking();
        return id;
      },
      saveBlob: async (url, filename) => {
        // a.download cannot express a folder, and the worker may be refused a click.
        const id = filename.includes('/') ? undefined : await saveByAnchor(url, filename);
        return id ?? platform.download(url, filename);
      },
      downloadPause: (id) => browser.downloads.pause(id),
      downloadResume: (id) => browser.downloads.resume(id),
      downloadCancel: (id) => browser.downloads.cancel(id),
      downloadInfo: async (id) => {
        const [item] = await browser.downloads.search({ id });
        if (!item) return undefined;
        return {
          state: item.state as DownloadState,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          error: item.error,
        };
      },
      notify: (job) => {
        if (popupPorts.size) return;
        const failed = job.status === 'failed';
        void browser.notifications.create(job.id, {
          type: 'basic',
          iconUrl: browser.runtime.getURL('/icon/128.png'),
          title: t(failed ? 'notifyFailed' : 'notifyDone'),
          message: job.title,
        });
      },
      publish: (job) => push({ type: 'job', job }),
      publishRemoved: (jobId) => push({ type: 'job:removed', jobId }),
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      companionRun: async (job) => {
        if (!companion) throw new JobError('unsupported');
        companion.send({ type: 'download', jobId: job.id, url: job.variant.url });
      },
      companionStop: async (jobId, discard) => {
        companion?.sendIfOpen({ type: 'cancel', jobId, discard });
      },
    };

    const manager = new JobManager(platform);

    const companion = __FEATURE_COMPANION__
      ? new Companion(
          () => browser.runtime.connectNative(COMPANION_HOST),
          (event) => {
            void ready
              .then(() => manager.onCompanionEvent(event))
              .then(() => {
                // An idle port would keep the host and this worker awake for nothing.
                if (event.type !== 'progress' && !manager.hasCompanionJobs()) companion?.close();
              });
          },
          () => browser.runtime.lastError?.message,
        )
      : undefined;

    /**
     * The only reliable way to name a blob. Chrome lets the most recently installed
     * extension that listens to onDeterminingFilename decide every download's name,
     * even when it suggests nothing, which leaves a blob URL's UUID as the filename.
     * An <a download> link keeps its name whatever other extensions are installed.
     */
    async function saveByAnchor(url: string, filename: string) {
      const created = new Promise<number | undefined>((resolve) => {
        awaitingCreation.set(url, resolve);
        setTimeout(() => resolve(undefined), ANCHOR_TIMEOUT_MS);
      });
      await heavy.send({ target: 'heavy', type: 'save', url, filename });
      const id = await created;
      awaitingCreation.delete(url);
      return id;
    }

    browser.downloads.onCreated.addListener((item) => {
      awaitingCreation.get(item.url)?.(item.id);
    });

    // Direct files cannot use a link, because a.download is ignored cross-origin, so
    // this is their best effort. If a newer extension outranks it they still get the
    // name from their URL. Firefox has no such event. Other downloads are answered
    // at once, because Chrome holds each one until every listener has replied.
    browser.downloads.onDeterminingFilename?.addListener((item, suggest) => {
      const filename = namesToApply.get(item.url);
      namesToApply.delete(item.url);
      if (filename) suggest({ filename, conflictAction: 'uniquify' });
      else suggest();
    });

    const ready = (async () => {
      const saved = await db.getJobs();
      await manager.restore(saved);
      await sweepOrphans(new Set(manager.list().map((job) => job.id))).catch(() => {});
      const settings = await loadSettings();
      await db.pruneHistory(settings.historyDays);
      await refreshRemoteConfig().catch(() => {});
      await syncContentScripts();
    })();

    let ticking: ReturnType<typeof setInterval> | undefined;
    function startTicking() {
      ticking ??= setInterval(() => {
        void manager.tick().then((active) => {
          if (active || !ticking) return;
          clearInterval(ticking);
          ticking = undefined;
        });
      }, TICK_MS);
    }

    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    function closeHeavyWhenIdle() {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        const busy = manager
          .list()
          .some((job) => job.variant.kind !== 'direct' && ['downloading', 'merging'].includes(job.status));
        if (!busy) void heavy.close();
      }, IDLE_CLOSE_MS);
    }

    async function hasHostAccess() {
      return browser.permissions.contains({ origins: [HOST_ACCESS] });
    }

    async function syncContentScripts() {
      if (!(await hasHostAccess())) return;
      const existing = await browser.scripting.getRegisteredContentScripts();
      if (existing.length) return;
      await browser.scripting.registerContentScripts([
        {
          id: 'vidget-probe',
          js: [PROBE_SCRIPT],
          matches: ['<all_urls>'],
          allFrames: true,
          runAt: 'document_start',
          world: 'MAIN',
        },
        {
          id: 'vidget-detector',
          js: [DETECTOR_SCRIPT],
          matches: ['<all_urls>'],
          allFrames: true,
          runAt: 'document_start',
        },
      ]);
    }

    /**
     * Scan a page the registered scripts never reached. Both scripts guard against
     * running twice. Failures are expected on browser pages.
     */
    async function injectInto(tabId: number) {
      const options = { target: { tabId, allFrames: true }, injectImmediately: true };
      await browser.scripting
        .executeScript({ ...options, files: [PROBE_SCRIPT], world: 'MAIN' })
        .catch(() => {});
      await browser.scripting.executeScript({ ...options, files: [DETECTOR_SCRIPT] }).catch(() => {});
    }

    /** Pages opened before access was granted have no scripts until they reload. */
    async function scanOpenTabs() {
      const open = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      await Promise.all(open.map((tab) => (tab.id === undefined ? null : injectInto(tab.id))));
    }

    async function allowed(url: string) {
      if (!URL.canParse(url)) return false;
      const hostname = new URL(url).hostname;
      if (!__FEATURE_YOUTUBE__ && !__FEATURE_COMPANION__ && isYoutubeHost(hostname)) return false;
      return !isBlocked(hostname, await loadRemoteConfig());
    }

    async function refreshBadge(tabId: number) {
      const state = await tabs.get(tabId);
      const items = presentItems(state, await loadSettings());
      const count = downloadableCount(items);
      await browser.action
        .setBadgeText({ tabId, text: count ? String(count) : '' })
        .catch(() => {}); // The tab may be gone already.
      push({ type: 'tab', tabId });
    }

    async function applyParsed(tabId: number, item: MediaInfo, parsed: ParsedManifest) {
      await tabs.update(tabId, (state) => {
        // Reports keep arriving during a parse, so start from what they have added.
        const current = state.items.find((other) => other.id === item.id) ?? item;
        replaceItem(state, {
          ...current,
          variants: parsed.variants,
          durationSec: parsed.durationSec ?? current.durationSec,
          protected: parsed.protected,
          status: parsed.live ? 'live' : 'ready',
          childKeys: parsed.childUrls.map(mediaKey),
          subtitles: parsed.subtitles,
        });
      });
    }

    async function parseStream(
      url: string,
      kind: 'hls' | 'dash',
      pageUrl: string,
    ): Promise<ParsedManifest> {
      const owner = `parse:${url}`;
      await setReferer(owner, [url], pageUrl);
      try {
        return await heavy.send<ParsedManifest>({ target: 'heavy', type: 'parse', url, kind });
      } finally {
        await clearReferer(owner);
        closeHeavyWhenIdle();
      }
    }

    /** `initiator` is only an origin, but a Referer should carry the full page URL. */
    async function pageUrlFor(tabId: number, initiator: string) {
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      if (!tab?.url || !URL.canParse(initiator)) return tab?.url ?? initiator;
      return new URL(tab.url).origin === new URL(initiator).origin ? tab.url : initiator;
    }

    async function ingest(tabId: number, report: MediaReport, pageUrl: string) {
      const kind = classify(report.url, report.contentType);
      if (!kind || isAd(report.url)) return;
      // The companion handles YouTube pages; their stream pieces are no use alone.
      if (__FEATURE_COMPANION__ && isYoutubeHost(new URL(report.url).hostname)) return;
      if (!(await allowed(report.url)) || !(await allowed(pageUrl))) return;

      const track = metaTrack(report.url);
      if (track) {
        await tabs.update(tabId, (state) => addMetaTrack(state, track, pageUrl));
        await refreshBadge(tabId);
        return;
      }
      const tiktokFile = tiktokFileId(report.url);
      if (tiktokFile) {
        await tabs.update(tabId, (state) => addTikTokFile(state, tiktokFile, report, pageUrl));
        await refreshBadge(tabId);
        return;
      }

      const item = itemFromReport(report, kind, pageUrl);
      item.key = redirectedFrom.get(item.key) ?? item.key;
      const isNew = await tabs.update(tabId, (state) => upsert(state, item));
      if (isNew && kind !== 'direct') {
        try {
          await applyParsed(tabId, item, await parseStream(report.url, kind, pageUrl));
        } catch {
          await tabs.update(tabId, (state) =>
            replaceItem(state, { ...item, status: 'error' }),
          );
        }
      }
      await refreshBadge(tabId);
    }

    async function ingestExtracted(tabId: number, media: ExtractedMedia, pageUrl: string) {
      const key = media.stream ? mediaKey(media.stream.url) : media.id;
      const item: MediaInfo = {
        id: hashId(media.id),
        key,
        title: media.title,
        site: siteOf(pageUrl),
        durationSec: media.durationSec,
        thumbnail: media.thumbnail,
        protected: media.protected ?? false,
        variants: media.variants ?? [],
        subtitles: media.subtitles,
        status: media.stream ? 'parsing' : 'ready',
        pageUrl,
        source: 'extractor',
      };
      await tabs.update(tabId, (state) => upsert(state, item));
      if (media.stream) {
        const parsed = await parseStream(media.stream.url, media.stream.kind, pageUrl);
        await applyParsed(tabId, item, parsed);
      }
    }

    const extracted = new Map<number, string>();

    async function openPageHtml(tabId: number) {
      const [frame] = await browser.scripting
        .executeScript({ target: { tabId }, func: () => document.documentElement.outerHTML })
        .catch(() => []);
      return typeof frame?.result === 'string' ? frame.result : '';
    }

    async function runExtractor(tabId: number, url: string, userAsked = false) {
      if (extracted.get(tabId) === url || !(await allowed(url))) return;
      const { disabledExtractors } = await loadRemoteConfig();
      const extractor = findExtractor(url, disabledExtractors);
      if (!extractor) return;
      extracted.set(tabId, url);
      let found = 0;
      try {
        const fetchText = async (target: string) => {
          const response = await fetch(target, { credentials: 'include' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        };
        const html = async (hasData: (html: string) => boolean) => {
          const open = await openPageHtml(tabId);
          if (hasData(open)) return open;
          return userAsked ? fetchText(url) : '';
        };
        for (const media of await extractor.extract({ url, fetchText, html })) {
          await ingestExtracted(tabId, media, url);
          found += 1;
        }
      } catch (err) {
        // Generic detection still covers the page when an extractor breaks.
        console.warn(`Extractor ${extractor.id} failed`, err);
      }
      // A page still loading may have nothing yet, so a later call may try again.
      if (!found && extracted.get(tabId) === url) extracted.delete(tabId);
      await refreshBadge(tabId);
    }

    async function onHints(tabId: number, hints: PageHints, topFrame: boolean) {
      await tabs.update(tabId, (state) => {
        state.posts = { ...state.posts, ...hints.posts };
        // A subframe knows about its video, but the page title belongs to the top frame.
        state.hints = topFrame
          ? { ...hints, durationSec: hints.durationSec ?? state.hints?.durationSec }
          : {
              url: state.hints?.url ?? hints.url,
              ...state.hints,
              durationSec: state.hints?.durationSec ?? hints.durationSec,
              poster: state.hints?.poster ?? hints.poster,
            };
      });
      if (topFrame) await runExtractor(tabId, hints.url);
      await refreshBadge(tabId);
    }

    async function activeTabId() {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id;
    }

    async function tabView(tabId: number) {
      const state = await tabs.get(tabId);
      const settings = await loadSettings();
      return { ...state, tabId, items: presentItems(state, settings) };
    }

    async function startJob(tabId: number, mediaId: string, variantId?: string) {
      const view = await tabView(tabId);
      const item = view.items.find((entry) => entry.id === mediaId);
      if (!item) throw new Error('Media is no longer available');
      const settings = await loadSettings();
      const variant =
        item.variants.find((entry) => entry.id === variantId) ??
        pickVariant(item, settings.defaultQuality);
      if (!variant) throw new Error('No downloadable variant');
      return manager.start(item, variant, tabId);
    }

    async function retryFromHistory(jobId: string) {
      const entry = (await db.getHistory()).find((row) => row.jobId === jobId);
      if (!entry) return;
      const existing = manager.get(jobId);
      if (existing) return manager.retry(jobId);
      await manager.start(
        {
          id: hashId(entry.sourceUrl),
          key: mediaKey(entry.sourceUrl),
          title: entry.title,
          site: entry.site,
          protected: false,
          variants: [entry.variant],
          status: 'ready',
          pageUrl: entry.pageUrl,
          source: 'network',
        },
        entry.variant,
      );
    }

    listen((message: ContentMessage | UiMessage | HeavyEvent, sender) => {
      if ('target' in message) {
        if (message.target !== 'background') return undefined;
        return ready.then(() => manager.onHeavyEvent(message)).then(() => {
          if (message.type === 'heavy:done' || message.type === 'heavy:failed') closeHeavyWhenIdle();
          return true;
        });
      }

      const senderTab = sender.tab?.id;
      switch (message.type) {
        case 'media:report': {
          if (senderTab === undefined) return undefined;
          const pageUrl = sender.url ?? sender.tab?.url ?? '';
          for (const report of message.reports) void ingest(senderTab, report, pageUrl);
          return undefined;
        }
        case 'media:drm':
          if (senderTab === undefined) return undefined;
          void tabs
            .update(senderTab, (state) => {
              state.drm = true;
            })
            .then(() => refreshBadge(senderTab));
          return undefined;
        case 'media:known':
          if (senderTab === undefined) return undefined;
          void tabs
            .update(senderTab, (state) => addKnownMedia(state, message.media))
            .then(() => refreshBadge(senderTab));
          return undefined;
        case 'page:hints':
          if (senderTab !== undefined) {
            void onHints(senderTab, message.hints, sender.frameId === 0);
          }
          return undefined;
        case 'tab:get':
          return (async () => {
            const tabId = message.tabId ?? senderTab ?? (await activeTabId());
            if (tabId === undefined) return undefined;
            // Without host access, opening the popup is what grants this tab activeTab.
            // The in-page button only asks from pages that already run the detector.
            // Not awaited: a page that is still loading must not hold up the popup.
            // Whatever the scan finds arrives as a tab update.
            const fromUi = sender.url?.startsWith(browser.runtime.getURL('/'));
            if (fromUi) void injectInto(tabId);
            const url = (await browser.tabs.get(tabId).catch(() => undefined))?.url;
            const blocked = !!url && !(await allowed(url));
            if (fromUi && url) void runExtractor(tabId, url, true);
            return { ...(await tabView(tabId)), blocked };
          })();
        case 'job:start':
          return ready.then(async () => {
            const tabId = message.tabId ?? senderTab ?? (await activeTabId());
            if (tabId === undefined) throw new Error('No tab');
            return startJob(tabId, message.mediaId, message.variantId);
          });
        case 'job:pause':
          return ready.then(() => manager.pause(message.jobId)).then(() => true);
        case 'job:resume':
          return ready.then(() => manager.resume(message.jobId)).then(() => true);
        case 'job:retry':
          return ready.then(() => manager.retry(message.jobId)).then(() => true);
        case 'job:cancel':
          return ready.then(() => manager.cancel(message.jobId)).then(() => true);
        case 'jobs:list':
          return ready.then(() => manager.list());
        case 'history:list':
          return db.getHistory();
        case 'history:clear':
          return db.clearHistory().then(() => true);
        case 'history:retry':
          return ready.then(() => retryFromHistory(message.jobId)).then(() => true);
        case 'history:show':
          browser.downloads.show(message.downloadId);
          return true;
      }
    });

    browser.runtime.onConnect.addListener((port) => {
      if (!port.name.startsWith(UI_PORT)) return;
      const isPopup = port.name.endsWith(':popup');
      ports.add(port);
      if (isPopup) popupPorts.add(port);
      port.onDisconnect.addListener(() => {
        ports.delete(port);
        popupPorts.delete(port);
      });
    });

    type HeadersListener = Parameters<typeof browser.webRequest.onHeadersReceived.addListener>[0];

    const onHeaders: HeadersListener = (details) => {
      const { tabId, url, type, responseHeaders, statusCode } = details;
      if (tabId < 0) return; // The extension's own segment fetches.
      if (type === 'main_frame') {
        extracted.delete(tabId);
        void tabs.clear(tabId).then(() => refreshBadge(tabId));
        return;
      }
      if (statusCode >= 400) return;
      const header = (name: string) =>
        responseHeaders?.find((entry) => entry.name.toLowerCase() === name)?.value;
      const contentType = header('content-type');
      if (!classify(url, contentType)) return;
      if (statusCode >= 300) {
        // The size here is the redirect's own, and the element keeps this URL as its src.
        const location = header('location');
        if (location) redirectedFrom.set(mediaKey(new URL(location, url).href), mediaKey(url));
        return;
      }
      const sizeBytes = totalSizeFrom({
        contentLength: header('content-length'),
        contentRange: header('content-range'),
      });
      const report: MediaReport = { url, source: 'network', contentType, sizeBytes };
      const documentUrl = (details as { documentUrl?: string }).documentUrl;
      // A sandboxed frame's initiator is the string "null", not a URL.
      void pageUrlFor(tabId, documentUrl ?? details.initiator ?? url).then((pageUrl) =>
        ingest(tabId, report, pageUrl),
      );
    };

    const network = new AccessGate({
      hasAccess: hasHostAccess,
      subscribe: () =>
        browser.webRequest.onHeadersReceived.addListener(
          onHeaders,
          { urls: ['<all_urls>'], types: ['main_frame', ...MEDIA_RESOURCE_TYPES] },
          ['responseHeaders'],
        ),
      unsubscribe: () => browser.webRequest.onHeadersReceived.removeListener(onHeaders),
    });
    void network.sync();

    browser.tabs.onRemoved.addListener((tabId) => {
      extracted.delete(tabId);
      void tabs.remove(tabId);
    });

    browser.tabs.onUpdated.addListener((tabId, info) => {
      // The subscription above is async, so it cannot wake a sleeping worker. This can.
      void network.sync();
      // Single-page navigations change the URL with no main_frame request.
      if (!info.url) return;
      void tabs.get(tabId).then((state) => {
        if (state.hints && state.hints.url !== info.url) void tabs.clear(tabId);
      });
    });

    browser.downloads.onChanged.addListener((delta) => {
      const state = delta.state?.current as DownloadState | undefined;
      if (!state) return;
      void ready.then(() => manager.onDownloadChange(delta.id, state, delta.error?.current));
    });

    browser.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId !== 'vidget-download' || tab?.id === undefined) return;
      const tabId = tab.id;
      void (async () => {
        const url = info.srcUrl ?? info.linkUrl;
        const items = (await tabView(tabId)).items;
        const match =
          items.find((item) => item.variants.some((variant) => variant.url === url)) ??
          (url && !url.startsWith('blob:') && classify(url) === 'direct'
            ? itemFromReport(
                { url, source: 'dom', title: tab.title },
                'direct',
                info.pageUrl ?? url,
              )
            : items[0]);
        if (!match || match.protected) return;
        const settings = await loadSettings();
        const variant = pickVariant(match, settings.defaultQuality);
        if (variant) await manager.start(match, variant, tabId);
      })();
    });

    browser.runtime.onInstalled.addListener(() => {
      browser.contextMenus.create({
        id: 'vidget-download',
        title: t('menuDownload'),
        contexts: ['video', 'link'],
        targetUrlPatterns: ['*://*/*.mp4*', '*://*/*.webm*', '*://*/*.mov*', '*://*/*.mkv*', '*://*/*.m3u8*', '*://*/*.mpd*'],
      });
    });

    // The popup closes when Chrome shows its prompt, so a grant is handled here.
    browser.permissions.onAdded.addListener(() => {
      void network.sync();
      void syncContentScripts().then(scanOpenTabs);
    });
    browser.permissions.onRemoved.addListener(() => void network.sync());
  },
});
