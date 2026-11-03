import { browser } from 'wxt/browser';
import { mountInPageButton } from '@/src/detect/inpage';
import { findVideos, mainVideo, reportsFor, reportsFromTiming } from '@/src/detect/scan';
import { cleanXTitle, isXHost, xPlayingPostTitle, xPostsById } from '@/src/detect/x';
import { tiktokFeedMedia } from '@/src/extractors/tiktok';
import type { ContentMessage } from '@/src/shared/messages';
import type { MediaReport, PageHints } from '@/src/shared/types';

const RESCAN_MS = 500;

declare global {
  interface Window {
    __vidgetDetector?: boolean;
  }
}

function send(message: ContentMessage) {
  browser.runtime.sendMessage(message).catch(() => {
    // The extension was reloaded; this orphaned script has nobody to talk to.
  });
}

function meta(property: string): string | undefined {
  return (
    document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`)?.content || undefined
  );
}

export default defineContentScript({
  registration: 'runtime',
  runAt: 'document_start',
  allFrames: true,
  main() {
    // On-demand injection can land on a page where the script already runs.
    if (window.__vidgetDetector) return;
    window.__vidgetDetector = true;

    const onX = isXHost(location.hostname);
    const onTikTok = /(^|\.)tiktok\.com$/.test(location.hostname);
    let videos: HTMLVideoElement[] = [];
    let lastHints = '';
    const reported = new Set<string>();
    let timingSeen = 0;

    const scan = () => {
      videos = findVideos();
      const fresh: MediaReport[] = [];
      const timing = performance.getEntriesByType('resource');
      for (const report of reportsFromTiming(timing.slice(timingSeen))) {
        if (reported.has(report.url)) continue;
        reported.add(report.url);
        fresh.push(report);
      }
      timingSeen = timing.length;
      for (const video of videos) {
        for (const report of reportsFor(video)) {
          const signature = `${report.url}|${report.durationSec ?? ''}`;
          if (reported.has(signature)) continue;
          reported.add(signature);
          fresh.push(report);
        }
      }
      if (fresh.length) send({ type: 'media:report', reports: fresh });

      const main = mainVideo(videos);
      const hints: PageHints = {
        url: location.href,
        title: (onX ? cleanXTitle(document.title) : document.title) || undefined,
        ogTitle: meta('og:title'),
        ogImage: meta('og:image'),
        durationSec: main && Number.isFinite(main.duration) ? main.duration : undefined,
        poster: main?.poster || undefined,
        posts: onX ? xPostsById(videos) : undefined,
      };
      const signature = JSON.stringify(hints);
      if (signature !== lastHints) {
        lastHints = signature;
        send({ type: 'page:hints', hints });
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleScan = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        // Idle callbacks can stall in a hidden tab, which has no frames to protect anyway.
        if (document.hidden || !('requestIdleCallback' in window)) scan();
        else requestIdleCallback(scan, { timeout: 1000 });
      }, RESCAN_MS);
    };

    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data?.__vidget) return;
      const data = event.data as { kind: string; url?: string; contentType?: string; text?: string };
      if (data.kind === 'drm') send({ type: 'media:drm' });
      else if (data.kind === 'feed' && onTikTok && typeof data.text === 'string') {
        const media = tiktokFeedMedia(data.text);
        if (media.length) send({ type: 'media:known', media });
      }
      else if (data.kind === 'media' && typeof data.url === 'string') {
        send({
          type: 'media:report',
          reports: [
            {
              url: data.url,
              source: 'probe',
              contentType: data.contentType,
              title: onX ? xPlayingPostTitle(findVideos()) : undefined,
            },
          ],
        });
      }
    });

    for (const name of ['loadedmetadata', 'play', 'durationchange']) {
      document.addEventListener(name, scheduleScan, { capture: true, passive: true });
    }

    const start = () => {
      new MutationObserver(scheduleScan).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
      scheduleScan();
      if (window === window.top || document.documentElement.clientWidth > 300) {
        mountInPageButton(() => videos);
      }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else start();
  },
});
