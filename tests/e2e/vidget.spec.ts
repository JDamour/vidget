import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test as base,
  type Worker,
} from '@playwright/test';
import { type FixtureServer, startServer } from './server';

const EXTENSION = join(import.meta.dirname, '..', '..', '.output-e2e', 'chrome-mv3');

interface Fixtures {
  server: FixtureServer;
  context: BrowserContext;
  extensionId: string;
  worker: Worker;
}

const test = base.extend<Fixtures>({
  server: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.close();
  },
  context: async ({}, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'vidget-e2e-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [
        `--disable-extensions-except=${EXTENSION}`,
        `--load-extension=${EXTENSION}`,
        // Lets X tests run on the real hostnames, against the fixture server.
        '--host-resolver-rules=MAP x.com 127.0.0.1, MAP video.twimg.com 127.0.0.1, MAP scontent.cdninstagram.com 127.0.0.1',
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },
  worker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    // A fresh profile registers its content scripts a moment after startup.
    await expect
      .poll(() =>
        worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length),
      )
      .toBe(2);
    await use(worker);
  },
  extensionId: async ({ worker }, use) => {
    await use(new URL(worker.url()).hostname);
  },
});

async function tabIdOf(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.startsWith(target))?.id ?? -1;
  }, url);
}

async function openPopup(context: BrowserContext, extensionId: string, tabId: number) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  return popup;
}

/** Open a page, then the popup pointed at it, waiting for detection to finish. */
async function detect(
  context: BrowserContext,
  worker: Worker,
  extensionId: string,
  url: string,
) {
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await tabIdOf(worker, url);
  expect(tabId).toBeGreaterThan(0);
  // The popup opens as a tab here, which would background and throttle the page.
  await expect
    .poll(() =>
      worker.evaluate(async (id) => {
        const key = `tab:${id}`;
        const state = (await chrome.storage.session.get(key))[key] as { hints?: unknown } | undefined;
        return !!state?.hints;
      }, tabId),
    )
    .toBe(true);
  const popup = await openPopup(context, extensionId, tabId);
  return { page, popup, tabId };
}

/** Wait for the single job to finish, returning a path to the saved file. */
async function waitForFile(worker: Worker, popup: Page): Promise<string> {
  await expect(popup.getByTestId('job').first()).toHaveAttribute('data-status', /done|failed/, {
    timeout: 60_000,
  });
  const status = await popup.getByTestId('job').first().getAttribute('data-status');
  if (status === 'failed') {
    throw new Error(await popup.getByTestId('job').first().innerText());
  }
  const dir = mkdtempSync(join(tmpdir(), 'vidget-out-'));
  const [item] = await worker.evaluate(async () => {
    const [latest] = await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 });
    return [{ filename: latest!.filename, size: latest!.fileSize, state: latest!.state }];
  });
  expect(item!.state).toBe('complete');
  const target = join(dir, 'output.mp4');
  copyFileSync(item!.filename, target);
  return target;
}

interface Probe {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  format: { duration?: string; start_time?: string; format_name: string };
}

function probe(file: string): Probe {
  const output = execFileSync(ffprobeInstaller.path, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]);
  return JSON.parse(output.toString()) as Probe;
}

/** Decode every frame: a container can look right and still be broken inside. */
function decodeErrors(file: string): string {
  const result = spawnSync(ffmpegInstaller.path, ['-v', 'error', '-i', file, '-f', 'null', '-']);
  return result.stderr.toString();
}

function expectPlayableClip(file: string, height = 360) {
  const info = probe(file);
  const video = info.streams.find((stream) => stream.codec_type === 'video');
  const audio = info.streams.find((stream) => stream.codec_type === 'audio');
  expect(video?.codec_name).toBe('h264');
  expect(video?.height).toBe(height);
  expect(audio?.codec_name).toBe('aac');
  expect(decodeErrors(file)).toBe('');
  const frames = spawnSync(ffprobeInstaller.path, [
    '-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file,
  ]);
  // 12 s at 25 fps.
  expect(Number(frames.stdout.toString().trim().replace(/,/g, ''))).toBeGreaterThanOrEqual(295);
}

const pageUrl = (server: FixtureServer, name: string) =>
  `http://localhost:${server.port}/pages/${name}`;
