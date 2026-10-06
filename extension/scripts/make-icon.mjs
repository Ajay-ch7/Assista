// Writes public/icon.png, the icon shown in Chrome's toolbar and on notifications. Run
// with `node scripts/make-icon.mjs` after changing it; the output is committed.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const OUT = resolve(import.meta.dirname, '../public/icon.png');
const BACKGROUND = [24, 54, 92];
const RING = [255, 196, 61];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A dark rounded square with a bright ring: a sound wave leaving a point.
const rows = [];
for (let y = 0; y < SIZE; y++) {
  const row = [0];
  for (let x = 0; x < SIZE; x++) {
    const dx = x - SIZE / 2 + 0.5;
    const dy = y - SIZE / 2 + 0.5;
    const distance = Math.hypot(dx, dy);
    const corner = Math.hypot(Math.max(Math.abs(dx) - 44, 0), Math.max(Math.abs(dy) - 44, 0));
    const inside = corner <= 20;
    const onRing = (distance > 30 && distance < 40) || distance < 12;
    const [r, g, b] = onRing ? RING : BACKGROUND;
    row.push(r, g, b, inside ? 255 : 0);
  }
  rows.push(Buffer.from(row));
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA

writeFileSync(
  OUT,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log(`Wrote ${OUT}`);
