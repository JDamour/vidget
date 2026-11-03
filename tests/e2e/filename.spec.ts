import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { RawChromium } from './raw-chromium';
import { type FixtureServer, startServer } from './server';

const root = join(import.meta.dirname, '..', '..');
const VIDGET = join(root, '.output-e2e', 'chrome-mv3');
const LISTENER = join(root, 'tests', 'fixtures', 'namer-extension');

interface Job {
  status: string;
  error?: string;
  filename: string;
}

/** Start the first detected item as a user would. */
const DOWNLOAD_FIRST_ITEM = `(async () => {
  const send = async (message) => (await chrome.runtime.sendMessage(message)).value;
  const [tab] = await chrome.tabs.query({ url: '*://localhost/pages/*' });
  for (let attempt = 0; attempt < 100; attempt++) {
    const view = await send({ type: 'tab:get', tabId: tab.id });
    const item = view?.hints && view.items.find((entry) => entry.status === 'ready');
    if (item) return send({ type: 'job:start', tabId: tab.id, mediaId: item.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const view = await send({ type: 'tab:get', tabId: tab.id });
  throw new Error('Nothing detected: ' + JSON.stringify({ tab: tab?.url, hints: !!view?.hints, items: view?.items.map((entry) => entry.status) }));
})()`;

const WAIT_FOR_JOB = `(async () => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { value } = await chrome.runtime.sendMessage({ type: 'jobs:list' });
    const job = value[0];
    if (job && ['done', 'failed'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { value } = await chrome.runtime.sendMessage({ type: 'jobs:list' });
  const downloads = await chrome.downloads.search({});
  throw new Error('Job never finished: ' + JSON.stringify({
    jobs: value.map(({ status, filename, downloadId, viaWorker, error }) => ({ status, filename, downloadId, viaWorker, error })),
    downloads: downloads.map(({ state, paused, filename, error, bytesReceived, totalBytes }) => ({ state, paused, filename, error, bytesReceived, totalBytes })),
  }));
})()`;

async function save(browser: RawChromium, url: string) {
  const id = await browser.extensionId('Vidget');
  await browser.open(url);
  const extensionPage = await browser.open(`chrome-extension://${id}/downloads.html`);
  await extensionPage(`new Promise((resolve) => setTimeout(resolve, 1500))`);
  await extensionPage(DOWNLOAD_FIRST_ITEM);
  const job = await extensionPage<Job>(WAIT_FOR_JOB);
  expect(job.error).toBeUndefined();
}

// Chrome gives the last-installed listener the final say, so order decides who wins.
const SETUPS = [
  { label: 'alone', extensions: [VIDGET], directName: /^Direct clip \(Original\)\.mp4$/ },
  {
    label: 'installed after an extension that watches downloads',
    extensions: [LISTENER, VIDGET],
    directName: /^Direct clip \(Original\)\.mp4$/,
  },
  {
    label: 'installed before an extension that watches downloads',
    extensions: [VIDGET, LISTENER],
    // Outranked, so it takes the name in its URL. If Chrome stalled the download,
    // the worker saved it instead, and that route keeps the full name.
    directName: /^(clip|Direct clip \(Original\))\.mp4$/,
  },
];

for (const { label, extensions, directName } of SETUPS) {
  test.describe(`saved filenames, ${label}`, () => {
    let server: FixtureServer;
    let browser: RawChromium;

    test.beforeEach(async () => {
      server = await startServer();
      browser = await RawChromium.launch(extensions);
    });
    test.afterEach(async () => {
      await browser.close();
      await server.close();
    });

    test('a direct file gets a real name', async () => {
      await save(browser, `http://localhost:${server.port}/pages/direct.html`);
      const [name] = readdirSync(browser.downloads);
      expect(name).toMatch(directName);
    });

    test('a merged stream always keeps its name', async () => {
      const src = encodeURIComponent(`http://127.0.0.1:${server.port}/hls-ts/master.m3u8`);
      await save(browser, `http://localhost:${server.port}/pages/stream.html?src=${src}`);
      expect(readdirSync(browser.downloads)).toEqual(['Stream page (360p).mp4']);
    });
  });
}
