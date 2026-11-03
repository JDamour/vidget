import { browser } from 'wxt/browser';
import { hashId } from '@/src/detect/registry';

const RESOURCE_TYPES = ['xmlhttprequest', 'other'] as const;

/** Deterministic, so a restarted service worker can still find its own rules. */
function ruleId(owner: string): number {
  return (parseInt(hashId(owner), 36) % 0x3fffffff) + 1;
}

/** Scope to the extension's own requests: page traffic is never touched. */
function scope(): Record<string, unknown> {
  return import.meta.env.FIREFOX
    ? { initiatorDomains: [new URL(browser.runtime.getURL('/')).hostname] }
    : { tabIds: [-1] };
}

/** Send the page's Referer and Origin on `owner`'s requests to `urls`' hosts. */
export async function setReferer(owner: string, urls: string[], pageUrl: string): Promise<void> {
  const hosts = [...new Set(urls.map((url) => new URL(url).hostname))];
  const id = ruleId(owner);
  const addRules = /^https?:/.test(pageUrl)
    ? [
        {
          id,
          priority: 1,
          action: {
            type: 'modifyHeaders' as const,
            requestHeaders: [
              { header: 'Referer', operation: 'set' as const, value: pageUrl },
              { header: 'Origin', operation: 'set' as const, value: new URL(pageUrl).origin },
            ],
          },
          condition: { requestDomains: hosts, resourceTypes: [...RESOURCE_TYPES], ...scope() },
        },
      ]
    : [];
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: addRules as never,
  });
}

export async function clearReferer(owner: string): Promise<void> {
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(owner)] });
}
