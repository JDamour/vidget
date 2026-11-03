// Renders the toolbar icon (a down arrow into a tray) to PNG with no image library.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SAMPLES = 4;

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}

function inRoundedRect(x, y, radius) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}

/** Arrow shaft, arrow head and tray, in a 0..1 square. */
function inGlyph(x, y) {
  const shaft = Math.abs(x - 0.5) < 0.075 && y > 0.2 && y < 0.56;
  const head = y >= 0.44 && y < 0.68 && Math.abs(x - 0.5) < 0.68 - y;
  const tray = y > 0.74 && y < 0.82 && x > 0.2 && x < 0.8;
  return shaft || head || tray;
}

function render(size) {
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if (!inRoundedRect(x, y, 0.22)) continue;
          bg += 1;
          if (inGlyph(x, y)) fg += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const mix = bg ? fg / bg : 0;
      const offset = 1 + px * 4;
      row[offset] = Math.round(37 + (255 - 37) * mix);
      row[offset + 1] = Math.round(99 + (255 - 99) * mix);
      row[offset + 2] = Math.round(235 + (255 - 235) * mix);
      row[offset + 3] = Math.round((bg / total) * 255);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icon', { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(`public/icon/${size}.png`, render(size));
