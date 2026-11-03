import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDailymotionMetadata } from '@/src/extractors/dailymotion';
import { findExtractor } from '@/src/extractors';
import { parseRedditListing } from '@/src/extractors/reddit';
import { parseVimeoConfig } from '@/src/extractors/vimeo';
import { renderFilename, sanitizeName } from '@/src/shared/filename';
import { formatBytes, formatDuration, qualityLabel } from '@/src/shared/format';
import { isBlocked, verifyConfig } from '@/src/shared/remote-config';
import { addHistory, clearHistory, getHistory, HISTORY_LIMIT, pruneHistory } from '@/src/storage/db';
import type { HistoryEntry } from '@/src/shared/types';

describe('filename', () => {
  it('removes characters illegal on any platform', () => {
    expect(sanitizeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    expect(sanitizeName('..hidden')).toBe('hidden');
    expect(sanitizeName('trailing dots...')).toBe('trailing dots');
  });

  it('protects Windows reserved names and empty results', () => {
    expect(sanitizeName('CON')).toBe('_CON');
    expect(sanitizeName('lpt1.txt')).toBe('_lpt1.txt');
    expect(sanitizeName('???')).toBe('video');
  });

  it('limits length', () => {
    expect(sanitizeName('x'.repeat(500)).length).toBe(180);
  });

  it('fills every token and keeps unknown ones visible', () => {
    const name = renderFilename(
      '{site} {date} {title} {quality} {id} {nope}',
      { title: 'T', site: 'vimeo.com', quality: '720p', id: 'abc', date: new Date('2026-11-02T10:00:00Z') },
      'mp4',
    );
    expect(name).toBe('vimeo.com 2026-11-02 T 720p abc {nope}.mp4');
  });

  it('adds a subfolder per site on request', () => {
    const tokens = { title: 'T', site: 'a.com', quality: '720p', id: '1' };
    expect(renderFilename('{title}', tokens, 'mp4', { siteFolder: true })).toBe('a.com/T.mp4');
  });
});

describe('format', () => {
  it('formats bytes and durations', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(0)).toBe('');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(undefined)).toBe('');
  });

  it('labels quality', () => {
    expect(qualityLabel({ id: '', kind: 'hls', url: '', height: 720 })).toBe('720p');
    expect(qualityLabel({ id: '', kind: 'hls', url: '', bitrate: 128_000 })).toBe('128 kbps');
    expect(qualityLabel({ id: '', kind: 'direct', url: '' })).toBe('Original');
  });
});

describe('remote config', () => {
  async function signed(payload: string) {
    const { publicKey, privateKey } = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(payload),
    );
    const raw = await crypto.subtle.exportKey('raw', publicKey);
    const b64 = (buffer: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return { file: { payload, signature: b64(signature) }, key: b64(raw) };
  }

  it('accepts a correctly signed file', async () => {
    const { file, key } = await signed('{"blockedSites":["example.com"]}');
    expect(await verifyConfig(file, key)).toEqual({ blockedSites: ['example.com'], disabledExtractors: [] });
  });

  it('rejects a tampered file', async () => {
    const { file, key } = await signed('{"blockedSites":[]}');
    expect(await verifyConfig({ ...file, payload: '{"blockedSites":["x"]}' }, key)).toBeUndefined();
  });

  it('blocks a site and its subdomains only', () => {
    const config = { blockedSites: ['example.com'], disabledExtractors: [] };
    expect(isBlocked('example.com', config)).toBe(true);
    expect(isBlocked('cdn.example.com', config)).toBe(true);
    expect(isBlocked('notexample.com', config)).toBe(false);
  });
});

