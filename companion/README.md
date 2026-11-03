# Vidget companion (proof of concept)

A small native-messaging host that lets the self-distributed Vidget build download YouTube videos through [yt-dlp](https://github.com/yt-dlp/yt-dlp). The extension never handles YouTube's streams itself. It sends the page address to this host, which runs yt-dlp and reports progress back. Store builds don't include any of this and don't request the `nativeMessaging` permission.

Only download videos you own, have permission for, or may lawfully copy. YouTube's terms forbid downloading except through YouTube's own download features.

## Requirements

- Node.js, because the host is `host.mjs`.
- yt-dlp on `PATH`, or its path passed to the installer.
- ffmpeg, for HD. Without it, yt-dlp can only fetch single-file formats, which on YouTube usually means 360p.

On Windows, `winget install yt-dlp.yt-dlp` installs yt-dlp and ffmpeg. winget puts ffmpeg on `PATH` without a link next to yt-dlp, so a terminal opened before the install won't find it; open a new one, or pass `--ffmpeg`. Recent yt-dlp releases also need a JavaScript runtime such as Deno to download from YouTube; see yt-dlp's own installation notes.

The extension id of an unpacked build depends only on its folder, so it stays the same across rebuilds. Run the installer again if you load the build from another folder.

## Set up

1. Build and load the companion build:

   ```bash
   npx -y pnpm@10 build:companion
   ```

   Then open `chrome://extensions`, turn on developer mode, choose **Load unpacked** and pick `.output-companion/chrome-mv3`. Copy the extension id shown under its name.

2. Register the host for Chrome and Edge:

   ```bash
   node companion/install.mjs <extension-id>
   ```

   Options: `--yt-dlp <path>`, `--ffmpeg <path>`, and `--out <folder>`, which defaults to your Downloads folder. On Windows this writes two keys under `HKCU\Software\…\NativeMessagingHosts`. On macOS and Linux it writes a manifest into each browser's `NativeMessagingHosts` folder. Run it again after moving the project or Node.

3. Open a YouTube video, then open Vidget and choose **Download**.

To remove everything the installer wrote:

```bash
node companion/install.mjs --uninstall
```

## How it works

- The `youtube` extractor, present only when `__FEATURE_COMPANION__` is set, offers a variant of kind `external` whose URL is the watch page.
- The job manager hands `external` jobs to `platform.companionRun`, which posts `{ type: 'download', jobId, url }` on a native port (`src/companion/client.ts`).
- `host.mjs` runs yt-dlp with `--` before the URL, so nothing in a page address can become an option. The format preference is H.264 and AAC first, for the same reason TikTok's default is H.264.
- Progress, `done` (with the file yt-dlp wrote) and `failed` (with yt-dlp's own error) come back as jobs updates. Hover a failed job to see the error.
- Pause stops yt-dlp but keeps its `.part` files, so Resume continues the download. Cancel also deletes them.
- An open native port keeps the service worker awake during a download. The port closes once no companion job is running, which also ends the host.

## Limits of this proof of concept

- **Node required:** the host needs Node.js. A real release would ship a single executable.
- **No in-browser setup:** the host is registered from a terminal, and nothing guides users through it inside the extension.
- **No "show in folder":** the file is saved by yt-dlp rather than the browser, so the browser's downloads list doesn't show it.
- **No quality choice:** the popup offers one entry, yt-dlp's best match for the format preference.
- **Firefox:** not set up. It needs its own manifest format and registry location.
- **Live streams and playlists:** not handled. Playlists are refused with `--no-playlist`.
- **yt-dlp updates:** YouTube changes often, and yt-dlp needs regular updates (`yt-dlp -U`) to keep working.
