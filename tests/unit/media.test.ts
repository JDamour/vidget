import { describe, expect, it, vi } from 'vitest';
import { assemble } from '@/src/media/assemble';
import { boxesIn, copyFragments, detectFormat, isEncryptedInit, mergeInits, retagMoof, type Sink, Timeline } from '@/src/media/boxes';
import { isProtectedMpd, loadDashTracks, parseDash } from '@/src/media/dash';
import { decryptAes128, ivFor } from '@/src/media/decrypt';
import { fetchBytes } from '@/src/media/fetch';
import { isProtectedPlaylist, loadHlsTracks, parseHls, parseMediaPlaylist } from '@/src/media/hls';

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const size = 8 + children.reduce((sum, child) => sum + child.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const child of children) {
    out.set(child, offset);
    offset += child.length;
  }
  return out;
}

const zeros = (length: number) => new Uint8Array(length);

function initFor(trackId: number, extraType = 'vide'): Uint8Array {
  const tkhd = zeros(84);
  new DataView(tkhd.buffer).setUint32(12, trackId);
  const trex = zeros(24);
  new DataView(trex.buffer).setUint32(4, trackId);
  return concat(
    box('ftyp', zeros(8)),
    box(
      'moov',
      box('mvhd', zeros(100)),
      box('trak', box('tkhd', tkhd), box('mdia', new TextEncoder().encode(extraType))),
      box('mvex', box('trex', trex)),
    ),
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function fragment(trackId: number, sequence: number, payload: number, flags = 0x020000): Uint8Array {
  const mfhd = zeros(8);
  new DataView(mfhd.buffer).setUint32(4, sequence);
  const hasBase = flags & 1;
  const tfhd = zeros(hasBase ? 16 : 8);
  const data = new DataView(tfhd.buffer);
  data.setUint32(0, flags);
  data.setUint32(4, trackId);
  return concat(
    box('moof', box('mfhd', mfhd), box('traf', box('tfhd', tfhd))),
    box('mdat', new Uint8Array(payload).fill(trackId)),
  );
}

function memorySink(): Sink & { bytes(): Promise<Uint8Array> } {
  const chunks: (Uint8Array | Blob)[] = [];
  return {
    position: 0,
    async write(chunk) {
      chunks.push(chunk);
      this.position += chunk instanceof Blob ? chunk.size : chunk.length;
    },
    async bytes() {
      return new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer());
    },
  };
}

function trackIdOf(bytes: Uint8Array, moofStart: number): number {
  const moof = bytes.subarray(moofStart);
  const root = [...boxesIn(moof)][0]!;
  const traf = [...boxesIn(moof, root.headerSize, root.size)].find((entry) => entry.type === 'traf')!;
  const tfhd = [...boxesIn(moof, traf.start + traf.headerSize, traf.start + traf.size)][0]!;
  return new DataView(moof.buffer, moof.byteOffset).getUint32(tfhd.start + tfhd.headerSize + 4);
}

describe('detectFormat', () => {
  it('recognizes each container from its first bytes', () => {
    const ts = zeros(376);
    ts[0] = 0x47;
    ts[188] = 0x47;
    expect(detectFormat(ts)).toBe('ts');
    expect(detectFormat(box('ftyp', zeros(8)))).toBe('fmp4');
    expect(detectFormat(box('moof'))).toBe('fmp4');
    expect(detectFormat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('webm');
    expect(detectFormat(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]))).toBe('aac');
    expect(detectFormat(new Uint8Array([0xff, 0xf1, 0x50, 0x80]))).toBe('aac');
    expect(detectFormat(new TextEncoder().encode('<html>hello</html>'))).toBe('unknown');
  });
});

describe('Timeline', () => {
  function initWith(tracks: [id: number, timescale: number][]) {
    const traks = tracks.map(([id, timescale]) => {
      const tkhd = zeros(84);
      new DataView(tkhd.buffer).setUint32(12, id);
      const mdhd = zeros(24);
      new DataView(mdhd.buffer).setUint32(12, timescale);
      return box('trak', box('tkhd', tkhd), box('mdia', box('mdhd', mdhd)));
    });
    return box('moov', ...traks);
  }

  it('leaves times alone until a section starts', () => {
    const timeline = new Timeline(initWith([[1, 1000]]));
    expect(timeline.place(1, 100n)).toBe(100n);
    expect(timeline.place(1, 2000n)).toBe(2000n);
  });

  it('moves each section to where the playlist starts it', () => {
    const timeline = new Timeline(initWith([[1, 1000]]));
    timeline.place(1, 100n);
    timeline.restartAt(4);
    expect(timeline.place(1, 100n)).toBe(4100n);
    expect(timeline.place(1, 150n)).toBe(4150n);
    timeline.restartAt(10);
    expect(timeline.place(1, 0n)).toBe(10100n);
  });

  it('uses each track\'s own timescale when one source holds both', () => {
    const timeline = new Timeline(initWith([[1, 90000], [2, 44100]]));
    timeline.place(1, 0n);
    timeline.place(2, 0n);
    timeline.restartAt(2);
    expect(timeline.place(1, 0n)).toBe(180000n);
    expect(timeline.place(2, 0n)).toBe(88200n);
  });
});