const streamUrl = (server: FixtureServer, src: string, via = 'fetch') =>
  `${pageUrl(server, 'stream.html')}?via=${via}&src=${encodeURIComponent(
    `http://127.0.0.1:${server.port}${src}`,
  )}`;

test('registers both content scripts when access is granted', async ({ worker }) => {
  await expect
    .poll(() =>
      worker.evaluate(async () =>
        (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id).sort(),
      ),
    )
    .toEqual(['vidget-detector', 'vidget-probe']);
});

/** A page opened with no content scripts, as it is before access is granted. */
async function pageWithoutScripts(context: BrowserContext, worker: Worker, url: string) {
  await worker.evaluate(() => chrome.scripting.unregisterContentScripts());
  const page = await context.newPage();
  await page.goto(url);
  const tabId = await tabIdOf(worker, url);
  // preload=none means no request is made, so nothing has reported this page yet.
  await page.waitForTimeout(800);
  return { page, tabId };
}

test('a grant scans pages that are already open, with no popup and no reload', async ({ context, worker, extensionId, server }) => {
  const url = pageUrl(server, 'shadow.html');
  const { tabId } = await pageWithoutScripts(context, worker, url);
  const count = () =>
    worker.evaluate(async (id) => {
      const key = `tab:${id}`;
      const state = (await chrome.storage.session.get(key))[key] as { items?: unknown[] } | undefined;
      return state?.items?.length ?? 0;
    }, tabId);
  expect(await count()).toBe(0);

  // Chrome closes the popup for its prompt, so only the worker sees the grant.
  await worker.evaluate(() => {
    (chrome.permissions.onAdded as unknown as { dispatch(...args: unknown[]): void }).dispatch({
      origins: ['*://*/*'],
    });
  });
  await expect.poll(count, { timeout: 8000 }).toBe(2);
  expect(
    await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length),
  ).toBe(2);

  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('media')).toHaveCount(2);
});

test('opening the popup scans a page with no detector', async ({ context, worker, extensionId, server }) => {
  const { tabId } = await pageWithoutScripts(context, worker, pageUrl(server, 'shadow.html'));
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('media')).toHaveCount(2, { timeout: 8000 });
});

test('explains a blocked site instead of asking the user to press play', async ({ context, worker, extensionId }) => {
  await context.route('https://www.youtube.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Stand-in</title>' }),
  );
  const url = 'https://www.youtube.com/watch?v=x';
  const page = await context.newPage();
  await page.goto(url);
  const popup = await openPopup(context, extensionId, await tabIdOf(worker, url));
  await expect(popup.getByTestId('empty')).toHaveText("Vidget can't download from this site.");
});

for (const [kind, src] of [
  ['muxed', '/hls-ts/high/spliced.m3u8'],
  ['separate tracks', '/hls-demux/spliced.m3u8'],
] as const) {
  test(`HLS: a spliced section plays on from the last one (${kind})`, async ({ context, worker, extensionId, server }) => {
    const { popup } = await detect(context, worker, extensionId, streamUrl(server, src));
    await popup.getByTestId('download').click();
    const file = await waitForFile(worker, popup);
    // Measured from the first frame: MPEG-TS clocks do not start at zero.
    const { duration, start_time: start } = probe(file).format;
    expect(Number(duration) - Number(start)).toBeGreaterThan(15.5);
    expect(Number(duration) - Number(start)).toBeLessThan(16.5);
    // Time going backwards at the join shows up here, though each frame decodes.
    expect(decodeErrors(file)).toBe('');
  });
}

test('Instagram: merges a video streamed as two tracks of byte ranges',async ({ context, worker, extensionId, server }) => {
  const piece = (name: string, tag: string, start: number, end: number) => {
    const efg = btoa(JSON.stringify({ vencode_tag: tag, xpv_asset_id: 1 }));
    return `http://scontent.cdninstagram.com:${server.port}/tracks/${name}.mp4?efg=${encodeURIComponent(efg)}&bytestart=${start}&byteend=${end}`;
  };
  server.page('/reels', '<!doctype html><title>Reels</title>');
  const url = `http://localhost:${server.port}/reels`;
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(
    (urls) => Promise.all(urls.map((target) => fetch(target).then((response) => response.arrayBuffer()))),
    [
      piece('video', 'ig-xpvds.clips.igwww-C3.dash_baseline_1_v1', 0, 99),
      piece('video', 'ig-xpvds.clips.igwww-C3.dash_baseline_1_v1', 100, 199),
      piece('audio', 'ig-xpvds.clips.igwww-C3.dash_ln_heaac_vbr3_audio', 0, 99),
    ],
  );
  const popup = await openPopup(context, extensionId, await tabIdOf(worker, url));
  await expect(popup.getByTestId('media')).toHaveCount(1);
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

/** Open a stand-in x.com page, built like the real one: no test ids, a status link. */
async function openX(context: BrowserContext, worker: Worker, server: FixtureServer, html: string) {
  server.page('/home', html);
  const url = `http://x.com:${server.port}/home`;
  const page = await context.newPage();
  await page.goto(url);
  return { page, tabId: await tabIdOf(worker, url) };
}