describe('extractors', () => {
  it('matches site URLs and honors the kill switch', () => {
    expect(findExtractor('https://vimeo.com/123456789')?.id).toBe('vimeo');
    expect(findExtractor('https://www.reddit.com/r/videos/comments/abc/title/')?.id).toBe('reddit');
    expect(findExtractor('https://www.dailymotion.com/video/x8abc')?.id).toBe('dailymotion');
    expect(findExtractor('https://example.com/')).toBeUndefined();
    expect(findExtractor('https://vimeo.com/123456789', ['vimeo'])).toBeUndefined();
  });

  it('reads Vimeo progressive files, best first', () => {
    const media = parseVimeoConfig(
      {
        video: { title: 'Talk', duration: 300, thumbs: { '1280': 't.jpg' } },
        request: {
          files: {
            progressive: [
              { url: 'https://v/360.mp4', height: 360 },
              { url: 'https://v/1080.mp4', height: 1080 },
            ],
          },
        },
      },
      '123',
    );
    expect(media?.variants?.map((variant) => variant.height)).toEqual([1080, 360]);
    expect(media).toMatchObject({ title: 'Talk', durationSec: 300, thumbnail: 't.jpg' });
  });

  it('falls back to Vimeo HLS', () => {
    const media = parseVimeoConfig(
      { request: { files: { hls: { default_cdn: 'a', cdns: { a: { url: 'https://v/m.m3u8' } } } } } },
      '123',
    );
    expect(media?.stream).toEqual({ url: 'https://v/m.m3u8', kind: 'hls' });
  });

  it('reads Reddit videos, following crossposts', () => {
    const video = { dash_url: 'https://v.redd.it/x/DASH.mpd', duration: 12 };
    const direct = [{ data: { children: [{ data: { id: 'a', title: 'T', secure_media: { reddit_video: video } } }] } }];
    expect(parseRedditListing(direct)?.stream).toEqual({ url: video.dash_url, kind: 'dash' });
    const crossposted = [
      {
        data: {
          children: [
            { data: { id: 'b', title: 'T', crosspost_parent_list: [{ secure_media: { reddit_video: video } }] } },
          ],
        },
      },
    ];
    expect(parseRedditListing(crossposted)?.durationSec).toBe(12);
    expect(parseRedditListing([{ data: { children: [{ data: { id: 'c' } }] } }])).toBeUndefined();
  });

  it('reads Dailymotion metadata and handles errors', () => {
    const media = parseDailymotionMetadata({
      id: 'x1',
      title: 'Clip',
      qualities: { auto: [{ type: 'application/x-mpegURL', url: 'https://d/m.m3u8' }] },
    });
    expect(media?.stream).toEqual({ url: 'https://d/m.m3u8', kind: 'hls' });
    expect(parseDailymotionMetadata({ error: { code: 'DM007' } })).toBeUndefined();
  });
});

describe('history store', () => {
  const entry = (index: number): HistoryEntry => ({
    jobId: `j${index}`,
    title: 'T',
    site: 's',
    filename: 'f',
    sizeBytes: 1,
    finishedAt: index,
    status: 'done',
    sourceUrl: 'u',
    pageUrl: 'p',
    variant: { id: 'v', kind: 'direct', url: 'u' },
    quality: 'q',
  });

  it('returns newest first and prunes to the limit', async () => {
    await clearHistory();
    for (let i = 0; i < HISTORY_LIMIT + 3; i++) await addHistory(entry(i));
    const rows = await getHistory();
    expect(rows).toHaveLength(HISTORY_LIMIT);
    expect(rows[0]!.jobId).toBe(`j${HISTORY_LIMIT + 2}`);
    expect(rows.at(-1)!.jobId).toBe('j3');
  }, 30_000);

  it('drops rows older than the retention window', async () => {
    await clearHistory();
    await addHistory(entry(1_000));
    await addHistory(entry(10 * 86_400_000));
    await pruneHistory(1, 10.5 * 86_400_000);
    expect((await getHistory()).map((row) => row.jobId)).toEqual([`j${10 * 86_400_000}`]);
  });
});

describe('locales', () => {
  const load = (locale: string) =>
    JSON.parse(readFileSync(`public/_locales/${locale}/messages.json`, 'utf8')) as Record<string, unknown>;

  it('has the same keys in every language', () => {
    const en = Object.keys(load('en')).sort();
    expect(Object.keys(load('fr')).sort()).toEqual(en);
    expect(Object.keys(load('rw')).sort()).toEqual(en);
  });
});
