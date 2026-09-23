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

describe('game folder depth', () => {
  it('uses the selected folder at depth zero and searches inside it for launchers', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-'));
    try {
      touch(path.join(td, 'Sample Title', 'Game', 'sampletitle.exe'), 60_000_000);
      for (const [root, depth] of [[path.join(td, 'Sample Title'), 0], [td, 1]]) {
        const games = scanner.scanGames(root, { maxDepth: depth });
        assert.equal(games.length, 1);
        assert.equal(path.basename(games[0].folder), 'Sample Title');
        assert.equal(path.basename(games[0].exePath), 'sampletitle.exe');
        assert.equal(games[0].displayName, 'Sample Title');
      }
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
  it('obeys the selected level even when a parent has an exe', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-'));
    try {
      touch(path.join(td, 'Publisher', 'launcher.exe'), 1_000_000);
      touch(path.join(td, 'Publisher', 'First Game', 'first.exe'), 2_000_000);
      touch(path.join(td, 'Publisher', 'Second Game', 'second.exe'), 2_000_000);
      const games = scanner.scanGames(td, { maxDepth: 2 });
      assert.deepEqual(games.map((g) => path.basename(g.folder)), ['First Game', 'Second Game']);
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

describe('executable search', () => {
  it('lists every executable separately down to depth ten', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'executables-'));
    try {
      const first = path.join(td, 'game.exe');
      const second = path.join(td, 'uninstall.exe');
      const utility = path.join(td, 'redist', '7za.exe');
      const tenth = path.join(td, ...Array(10).fill('nested'), 'last.exe');
      const eleventh = path.join(path.dirname(tenth), 'nested', 'too-deep.exe');
      for (const file of [first, second, utility, tenth, eleventh]) touch(file, 1);
      const { games, truncated } = scanner.findExecutables(td, new Set());
      assert.deepEqual(new Set(games.map((g) => g.exePath)), new Set([first, second, utility, tenth]));
      assert.equal(new Set(games.map((g) => g.folder)).size, 4);
      assert.ok(games.every((g) => g.candidates.length === 1 && g.startDir === path.dirname(g.exePath)));
      assert.ok(games.every((g) => g.fromExecutableSearch));
      assert.equal(games.find((g) => g.exePath === second).idMethod, 'folder');
      assert.equal(truncated, false);
      const remaining = scanner.findExecutables(td, new Set([first.toUpperCase()]));
      assert.equal(remaining.games.length, 3);
      assert.ok(remaining.games.every((g) => g.exePath !== first));
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it('reports truncation instead of silently dropping', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-'));
    try {
      for (let i = 0; i < 5; i++) touch(path.join(td, `G${i}`, 'game.exe'), 10_000_000);
      const full = scanner.findExecutables(td, new Set());
      assert.equal(full.games.length, 5);
      assert.equal(full.truncated, false);
      const capped = scanner.findExecutables(td, new Set(), { limit: 2 });
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