// Copies what real X pages do: no test ids, no <time>, a date inside the status
// link, and an inline script beside it whose source innerText can pick up.
const xPost = (handle: string, text: string, media: string) => `
  <article>
    <a href="/${handle}">Name</a><div>${handle} Name</div>
    <a href="/${handle}"><div>@${handle}</div></a>
    <a href="/${handle}/status/1">30 Oct</a>
    <script>window.__xClientTextFormatters?.run('x');</script>
    <div>${text}</div>
    ${media}
    <div>676</div><div>24k</div>
  </article>`;
const xVideo = (poster: string, attrs = '') =>
  `<video width="400" height="225" poster="${poster}" ${attrs}></video>`;
const xPage = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

test('X: names a feed video after its own post, not the page', async ({ context, worker, extensionId, server }) => {
  const stream = `http://video.twimg.com:${server.port}/amplify_video/222/hls-ts/master.m3u8`;
  const { page, tabId } = await openX(
    context,
    worker,
    server,
    xPage(
      '(3) Home / X',
      xPost('first', 'The wrong post', xVideo('http://x.com/amplify_video_thumb/111/img/a.jpg')) +
        xPost('second', 'A storm over the lake', xVideo('http://x.com/amplify_video_thumb/222/img/b.jpg')),
    ),
  );
  await page.evaluate((url) => fetch(url), stream);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('media')).toContainText('@second - A storm over the lake');
  await popup.getByTestId('download').click();
  await expect(popup.getByTestId('job').first()).toHaveAttribute('data-status', 'done');
  const filename = await worker.evaluate(async () => {
    const jobs = await new Promise<{ filename: string }[]>((resolve) => {
      const open = indexedDB.open('vidget-db');
      open.onsuccess = () => {
        const all = open.result.transaction('jobs').objectStore('jobs').getAll();
        all.onsuccess = () => resolve(all.result);
      };
    });
    return jobs[0]!.filename;
  });
  expect(filename).toBe('@second - A storm over the lake (360p).mp4');
});

test('X: a post page keeps the opening line of the post', async ({ context, worker, extensionId, server }) => {
  const article = `
    <article>
      <a href="/natgeo">Nat Geo</a><div>Nat Geo</div>
      <a href="/natgeo"><div>@natgeo</div></a>
      <div>Even a moment on Everest.</div>
      <div>Now in theaters.</div>
      ${xVideo('http://x.com/amplify_video_thumb/555/img/a.jpg')}
      <a href="/natgeo/status/9">3:00 PM</a>
      <div>51</div>
    </article>`;
  const { page, tabId } = await openX(context, worker, server, xPage('Nat Geo on X / X', article));
  await page.evaluate((url) => fetch(url), `http://video.twimg.com:${server.port}/amplify_video/555/hls-ts/master.m3u8`);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('media')).toContainText('@natgeo - Even a moment on Everest. Now in theaters.');
});

test('X: a poster with no media id falls back to the post that is playing', async ({ context, worker, extensionId, server }) => {
  const { page, tabId } = await openX(
    context,
    worker,
    server,
    xPage(
      'Home / X',
      xPost('idle', 'Not playing', xVideo('http://x.com/media/AAA.jpg')) +
        xPost(
          'player',
          'Playing now',
          xVideo('http://x.com/media/BBB.jpg', `autoplay muted loop src="/direct/play.webm"`),
        ),
    ),
  );
  await page.waitForFunction(() => !document.querySelectorAll('video')[1]!.paused);
  await page.evaluate((url) => fetch(url), `http://video.twimg.com:${server.port}/hls-ts/master.m3u8`);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('media').filter({ hasText: '@player - Playing now' })).not.toHaveCount(0);
});

test('X: stays neutral rather than guess between two playing videos', async ({ context, worker, extensionId, server }) => {
  const play = 'autoplay muted loop src="/direct/play.webm?';
  const { page, tabId } = await openX(
    context,
    worker,
    server,
    xPage(
      'Home / X',
      xPost('one', 'First', xVideo('http://x.com/media/AAA.jpg', `${play}1"`)) +
        xPost('two', 'Second', xVideo('http://x.com/media/BBB.jpg', `${play}2"`)),
    ),
  );
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every((video) => !video.paused));
  await page.evaluate((url) => fetch(url), `http://video.twimg.com:${server.port}/amplify_video/333/hls-ts/master.m3u8`);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('media').filter({ hasText: 'X video 333' })).toHaveCount(1);
});

