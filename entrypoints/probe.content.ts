import { classify } from '@/src/detect/classify';

/**
 * Runs in the page's own JS context. Network hooks catch players that fetch a
 * manifest and play it through a blob: URL; EME hooks flag DRM. Everything here
 * only observes and hands calls straight through to the original functions.
 */
export default defineContentScript({
  registration: 'runtime',
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    // On-demand injection can land on a page where this already runs.
    const marker = Symbol.for('vidget.probe');
    const scope = window as unknown as Record<symbol, boolean>;
    if (scope[marker]) return;
    scope[marker] = true;

    const post = (data: Record<string, unknown>) => {
      window.postMessage({ __vidget: true, ...data }, '*');
    };

    const seen = new Set<string>();
    const check = (url: string | undefined, contentType: string | null | undefined) => {
      if (!url || seen.has(url)) return;
      if (!classify(url, contentType ?? undefined)) return;
      seen.add(url);
      post({ kind: 'media', url, contentType: contentType ?? undefined });
    };

    // TikTok's feed responses name the files each post may stream as.
    const FEED_DATA = /^https:\/\/(www|m)\.tiktok\.com\/api\/[\w/]*(item_list|item\/detail)/;

    const originalFetch = window.fetch;
    window.fetch = function fetch(this: unknown, ...args: Parameters<typeof window.fetch>) {
      const result = originalFetch.apply(this as typeof globalThis, args);
      result.then(
        (response) => {
          check(response.url, response.headers.get('content-type'));
          if (!FEED_DATA.test(response.url)) return;
          // Cloned before the page reads the body, since this handler runs first.
          response.clone().text().then((text) => post({ kind: 'feed', text }), () => {});
        },
        () => {},
      );
      return result;
    } as typeof window.fetch;

    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function send(...args) {
      this.addEventListener('readystatechange', () => {
        if (this.readyState === XMLHttpRequest.HEADERS_RECEIVED) {
          check(this.responseURL, this.getResponseHeader('content-type'));
        }
      });
      return originalSend.apply(this, args);
    };

    // requestMediaKeySystemAccess alone is not proof of DRM: many sites call it
    // only to test capabilities. Attaching keys to an element is.
    const originalSetMediaKeys = HTMLMediaElement.prototype.setMediaKeys;
    if (originalSetMediaKeys) {
      HTMLMediaElement.prototype.setMediaKeys = function setMediaKeys(keys) {
        if (keys) post({ kind: 'drm' });
        return originalSetMediaKeys.call(this, keys);
      };
    }
    if (typeof MediaKeySession !== 'undefined') {
      const originalGenerate = MediaKeySession.prototype.generateRequest;
      MediaKeySession.prototype.generateRequest = function generateRequest(...args) {
        post({ kind: 'drm' });
        return originalGenerate.apply(this, args);
      };
    }
  },
});
