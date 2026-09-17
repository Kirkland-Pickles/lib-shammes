'use strict';
// Expected IDs come from the original v1-v3 Python implementation.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const steam = require('../src/main/steam');

describe('shortcut ids', () => {
  it('matches the Python vectors', () => {
    const exe = '"C:\\Games\\Foo\\foo.exe"';
    assert.equal(steam.shortcutId(exe, 'Foo'), 4101564039);
    assert.equal(steam.appidSigned(4101564039), -193403257);
    assert.equal(steam.gridStemFor(exe, 'Foo'), '4101564039');
  });

  it('always sets the high bit and stays in u32 range', () => {
    for (const [exe, name] of [['a', 'b'], ['C:\\x\\y.exe', 'Game'], ['"', '']]) {
      const id = steam.shortcutId(exe, name);
      assert.ok(Number.isInteger(id) && id >= 0 && id <= 0xffffffff);
      assert.ok(id & 0x80000000, 'high bit must be set');
    }
  });

  it('produces the documented grid filenames', () => {
    const path = require('path');
    const stem = '4101564039';
    assert.equal(path.basename(steam.artDest('g', stem, 'wide', '.png')), '4101564039.png');
    assert.equal(path.basename(steam.artDest('g', stem, 'grid', '.png')), '4101564039p.png');
    assert.equal(path.basename(steam.artDest('g', stem, 'hero', '.jpg')), '4101564039_hero.jpg');
    assert.equal(path.basename(steam.artDest('g', stem, 'logo', '.png')), '4101564039_logo.png');
    assert.equal(path.basename(steam.artDest('g', stem, 'icon', '.png')), '4101564039_icon.png');
  });
});
