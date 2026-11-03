import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Companion } from '@/src/companion/client';
import type { CompanionEvent } from '@/src/companion/protocol';
import { cleanYoutubeTitle, youtube, youtubeVideoId } from '@/src/extractors/youtube';

const ROOT = join(import.meta.dirname, '..', '..');
const HOST = join(ROOT, 'companion', 'host.mjs');
const FAKE = join(ROOT, 'tests', 'fixtures', 'fake-yt-dlp.mjs');

/** The host as Chrome runs it: length-prefixed JSON both ways. */
class HostProcess {
  readonly messages: Record<string, unknown>[] = [];
  private child: ChildProcess;
  private pending = Buffer.alloc(0);

  constructor(configPath: string) {
    this.child = spawn(process.execPath, [HOST], {
      env: { ...process.env, VIDGET_COMPANION_CONFIG: configPath },
    });
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= 4) {
        const size = this.pending.readUInt32LE(0);
        if (this.pending.length < 4 + size) break;
        this.messages.push(JSON.parse(this.pending.subarray(4, 4 + size).toString('utf8')));
        this.pending = this.pending.subarray(4 + size);
      }
    });
  }

  send(message: unknown) {
    const body = Buffer.from(JSON.stringify(message));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    this.child.stdin!.write(Buffer.concat([head, body]));
  }

  async next(type: string, jobId?: string) {
    await vi.waitFor(
      () => {
        if (!this.find(type, jobId)) throw new Error(`no ${type} yet`);
      },
      { timeout: 10_000, interval: 50 },
    );
    return this.find(type, jobId)!;
  }

  find(type: string, jobId?: string) {
    return this.messages.find((message) => message.type === type && (!jobId || message.jobId === jobId));
  }

  closeInput() {
    this.child.stdin!.end();
    return new Promise((resolve) => this.child.once('exit', resolve));
  }
}

describe('companion host', () => {
  let dir: string;
  let host: HostProcess;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vidget-companion-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ ytDlp: [process.execPath, FAKE], ffmpeg: 'ffmpeg', outDir: dir }));
    host = new HostProcess(config);
  });

  afterEach(async () => {
    await host.closeInput();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the yt-dlp it found', async () => {
    host.send({ type: 'hello' });
    expect(await host.next('hello')).toMatchObject({ version: '0.1.0', ytDlp: '2026.10.01', ffmpeg: true });
  });

  it('runs a download to the end, adding up both tracks', async () => {
    host.send({ type: 'download', jobId: 'j1', url: 'https://www.youtube.com/watch?v=abc' });
    const done = await host.next('done', 'j1');
    expect(done).toMatchObject({ file: join(dir, 'Clip [abc].mp4') });
    expect(readFileSync(join(dir, 'Clip [abc].mp4'), 'utf8')).toBe(
      'merged with bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b',
    );
    const progress = host.messages.filter((message) => message.type === 'progress');
    expect(progress[0]).toMatchObject({ stage: 'downloading', downloaded: 50, total: 100, speed: 25, eta: 2 });
    expect(progress.at(-1)).toMatchObject({ stage: 'merging', downloaded: 140, total: 140 });
  });

  it('passes on what went wrong', async () => {
    host.send({ type: 'download', jobId: 'j2', url: 'https://www.youtube.com/watch?v=fail' });
    expect(await host.next('failed', 'j2')).toMatchObject({
      message: '[youtube] abc: Sign in to confirm you are not a bot',
    });
  });

  it('never lets a page address become a yt-dlp option', async () => {
    host.send({ type: 'download', jobId: 'j3', url: '--exec=calc' });
    expect(await host.next('failed', 'j3')).toMatchObject({ message: 'Not a web address' });
    // A real address that carries option-like text still arrives as one URL.
    host.send({ type: 'download', jobId: 'j4', url: 'https://www.youtube.com/watch?v=abc --exec=calc' });
    expect(await host.next('done', 'j4')).toBeDefined();
  });

  it('cancels a download and removes its partial file', async () => {
    host.send({ type: 'download', jobId: 'j5', url: 'https://www.youtube.com/watch?v=slow' });
    await host.next('progress', 'j5');
    const part = join(dir, 'Clip [abc].f1.mp4.part');
    expect(existsSync(part)).toBe(true);
    host.send({ type: 'cancel', jobId: 'j5', discard: true });
    await vi.waitFor(() => expect(existsSync(part)).toBe(false), { timeout: 10_000 });
    expect(host.find('failed', 'j5')).toBeUndefined();
  });

  it('keeps the partial file when pausing, so the download can resume', async () => {
    host.send({ type: 'download', jobId: 'j6', url: 'https://www.youtube.com/watch?v=slow' });
    await host.next('progress', 'j6');
    host.send({ type: 'cancel', jobId: 'j6', discard: false });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(existsSync(join(dir, 'Clip [abc].f1.mp4.part'))).toBe(true);
  });
});

