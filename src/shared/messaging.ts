import { browser } from 'wxt/browser';

type Sender = Parameters<Parameters<typeof browser.runtime.onMessage.addListener>[0]>[1];
type Handler = (message: any, sender: Sender) => unknown;

/** Route a listener's result or error back through `sendResponse`. */
export function listen(handler: Handler): void {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = handler(message, sender);
    if (result === undefined) return false;
    Promise.resolve(result).then(
      (value) => sendResponse({ value }),
      (err) => sendResponse({ error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });
}

export async function request<T>(message: unknown): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as
    | { value?: T; error?: string }
    | undefined;
  if (reply?.error) throw new Error(reply.error);
  return reply?.value as T;
}
