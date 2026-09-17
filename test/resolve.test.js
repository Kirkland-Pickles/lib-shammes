'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const resolve = require('../src/main/resolve');
const scanner = require('../src/main/scanner');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('resolve', () => {
  it('resolves exact aliases with Steam IDs', () => {
    const id = resolve.resolveFolder('rdr2', scanner.cleanFolderName);
    assert.equal(id.title, 'Red Dead Redemption 2');
    assert.equal(id.steamAppid, 1174180);
    assert.equal(id.method, 'alias');
    assert.ok(id.confidence >= 0.9);
  });

  it('resolves aliases after folder cleanup', () => {
    assert.equal(scanner.cleanFolderName('RDR2-Razor1911'), 'RDR2');
    const er = resolve.resolveFolder('ELDEN RING [FitGirl Repack]', scanner.cleanFolderName);
    assert.equal(er.title, 'ELDEN RING');
    assert.equal(er.steamAppid, 1245620);
  });

  it('applies pattern rules', () => {
    assert.equal(resolve.resolveFolder('fifa23', scanner.cleanFolderName).title, 'EA SPORTS FIFA 23');
    assert.equal(resolve.resolveFolder('FC25', scanner.cleanFolderName).title, 'EA SPORTS FC 25');
    assert.equal(resolve.resolveFolder('COD BO2', scanner.cleanFolderName).title, 'Call of Duty: Black Ops II');
    const ac = resolve.resolveFolder('AC Odyssey', scanner.cleanFolderName);
    assert.equal(ac.title, "Assassin's Creed Odyssey");
    assert.equal(ac.steamAppid, 812140);
  });

  it('leaves unknown folders unparsed', () => {
    const id = resolve.resolveFolder('MyCoolGame123', scanner.cleanFolderName);
    assert.equal(id.method, 'folder');
    assert.equal(id.steamAppid, null);
    assert.ok(id.title.includes('MyCoolGame'));
  });

  it('resolves exe stems incl. engine suffixes', () => {
    const w = resolve.resolveExeStem('witcher3');
    assert.ok(w && w.title.startsWith('The Witcher 3') && w.steamAppid === 292030);
    const f = resolve.resolveExeStem('FortniteClient-Win64-Shipping');
    assert.ok(f && f.title === 'Fortnite' && f.steamAppid === null);
    assert.equal(resolve.resolveExeStem('Game-Win64-Shipping'), null);
    assert.equal(resolve.resolveExeStem('uninstall'), null);
  });
});

describe('strips', () => {
  const strips = require('../src/main/strips');

  it('strips razer1911 (either spelling) like any other group', () => {
    assert.equal(scanner.cleanFolderName('RDR2-RAZER1911'), 'RDR2');
    const id = resolve.resolveFolder('RDR2-RAZER1911', scanner.cleanFolderName);
    assert.equal(id.title, 'Red Dead Redemption 2');
    assert.equal(id.steamAppid, 1174180);
  });

  it('strips dodirepacks with or without a separator', () => {
    assert.equal(scanner.cleanFolderName('Game.DODIRepacks'), 'Game');
    assert.equal(scanner.cleanFolderName('Sample Title-DODI-Repacks'), 'Sample Title');
    assert.equal(scanner.cleanFolderName('Another Sample (DODIRepacks)'), 'Another Sample');
  });

  it('never strips bare razer (hardware brand, not a group)', () => {
    assert.equal(scanner.cleanFolderName('Razer Device'), 'Razer Device');
    assert.ok(!strips.RELEASE_GROUPS.includes('razer'));
    assert.ok(strips.RELEASE_GROUPS.includes('razer1911'));
  });

  it('keeps ambiguous group words when they are part of a title', () => {
    for (const title of ['Rune Title', 'Wanted Title', 'Nova Title', 'Title Wanted', 'Title Prophet']) {
      assert.equal(scanner.cleanFolderName(title), title);
      assert.equal(strips.toSearchQuery(title), title);
    }
    assert.equal(scanner.cleanFolderName('Title-Wanted'), 'Title-Wanted');
    assert.equal(strips.toSearchQuery('Title-Wanted'), 'Title Wanted');
  });
});

