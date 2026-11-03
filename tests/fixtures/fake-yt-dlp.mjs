// Stands in for yt-dlp in the companion tests: prints what the host parses, writes files.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('2026.10.01');
  process.exit(0);
}

const separator = args.indexOf('--');
const url = args[separator + 1];
if (separator < 0 || args.length !== separator + 2) {
  console.error('ERROR: the URL must come alone after --');
  process.exit(2);
}
const outDir = args[args.indexOf('-P') + 1];
const format = args[args.indexOf('-f') + 1];
const progress = (fields) => console.log(`VIDGET-PROGRESS ${JSON.stringify(fields)}`);

if (url.includes('fail')) {
  console.error('ERROR: [youtube] abc: Sign in to confirm you are not a bot');
  process.exit(1);
}

// Like the real thing under --print: quiet, so file names appear only in progress.
const video = join(outDir, 'Clip [abc].f1.mp4');
const tmpfilename = `${video}.part`;
writeFileSync(tmpfilename, 'partial');

if (url.includes('slow')) {
  progress({ status: 'downloading', downloaded_bytes: 10, total_bytes: 100, filename: video, tmpfilename });
  setTimeout(() => {}, 60_000);
} else {
  progress({ status: 'downloading', downloaded_bytes: 50, total_bytes: 100, filename: video, tmpfilename, speed: 25, eta: 2 });
  progress({ status: 'finished', downloaded_bytes: 100, total_bytes: 100, filename: video });
  const audio = join(outDir, 'Clip [abc].f2.m4a');
  progress({ status: 'finished', downloaded_bytes: 40, total_bytes: 40, filename: audio });
  const merged = join(outDir, 'Clip [abc].mp4');
  console.log(`[Merger] Merging formats into "${merged}"`);
  writeFileSync(merged, `merged with ${format}`);
  console.log(`VIDGET-FILE ${merged}`);
}
