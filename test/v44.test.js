'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scanner = require('../src/main/scanner');
const steam = require('../src/main/steam');

function touch(p, size) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fh = fs.openSync(p, 'w');
  fs.ftruncateSync(fh, size);
  fs.closeSync(fh);
}

// Minimal .lnk fixture with an ANSI path and optional Unicode path.
function makeLnk(targetAnsi, withUnicode) {
  const aBytes = Buffer.from(`${targetAnsi}\0`, 'latin1');
  const uBytes = withUnicode ? Buffer.from(`${targetAnsi}\0`, 'utf16le') : Buffer.alloc(0);
  const headerSize = withUnicode ? 36 : 28;
  const volOff = headerSize;
  const baseOff = volOff + 16;
  const uOff = withUnicode ? baseOff + aBytes.length : 0;
  const total = baseOff + aBytes.length + uBytes.length;
  const h = Buffer.alloc(76);
  h.writeUInt32LE(0x4c, 0);
  h.writeUInt32LE(withUnicode ? 0x82 : 0x02, 20); // HasLinkInfo [+ Unicode]
  const info = Buffer.alloc(total);
  info.writeUInt32LE(total, 0);
  info.writeUInt32LE(headerSize, 4);
  info.writeUInt32LE(0x01, 8); // VolumeIDAndLocalBasePath
  info.writeUInt32LE(volOff, 12);
  info.writeUInt32LE(baseOff, 16);
  info.writeUInt32LE(0, 20);
  info.writeUInt32LE(0, 24);
  if (withUnicode) {
    info.writeUInt32LE(uOff, 28);
    info.writeUInt32LE(0, 32);
  }
  info.writeUInt32LE(16, volOff); // minimal VolumeID
  info.writeUInt32LE(3, volOff + 4);
  aBytes.copy(info, baseOff);
  if (withUnicode) uBytes.copy(info, uOff);
  return Buffer.concat([h, info]);
}

describe('lnk exe signal', () => {
  it('parses ANSI and Unicode LinkInfo targets, rejects junk', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'));
    try {
      const target = 'C:\\Games\\SomeGame\\game.exe';
      const a = path.join(td, 'a.lnk');
      const u = path.join(td, 'u.lnk');
      fs.writeFileSync(a, makeLnk(target, false));
      fs.writeFileSync(u, makeLnk(target, true));
      assert.equal(scanner.parseLnkTarget(a), target);
      assert.equal(scanner.parseLnkTarget(u), target);
      fs.writeFileSync(path.join(td, 'junk.lnk'), Buffer.from('not a shortcut'));
      assert.equal(scanner.parseLnkTarget(path.join(td, 'junk.lnk')), null);
      assert.equal(scanner.parseLnkTarget(path.join(td, 'missing.lnk')), null);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it('desktop shortcut outranks size/name heuristics', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'lnk-'));
    try {
      const dir = path.join(td, 'SomeGame');
      touch(path.join(dir, 'aaa.exe'), 10_000_000);
      touch(path.join(dir, 'bbb.exe'), 5_000_000);
      const plain = scanner.scanGames(td, { maxDepth: 1 });
      assert.equal(path.basename(plain[0].exePath), 'aaa.exe');
      const linkMap = new Map([[dir.toLowerCase(), path.join(dir, 'bbb.exe')]]);
      const boosted = scanner.scanGames(td, { maxDepth: 1, linkMap });
      assert.equal(path.basename(boosted[0].exePath), 'bbb.exe');
      assert.equal(boosted[0].lnkBoosted, true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('depth 3 chains', () => {
  it('keeps a title/Game layout at the parent even at depth 3', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-'));
    try {
      touch(path.join(td, 'Sample Title', 'Game', 'sampletitle.exe'), 60_000_000);
      for (const d of [2, 3]) {
        const games = scanner.scanGames(td, { maxDepth: d });
        assert.equal(games.length, 1);
        assert.equal(path.basename(games[0].folder), 'Sample Title');
        assert.equal(path.basename(games[0].exePath), 'sampletitle.exe');
        assert.equal(games[0].displayName, 'Sample Title');
      }
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
  it('attributes Outer/Mid/Game to Game at depth 3, Mid at depth 2', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-'));
    try {
      touch(path.join(td, 'Outer', 'Mid', 'Game', 'game.exe'), 10_000_000);
      const d2 = scanner.scanGames(td, { maxDepth: 2 });
      assert.equal(d2.length, 1);
      assert.equal(path.basename(d2[0].folder), 'Mid');
      assert.equal(path.basename(d2[0].exePath), 'game.exe');
      const d3 = scanner.scanGames(td, { maxDepth: 3 });
      assert.equal(d3.length, 1);
      assert.equal(path.basename(d3[0].folder), 'Game');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('orphan cap', () => {
  it('reports truncation instead of silently dropping', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-'));
    try {
      for (let i = 0; i < 5; i++) touch(path.join(td, `G${i}`, 'game.exe'), 10_000_000);
      const full = scanner.scanOrphans(td, new Set());
      assert.equal(full.games.length, 5);
      assert.equal(full.truncated, false);
      const capped = scanner.scanOrphans(td, new Set(), { limit: 2 });
      assert.equal(capped.games.length, 2);
      assert.equal(capped.truncated, true);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('stale shortcut pruning', () => {
  it('lists only our tagged shortcuts with missing exes', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-'));
    try {
      const real = path.join(td, 'real.exe');
      touch(real, 1000);
      const entries = [
        { AppName: 'Gone', Exe: `"${path.join(td, 'gone.exe')}"`, tags: { 0: 'SGDB Manager' } },
        { AppName: 'Here', Exe: `"${real}"`, tags: { 0: 'SGDB Manager' } },
        { AppName: 'Foreign', Exe: `"${path.join(td, 'gone.exe')}"`, tags: {} },
      ];
      const stale = steam.findStaleShortcuts(entries);
      assert.equal(stale.length, 1);
      assert.equal(stale[0].display, 'Gone');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