test('X: a post page takes its title from the page', async ({ context, worker, extensionId, server }) => {
  const { page, tabId } = await openX(context, worker, server, xPage('Nat Geo on X: "Everest at dawn" / X', ''));
  await page.evaluate((url) => fetch(url), `http://video.twimg.com:${server.port}/hls-ts/master.m3u8`);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('media')).toContainText('Nat Geo - Everest at dawn');
});

test('shows the empty state on a page with no video', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, pageUrl(server, 'none.html'));
  await expect(popup.getByTestId('empty')).toBeVisible();
});

test('DOM scan reaches shadow roots and iframes', async ({ context, worker, extensionId, server }) => {
  // preload=none means no request is made, so only the DOM scan can find these.
  const { popup } = await detect(context, worker, extensionId, pageUrl(server, 'shadow.html'));
  await expect(popup.getByTestId('media')).toHaveCount(2);
});

test('hides clips under the minimum size', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, pageUrl(server, 'tiny.html'));
  await expect(popup.getByTestId('empty')).toBeVisible();
});

test('direct file: detects, badges and downloads', async ({ context, worker, extensionId, server }) => {
  const { popup, tabId } = await detect(context, worker, extensionId, pageUrl(server, 'direct.html'));
  await expect(popup.getByTestId('media')).toHaveCount(1);
  await expect(popup.getByTestId('media')).toContainText('Direct clip');
  await expect
    .poll(() => worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId))
    .toBe('1');
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('direct file: sends the page Referer the CDN demands', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, pageUrl(server, 'gated.html'));
  await expect(popup.getByTestId('media')).toHaveCount(1);
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('HLS MPEG-TS: lists qualities and remuxes the chosen one', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-ts/master.m3u8'));
  const select = popup.getByRole('combobox');
  await expect(select.locator('option')).toHaveText(['360p', '180p']);
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('HLS: the lower quality really is the lower one', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-ts/master.m3u8'));
  await popup.getByRole('combobox').selectOption({ label: '180p' });
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup), 180);
});

test('HLS: found through XHR too', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-ts/master.m3u8', 'xhr'));
  await expect(popup.getByTestId('media')).toHaveCount(1);
});

test('HLS AES-128: decrypts clear-key segments', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-aes/index.m3u8'));
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('HLS fMP4: appends CMAF segments', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-fmp4/index.m3u8'));
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('HLS demuxed: merges separate audio and video', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-demux/master.m3u8'));
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('DASH: merges separate fMP4 audio and video', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/dash/manifest.mpd'));
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('retries a flaky segment and recovers an expired one', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-ts/master.m3u8'));
  server.failNext(/high\/index2\.ts/, 503, 2);
  server.failNext(/high\/index4\.ts/, 403, 1);
  await popup.getByTestId('download').click();
  expectPlayableClip(await waitForFile(worker, popup));
});

test('reports a plain reason when segments are gone for good', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-ts/master.m3u8'));
  server.failNext(/high\/index3\.ts/, 404, 100);
  await popup.getByTestId('download').click();
  const job = popup.getByTestId('job').first();
  await expect(job).toHaveAttribute('data-status', 'failed', { timeout: 30_000 });
  await expect(job).toContainText('expired');
});

test('pause and resume continue from the completed segments', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-ts/master.m3u8'));
  await popup.evaluate(() => {
    void chrome.storage.local.set({ settings: { segmentWorkers: 1, rightsAccepted: true } });
  });
  // Hold one segment back with retries so the job is still running when paused.
  server.failNext(/high\/index3\.ts/, 503, 3);
  await popup.getByTestId('download').click();
  const job = popup.getByTestId('job').first();
  await job.getByRole('button', { name: 'Pause' }).click();
  await expect(job).toHaveAttribute('data-status', 'paused');
  const fetched = server.requests.filter((path) => /high\/index\d+\.ts/.test(path));
  server.requests.length = 0;
  await job.getByRole('button', { name: 'Resume' }).click();
  expectPlayableClip(await waitForFile(worker, popup));
  const refetched = server.requests.filter((path) => /high\/index\d+\.ts/.test(path));
  const completedFirstTime = new Set(fetched.slice(0, Math.max(0, fetched.length - 4)));
  for (const path of completedFirstTime) expect(refetched).not.toContain(path);
});

test('cancel removes the job and its working folder', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/hls-ts/master.m3u8'));
  server.failNext(/high\/index1\.ts/, 503, 3);
  await popup.getByTestId('download').click();
  const job = popup.getByTestId('job').first();
  await job.getByRole('button', { name: 'Cancel or remove' }).click();
  await expect(popup.getByTestId('job')).toHaveCount(0);
  const left = await popup.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const jobs = await root.getDirectoryHandle('jobs', { create: true });
    const names: string[] = [];
    for await (const name of (jobs as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    return names;
  });
  expect(left).toEqual([]);
});

