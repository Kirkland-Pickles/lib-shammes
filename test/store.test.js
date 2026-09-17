'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/main/store');

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
