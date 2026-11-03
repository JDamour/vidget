import { describe, expect, it } from 'vitest';
import { emptyTab, itemFromReport, presentItems, upsert } from '@/src/detect/registry';
import { cleanXTitle, isXHost, xMediaId, xPostTitle } from '@/src/detect/x';

// Lines as they appear on real X pages.
const FEED_POST = ['NASA', '@NASA', '30 Oct', 'MAX POWER, the newest air show, is a week away!', 'Flyovers and more.', 'ALT', '676', '24k', '146k', '3.3m'];
const POST_PAGE = ['National Geographic', '@NatGeo', 'Even a moment\u2019s rest on Everest.', 'From Oscar\u00ae-winning filmmakers.', '00:45', '\u00b7', '51', '115'];

describe('xMediaId', () => {
  it('reads the id from stream and poster URLs alike', () => {
    expect(xMediaId('https://video.twimg.com/amplify_video/2115146475025903616/pl/a.m3u8')).toBe('2115146475025903616');
    expect(xMediaId('https://pbs.twimg.com/amplify_video_thumb/2115146475025903616/img/x?format=webp')).toBe('2115146475025903616');
    expect(xMediaId('https://video.twimg.com/ext_tw_video/123/pu/pl/a.m3u8')).toBe('123');
    expect(xMediaId('https://pbs.twimg.com/tweet_video_thumb/456.jpg')).toBe('456');
    expect(xMediaId('https://pbs.twimg.com/tweet_video_thumb/123abc.jpg')).toBeUndefined();
    expect(xMediaId('https://pbs.twimg.com/media/HUiBvkUXcAAHp7a?format=webp')).toBeUndefined();
  });
});

describe('isXHost', () => {
  it('matches X and Twitter only', () => {
    expect(isXHost('x.com')).toBe(true);
    expect(isXHost('mobile.twitter.com')).toBe(true);
    expect(isXHost('netflix.com')).toBe(false);
  });
});

describe('xPostTitle', () => {
  it('takes the words after the date and before the counters', () => {
    expect(xPostTitle(FEED_POST, '/NASA/status/2116263878807998722')).toBe(
      '@NASA - MAX POWER, the newest air show, is a week away! Flyovers and more.',
    );
  });

  it('keeps the first line of a post page, which has no date', () => {
    expect(xPostTitle(POST_PAGE, '/NatGeo/status/1')).toBe(
      '@NatGeo - Even a moment\u2019s rest on Everest. From Oscar\u00ae-winning filmmakers.',
    );
  });

  it('recognizes dates however they are written', () => {
    for (const date of ['3h', '12 m', 'Now', '30 Oct', 'Oct 30', 'Oct 30, 2025', '30 oct.', '2 Nov 2025']) {
      expect(xPostTitle(['A', '@a', date, 'Hello', '1'], '/a/status/1')).toBe('@a - Hello');
    }
  });

  it('skips the Pinned label and a separate dot', () => {
    expect(xPostTitle(['Pinned', 'NASA', '@NASA', '\u00b7', '30 Oct', 'Hello', '12'], '/NASA/status/1')).toBe('@NASA - Hello');
  });

  it('skips who a reply is to', () => {
    expect(xPostTitle(['A', '@a', '1h', 'Replying to', '@b', 'Thanks!', '3'], '/a/status/1')).toBe('@a - Thanks!');
  });

  it('keeps mentions inside a sentence', () => {
    expect(xPostTitle(['NASA', '@NASA', '29 Oct', "LIVE: @csa_asc's crew", '1'], '/NASA/status/1')).toBe("@NASA - LIVE: @csa_asc's crew");
  });

  it('drops links and shortens long posts on a word', () => {
    const title = xPostTitle(['A', '@a', '1h', `${'word '.repeat(40)}https://t.co/abc`], '/a/status/1')!;
    expect(title).not.toContain('t.co');
    expect(title.endsWith('word\u2026')).toBe(true);
    expect(title.length).toBeLessThan(100);
  });

  it('handles a post with no words', () => {
    expect(xPostTitle(['A', '@a', '1h', '12', '3'], '/a/status/1')).toBe('@a video');
  });

  it('gives up when the handle is not there', () => {
    expect(xPostTitle(['Something else'], '/a/status/1')).toBeUndefined();
    expect(xPostTitle(FEED_POST, '/NASA')).toBeUndefined();
  });
});

describe('cleanXTitle', () => {
  it('drops the unread count and the site name', () => {
    expect(cleanXTitle('NASA (@NASA) / X')).toBe('NASA (@NASA)');
  });

  it('treats feed pages as having no title', () => {
    expect(cleanXTitle('(1) Home / X')).toBeUndefined();
    expect(cleanXTitle('Home / X')).toBeUndefined();
  });

  it('reads post pages', () => {
    expect(cleanXTitle('National Geographic on X: "Even a moment\u2019s rest" / X')).toBe(
      'National Geographic - Even a moment\u2019s rest',
    );
  });
});

describe('titles in the registry', () => {
  const min = { minDurationSec: 5, minSizeKb: 300 };
  const stream = (id: string) =>
    ({
      ...itemFromReport(
        { url: `https://video.twimg.com/amplify_video/${id}/pl/a.m3u8`, source: 'network' },
        'hls',
        'https://x.com/home',
      ),
      status: 'ready',
    }) as const;

  it('gives each stream its own post', () => {
    const state = emptyTab();
    upsert(state, stream('111'));
    upsert(state, stream('222'));
    state.posts = { '111': '@a - one', '222': '@b - two' };
    state.hints = { url: 'https://x.com/home' };
    expect(presentItems(state, min).map((item) => item.title)).toEqual(['@a - one', '@b - two']);
  });

  it('falls back to the media id, not to a random URL segment', () => {
    const state = emptyTab();
    upsert(state, stream('333'));
    expect(presentItems(state, min)[0]!.title).toBe('X video 333');
  });

  it('prefers the post over a title the playing video suggested', () => {
    const state = emptyTab();
    upsert(state, { ...stream('444'), title: '@guess - maybe' });
    state.posts = { '444': '@sure - exact' };
    expect(presentItems(state, min)[0]!.title).toBe('@sure - exact');
  });
});
