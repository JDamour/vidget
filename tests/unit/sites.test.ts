import { describe, expect, it } from 'vitest';
import { isAd } from '@/src/detect/classify';
import { metaTrack } from '@/src/detect/meta';
import {
  addKnownMedia,
  addMetaTrack,
  addTikTokFile,
  emptyTab,
  presentItems,
  upsert,
} from '@/src/detect/registry';
import { findExtractor } from '@/src/extractors';
import { facebookVideoId, parseFacebookPage } from '@/src/extractors/facebook';
import { parseInstagramPage } from '@/src/extractors/instagram';
import { parseTikTokPage, tiktokFeedMedia, tiktokFileId } from '@/src/extractors/tiktok';
import { parseHls } from '@/src/media/hls';
import type { MediaInfo, TabState } from '@/src/shared/types';

const NO_MINIMUMS = { minDurationSec: 0, minSizeKb: 0 };

const efg = (tag: string, asset: number | string = 42) =>
  encodeURIComponent(btoa(JSON.stringify({ vencode_tag: tag, xpv_asset_id: asset })));

function cdnUrl(file: string, tag: string, range = '&bytestart=0&byteend=55', asset?: number) {
  return `https://instagram.fkgl4-2.fna.fbcdn.net/o1/${file}.mp4?oh=sig&efg=${efg(tag, asset)}${range}`;
}

const page = (...blocks: unknown[]) =>
  `<html><head><title>Fallback | Facebook</title></head><body>${blocks
    .map((block) => `<script type="application/json" data-sjs>${JSON.stringify(block)}</script>`)
    .join('')}</body></html>`;

function item(fields: Partial<MediaInfo>): MediaInfo {
  return {
    id: fields.key ?? 'id',
    key: 'https://a.test/clip.mp4',
    title: '',
    site: 'a.test',
    protected: false,
    status: 'ready',
    pageUrl: 'https://a.test/',
    source: 'network',
    variants: [{ id: 'direct', kind: 'direct', url: 'https://a.test/clip.mp4' }],
    ...fields,
  };
}

describe('metaTrack', () => {
  it('turns a piece of a track into the whole file', () => {
    const track = metaTrack(cdnUrl('v', 'ig-xpvds.clips.igwww-C3.dash_baseline_1_v1'));
    expect(track).toMatchObject({ asset: '42', audio: false, rank: -1 });
    expect(new URL(track!.url).searchParams.has('bytestart')).toBe(false);
    expect(new URL(track!.url).searchParams.has('byteend')).toBe(false);
    expect(new URL(track!.url).searchParams.get('oh')).toBe('sig');
  });

  it('recognizes audio tracks on both sites', () => {
    expect(metaTrack(cdnUrl('a', 'ig-xpvds.clips.igwww-C3.dash_ln_heaac_vbr3_audio'))?.audio).toBe(true);
    expect(metaTrack(cdnUrl('a', 'dash_vbr3_audio'))?.audio).toBe(true);
  });

  it('reads a height from the tag when it names one', () => {
    expect(metaTrack(cdnUrl('v', 'dash_h264-basic-gen2_720p'))).toMatchObject({ height: 720, rank: 720 });
  });

  it('prefers the lower numbered encoding', () => {
    const best = metaTrack(cdnUrl('v', 'dash_baseline_1_v1'))!;
    const worse = metaTrack(cdnUrl('v', 'dash_baseline_3_v1'))!;
    expect(best.rank).toBeGreaterThan(worse.rank);
  });

  it('leaves a whole progressive file to generic detection', () => {
    const tag = 'xpv_progressive.INSTAGRAM.FEED.C3.640.dash_baseline_1_v1';
    expect(metaTrack(cdnUrl('v', tag, ''))).toBeUndefined();
    expect(metaTrack(cdnUrl('v', tag))).toMatchObject({ audio: false });
  });

  it('ignores other hosts and URLs it cannot read', () => {
    expect(metaTrack(`https://cdn.test/v.mp4?efg=${efg('dash_audio')}&bytestart=0`)).toBeUndefined();
    expect(metaTrack('https://x.fbcdn.net/v.mp4?efg=!!!&bytestart=0')).toBeUndefined();
    expect(metaTrack('not a url')).toBeUndefined();
  });
});

