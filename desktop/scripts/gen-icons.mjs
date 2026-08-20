// Generate placeholder Exo icons (solid color + lighter square) with no deps.
// Replace with real branding via `bunx tauri icon <source.png>` before release.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Dark base with a centered lighter block placeholder.
const BASE = [16, 24, 40, 255];   // #101828
const MARK = [94, 234, 212, 255]; // #5EEAD4

function png(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const lo = Math.floor(size * 0.3), hi = Math.ceil(size * 0.7);
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const inMark = x >= lo && x < hi && y >= lo && y < hi;
      const px = inMark ? MARK : BASE;
      raw.set(px, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const p32 = png(32), p128 = png(128), p256 = png(256);
writeFileSync(join(out, "32x32.png"), p32);
writeFileSync(join(out, "128x128.png"), p128);
writeFileSync(join(out, "128x128@2x.png"), p256);

// ICO: single PNG-compressed 32x32 entry (valid on Windows Vista+).
const icoHeader = Buffer.alloc(6);
icoHeader.writeUInt16LE(1, 2); // type: icon
icoHeader.writeUInt16LE(1, 4); // count
const icoEntry = Buffer.alloc(16);
icoEntry[0] = 32; icoEntry[1] = 32;
icoEntry.writeUInt16LE(1, 4);  // planes
icoEntry.writeUInt16LE(32, 6); // bpp
icoEntry.writeUInt32LE(p32.length, 8);
icoEntry.writeUInt32LE(22, 12); // offset
writeFileSync(join(out, "icon.ico"), Buffer.concat([icoHeader, icoEntry, p32]));

// ICNS: ic07 (128 PNG) + ic08 (256 PNG).
const icnsEntry = (type, data) => {
  const h = Buffer.alloc(8);
  h.write(type, 0, "ascii");
  h.writeUInt32BE(data.length + 8, 4);
  return Buffer.concat([h, data]);
};
const entries = Buffer.concat([icnsEntry("ic07", p128), icnsEntry("ic08", p256)]);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, "ascii");
icnsHeader.writeUInt32BE(entries.length + 8, 4);
writeFileSync(join(out, "icon.icns"), Buffer.concat([icnsHeader, entries]));

console.log("icons written to", out);
