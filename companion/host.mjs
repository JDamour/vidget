// Vidget companion: a native messaging host that runs yt-dlp for the extension.
// Chrome starts it when the extension connects and closes its stdin on disconnect.
// stdout carries only protocol messages, so diagnostics go to stderr.
//
// Extension -> host
//   { type: 'hello' }
//   { type: 'download', jobId, url }
//   { type: 'cancel', jobId, discard }   discard removes the partial files
// Host -> extension
//   { type: 'hello', version, ytDlp, ffmpeg }
//   { type: 'progress', jobId, stage, downloaded, total?, speed?, eta? }
//   { type: 'done', jobId, file, size }
//   { type: 'failed', jobId, message }

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const PROGRESS_MS = 250;
const JOB_ID = /^[\w-]{1,64}$/;

function loadConfig() {
  const path = process.env.VIDGET_COMPANION_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), 'config.json');
  const config = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const ytDlp = [config.ytDlp ?? 'yt-dlp'].flat();
  return { ytDlp, ffmpeg: config.ffmpeg, outDir: config.outDir ?? join(homedir(), 'Downloads') };
}

const config = loadConfig();

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

function ytDlpVersion() {
  const [command, ...prefix] = config.ytDlp;
  const result = spawnSync(command, [...prefix, '--version'], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** H.264 and AAC first, because many players cannot open VP9 or AV1 in MP4. */
function formatFor(hasFfmpeg) {
  return hasFfmpeg ? 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b' : 'b[ext=mp4]/b';
}

const runs = new Map();

function argsFor(url) {
  const [, ...prefix] = config.ytDlp;
  return [
    ...prefix,
    '--newline',
    '--no-colors',
    '--no-playlist',
    '--no-simulate',
    '--progress',
    '--progress-template',
    'download:VIDGET-PROGRESS %(progress)j',
    '--print',
    'after_move:VIDGET-FILE %(filepath)s',
    '-f',
    formatFor(!!config.ffmpeg),
    ...(config.ffmpeg ? ['--ffmpeg-location', config.ffmpeg, '--merge-output-format', 'mp4'] : []),
    '-P',
    config.outDir,
    '-o',
    '%(title).150B [%(id)s].%(ext)s',
    // Everything after this is a URL, never an option, whatever the page put in it.
    '--',
    url,
  ];
}

function stop(run) {
  if (process.platform === 'win32') {
    // yt-dlp starts ffmpeg for merges, and only a tree kill stops both.
    spawnSync('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    run.child.kill();
  }
}

function removePartials(run) {
  for (const path of run.partials) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      process.stderr.write(`vidget companion: could not remove ${path}: ${error}\n`);
    }
  }
}

function startDownload({ jobId, url }) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    send({ type: 'failed', jobId, message: 'Not a web address' });
    return;
  }
  const previous = runs.get(jobId);
  if (previous) stop(previous);

  const child = spawn(config.ytDlp[0], argsFor(url), { env, windowsHide: true });
  const run = { child, partials: new Set(), canceled: false, discard: false };
  runs.set(jobId, run);
  let file;
  let lastError;
  let finishedBytes = 0;
  let currentPart;
  let lastSent = 0;

  const onLine = (line) => {
    if (line.startsWith('VIDGET-PROGRESS ')) {
      let progress;
      try {
        progress = JSON.parse(line.slice('VIDGET-PROGRESS '.length));
      } catch {
        return;
      }
      // --print makes yt-dlp quiet, so its file names arrive only here.
      if (progress.tmpfilename) run.partials.add(progress.tmpfilename);
      if (progress.filename) run.partials.add(`${progress.filename}.ytdl`);
      // Video and audio download one after the other; their bytes add up.
      if (progress.filename !== currentPart) currentPart = progress.filename;
      const total = progress.total_bytes ?? progress.total_bytes_estimate;
      const downloaded = progress.downloaded_bytes ?? 0;
      if (progress.status === 'finished') {
        finishedBytes += total ?? downloaded;
        currentPart = undefined;
      }
      const now = Date.now();
      if (progress.status !== 'finished' && now - lastSent < PROGRESS_MS) return;
      lastSent = now;
      send({
        type: 'progress',
        jobId,
        stage: 'downloading',
        downloaded: finishedBytes + (progress.status === 'finished' ? 0 : downloaded),
        total: total === undefined ? undefined : finishedBytes + (progress.status === 'finished' ? 0 : total),
        speed: progress.speed ?? undefined,
        eta: progress.eta ?? undefined,
      });
    } else if (line.startsWith('VIDGET-FILE ')) {
      file = line.slice('VIDGET-FILE '.length).trim();
    } else if (line.startsWith('[Merger]') || line.startsWith('[VideoConvertor]')) {
      send({ type: 'progress', jobId, stage: 'merging', downloaded: finishedBytes, total: finishedBytes });
    } else if (line.startsWith('ERROR:')) {
      lastError = line.slice('ERROR:'.length).trim();
    }
  };

  for (const stream of [child.stdout, child.stderr]) {
    let buffered = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
  }

  child.on('error', (error) => {
    lastError = error.code === 'ENOENT' ? 'yt-dlp was not found. Run the companion installer again.' : String(error);
  });

  child.on('close', (code) => {
    if (runs.get(jobId) === run) runs.delete(jobId);
    if (run.canceled) {
      if (run.discard) removePartials(run);
      return;
    }
    if (code === 0 && file && existsSync(file)) {
      send({ type: 'done', jobId, file, size: statSync(file).size });
    } else {
      send({ type: 'failed', jobId, message: lastError ?? `yt-dlp stopped with code ${code}` });
    }
  });
}

function handle(message) {
  if (message?.type === 'hello') {
    send({ type: 'hello', version: VERSION, ytDlp: ytDlpVersion(), ffmpeg: !!config.ffmpeg });
  } else if (message?.type === 'download') {
    startDownload(message);
  } else if (message?.type === 'cancel') {
    const run = runs.get(message.jobId);
    if (!run) return;
    run.canceled = true;
    run.discard = !!message.discard;
    stop(run);
  }
}

let pending = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 4) {
    const size = pending.readUInt32LE(0);
    if (pending.length < 4 + size) break;
    const body = pending.subarray(4, 4 + size).toString('utf8');
    pending = pending.subarray(4 + size);
    try {
      handle(JSON.parse(body));
    } catch (error) {
      process.stderr.write(`vidget companion: ${error}\n`);
    }
  }
});

// The extension went away. Stopped downloads resume from their .part files later.
process.stdin.on('end', () => {
  for (const run of runs.values()) {
    run.canceled = true;
    stop(run);
  }
  process.exit(0);
});
