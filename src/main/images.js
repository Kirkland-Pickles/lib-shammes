'use strict';
/* Steam grid and shortcut-icon helpers. ICO files embed PNG bytes directly.
   Non-PNG sources get grid art only. */
const fs = require('fs');
const path = require('path');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function extFromUrl(url, fallback = '.png') {
  const p = String(url || '').split('?')[0].toLowerCase();
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    if (p.endsWith(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  }
  return fallback;
}

function isWebp(data) {
  return data.length > 12 && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

function isPng(data) {
  return data.length > 8 && data.subarray(0, 8).equals(PNG_SIG);
}

/** Save grid bytes. Animated SGDB assets are WebP but Steam only shows them
 *  with a .png name - so force .png in that case (bytes untouched). */
function saveGridBytes(data, dest) {
  let out = String(dest);
  if (isWebp(data) && path.extname(out).toLowerCase() !== '.png') {
    out = out.slice(0, -path.extname(out).length) + '.png';
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, data);
  return out;
}

function pngSize(data) {
  // IHDR starts at byte 16: width + height, big-endian uint32.
  if (!isPng(data) || data.length < 24) return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Write a single-image ICO embedding the PNG bytes. Returns path or null
 *  when the source isn't a PNG (caller falls back to grid art only). */
function writePngIco(pngBytes, destIco) {
  if (!isPng(pngBytes)) return null;
  const size = pngSize(pngBytes) || { width: 256, height: 256 };
  const w = size.width >= 256 ? 0 : size.width; // 0 means 256 in ICO
  const h = size.height >= 256 ? 0 : size.height;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(w, 0);
  entry.writeUInt8(h, 1);
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBytes.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // data offset
  fs.mkdirSync(path.dirname(destIco), { recursive: true });
  fs.writeFileSync(destIco, Buffer.concat([header, entry, pngBytes]));
  return destIco;
}

function gridHasArt(gridFolder, stem, kindSuffix) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    if (fs.existsSync(path.join(gridFolder, `${stem}${kindSuffix}${ext}`))) return true;
  }
  return false;
}

module.exports = { extFromUrl, isWebp, isPng, saveGridBytes, pngSize, writePngIco, gridHasArt };
