// Registers the Vidget companion with Chrome and Edge for the current user.
//
//   node companion/install.mjs <extension-id> [--yt-dlp <path>] [--ffmpeg <path>] [--out <folder>]
//   node companion/install.mjs --uninstall
//
// The extension id is shown on chrome://extensions with developer mode on.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_NAME = 'com.vidget.companion';
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const uninstall = args.includes('--uninstall');
const extensionId = args.find((arg) => /^[a-p]{32}$/.test(arg));

const windows = process.platform === 'win32';
const registryKeys = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
];
const manifestDirs =
  process.platform === 'darwin'
    ? ['Google/Chrome', 'Microsoft Edge', 'Chromium'].map((browser) =>
        join(homedir(), 'Library', 'Application Support', browser, 'NativeMessagingHosts'),
      )
    : ['google-chrome', 'microsoft-edge', 'chromium'].map((browser) =>
        join(homedir(), '.config', browser, 'NativeMessagingHosts'),
      );
const manifestPath = join(here, `${HOST_NAME}.json`);

function which(command) {
  const result = spawnSync(windows ? 'where' : 'which', [command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() : undefined;
}

if (uninstall) {
  if (windows) {
    for (const key of registryKeys) spawnSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
  } else {
    for (const dir of manifestDirs) rmSync(join(dir, `${HOST_NAME}.json`), { force: true });
  }
  for (const file of [manifestPath, join(here, 'config.json'), join(here, 'host.cmd'), join(here, 'host.sh')]) {
    rmSync(file, { force: true });
  }
  console.log('Vidget companion removed.');
  process.exit(0);
}

if (!extensionId) {
  console.error('Usage: node companion/install.mjs <extension-id> [--yt-dlp <path>] [--ffmpeg <path>] [--out <folder>]');
  console.error('The id is the 32 letters shown for Vidget on chrome://extensions.');
  process.exit(1);
}

const ytDlp = option('--yt-dlp') ?? which('yt-dlp');
const ffmpeg = option('--ffmpeg') ?? which('ffmpeg');
const outDir = resolve(option('--out') ?? join(homedir(), 'Downloads'));
writeFileSync(
  join(here, 'config.json'),
  `${JSON.stringify({ ytDlp: ytDlp ?? 'yt-dlp', ffmpeg, outDir }, null, 2)}\n`,
);

// Chrome runs the host directly, so a small launcher points it at this Node.
const hostScript = join(here, 'host.mjs');
let launcher;
if (windows) {
  launcher = join(here, 'host.cmd');
  writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${hostScript}" %*\r\n`);
} else {
  launcher = join(here, 'host.sh');
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${hostScript}" "$@"\n`);
  chmodSync(launcher, 0o755);
}

const manifest = {
  name: HOST_NAME,
  description: 'Vidget companion: runs yt-dlp for the Vidget extension',
  path: launcher,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

if (windows) {
  for (const key of registryKeys) {
    const result = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { encoding: 'utf8' });
    if (result.status !== 0) console.error(`Could not write ${key}: ${result.stderr}`);
  }
} else {
  for (const dir of manifestDirs) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

console.log(`Vidget companion registered for extension ${extensionId}.`);
console.log(`Downloads go to ${outDir}.`);
if (!ytDlp) console.warn('yt-dlp was not found on PATH. Install it, or pass --yt-dlp <path>, then run this again.');
if (!ffmpeg) console.warn('ffmpeg was not found, so only single-file formats (often 360p) are available. Pass --ffmpeg <path> for HD.');
if (!existsSync(hostScript)) console.warn(`Missing ${hostScript}.`);