describe('search fallback rule', () => {
  const strips = require('../src/main/strips');

  it('cleans scene names into search queries', () => {
    assert.equal(
      strips.toSearchQuery('Sample.Game.Title-RUNE.exe'),
      'Sample Game Title');
    assert.equal(strips.toSearchQuery('Sample-Razor1911'), 'Sample');
    assert.equal(strips.toSearchQuery('Sample Title v1.3044'), 'Sample Title');
    assert.equal(strips.toSearchQuery('Sample Title [FitGirl Repack]'), 'Sample Title');
    assert.equal(strips.toSearchQuery('Sample Title (v2.13)-CODEX'), 'Sample Title');
    assert.equal(scanner.cleanFolderName('Sample-TENOKE'), 'Sample');
    assert.equal(scanner.cleanFolderName('Game-DARKSiDERS'), 'Game');
    assert.equal(
      strips.toSearchQuery('Another.Sample.Title-VOICES38'),
      'Another Sample Title');
  });

  it('scores query recall against candidate names', () => {
    assert.equal(
      resolve.titleSimilarity('Sample Title', 'Sample: Title'), 1);
    assert.equal(
      resolve.titleSimilarity('Sample Title', 'The Sample Title: Extended Edition'), 1);
    assert.ok(
      resolve.titleSimilarity('MyCoolGame123', 'Something Else Entirely')
      < resolve.MIN_TITLE_RECALL);
    assert.equal(resolve.titleSimilarity('', 'Anything'), 0);
  });
});

describe('scanner', () => {
  function touch(p, size) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fh = fs.openSync(p, 'w');
    fs.ftruncateSync(fh, size);
    fs.closeSync(fh);
  }

  it('picks the real exe and lists every candidate', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    try {
      touch(path.join(td, 'Sample Title', 'sampletitle.exe'), 60_000_000);
      touch(path.join(td, 'Sample Title', 'uninstall.exe'), 1_000_000);
      const games = scanner.scanGames(td, { maxDepth: 2 });
      assert.equal(games.length, 1);
      assert.equal(path.basename(games[0].exePath), 'sampletitle.exe');
      assert.equal(games[0].displayName, 'Sample Title');
      assert.equal(games[0].steamAppid, null);
      assert.ok(games[0].candidates.length >= 2, 'dropdown must list every exe');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it('prefers the exe name when the folder name is garbage', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    try {
      touch(path.join(td, '98274923749879', 'Sample.Game.Title-RUNE.exe'), 60_000_000);
      const games = scanner.scanGames(td, { maxDepth: 2 });
      assert.equal(games.length, 1);
      assert.equal(games[0].displayName, 'Sample Game Title');
      assert.equal(games[0].query, 'Sample Game Title');
      assert.equal(games[0].idMethod, 'folder');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it('resolves exe stems with scene suffixes via the tables', () => {
    const w = resolve.resolveExeStem('ELDEN RING-codex');
    assert.ok(w && w.title === 'ELDEN RING' && w.steamAppid === 1245620);
    assert.equal(resolve.resolveExeStem('Sample.Game.Title-RUNE'), null);
  });

  it('handles publisher layout and rescues buried exes via orphans', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    try {
      touch(path.join(td, 'GameA', 'gamea.exe'), 10_000_000);
      touch(path.join(td, 'Publisher', 'GameB', 'gameb.exe'), 20_000_000);
      touch(path.join(td, 'Pub', 'Deep', 'd1', 'd2', 'd3', 'd4', 'deep.exe'), 20_000_000);
      const games = scanner.scanGames(td, { maxDepth: 2 });
      const names = new Set(games.map((g) => path.basename(g.folder)));
      assert.ok(names.has('GameA') && names.has('GameB'), [...names].join(','));
      const deep = games.find((g) => path.basename(g.folder) === 'Deep');
      assert.ok(deep && deep.exePath === null, 'buried exe must be missed by folder pass');
      const claimed = new Set();
      for (const g of games) {
        if (g.exePath) claimed.add(g.exePath);
        for (const c of g.candidates) claimed.add(c.path);
      }
      const orphans = scanner.scanOrphans(td, claimed);
      assert.ok(orphans.games.some((g) => path.basename(g.exePath) === 'deep.exe'), 'orphan scan must rescue it');
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
