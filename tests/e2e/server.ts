import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

const OUT = join(import.meta.dirname, '..', 'fixtures', 'out');
const PAGES = join(import.meta.dirname, '..', 'fixtures', 'pages');

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
  '.ts': 'video/mp2t',
  '.html': 'text/html',
  '.key': 'application/octet-stream',
};

export interface FixtureServer {
  port: number;
  /** Paths requested since the last reset, to count fetches on resume. */
  requests: string[];
  /** Serve this HTML at `path`, whichever hostname the request came in on. */
  page(path: string, html: string): void;
  /** Answer the next request for a matching path with this status. */
  failNext(pattern: RegExp, status: number, times?: number): void;
  close(): Promise<void>;
}

export async function startServer(): Promise<FixtureServer> {
  const failures: { pattern: RegExp; status: number; times: number }[] = [];
  const requests: string[] = [];
  const inlinePages = new Map<string, string>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // X's stream URLs carry a media id: /amplify_video/123/hls-ts/master.m3u8.
    const path = decodeURIComponent(url.pathname).replace(/^\/amplify_video\/\d+/, '');
    requests.push(path);
    res.setHeader('Access-Control-Allow-Origin', '*');

    const inline = inlinePages.get(path);
    if (inline) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(inline);
      return;
    }

    const failure = failures.find((entry) => entry.pattern.test(path) && entry.times > 0);
    if (failure) {
      failure.times -= 1;
      res.writeHead(failure.status).end();
      return;
    }

    if (path.startsWith('/gated/') && !req.headers.referer?.includes('/pages/')) {
      res.writeHead(403).end('Referer required');
      return;
    }

    const root = path.startsWith('/pages/') ? PAGES : OUT;
    const relative = path.startsWith('/pages/') ? path.slice('/pages/'.length) : path;
    const file = normalize(join(root, relative));
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }

    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const size = statSync(file).size;
    // Meta's CDN takes the range from the query, and answers with a plain 200.
    const pieceStart = url.searchParams.get('bytestart');
    if (pieceStart) {
      const start = Number(pieceStart);
      const end = Math.min(Number(url.searchParams.get('byteend')), size - 1);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    if (path.endsWith('.html') || path.endsWith('.m3u8') || path.endsWith('.mpd')) {
      res.end(readFileSync(file));
    } else {
      createReadStream(file).pipe(res);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    requests,
    page(path, html) {
      inlinePages.set(path, html);
    },
    failNext(pattern, status, times = 1) {
      failures.push({ pattern, status, times });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
