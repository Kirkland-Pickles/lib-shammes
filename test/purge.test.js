'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const steam = require('../src/main/steam');
const store = require('../src/main/store');

function fakeEntry(appid, name, tags) {
  return {
    appid, AppName: name, Exe: `"C:\\G\\${name}\\g.exe"`, StartDir: `C:\\G\\${name}`,
    icon: '', ShortcutPath: '', LaunchOptions: '', IsHidden: 0, AllowDesktopConfig: 1,
    AllowOverlay: 1, OpenVR: 0, Devkit: 0, DevkitGameID: '', DevkitOverrideAppID: 0,
    LastPlayTime: 0, FlatpakAppID: '', tags,
  };
}

describe('planPurge', () => {
  it('removes journaled + tagged shortcuts, restores fields, deletes only untouched files', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-'));
    try {
      const grid = path.join(td, 'grid');
      fs.mkdirSync(grid, { recursive: true });
      const ours = path.join(grid, '2000000001p.png');
      const theirs = path.join(grid, '2000000002p.png');
      fs.writeFileSync(ours, Buffer.alloc(100, 1));
      fs.writeFileSync(theirs, Buffer.alloc(100, 2));
      // Keep files changed after they were recorded.
      const changed = path.join(grid, '2000000001_hero.png');
      fs.writeFileSync(changed, Buffer.alloc(50, 9));
      const entries = [
        fakeEntry(-100, 'Ours', { 0: 'SGDB Manager' }),
        fakeEntry(-200, 'Foreign', {}),
      ];
      // entry appids are signed; journal uses signed too
      const changes = {
        shortcuts: [{ appid: -100, appName: 'Ours' }],
        fields: [{ appid: -200, field: 'AppName', before: 'Foreign Original' }],
        files: [
          { path: ours, size: 100, mtimeMs: fs.statSync(ours).mtimeMs },
          { path: changed, size: 9999, mtimeMs: 0 },
        ],
      };
      const sig = (p) => {
        try {
          const st = fs.statSync(p);
          return { size: st.size, mtimeMs: st.mtimeMs };
        } catch { return null; }
      };
      const plan = steam.planPurge(entries, changes, [grid], sig);
      assert.deepEqual(plan.removeAppids, [-100]);
      assert.deepEqual(plan.restoreFields, [{ appid: -200, field: 'AppName', before: 'Foreign Original' }]);
      assert.ok(plan.deleteFiles.some((f) => f.path === ours));
      assert.ok(!plan.deleteFiles.some((f) => f.path === theirs), 'never touch unjournaled files');
      assert.ok(plan.skippedFiles.some((f) => f.path === changed), 'changed-by-user files are kept');
      assert.ok(plan.names.includes('Ours'));
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });

  it('is empty when nothing was ever changed', () => {
    const plan = steam.planPurge([fakeEntry(5, 'X', {})], store.blankChanges(), []);
    assert.deepEqual(plan.removeAppids, []);
    assert.deepEqual(plan.restoreFields, []);
    assert.deepEqual(plan.deleteFiles, []);
  });
});

describe('listInstalledGames', () => {
  it('parses appmanifests across libraries, dedupes', () => {
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'libs-'));
    try {
      const lib1 = path.join(td, 'Steam');
      const lib2 = path.join(td, 'Lib2');
      for (const [lib, id, name, dir] of [
        [lib1, 10, 'First Game', 'first-game'],
        [lib1, 20, 'Second Game', 'second-game'],
        [lib2, 10, 'First Game', 'first-game'],
      ]) {
        fs.mkdirSync(path.join(lib, 'steamapps'), { recursive: true });
        fs.writeFileSync(path.join(lib, 'steamapps', `appmanifest_${id}.acf`),
          `"AppState"\n{\n\t"appid"\t\t"${id}"\n\t"name"\t\t"${name}"\n\t"installdir"\t\t"${dir}"\n}\n`);
      }
      const games = steam.listInstalledGames(lib1);
      // lib2 exists but is not linked from lib1 yet.
      assert.deepEqual(games.map((g) => g.name), ['First Game', 'Second Game']);
      assert.ok(games[0].installdir.endsWith(path.join('common', 'first-game')));
      // Link lib2. Duplicate app 10 should still appear once.
      fs.writeFileSync(path.join(lib1, 'steamapps', 'libraryfolders.vdf'),
        `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${lib1.replace(/\\/g, '\\\\')}"\n\t}\n`
        + `\t"1"\n\t{\n\t\t"path"\t\t"${lib2.replace(/\\/g, '\\\\')}"\n\t}\n}\n`);
      const merged = steam.listInstalledGames(lib1);
      assert.equal(merged.length, 2);
      assert.equal(merged.filter((g) => g.appid === 10).length, 1);
    } finally {
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('change journal', () => {
  it('round-trips through the file', () => {
    const prev = process.env.APPDATA;
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'chg-'));
    try {
      process.env.APPDATA = td;
      const ch = store.loadChanges();
      assert.deepEqual(ch, { shortcuts: [], fields: [], files: [] });
      ch.shortcuts.push({ appid: -5, appName: 'X' });
      store.saveChanges(ch);
      assert.deepEqual(store.loadChanges(), ch);
    } finally {
      if (prev === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prev;
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});

describe('config patch allowlist', () => {
  it('keeps known keys and drops unknown ones plus __proto__', () => {
    // Parsed, not a literal: only JSON makes __proto__ an own key.
    const evil = JSON.parse('{"api_key":"k","evil":1,"__proto__":{"x":1}}');
    assert.deepEqual(store.sanitizePatch(evil), { api_key: 'k' });
    assert.ok(!('x' in {}));
  });
  it('tolerates non-objects', () => {
    assert.deepEqual(store.sanitizePatch(null), {});
    assert.deepEqual(store.sanitizePatch('x'), {});
  });
});

describe('atomic writes', () => {
  it('store.save round-trips and leaves no tmp files', () => {
    const prev = process.env.APPDATA;
    const td = fs.mkdtempSync(path.join(os.tmpdir(), 'chg-'));
    try {
      process.env.APPDATA = td;
      const cfg = store.load();
      cfg.api_key = 'k';
      store.save(cfg);
      assert.equal(store.load().api_key, 'k');
      assert.equal(fs.readdirSync(store.configDir()).filter((f) => f.endsWith('.tmp')).length, 0);
    } finally {
      if (prev === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = prev;
      fs.rmSync(td, { recursive: true, force: true });
    }
  });
});
