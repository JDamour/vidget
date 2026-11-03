import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, expect, test, type Worker } from '@playwright/test';
import { startServer } from './server';

const OUT = process.env.SHOTS_DIR ?? '';
const root = join(import.meta.dirname, '..', '..');
const launch = (ext: string, colorScheme: 'light' | 'dark') =>
  chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'v-')), {
    channel: 'chromium',
    headless: true,
    colorScheme,
    viewport: { width: 900, height: 700 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });

const hasWebRequestListener = (worker: Worker) =>
  worker.evaluate(() =>
    (chrome.webRequest.onHeadersReceived as unknown as { hasListeners(): boolean }).hasListeners(),
  );

/** Give the worker's async startup time to run. */
const popupless = async (context: BrowserContext) => {
  const page = await context.newPage();
  await page.goto('about:blank');
  await page.waitForTimeout(500);
  await page.close();
};

test('production build asks for access on first run', async () => {
  const ext = join(root, '.output', 'chrome-mv3');
  const context = await launch(ext, 'light');
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  expect(await worker.evaluate(() => chrome.permissions.contains({ origins: ['*://*/*'] }))).toBe(false);
  // Subscribing without host access is what Chrome reports as an extension error.
  await popupless(context);
  expect(await hasWebRequestListener(worker)).toBe(false);
  expect(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).toEqual([]);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 420 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.getByTestId('access')).toBeVisible();
  await expect(popup.getByTestId('rights')).toBeVisible();
  if (OUT) await popup.screenshot({ path: join(OUT, 'first-run.png') });
  await context.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`UI in ${scheme}`, async () => {
    if (OUT) mkdirSync(OUT, { recursive: true });
    const server = await startServer();
    const ext = join(root, '.output-e2e', 'chrome-mv3');
    const context = await launch(ext, scheme);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).hostname;
    await expect.poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length)).toBe(2);
    await expect.poll(() => hasWebRequestListener(worker)).toBe(true);
    await worker.evaluate(() => chrome.storage.local.set({ settings: { rightsAccepted: true } }));

    const src = encodeURIComponent(`http://127.0.0.1:${server.port}/hls-ts/master.m3u8`);
    const page = await context.newPage();
    await page.goto(`http://localhost:${server.port}/pages/stream.html?src=${src}`);
    await page.waitForTimeout(1500);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((tab) => tab.url?.includes('stream.html'))?.id);
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 380, height: 420 });
    await popup.goto(`chrome-extension://${id}/popup.html?tabId=${tabId}`);
    await popup.getByTestId('download').waitFor();
    if (OUT) await popup.screenshot({ path: join(OUT, `popup-${scheme}.png`) });

    await popup.getByTestId('download').click();
    await expect(popup.getByTestId('job').first()).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
    if (OUT) await popup.screenshot({ path: join(OUT, `popup-done-${scheme}.png`) });

    const downloads = await context.newPage();
    await downloads.goto(`chrome-extension://${id}/downloads.html`);
    await downloads.getByTestId('history-row').first().waitFor();
    if (OUT) await downloads.screenshot({ path: join(OUT, `downloads-${scheme}.png`) });

    const options = await context.newPage();
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.getByRole('heading').first().waitFor();
    if (OUT) await options.screenshot({ path: join(OUT, `options-${scheme}.png`), fullPage: true });

    await context.close();
    await server.close();
  });
}