test('DRM: SAMPLE-AES HLS is labeled and never offered', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/drm/sample-aes.m3u8'));
  await expect(popup.getByTestId('protected')).toBeVisible();
  await expect(popup.getByTestId('download')).toHaveCount(0);
});

test('DRM: ContentProtection DASH is labeled and never offered', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, streamUrl(server, '/dash/drm.mpd'));
  await expect(popup.getByTestId('protected')).toBeVisible();
  await expect(popup.getByTestId('download')).toHaveCount(0);
});

test('DRM: EME keys on an element protect the page', async ({ context, worker, extensionId, server }) => {
  const { popup, tabId } = await detect(context, worker, extensionId, pageUrl(server, 'eme.html'));
  await expect(popup.getByTestId('protected')).toBeVisible();
  await expect(popup.getByTestId('download')).toHaveCount(0);
  expect(await worker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)).toBe('');
});

test('DRM: a capability check alone does not', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, `${pageUrl(server, 'eme.html')}?mode=probe`);
  await expect(popup.getByTestId('download')).toBeVisible();
  await expect(popup.getByTestId('protected')).toHaveCount(0);
});

test('the service worker refuses a protected item outright', async ({ context, worker, extensionId, server }) => {
  const { popup, tabId } = await detect(context, worker, extensionId, pageUrl(server, 'eme.html'));
  await expect(popup.getByTestId('protected')).toBeVisible();
  const reply = await popup.evaluate(async (id) => {
    const view = (await chrome.runtime.sendMessage({ type: 'tab:get', tabId: id })) as {
      value: { items: { id: string }[] };
    };
    return chrome.runtime.sendMessage({ type: 'job:start', tabId: id, mediaId: view.value.items[0]!.id });
  }, tabId);
  expect(reply).toHaveProperty('error');
  await expect(popup.getByTestId('job')).toHaveCount(0);
});

test('the in-page button opens the quality menu and starts a job', async ({ context, worker, extensionId, server }) => {
  const { page, tabId } = await detect(context, worker, extensionId, pageUrl(server, 'inpage.html'));
  await page.bringToFront();
  await page.waitForFunction(() => !(document.getElementById('main') as HTMLVideoElement).paused);
  const box = await page.evaluate(() => {
    const { top, right } = document.getElementById('main')!.getBoundingClientRect();
    return { top, right };
  });
  await page.mouse.move(box.right - 200, box.top + 100);
  await page.waitForTimeout(200);
  await page.mouse.move(box.right - 190, box.top + 110);
  const pillX = box.right - 40;
  const pillY = box.top + 20;
  await expect
    .poll(() =>
      page.evaluate(
        ([x, y]) => document.elementFromPoint(x!, y!)?.tagName,
        [pillX, pillY],
      ),
    )
    .toBe('DIV');
  await page.mouse.click(pillX, pillY);
  await page.waitForTimeout(300);
  await page.mouse.click(pillX, pillY + 42);
  const popup = await openPopup(context, extensionId, tabId);
  await expect(popup.getByTestId('job')).toHaveCount(1);
  const info = probe(await waitForFile(worker, popup));
  expect(info.streams[0]?.codec_name).toBe('vp8');
});

test('the context menu downloads the video under the cursor', async ({ context, worker, extensionId, server }) => {
  const url = pageUrl(server, 'direct.html');
  const { popup, tabId } = await detect(context, worker, extensionId, url);
  await worker.evaluate(
    ([id, page, src]) => {
      (chrome.contextMenus.onClicked as unknown as { dispatch(...args: unknown[]): void }).dispatch(
        { menuItemId: 'vidget-download', pageUrl: page, srcUrl: src },
        { id, title: 'Direct page' },
      );
    },
    [tabId, url, `http://localhost:${server.port}/direct/clip.mp4`] as const,
  );
  expectPlayableClip(await waitForFile(worker, popup));
});

test('history records finished downloads', async ({ context, worker, extensionId, server }) => {
  const { popup } = await detect(context, worker, extensionId, pageUrl(server, 'direct.html'));
  await popup.getByTestId('download').click();
  await waitForFile(worker, popup);
  const downloads = await context.newPage();
  await downloads.goto(`chrome-extension://${extensionId}/downloads.html`);
  await expect(downloads.getByTestId('history-row')).toHaveCount(1);
  await expect(downloads.getByTestId('history-row')).toContainText('Direct clip');
});
