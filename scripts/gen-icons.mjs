/**
 * Writes the extension's PNG icons without pulling in an image library: a PNG is
 * just a few length-prefixed chunks around a zlib stream, and zlib ships with Node.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'packages/extension/public/icons');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Dark tile with the two capture-button colours quartered across it. */
function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const inset = size * 0.06;
  const put = (x, y, r, g, b, a) => {
    const i = (y * size + x) * 4;
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = roundedCoverage(x, y, inset, size - inset, radius);
      if (alpha === 0) { put(x, y, 0, 0, 0, 0); continue; }
      const u = (x - inset) / (size - inset * 2);
      const v = (y - inset) / (size - inset * 2);
      let color;
      if (u < 0.5 && v < 0.5) color = [30, 155, 245];
      else if (u >= 0.5 && v >= 0.5) color = [245, 197, 24];
      else color = [11, 11, 13];
      put(x, y, color[0], color[1], color[2], Math.round(alpha * 255));
    }
  }
  return pixels;
}

/** 4x supersampled coverage so the rounded corners are not jagged. */
function roundedCoverage(x, y, min, max, radius) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4;
      const py = y + (sy + 0.5) / 4;
      if (px < min || px > max || py < min || py > max) continue;
      const cx = Math.min(Math.max(px, min + radius), max - radius);
      const cy = Math.min(Math.max(py, min + radius), max - radius);
      if (Math.hypot(px - cx, py - cy) <= radius) hits++;
    }
  }
  return hits / 16;
}

await fs.mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await fs.writeFile(path.join(outDir, `icon-${size}.png`), encodePng(size, draw(size)));
}
console.log(`  icons -> ${path.relative(process.cwd(), outDir)}`);