describe('addMetaTrack', () => {
  const video = metaTrack(cdnUrl('video', 'dash_baseline_1_v1'))!;
  const audio = metaTrack(cdnUrl('audio', 'dash_ln_heaac_vbr3_audio'))!;
  const pageUrl = 'https://www.instagram.com/';

  it('makes one video from many pieces, whichever track arrives first', () => {
    for (const order of [
      [video, audio, video],
      [audio, video, audio],
    ]) {
      const state = emptyTab();
      for (const track of order) addMetaTrack(state, track, pageUrl);
      expect(state.items).toHaveLength(1);
      expect(state.items[0]).toMatchObject({ status: 'ready', site: 'instagram.com' });
      expect(state.items[0]!.variants).toHaveLength(1);
      expect(state.items[0]!.variants[0]).toMatchObject({ url: video.url, audioUrl: audio.url });
    }
  });

  it('keeps the best video and its audio as the player changes quality', () => {
    const state = emptyTab();
    const low = metaTrack(cdnUrl('low', 'dash_baseline_3_v1'))!;
    addMetaTrack(state, low, pageUrl);
    addMetaTrack(state, audio, pageUrl);
    addMetaTrack(state, video, pageUrl);
    addMetaTrack(state, low, pageUrl);
    expect(state.items[0]!.variants[0]).toMatchObject({ url: video.url, audioUrl: audio.url });
  });

  it('keeps different videos apart', () => {
    const state = emptyTab();
    addMetaTrack(state, video, pageUrl);
    addMetaTrack(state, metaTrack(cdnUrl('other', 'dash_baseline_1_v1', undefined, 7))!, pageUrl);
    expect(state.items).toHaveLength(2);
  });

  it('offers nothing until there is a picture', () => {
    const state = emptyTab();
    addMetaTrack(state, audio, pageUrl);
    expect(state.items[0]).toMatchObject({ status: 'parsing', variants: [] });
  });
});

describe('Facebook extractor', () => {
  const hd = 'https://video.test/hd.mp4?bitrate=580000&tag=hd';
  const sd = 'https://video.test/sd.mp4?bitrate=127000&tag=sd';
  const video = {
    __typename: 'Video',
    id: '123',
    playable_duration_in_ms: 74304,
    videoDeliveryLegacyFields: { id: '123', browser_native_hd_url: hd, browser_native_sd_url: sd },
  };
  const story = { __typename: 'Video', id: '123', creation_story: { message: { text: 'A caption' } } };

  it('offers both files, best first, with the post caption as title', () => {
    expect(parseFacebookPage(page({ media: video }, story), '123')).toEqual([
      {
        id: 'facebook-123',
        title: 'A caption',
        durationSec: 74.304,
        variants: [
          { id: 'facebook-hd', kind: 'direct', url: hd, bitrate: 580000 },
          { id: 'facebook-sd', kind: 'direct', url: sd, bitrate: 127000 },
        ],
      },
    ]);
  });

  it('falls back to the page title without the site name', () => {
    expect(parseFacebookPage(page({ media: video }), '123')[0]?.title).toBe('Fallback');
  });

  it('ignores data left over from a page it navigated away from', () => {
    expect(parseFacebookPage(page({ media: video }), '999')).toEqual([]);
  });

  it('reads the logged-in delivery format', () => {
    const delivery = {
      progressive_urls: [
        { progressive_url: sd, metadata: { quality: 'SD' } },
        { progressive_url: hd, metadata: { quality: 'HD' } },
      ],
    };
    expect(parseFacebookPage(page({ delivery }), '123')[0]?.variants?.map((v) => v.url)).toEqual([hd, sd]);
  });

  it('finds the id in each kind of address', () => {
    expect(facebookVideoId('https://www.facebook.com/page/videos/123/')).toBe('123');
    expect(facebookVideoId('https://www.facebook.com/page/videos/some-title/123/')).toBe('123');
    expect(facebookVideoId('https://www.facebook.com/reel/123')).toBe('123');
    expect(facebookVideoId('https://www.facebook.com/watch/?v=123')).toBe('123');
    expect(facebookVideoId('https://www.facebook.com/page/posts/abc')).toBeUndefined();
  });
});