describe('fMP4 merge', () => {
  it('combines two inits with renumbered tracks', () => {
    const merged = mergeInits([initFor(1), initFor(1, 'soun')]);
    const top = [...boxesIn(merged)];
    expect(top.map((entry) => entry.type)).toEqual(['ftyp', 'moov']);
    const moov = top[1]!;
    const children = [...boxesIn(merged, moov.start + moov.headerSize, moov.start + moov.size)];
    expect(children.map((entry) => entry.type)).toEqual(['mvhd', 'trak', 'trak', 'mvex']);

    const data = new DataView(merged.buffer);
    const ids = children
      .filter((entry) => entry.type === 'trak')
      .map((trak) => {
        const tkhd = [...boxesIn(merged, trak.start + 8, trak.start + trak.size)][0]!;
        return data.getUint32(tkhd.start + tkhd.headerSize + 12);
      });
    expect(ids).toEqual([1, 2]);

    const mvex = children[3]!;
    const trexIds = [...boxesIn(merged, mvex.start + 8, mvex.start + mvex.size)].map((trex) =>
      data.getUint32(trex.start + 12),
    );
    expect(trexIds).toEqual([1, 2]);

    const mvhd = children[0]!;
    expect(data.getUint32(mvhd.start + mvhd.size - 4)).toBe(3);
  });

  it('rejects inits with more than one track', () => {
    const init = initFor(1);
    const moov = [...boxesIn(init)][1]!;
    const children = [...boxesIn(init, moov.start + 8, moov.start + moov.size)];
    const trak = children[1]!;
    const trakBytes = init.subarray(trak.start, trak.start + trak.size);
    const doubled = box('moov', box('mvhd', zeros(100)), trakBytes, trakBytes, box('mvex', box('trex', zeros(24))));
    expect(() => mergeInits([doubled, initFor(1)])).toThrow(/one track/);
  });

  it('shifts absolute base data offsets when a fragment moves', () => {
    const moof = fragment(1, 1, 4, 0x000001).slice(0, 56);
    const view = new DataView(moof.buffer);
    const tfhdFields = 8 + 16 + 8 + 8; // moof, mfhd, traf and tfhd headers
    view.setBigUint64(tfhdFields + 8, 1000n);
    retagMoof(moof, { trackId: 2, sequence: 9, moved: 500 });
    expect(view.getUint32(tfhdFields + 4)).toBe(2);
    expect(view.getBigUint64(tfhdFields + 8)).toBe(1500n);
    expect(view.getUint32(8 + 8 + 4)).toBe(9); // mfhd sequence number
  });

  it('drops index boxes and renumbers fragments', async () => {
    const segment = new Blob([
      box('styp', zeros(4)),
      box('sidx', zeros(20)),
      fragment(5, 77, 8),
    ] as BlobPart[]);
    const sink = memorySink();
    const next = await copyFragments(segment, sink, { sequence: 3 });
    expect(next).toBe(4);
    const bytes = await sink.bytes();
    expect([...boxesIn(bytes)].map((entry) => entry.type)).toEqual(['moof', 'mdat']);
    expect(trackIdOf(bytes, 0)).toBe(5);
  });

  it('assembles separate tracks into one interleaved file', async () => {
    const track = (id: number) => ({
      init: new Blob([initFor(id)] as BlobPart[]),
      count: 3,
      segment: async (index: number) => new Blob([fragment(id, index + 1, 16)] as BlobPart[]),
    });
    const sink = memorySink();
    expect(await assemble([track(1), track(1)], sink)).toBe('mp4');
    const bytes = await sink.bytes();
    const moofs = [...boxesIn(bytes)].filter((entry) => entry.type === 'moof');
    expect(moofs).toHaveLength(6);
    expect(moofs.map((entry) => trackIdOf(bytes, entry.start))).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it('refuses encrypted tracks', async () => {
    const init = concat(initFor(1, 'encv'));
    expect(isEncryptedInit(init)).toBe(true);
    expect(isEncryptedInit(initFor(1))).toBe(false);
    const files = { init: new Blob([init] as BlobPart[]), count: 0, segment: async () => new Blob() };
    await expect(assemble([files], memorySink())).rejects.toMatchObject({ code: 'protected' });
  });

  it('concatenates a lone WebM track but will not merge two', async () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    const track = {
      init: new Blob([webm]),
      count: 1,
      segment: async () => new Blob([new Uint8Array([9, 9])]),
    };
    const sink = memorySink();
    expect(await assemble([track], sink)).toBe('webm');
    expect((await sink.bytes()).length).toBe(9);
    await expect(assemble([track, track], memorySink())).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('AES-128', () => {
  it('derives the default IV from the media sequence', () => {
    const iv = ivFor({ uri: 'k' }, 0x01020304);
    expect([...iv.subarray(12)]).toEqual([1, 2, 3, 4]);
    expect([...iv.subarray(0, 12)]).toEqual(new Array(12).fill(0));
  });

  it('prefers an explicit IV', () => {
    const explicit = new Uint8Array(16).fill(7);
    expect(ivFor({ uri: 'k', iv: explicit }, 5)).toBe(explicit);
  });

  it('decrypts what WebCrypto encrypted, removing padding', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const plain = new TextEncoder().encode('a segment of video bytes');
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CBC', false, ['encrypt']);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plain));
    expect(await decryptAes128(cipher, keyBytes, iv)).toEqual(plain);
  });

  it('rejects keys of the wrong length', async () => {
    await expect(decryptAes128(zeros(16), zeros(8), zeros(16))).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('HLS', () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
720b/index.m3u8
`;
  const media = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:6,
a.ts
#EXTINF:4,
b.ts
#EXT-X-ENDLIST
`;
  const fetcher = async (url: string) => ({ text: media, url });

  it('turns a master into sorted variants with sizes', async () => {
    const parsed = await parseHls(master, 'https://a.com/v/master.m3u8', fetcher);
    expect(parsed.variants.map((variant) => variant.height)).toEqual([720, 360]);
    const best = parsed.variants[0]!;
    expect(best.bitrate).toBe(2_500_000);
    expect(best.url).toBe('https://a.com/v/720/index.m3u8');
    expect(best.audioUrl).toBe('https://a.com/v/audio/en.m3u8');
    expect(best.sizeEstimate).toBe(Math.round((2_500_000 / 8) * 10));
    expect(parsed.durationSec).toBe(10);
    expect(parsed.live).toBe(false);
    expect(parsed.protected).toBe(false);
    expect(parsed.childUrls).toContain('https://a.com/v/360/index.m3u8');
  });

  it('accepts a bare media playlist', async () => {
    const parsed = await parseHls(media, 'https://a.com/v/index.m3u8', fetcher);
    expect(parsed.variants).toEqual([{ id: 'hls-single', kind: 'hls', url: 'https://a.com/v/index.m3u8' }]);
  });

  it('resolves segments, sequence numbers and keys', () => {
    const track = parseMediaPlaylist(media, 'https://a.com/v/index.m3u8', 'muxed');
    expect(track.segments[0]).toMatchObject({
      url: 'https://a.com/v/a.ts',
      mediaSequence: 10,
      key: { uri: 'https://a.com/v/key.bin' },
    });
    expect(track.segments[1]!.mediaSequence).toBe(11);
  });

  it('keeps explicit IVs and byte ranges', () => {
    const track = parseMediaPlaylist(
      `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k",IV=0x000102030405060708090a0b0c0d0e0f
#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"
#EXT-X-BYTERANGE:500@100
#EXTINF:4,
all.m4s
#EXT-X-BYTERANGE:500
#EXTINF:4,
all.m4s
#EXT-X-ENDLIST`,
      'https://a.com/index.m3u8',
      'muxed',
    );
    expect([...track.segments[0]!.key!.iv!.subarray(0, 4)]).toEqual([0, 1, 2, 3]);
    expect([...track.segments[0]!.key!.iv!.subarray(12)]).toEqual([12, 13, 14, 15]);
    expect(track.init).toEqual({ url: 'https://a.com/init.mp4', byteRange: { length: 100, offset: 0 } });
    expect(track.segments[0]!.byteRange).toEqual({ length: 500, offset: 100 });
    expect(track.segments[1]!.byteRange).toEqual({ length: 500, offset: 600 });
  });

  it('treats a playlist with no end tag as live', () => {
    const track = parseMediaPlaylist('#EXTM3U\n#EXTINF:4,\na.ts\n', 'https://a.com/i.m3u8', 'muxed');
    expect(track.live).toBe(true);
  });

  it('allows clear-key AES-128 and rejects real DRM', () => {
    expect(isProtectedPlaylist(media)).toBe(false);
    expect(isProtectedPlaylist('#EXT-X-KEY:METHOD=NONE')).toBe(false);
    expect(isProtectedPlaylist('#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="identity"')).toBe(false);
    expect(isProtectedPlaylist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x"')).toBe(true);
    expect(isProtectedPlaylist('#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI="data:x"')).toBe(true);
    expect(
      isProtectedPlaylist(
        '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.widevine.alpha"',
      ),
    ).toBe(true);
  });

  it('refuses protected and live playlists at download time', async () => {
    const variant = { id: 'x', kind: 'hls' as const, url: 'https://a.com/i.m3u8' };
    await expect(
      loadHlsTracks(variant, async (url) => ({ text: '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="x"', url })),
    ).rejects.toMatchObject({ code: 'protected' });
    await expect(
      loadHlsTracks(variant, async (url) => ({ text: '#EXTM3U\n#EXTINF:4,\na.ts\n', url })),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('DASH', () => {
  const mpd = (adaptations: string, attrs = 'type="static"') => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attrs} mediaPresentationDuration="PT20S" minBufferTime="PT2S">
  <Period><BaseURL>https://cdn.a.com/v/</BaseURL>${adaptations}</Period>
</MPD>`;
  const template = '<SegmentTemplate initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Number$.m4s" startNumber="1" duration="4" timescale="1"/>';
  const manifest = mpd(`
    <AdaptationSet contentType="video" mimeType="video/mp4">${template}
      <Representation id="v720" bandwidth="2000000" width="1280" height="720" codecs="avc1.4d401f"/>
      <Representation id="v360" bandwidth="600000" width="640" height="360" codecs="avc1.4d401e"/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en">${template}
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/>
    </AdaptationSet>`);

  it('pairs each video with audio', () => {
    const parsed = parseDash(manifest, 'https://a.com/m.mpd');
    expect(parsed.variants.map((variant) => variant.height)).toEqual([720, 360]);
    expect(parsed.durationSec).toBe(20);
    expect(parsed.variants[0]).toMatchObject({
      bitrate: 2_128_000,
      needsFfmpeg: false,
      sizeEstimate: Math.round((2_128_000 / 8) * 20),
    });
  });

  it('resolves both tracks with init and media URLs', () => {
    const { variants } = parseDash(manifest, 'https://a.com/m.mpd');
    const [video, audio] = loadDashTracks(manifest, 'https://a.com/m.mpd', variants[0]!);
    expect(video).toMatchObject({ role: 'video', init: { url: 'https://cdn.a.com/v/v720/init.mp4' } });
    expect(video!.segments).toHaveLength(5);
    expect(video!.segments[0]!.url).toBe('https://cdn.a.com/v/v720/1.m4s');
    expect(audio!.segments[0]!.url).toBe('https://cdn.a.com/v/a1/1.m4s');
  });

  it('flags WebM pairs as needing ffmpeg unless an fMP4 option exists', () => {
    const webmOnly = mpd(`
      <AdaptationSet contentType="video" mimeType="video/webm">${template.replaceAll('.mp4', '.webm').replaceAll('.m4s', '.webm')}
        <Representation id="vp9" bandwidth="1000000" width="1920" height="1080" codecs="vp9"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/webm" lang="en">${template.replaceAll('.mp4', '.webm').replaceAll('.m4s', '.webm')}
        <Representation id="opus" bandwidth="96000" codecs="opus"/>
      </AdaptationSet>`);
    expect(parseDash(webmOnly, 'https://a.com/m.mpd').variants[0]!.needsFfmpeg).toBe(true);
  });

  it('detects DRM and live manifests', () => {
    const drm = mpd(`<AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>${template}<Representation id="v" bandwidth="1"/></AdaptationSet>`);
    expect(isProtectedMpd(drm)).toBe(true);
    expect(isProtectedMpd(drm.replaceAll('ContentProtection', 'cenc:ContentProtection'))).toBe(true);
    expect(isProtectedMpd(manifest)).toBe(false);
    expect(parseDash(drm, 'https://a.com/m.mpd').protected).toBe(true);
    const variant = { id: 'x', kind: 'dash' as const, url: 'https://a.com/m.mpd' };
    expect(() => loadDashTracks(drm, variant.url, variant)).toThrow();
    const live = mpd('', 'type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z"');
    expect(() => loadDashTracks(live, variant.url, variant)).toThrow(/Live/);
  });
});

describe('fetchBytes', () => {
  it('retries server errors, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2])));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchBytes('https://a.com/s', { backoffMs: 1 })).toEqual(new Uint8Array([1, 2]));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it('gives up after three retries', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchBytes('https://a.com/s', { backoffMs: 1 })).rejects.toMatchObject({ code: 'network' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.unstubAllGlobals();
  });

  it('reports expired links at once, and sends the byte range', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      fetchBytes('https://a.com/s', { byteRange: { offset: 100, length: 50 } }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]).toMatchObject({
      credentials: 'include',
      headers: { Range: 'bytes=100-149' },
    });
    vi.unstubAllGlobals();
  });
});
