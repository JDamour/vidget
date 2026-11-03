import { describe, expect, it, vi } from 'vitest';
import { AccessGate } from '@/src/detect/access';
import { reportsFromTiming } from '@/src/detect/scan';
import { classify, isAd, isYoutubeHost, mediaKey, totalSizeFrom } from '@/src/detect/classify';
import {
  downloadableCount,
  emptyTab,
  itemFromReport,
  presentItems,
  replaceItem,
  upsert,
} from '@/src/detect/registry';

const min = { minDurationSec: 5, minSizeKb: 300 };
const page = 'https://example.com/watch';

describe('classify', () => {
  it('prefers the MIME type', () => {
    expect(classify('https://a.com/x', 'application/vnd.apple.mpegurl')).toBe('hls');
    expect(classify('https://a.com/x', 'application/x-mpegURL; charset=utf-8')).toBe('hls');
    expect(classify('https://a.com/x', 'application/dash+xml')).toBe('dash');
    expect(classify('https://a.com/x', 'video/mp4')).toBe('direct');
  });

  it('falls back to the extension, ignoring the query', () => {
    expect(classify('https://a.com/v/index.m3u8?t=1')).toBe('hls');
    expect(classify('https://a.com/v/manifest.mpd')).toBe('dash');
    expect(classify('https://a.com/v/a.WEBM')).toBe('direct');
    expect(classify('https://a.com/v/a.jpg')).toBeNull();
  });

  it('ignores segments and non-http URLs', () => {
    expect(classify('https://a.com/seg1.ts', 'video/mp2t')).toBeNull();
    expect(classify('https://a.com/seg1.m4s', 'video/iso.segment')).toBeNull();
    expect(classify('blob:https://a.com/1234', 'video/mp4')).toBeNull();
  });
});

describe('filters', () => {
  it('spots ad servers and ad paths', () => {
    expect(isAd('https://pubads.g.doubleclick.net/x.mp4')).toBe(true);
    expect(isAd('https://cdn.example.com/ads/spot.mp4')).toBe(true);
    expect(isAd('https://cdn.example.com/uploads/talk.mp4')).toBe(false);
    expect(isAd('https://cdn.example.com/downloads/talk.mp4')).toBe(false);
  });

  it('recognizes YouTube hosts only', () => {
    expect(isYoutubeHost('www.youtube.com')).toBe(true);
    expect(isYoutubeHost('rr1---sn.googlevideo.com')).toBe(true);
    expect(isYoutubeHost('notyoutube.com')).toBe(false);
  });

  it('reads the total size from Content-Range first', () => {
    expect(totalSizeFrom({ contentLength: '100', contentRange: 'bytes 0-99/5000' })).toBe(5000);
    expect(totalSizeFrom({ contentLength: '100' })).toBe(100);
    expect(totalSizeFrom({})).toBeUndefined();
  });

  it('keys media without its signed query', () => {
    expect(mediaKey('https://a.com/v.mp4?sig=1')).toBe(mediaKey('https://a.com/v.mp4?sig=2'));
  });
});