describe('Instagram extractor', () => {
  const post = {
    pk: '9',
    code: 'ABC',
    user: { username: 'nasa' },
    caption: { text: 'Hello\n\nspace https://t.co/x' },
    display_uri: 'https://img.test/a.jpg',
    video_versions: [
      { type: 101, url: 'https://cdn.test/a.mp4' },
      { type: 102, url: 'https://cdn.test/a.mp4' },
    ],
  };

  it('uses a title built from the author and caption', () => {
    expect(parseInstagramPage(page({ post }), 'ABC')).toEqual([
      {
        id: 'instagram-9',
        title: '@nasa - Hello space',
        durationSec: undefined,
        thumbnail: 'https://img.test/a.jpg',
        variants: [{ id: 'instagram-file', kind: 'direct', url: 'https://cdn.test/a.mp4' }],
      },
    ]);
  });

  it('is not misled by a wrapper that repeats the code', () => {
    const [media] = parseInstagramPage(page({ code: 'ABC', result: post }), 'ABC');
    expect(media?.title).toBe('@nasa - Hello space');
  });

  it('lists each video of a carousel under the post caption', () => {
    const child = (pk: string) => ({ pk, video_versions: [{ url: `https://cdn.test/${pk}.mp4` }] });
    const carousel = {
      ...post,
      video_versions: undefined,
      carousel_media: [child('1'), child('2')],
    };
    const media = parseInstagramPage(page({ carousel }), 'ABC');
    expect(media.map((entry) => entry.id)).toEqual(['instagram-1', 'instagram-2']);
    expect(media[1]?.title).toBe('@nasa - Hello space');
  });

  it('sorts stated sizes, best first', () => {
    const sized = {
      ...post,
      video_versions: [
        { url: 'https://cdn.test/low.mp4', width: 360, height: 640 },
        { url: 'https://cdn.test/high.mp4', width: 720, height: 1280 },
      ],
    };
    expect(parseInstagramPage(page({ sized }), 'ABC')[0]?.variants?.map((v) => v.height)).toEqual([1280, 640]);
  });

  it('ignores data left over from another post', () => {
    expect(parseInstagramPage(page({ post }), 'OTHER')).toEqual([]);
  });
});

describe('TikTok extractor', () => {
  const encoding = (CodecType: string, Width: number, Height: number, name: string) => ({
    Bitrate: Width * 1000,
    CodecType,
    PlayAddr: { DataSize: '100', Width, Height, UrlList: [`https://v16.test/${name}/`] },
  });
  const rehydration = (itemStruct: unknown) => ({
    __DEFAULT_SCOPE__: { 'webapp.video-detail': { itemInfo: { itemStruct } } },
  });
  const struct = {
    id: '7',
    desc: 'frogs',
    author: { uniqueId: 'someone' },
    video: {
      duration: 24,
      cover: 'https://img.test/c.jpg',
      playAddr: 'https://v16.test/play/',
      bitrateInfo: [
        encoding('h265_hvc1', 1080, 1920, 'hevc-1080'),
        encoding('h264', 576, 1024, 'avc-576-a'),
        encoding('h265_hvc1', 720, 1280, 'hevc-720'),
        encoding('h265_hvc1', 576, 1024, 'hevc-576'),
        encoding('h264', 576, 1024, 'avc-576-b'),
      ],
    },
  };

  it('defaults to H.264 and keeps one encoding per height', () => {
    const [media] = parseTikTokPage(page(rehydration(struct)), '7');
    expect(media?.title).toBe('@someone - frogs');
    expect(media?.variants?.map((variant) => [variant.height, variant.codecs])).toEqual([
      [576, 'h264'],
      [1080, 'h265_hvc1'],
      [720, 'h265_hvc1'],
    ]);
    expect(media?.variants?.[0]?.url).toBe('https://v16.test/avc-576-a/');
  });

  it('falls back to the play address', () => {
    const plain = { ...struct, video: { ...struct.video, bitrateInfo: undefined } };
    expect(parseTikTokPage(page(rehydration(plain)), '7')[0]?.variants).toEqual([
      { id: 'tiktok-play', kind: 'direct', url: 'https://v16.test/play/', needsReferer: true },
    ]);
  });

  it('marks every file as needing the page Referer', () => {
    const [media] = parseTikTokPage(page(rehydration(struct)), '7');
    expect(media?.variants?.every((variant) => variant.needsReferer)).toBe(true);
  });

  it('ignores another video and a photo post', () => {
    expect(parseTikTokPage(page(rehydration(struct)), '8')).toEqual([]);
    expect(parseTikTokPage(page(rehydration({ id: '7', video: {} })), '7')).toEqual([]);
  });
});

