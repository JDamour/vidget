import { browser } from 'wxt/browser';

export interface RemoteConfig {
  blockedSites: string[];
  disabledExtractors: string[];
}

interface Cached {
  config: RemoteConfig;
  fetchedAt: number;
}

const DAY_MS = 86_400_000;
const EMPTY: RemoteConfig = { blockedSites: [], disabledExtractors: [] };

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/** Verify a `{ payload, signature }` file signed with ECDSA P-256 / SHA-256. */
export async function verifyConfig(
  file: { payload: string; signature: string },
  publicKeyRaw: string,
): Promise<RemoteConfig | undefined> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(publicKeyRaw),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64ToBytes(file.signature),
    new TextEncoder().encode(file.payload),
  );
  if (!valid) return undefined;
  const config = JSON.parse(file.payload) as Partial<RemoteConfig>;
  return { ...EMPTY, ...config };
}

export function isBlocked(hostname: string, config: RemoteConfig): boolean {
  return config.blockedSites.some((site) => hostname === site || hostname.endsWith(`.${site}`));
}

export async function loadRemoteConfig(): Promise<RemoteConfig> {
  const { remoteConfig } = await browser.storage.local.get('remoteConfig');
  return (remoteConfig as Cached | undefined)?.config ?? EMPTY;
}

/**
 * Data only: this can turn sites and extractors off, never add behavior. It
 * makes no request until a URL and public key are set at build time.
 */
export async function refreshRemoteConfig(now = Date.now()): Promise<void> {
  const url = import.meta.env.WXT_REMOTE_CONFIG_URL as string | undefined;
  const publicKey = import.meta.env.WXT_REMOTE_CONFIG_KEY as string | undefined;
  if (!url || !publicKey) return;
  const { remoteConfig } = await browser.storage.local.get('remoteConfig');
  if (now - ((remoteConfig as Cached | undefined)?.fetchedAt ?? 0) < DAY_MS) return;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return;
  const config = await verifyConfig(await response.json(), publicKey);
  if (config) {
    await browser.storage.local.set({ remoteConfig: { config, fetchedAt: now } satisfies Cached });
  }
}