describe('tab registry', () => {
  const direct = (url: string, extra = {}) =>
    itemFromReport({ url, source: 'network', sizeBytes: 5_000_000, ...extra }, 'direct', page);

  it('merges the same media from several detectors', () => {
    const state = emptyTab();
    expect(upsert(state, direct('https://a.com/v.mp4?a=1'))).toBe(true);
    const dom = itemFromReport(
      { url: 'https://a.com/v.mp4?a=2', source: 'dom', durationSec: 60, thumbnail: 'p.jpg' },
      'direct',
      page,
    );
    expect(upsert(state, dom)).toBe(false);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ durationSec: 60, thumbnail: 'p.jpg', sizeBytes: 5_000_000 });
  });

  it('drops clips under the minimums', () => {
    const state = emptyTab();
    upsert(state, direct('https://a.com/short.mp4', { durationSec: 3 }));
    upsert(state, direct('https://a.com/small.mp4', { sizeBytes: 1000 }));
    upsert(state, direct('https://a.com/long.mp4', { durationSec: 90 }));
    expect(presentItems(state, min).map((item) => item.key)).toEqual(['https://a.com/long.mp4']);
  });

  it('hides child playlists of a parsed master', () => {
    const state = emptyTab();
    const report = { url: 'https://a.com/master.m3u8', source: 'probe' as const };
    const master = itemFromReport(report, 'hls', page);
    const child = itemFromReport({ ...report, url: 'https://a.com/720.m3u8' }, 'hls', page);
    upsert(state, master);
    upsert(state, child);
    replaceItem(state, { ...master, status: 'ready', childKeys: [child.key] });
    expect(state.items).toHaveLength(1);
    expect(upsert(state, child)).toBe(false);
    expect(state.items).toHaveLength(1);
  });

  it('does not mistake a manifest for a tiny video', () => {
    const state = emptyTab();
    const report = { url: 'https://a.com/m.m3u8', source: 'network' as const, sizeBytes: 209 };
    upsert(state, { ...itemFromReport(report, 'hls', page), status: 'ready' });
    expect(presentItems(state, min)).toHaveLength(1);
  });

  it('prefers extractor results over generic detection', () => {
    const state = emptyTab();
    upsert(state, direct('https://a.com/generic.mp4'));
    upsert(state, { ...direct('https://a.com/site.mp4'), source: 'extractor' });
    expect(presentItems(state, min).map((item) => item.source)).toEqual(['extractor']);
  });

  it('marks everything protected once the page uses EME', () => {
    const state = emptyTab();
    upsert(state, direct('https://a.com/v.mp4'));
    state.drm = true;
    const items = presentItems(state, min);
    expect(items[0]!.protected).toBe(true);
    expect(downloadableCount(items)).toBe(0);
  });

  it('fills titles from page hints, then the URL', () => {
    const state = emptyTab();
    upsert(state, direct('https://a.com/my-talk.mp4'));
    expect(presentItems(state, min)[0]!.title).toBe('my-talk');
    state.hints = { url: page, title: 'Page', ogTitle: 'OG title' };
    expect(presentItems(state, min)[0]!.title).toBe('OG title');
  });
});

describe('reportsFromTiming', () => {
  it('keeps manifests and files, and skips everything else', () => {
    const reports = reportsFromTiming([
      { name: 'https://a.com/master.m3u8?t=1' },
      { name: 'https://a.com/seg1.ts' },
      { name: 'https://a.com/app.js' },
      { name: 'https://a.com/clip.mp4' },
    ]);
    expect(reports.map((report) => report.url)).toEqual([
      'https://a.com/master.m3u8?t=1',
      'https://a.com/clip.mp4',
    ]);
  });
});

describe('AccessGate', () => {
  function gate(access: boolean) {
    const state = { access, subscribe: vi.fn(), unsubscribe: vi.fn() };
    const accessGate = new AccessGate({
      hasAccess: async () => state.access,
      subscribe: state.subscribe,
      unsubscribe: state.unsubscribe,
    });
    return { state, accessGate };
  }

  it('does not subscribe without access', async () => {
    const { state, accessGate } = gate(false);
    await accessGate.sync();
    expect(state.subscribe).not.toHaveBeenCalled();
    expect(state.unsubscribe).not.toHaveBeenCalled();
  });

  it('subscribes once access is granted after startup', async () => {
    const { state, accessGate } = gate(false);
    await accessGate.sync();
    state.access = true;
    await accessGate.sync();
    expect(state.subscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribes once, however often and however concurrently it syncs', async () => {
    const { state, accessGate } = gate(true);
    await Promise.all([accessGate.sync(), accessGate.sync(), accessGate.sync()]);
    await accessGate.sync();
    expect(state.subscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when access is revoked, and can come back', async () => {
    const { state, accessGate } = gate(true);
    await accessGate.sync();
    state.access = false;
    await accessGate.sync();
    expect(state.unsubscribe).toHaveBeenCalledTimes(1);
    state.access = true;
    await accessGate.sync();
    expect(state.subscribe).toHaveBeenCalledTimes(2);
  });
});