describe('TikTok feed', () => {
  const file = (id: string, sig = 'sig1') =>
    `https://v16-webapp-prime.tiktok.com/video/tos/alisg/tos-alisg-ve-0068c800-sg/${id}/?signature=${sig}&mime_type=video_mp4`;
  const post = (id: string, files: [codec: string, fileId: string][]) => ({
    id,
    desc: `post ${id}`,
    author: { uniqueId: 'someone' },
    video: {
      duration: 15,
      playAddr: file(files[0]![1]),
      bitrateInfo: files.map(([CodecType, fileId]) => ({
        CodecType,
        PlayAddr: { Width: 540, Height: 960, UrlList: [file(fileId), file(fileId, 'sig2')] },
      })),
    },
  });
  const feed = JSON.stringify({
    itemList: [post('1', [['h265_hvc1', 'oHEVC1'], ['h264', 'oAVC1']]), post('2', [['h264', 'oAVC2']])],
  });
  const report = (fileId: string, sig = 'sig1') => ({ url: file(fileId, sig), source: 'network' as const, sizeBytes: 100 });
  const pageUrl = 'https://www.tiktok.com/foryou';

  it('reads the file id from either kind of address', () => {
    expect(tiktokFileId(file('oAVC1'))).toBe('oAVC1');
    expect(tiktokFileId('https://v16-webapp.tiktok.com/5b05/6aec/video/tos/alisg/tos-alisg-pve-0037c001/o8fq/')).toBe('o8fq');
    expect(tiktokFileId('https://cdn.test/video/tos/a/b/o8fq/')).toBeUndefined();
  });

  it('lists each post with every file it may stream', () => {
    const known = tiktokFeedMedia(feed);
    expect(known.map((entry) => entry.fileIds)).toEqual([['oHEVC1', 'oAVC1'], ['oAVC2']]);
    expect(known[0]?.media).toMatchObject({ id: 'tiktok-1', title: '@someone - post 1', durationSec: 15 });
    expect(known[0]?.media.variants?.[0]?.codecs).toBe('h264');
    expect(tiktokFeedMedia('not json')).toEqual([]);
    expect(tiktokFeedMedia(JSON.stringify({ itemInfo: { itemStruct: post('3', [['h264', 'o3']]) } }))).toHaveLength(1);
  });

  it('names a streamed file after its post and offers H.264 first', () => {
    const state = emptyTab();
    addKnownMedia(state, tiktokFeedMedia(feed));
    addTikTokFile(state, 'oHEVC1', report('oHEVC1'), pageUrl);
    addTikTokFile(state, 'oAVC1', report('oAVC1', 'sig9'), pageUrl);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ title: '@someone - post 1', durationSec: 15 });
    expect(state.items[0]?.variants[0]?.codecs).toBe('h264');
  });

  it('marks a file the feed has not named as needing the Referer too', () => {
    const state = emptyTab();
    addTikTokFile(state, 'oUnknown', report('oUnknown'), pageUrl);
    expect(state.items[0]?.variants[0]?.needsReferer).toBe(true);
  });

  it('renames files that streamed before the feed response arrived', () => {
    const state = emptyTab();
    addTikTokFile(state, 'oAVC2', report('oAVC2'), pageUrl);
    addTikTokFile(state, 'oAVC2', report('oAVC2', 'sig2'), pageUrl);
    addTikTokFile(state, 'oUnknown', report('oUnknown'), pageUrl);
    expect(state.items).toHaveLength(2);
    addKnownMedia(state, tiktokFeedMedia(feed));
    expect(state.items.map((entry) => entry.title)).toEqual(['', '@someone - post 2']);
  });

  it('keeps a bounded number of posts', () => {
    const state = emptyTab();
    for (let i = 0; i < 130; i++) {
      addKnownMedia(state, tiktokFeedMedia(JSON.stringify({ itemList: [post(String(i), [['h264', `o${i}`]])] })));
    }
    expect(Object.keys(state.known!.media)).toHaveLength(100);
    expect(Object.keys(state.known!.files)).toHaveLength(100);
    expect(state.known!.media['tiktok-129']).toBeDefined();
    expect(state.known!.media['tiktok-0']).toBeUndefined();
  });
});

