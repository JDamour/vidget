// Builds every stream type the E2E suite needs from a synthetic test clip.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
const DURATION = 12;
const KEY_HEX = '00112233445566778899aabbccddeeff';

// The HLS and DASH muxers write init and media files into the working directory.
const ffmpegIn = (cwd, ...args) =>
  execFileSync(ffmpegInstaller.path, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit', cwd });
const ffmpeg = (...args) => ffmpegIn(out, ...args);

const dir = (name) => {
  const path = join(out, name);
  mkdirSync(path, { recursive: true });
  return path;
};

if (existsSync(join(out, 'hls-demux', 'spliced.m3u8')) && !process.argv.includes('--force')) {
  console.log('Fixtures already built.');
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const source = join(dir('direct'), 'clip.mp4');
ffmpeg(
  '-f', 'lavfi', '-i', `testsrc=duration=${DURATION}:size=640x360:rate=25`,
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION}`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-x264-params', 'nal-hrd=cbr',
  '-b:v', '800k', '-minrate', '800k', '-maxrate', '800k', '-bufsize', '800k',
  '-c:a', 'aac', '-shortest',
  '-movflags', '+faststart', source,
);

const tiny = join(dir('direct'), 'tiny.mp4');
ffmpeg('-i', source, '-t', '1', '-vf', 'scale=160:90', '-c:v', 'libx264', '-an', tiny);

// VP8, because the bundled Chromium cannot decode H.264 and the in-page button
// only appears over a video that is really playing.
ffmpeg('-i', source, '-an', '-c:v', 'libvpx', '-b:v', '600k', '-minrate', '600k', '-maxrate', '600k',
  join(dir('direct'), 'play.webm'));

const small = join(dir('direct'), 'small.mp4');
ffmpeg('-i', source, '-vf', 'scale=320:180', '-c:v', 'libx264', '-g', '25', '-c:a', 'aac', small);

const hls = (folder, ...extra) =>
  ffmpegIn(dir(folder), '-i', source, '-c', 'copy', '-f', 'hls', '-hls_time', '2',
    '-hls_playlist_type', 'vod', ...extra, 'index.m3u8');

// Muxed MPEG-TS at two qualities, behind a master playlist.
const smallHls = join(dir('hls-ts'), 'low');
mkdirSync(smallHls, { recursive: true });
ffmpeg('-i', small, '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  join(smallHls, 'index.m3u8'));
hls('hls-ts/high');
writeFileSync(join(out, 'hls-ts', 'master.m3u8'), `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"
high/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.64000d,mp4a.40.2"
low/index.m3u8
`);

// AES-128 clear key.
const aes = dir('hls-aes');
writeFileSync(join(aes, 'video.key'), Buffer.from(KEY_HEX, 'hex'));
writeFileSync(join(aes, 'key-info.txt'), `video.key\n${join(aes, 'video.key')}\n`);
hls('hls-aes', '-hls_key_info_file', join(aes, 'key-info.txt'));

// CMAF segments.
hls('hls-fmp4', '-hls_segment_type', 'fmp4');

// Demuxed: video and audio in separate MPEG-TS renditions.
const demux = dir('hls-demux');
for (const [name, map] of [['video', ['-an']], ['audio', ['-vn']]]) {
  const folder = join(demux, name);
  mkdirSync(folder, { recursive: true });
  ffmpeg('-i', source, ...map, '-c', 'copy', '-f', 'hls', '-hls_time', '2',
    '-hls_playlist_type', 'vod', join(folder, 'index.m3u8'));
}
writeFileSync(join(demux, 'master.m3u8'), `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
video/index.m3u8
`);

// A 4 s section spliced before the full clip, so the clock restarts at the join.
const splice = (folder) => {
  const entries = readFileSync(join(folder, 'index.m3u8'), 'utf8').match(/#EXTINF:.*\n.+\n/g);
  writeFileSync(join(folder, 'spliced.m3u8'), `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-PLAYLIST-TYPE:VOD
${entries.slice(0, 2).join('')}#EXT-X-DISCONTINUITY
${entries.join('')}#EXT-X-ENDLIST
`);
};
splice(join(out, 'hls-ts', 'high'));
splice(join(demux, 'video'));
splice(join(demux, 'audio'));
writeFileSync(join(demux, 'spliced.m3u8'), `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/spliced.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
video/spliced.m3u8
`);

// DASH with separate fMP4 audio and video.
ffmpegIn(dir('dash'), '-i', source, '-c', 'copy', '-map', '0:v', '-map', '0:a', '-f', 'dash',
  '-seg_duration', '2', '-use_template', '1', '-use_timeline', '0',
  '-init_seg_name', 'init-$RepresentationID$.m4s',
  '-media_seg_name', 'chunk-$RepresentationID$-$Number$.m4s',
  'manifest.mpd');

// Whole fragmented files, one per track, as Facebook and Instagram stream them.
for (const [name, map] of [['video', '-an'], ['audio', '-vn']]) {
  ffmpeg('-i', source, map, '-c', 'copy',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof+global_sidx', '-frag_duration', '2000000',
    join(dir('tracks'), `${name}.mp4`));
}

// Stand-ins for DRM streams. Only the signaling matters: they must be refused.
writeFileSync(join(dir('drm'), 'sample-aes.m3u8'), `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://license",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:20,
nope.ts
#EXT-X-ENDLIST
`);
const mpd = readFileSync(join(out, 'dash', 'manifest.mpd'), 'utf8').replace(
  /(<AdaptationSet[^>]*>)/,
  '$1<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>',
);
writeFileSync(join(out, 'dash', 'drm.mpd'), mpd);

// A Referer-gated copy of the direct file, served only with the right Referer.
copyFileSync(source, join(dir('gated'), 'clip.mp4'));

console.log('Fixtures written to', out);
