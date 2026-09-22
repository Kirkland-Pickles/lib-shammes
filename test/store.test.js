'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/main/store');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('folder depths', () => {
  it('loads existing folder depths and preserves zero', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'config-'));
    const previous = process.env.APPDATA;
    process.env.APPDATA = td;
    try {
      store.save({ ...store.DEFAULTS, games_roots: ['C:/Games', 'D:/Single'], scan_depth: 2,
        folder_depths: { [store.folderKey('D:/Single')]: 0 } });
      const cfg = store.load();
      assert.equal(cfg.folder_depths[store.folderKey('C:/Games')], 2);
      assert.equal(cfg.folder_depths[store.folderKey('D:/Single')], 0);
      store.save(cfg);
      assert.deepEqual(store.load().folder_depths, cfg.folder_depths);
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('saved SGDB matches', () => {
  it('keys matches by full folder path', () => {
    const cfg = { sgdb_map: {}, sgdb_cache: {} };
    store.rememberSgdb(cfg, 'C:/Games/Game', 10);
    store.rememberSgdb(cfg, 'D:\\Other\\Game\\', 20);
    assert.equal(store.sgdbIdFor(cfg, 'c:\\games\\game'), 10);
    assert.equal(store.sgdbIdFor(cfg, 'D:/Other/Game'), 20);
    assert.equal(store.sgdbIdFor(cfg, 'E:\\Game'), null);
  });
});