describe('extractor routing', () => {
  it.each([
    ['https://www.facebook.com/page/videos/123/', 'facebook'],
    ['https://www.facebook.com/watch/?v=123', 'facebook'],
    ['https://www.facebook.com/reel/123', 'facebook'],
    ['https://www.instagram.com/p/ABC/', 'instagram'],
    ['https://www.instagram.com/nasa/reel/ABC/', 'instagram'],
    ['https://www.tiktok.com/@a/video/123', 'tiktok'],
  ])('%s', (url, id) => {
    expect(findExtractor(url)?.id).toBe(id);
  });

  it.each([
    'https://www.facebook.com/',
    'https://www.instagram.com/',
    'https://www.instagram.com/nasa/reels/',
    'https://www.tiktok.com/foryou',
  ])('leaves feeds to generic detection: %s', (url) => {
    expect(findExtractor(url)).toBeUndefined();
  });
});

describe('generic detection on real sites', () => {
  it('filters the video ad CDN', () => {
    expect(isAd('https://rr3---sn-woc7kn7y.c.2mdn.net/videoplayback/id/1')).toBe(true);
  });

  it('filters video ads served from a neutral host', () => {
    expect(isAd('https://redirector.gvt1.com/videoplayback/id/1/source/dclk_video_ads/x')).toBe(true);
    expect(isAd('https://cdn.test/videos/my_ads_review.mp4')).toBe(false);
  });

  it('merges one file served from two mirrors', () => {
    const state = emptyTab();
    const copy = (host: string) =>
      item({ key: `https://${host}/items/clip.mp4`, sizeBytes: 500 });
    upsert(state, copy('dn1.archive.test'));
    upsert(state, copy('dn2.archive.test'));
    expect(state.items).toHaveLength(1);
  });

  it('keeps different files that share a name or a size', () => {
    const state = emptyTab();
    upsert(state, item({ key: 'https://a.test/1/clip.mp4', sizeBytes: 500 }));
    upsert(state, item({ key: 'https://a.test/2/clip.mp4', sizeBytes: 600 }));
    upsert(state, item({ key: 'https://a.test/3/other.mp4', sizeBytes: 500 }));
    upsert(state, item({ key: 'https://a.test/4/clip.mp4' }));
    expect(state.items).toHaveLength(4);
  });

  it('does not list a stream player segments as videos', () => {
    const stream = item({
      key: 'https://a.test/master.m3u8',
      variants: [{ id: 'hls', kind: 'hls', url: 'https://a.test/v.m3u8' }],
    });
    const segment = item({ key: 'https://a.test/seg-1.mp4' });
    const onPage = item({ key: 'https://a.test/trailer.mp4', source: 'dom' });
    const state: TabState = { ...emptyTab(), items: [stream, segment, onPage] };
    expect(presentItems(state, NO_MINIMUMS).map((entry) => entry.key)).toEqual([stream.key, onPage.key]);
  });

  it('keeps network files when the page has no stream', () => {
    const state: TabState = { ...emptyTab(), items: [item({})] };
    expect(presentItems(state, NO_MINIMUMS)).toHaveLength(1);
  });

  it('does not use a site name as a title', () => {
    const state: TabState = {
      ...emptyTab(),
      items: [item({ site: 'twitch.tv' })],
      hints: { url: 'https://twitch.tv/', ogTitle: 'Twitch', title: 'Week 6 - Twitch' },
    };
    expect(presentItems(state, NO_MINIMUMS)[0]?.title).toBe('Week 6 - Twitch');
  });

  it('claims every playlist of a master, even ones no variant uses', async () => {
    const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio-en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="fr",URI="audio-fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=640x360,AUDIO="a"
high.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360,AUDIO="a"
low.m3u8
`;
    const media = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ns.ts\n#EXT-X-ENDLIST\n';
    const parsed = await parseHls(master, 'https://a.test/master.m3u8', async (url) => ({ text: media, url }));
    expect(parsed.variants).toHaveLength(1);
    expect(parsed.childUrls.sort()).toEqual(
      ['audio-en', 'audio-fr', 'high', 'low'].map((name) => `https://a.test/${name}.m3u8`),
    );
  });
});