describe('Companion client', () => {
  function fakePort() {
    const listeners = { message: [] as ((message: unknown) => void)[], disconnect: [] as (() => void)[] };
    return {
      posted: [] as unknown[],
      postMessage(message: unknown) {
        this.posted.push(message);
      },
      disconnect: vi.fn(),
      onMessage: { addListener: (listener: (message: unknown) => void) => listeners.message.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => listeners.disconnect.push(listener) },
      emit: (message: unknown) => listeners.message.forEach((listener) => listener(message)),
      drop: () => listeners.disconnect.forEach((listener) => listener()),
    };
  }

  it('opens one port, and only for work that needs it', () => {
    const port = fakePort();
    const connect = vi.fn(() => port);
    const companion = new Companion(connect, () => {});
    companion.sendIfOpen({ type: 'cancel', jobId: 'a', discard: true });
    expect(connect).not.toHaveBeenCalled();
    companion.send({ type: 'download', jobId: 'a', url: 'https://youtu.be/abc' });
    companion.send({ type: 'download', jobId: 'b', url: 'https://youtu.be/abc' });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(port.posted).toHaveLength(2);
  });

  it('explains a missing host in plain words', () => {
    const port = fakePort();
    const events: CompanionEvent[] = [];
    const companion = new Companion(
      () => port,
      (event) => events.push(event),
      () => 'Specified native messaging host not found.',
    );
    companion.send({ type: 'hello' });
    port.emit({ type: 'hello', version: '0.1.0', ytDlp: null, ffmpeg: false });
    port.drop();
    expect(events).toEqual([
      { type: 'hello', version: '0.1.0', ytDlp: null, ffmpeg: false },
      { type: 'disconnected', message: 'The Vidget companion is not installed' },
    ]);
  });

  it('does not report its own close as a failure', () => {
    const port = fakePort();
    const onEvent = vi.fn();
    const companion = new Companion(() => port, onEvent);
    companion.send({ type: 'hello' });
    companion.close();
    port.drop();
    expect(onEvent).not.toHaveBeenCalled();
    expect(port.disconnect).toHaveBeenCalled();
  });
});

describe('YouTube extractor', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=x', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/', undefined],
    ['https://www.youtube.com/watch?v=short', undefined],
    ['https://evil.test/watch?v=dQw4w9WgXcQ', undefined],
  ])('%s', (url, id) => {
    expect(youtubeVideoId(url)).toBe(id);
  });

  it('cleans the page title', () => {
    expect(cleanYoutubeTitle('(3) A talk - YouTube')).toBe('A talk');
    expect(cleanYoutubeTitle('YouTube')).toBe('');
  });

  it('offers the page to the companion, never a stream', async () => {
    const media = await youtube.extract({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x',
      fetchText: async () => '',
      html: async () => '<html><head><title>(2) A talk - YouTube</title></head></html>',
    });
    expect(media).toEqual([
      {
        id: 'youtube-dQw4w9WgXcQ',
        title: 'A talk',
        variants: [{ id: 'yt-dlp', kind: 'external', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
      },
    ]);
  });

  it('is left out of store builds', async () => {
    const { findExtractor } = await import('@/src/extractors');
    expect(findExtractor('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
  });
});
