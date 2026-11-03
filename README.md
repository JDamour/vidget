# Vidget

A Manifest V3 browser extension that detects non-DRM video on a page and saves it as one playable file. It handles direct files, HLS, DASH and clear-key AES-128 HLS, and it runs entirely on the user's device. DRM-protected media is labeled and never offered for download.

## Develop

Uses pnpm. If it isn't installed, put `npx -y pnpm@10` in front of these commands.

```bash
pnpm install
pnpm dev            # Chrome with live reload
pnpm build          # production build in .output/chrome-mv3
pnpm build:firefox  # .output/firefox-mv3
pnpm zip            # store package
```

To load a build by hand, open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick `.output/chrome-mv3`.

## Test

```bash
pnpm typecheck
pnpm test           # unit tests
pnpm exec playwright install chromium   # once
pnpm e2e            # builds, generates fixtures, runs the browser suite
```

The E2E suite drives the extension in Chromium against a local CDN stand-in, then checks each saved file with ffprobe and decodes every frame with ffmpeg. `VIDGET_E2E=1` builds into `.output-e2e` with host access granted at install, because Playwright cannot click the permission prompt.

## Layout

| Path | Contents |
| --- | --- |
| `entrypoints/background.ts` | Service worker: wires detection, the queue, badge and context menu |
| `entrypoints/detector.content.ts`, `probe.content.ts` | DOM scan and in-page button; main-world fetch, XHR and EME hooks |
| `entrypoints/offscreen/` | Heavy worker host: segment fetch, decrypt, assemble |
| `entrypoints/popup/`, `downloads/`, `options/` | UI |
| `src/detect/` | Classification, per-tab registry, deduplication |
| `src/media/` | HLS, DASH, AES-128, MPEG-TS remux, streaming fMP4 merge |
| `src/queue/` | Job state machine, scheduler, Referer rules, `HeavyWorker` |
| `src/extractors/` | One file per site, plus the registry |
| `src/storage/` | IndexedDB and OPFS |

## Build flags

| Variable | Effect |
| --- | --- |
| `FEATURE_YOUTUBE=true` | Allows YouTube hosts. Off for every store build. |
| `WXT_REMOTE_CONFIG_URL`, `WXT_REMOTE_CONFIG_KEY` | Signed blocklist location, and its base64 raw P-256 public key. With neither set, the extension makes no network calls of its own. |

## Titles on X

X has no extractor yet, because its posts load through a logged-in API. Instead, `src/detect/x.ts` reads the page. X's markup has no test ids and no `<time>` elements, so it uses only the status link and the visible text. In order of preference, a title comes from:

1. The post whose poster has the same media ID as the stream.
2. The post whose video is playing when the stream appears, if exactly one is. Many posters are plain images with no ID.
3. The page title, on a post page.
4. `X video <id>`.

## Facebook, Instagram and TikTok

Their extractors read the inline JSON of the open page, so they need no API calls. These sites navigate without reloading and keep their first page's data, so each extractor checks that the data belongs to the current video. If it doesn't, the page is fetched again, but only when the popup opens, which avoids one fetch per scrolled video.

Feeds have no such address, so they rely on generic detection. Facebook and Instagram stream separate video and audio files, requesting each piece with `bytestart` and `byteend` in the query. `src/detect/meta.ts` drops those two parameters to get the whole file, and pairs the tracks by the asset id in the `efg` parameter. A variant with a `direct` kind and an `audioUrl` is two whole files for the worker to merge.

TikTok's feed shares one address and one page title for every video. The probe passes TikTok's own feed responses (`/api/…/item_list/`) to the detector. These name every file each post may stream, so a file the player fetched is matched to its post by the file id in its path. The rest of a TikTok video URL is a signature that changes between requests for the same file.

The extractors offer files that already hold both tracks. On Facebook and Instagram, these may be below the highest quality the player streams. TikTok's default is its best H.264 encoding, because many players can't open its higher-resolution H.265 files, which stay selectable.

## YouTube companion build

Store builds never offer YouTube. `pnpm build:companion` makes a self-distributed build in `.output-companion/` that hands YouTube pages to a local yt-dlp through native messaging. It is the only build that requests `nativeMessaging`. See [companion/README.md](companion/README.md) for setup and limits.

## Where this differs from the spec

- **fMP4 merging is our own code, not `mp4box.js`.** `src/media/boxes.ts` streams box by box from disk, so memory stays flat with no 2 GB ceiling and no dependency.
- **`ffmpeg.wasm` is not bundled.** The published `@ffmpeg/core` includes x264 and x265, which would force GPL. WebM video + WebM audio pairs therefore fail with a clear reason, and fMP4 variants are preferred when a manifest offers both.
- **Host access is one grant for all sites, requested on first use,** rather than per site. Video usually comes from a CDN on another host, and both `webRequest` and cross-origin fetches need access to that host too.
- **`requestMediaKeySystemAccess` is not treated as DRM.** Many sites call it just to test capabilities. Vidget flags `setMediaKeys` and `generateRequest`, plus manifest signaling and CENC boxes in init segments.
- **Referer rules cover worker fetches only.** `chrome.downloads` traffic is invisible to `declarativeNetRequest`, so a direct file refused with a 403 is fetched again by the worker.
- **Merged files are saved through `<a download>`, not `chrome.downloads.download`.** Chrome lets the most recently installed extension that listens to `onDeterminingFilename` decide every download's name, even if it suggests nothing, which turns a blob URL into a bare UUID. A link keeps its name. Direct files can't use one, so they fall back to the name in their URL when outranked. Site subfolders still go through the API, because `a.download` cannot hold a path.
- **A direct download that hasn't started after 5 seconds moves to the worker.** `downloads.download()` sometimes stalled in headless Chromium with no request in the network log. The cause is unknown and hasn't been seen in a normal browser, but the job would otherwise wait forever.
- **Filename tests run without Playwright's download handling.** It renames every download, so `tests/e2e/filename.spec.ts` drives Chromium over plain CDP.
- **Segment fetches run as async workers on the offscreen page,** not in Web Workers: network and WebCrypto are already off the main thread. Long MPEG-TS remuxes do run on that page's main thread.
