'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const steam = require('../src/main/steam');
const store = require('../src/main/store');
const { SGDBClient } = require('../src/main/sgdb');

function main(t, metadata = {}, desktopOverrides = {}, steamOverrides = {}, save = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-art-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { ...structuredClone(store.DEFAULTS), steam_path: root, steam_user_id: '1' };
  const handlers = new Map();
  const calls = [];
  let changes = store.blankChanges();
  const filename = path.join(__dirname, '../src/main/main.js');
  const realRequire = createRequire(filename);
  const mocks = {
    './desktop': { createDesktop: (options) => ({ ...realRequire('./desktop').createDesktop(options), ...desktopOverrides }) },
    electron: {
      app: { isPackaged: true, whenReady: () => ({ then() {} }), on() {} },
      Menu: { setApplicationMenu() {} }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    },
    './store': { ...store, load: () => cfg, save, configDir: () => path.join(root, 'appdata'),
      loadChanges: () => structuredClone(changes), saveChanges: (value) => { changes = structuredClone(value); } },
    './steam': { ...steam, normalizeSteamPath: (value) => value,
      loadEntries: () => { calls.push('read shortcuts'); return []; },
      saveEntries: () => { calls.push('write shortcuts'); throw new Error('Native artwork must not write shortcuts'); }, ...steamOverrides },
    './sgdb': { SGDBClient: class {
      steamMetadata = async () => { calls.push('metadata'); if (metadata instanceof Error) throw metadata; return metadata; };
      gridsVertical = async () => [{ id: 9, url: 'https://test.invalid/art.jpg' }];
      logos = this.gridsVertical;
      icons = this.gridsVertical;
      downloadBytes = async () => { calls.push('download'); return Buffer.from('new artwork'); };
    } },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (name) => mocks[name] || realRequire(name), __dirname: path.dirname(filename),
    process: { argv: [], platform: process.platform }, Buffer,
  }, { filename });
  return { root, calls, cfg, grid: steam.gridDir(root, '1'), changes: () => changes,
    download: (row = native(), options = {}) => handlers.get('art:download')(null, { rows: [row], kinds: ['grid'], onlyMissing: false, ...options }),
    invoke: (name, req) => handlers.get(name)(null, req) };
}

function native(art = {}, appid = 123) {
  return { source: 'steam', folder: `steam:${appid}`, steamAppid: appid, display: 'Game', sgdbId: 7, art };
}

it('returns saved Desktop shortcuts when config persistence fails', async (t) => {
  const row = { id: 'link:saved', display: 'Game', shortcut: 'saved.lnk' };
  const env = main(t, {}, { apply: async () => [{ id: 'exe:new', ok: true, row }] }, {}, () => { throw new Error('config denied'); });
  const [result] = await env.invoke('desktop:apply', []);
  assert.equal(result.ok, true);
  assert.equal(result.row.shortcut, row.shortcut);
  assert.match(result.warning, /config denied/);
  assert.equal(env.cfg.desktop_overrides[row.id].display, 'Game');
});

it('retains explicitly added executables separately from scan roots and ignores missing files', async (t) => {
  const env = main(t);
  const exe = path.join(env.root, 'manual.exe');
  fs.writeFileSync(exe, 'fixture');
  env.invoke('cfg:set', { steam_executables: [{ folder: exe, exePath: exe }, { folder: exe, exePath: exe },
    { exePath: path.join(env.root, 'missing.exe') }] });
  const rows = await env.invoke('scan:start', { roots: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exePath, exe);
  assert.equal(env.cfg.desktop_executables.length, 0);
});

it('replaces all Desktop icon choices when skipping is off without writing shortcuts', async (t) => {
  let downloaded = 0;
  const env = main(t, {}, { cacheIcon: async () => { downloaded++; return 'cached.ico'; } });
  const rows = [{ id: 'new', sgdbId: 7 }, { id: 'existing', sgdbId: 7, icon: 'custom.ico' },
    { id: 'manual', sgdbId: 7, iconChoice: { file: 'chosen.ico' } },
    { id: 'exe', sgdbId: 7, iconChoice: { exeIcon: true } },
    { id: 'current', sgdbId: 7, iconChoice: { keepIcon: true } }, { id: 'unmatched' }];
  let results = await env.invoke('desktop:download', rows);
  assert.equal(results.filter((row) => row.choice).length, 1);
  assert.equal(results[0].id, 'new');
  assert.equal(results[0].choice.file, 'cached.ico');
  assert.equal(results[0].choice.automatic, true);
  assert.ok(results.find((row) => row.id === 'manual').skipped);
  assert.ok(results.find((row) => row.id === 'existing').skipped);
  env.cfg.only_missing = false;
  results = await env.invoke('desktop:download', rows);
  assert.deepEqual(Array.from(results.filter((row) => row.choice), (row) => row.id), ['new', 'existing', 'manual', 'exe', 'current']);
  assert.ok(results.filter((row) => row.choice).every((row) => row.choice.automatic && row.choice.id === 9));
  assert.equal(downloaded, 6);
  assert.deepEqual(env.calls, []);
});

it('updates an app-managed shortcut from the Steam list without adding a duplicate', async (t) => {
  const entries = [steam.buildEntry({ appName: 'Old name', exePath: 'C:/Games/game.exe', tags: [steam.MANAGED_TAG] })];
  let writes = 0;
  const env = main(t, {}, {}, { loadEntries: () => entries, saveEntries: () => { writes++; return null; } });
  const result = await env.invoke('steam:add', { rows: [{ source: 'shortcut', managed: true,
    shortcutIdx: 0, appid: entries[0].appid, folder: 'shortcut://fixture', display: 'New name', exe: 'C:/Games/game.exe', art: {} }], kinds: [] });
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].AppName, 'New name');
  assert.equal(writes, 1);
});

it('converts executable icon choices to image bytes for native and non-Steam games', async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB7kAAAAASUVORK5CYII=', 'base64');
  for (const source of ['steam', 'folder']) {
    const env = main(t, { icon: 'a'.repeat(40) }, { preview: async (file, index) => {
      assert.equal(file, 'chosen.exe'); assert.equal(index, 0);
      return `data:image/png;base64,${png.toString('base64')}`;
    } });
    const row = { ...native({ icon: { file: 'chosen.exe' } }), source, exe: 'C:/Games/game.exe' };
    const result = await env.download(row, { kinds: ['icon'] });
    assert.equal(result.saved, 1);
    assert.equal(result.failed, 0);
    const dest = source === 'steam' ? result.rows[0].art.icon.appliedFile
      : steam.artDest(env.grid, steam.gridStemFor(steam.quoteExe(row.exe), row.display), 'icon', '.png');
    assert.deepEqual(fs.readFileSync(dest), png);
  }
});

it('reads current artwork from the Steam cache without SGDB and prefers custom artwork', async (t) => {
  const env = main(t, new Error('metadata unavailable'));
  const cache = path.join(env.root, 'appcache', 'librarycache');
  const files = { grid: 'capsule-hash/library_capsule.jpg', hero: 'hero-hash/library_hero.jpg',
    logo: 'logo.png', wide: 'header.jpg', icon: 'a'.repeat(40) + '.jpg' };
  const parts = [Buffer.from([0, 0, 0, 48, 0, 0]), Buffer.from('123\0')];
  for (const [index, relative] of Object.values(files).entries()) {
    const file = path.join(cache, '123', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'cached artwork');
    parts.push(Buffer.from(`\x01${index}f\0${relative}\0`));
  }
  parts.push(Buffer.from([8, 8, 8, 8]));
  fs.writeFileSync(path.join(cache, 'assetcache.vdf'), Buffer.concat(parts));
  for (const [kind, relative] of Object.entries(files)) {
    const item = await env.invoke('art:current', { row: native(), kind });
    assert.equal(item.file, path.join(cache, '123', relative));
    assert.ok(item.url.endsWith(Buffer.from('cached artwork').toString('base64')));
  }
  fs.mkdirSync(env.grid, { recursive: true });
  const custom = path.join(env.grid, '123p.png');
  fs.writeFileSync(custom, 'custom artwork');
  assert.equal((await env.invoke('art:current', { row: native(), kind: 'grid' })).file, custom);
  assert.equal((await env.invoke('art:current', { row: native(), kind: 'grid', stock: true })).file,
    path.join(cache, '123', files.grid));
  assert.equal(await env.invoke('art:current', { row: native(), kind: 'invalid' }), null);
  assert.deepEqual(env.calls, []);
});

it('checks stock artwork by the original Steam AppID, not the chosen SGDB listing', async () => {
  const client = new SGDBClient('test');
  const requests = [];
  client._getJson = async (url) => {
    requests.push(url);
    return url.startsWith('/games/steam/') ? { id: 7, name: 'Game' } : {
      external_platform_data: { steam: [{ id: '456', metadata: { icon: 'wrong' } }, { id: '123', metadata: { icon: 'right' } }] },
    };
  };
  assert.equal((await client.steamMetadata(123)).icon, 'right');
  assert.deepEqual(requests, ['/games/steam/123', '/games/id/7?platformdata=steam']);
  await assert.rejects(client.steamMetadata(789), /Could not check stock/);
});

it('skips stock and custom artwork when onlyMissing is on', async (t) => {
  for (const stock of [{ library_capsule: 'capsule.jpg' }, { library_capsule_full: { image2x: { english: 'capsule.jpg' } } }]) {
    const env = main(t, stock);
    const result = await env.download(native(), { onlyMissing: true });
    assert.equal(result.saved, 0);
    assert.equal(result.failed, 0);
    assert.ok(!env.calls.includes('download'));
  }
  const env = main(t, new Error('metadata unavailable'));
  fs.mkdirSync(env.grid, { recursive: true });
  const custom = path.join(env.grid, '123p.png');
  fs.writeFileSync(custom, 'custom');
  const result = await env.download(native(), { onlyMissing: true });
  assert.equal(result.saved, 0);
  assert.equal(fs.readFileSync(custom, 'utf8'), 'custom');
  assert.ok(!env.calls.includes('metadata'));
});

it('allows automatic replacement when onlyMissing is off and manual replacement when it is on', async (t) => {
  for (const [manual, metadata] of [
    [false, { library_capsule: 'stock.jpg' }], [true, { library_capsule: 'stock.jpg' }],
    [false, new Error('metadata unavailable')], [true, new Error('metadata unavailable')],
  ]) {
    const env = main(t, metadata);
    const row = native(manual ? { grid: { url: 'https://test.invalid/chosen.jpg' } } : {});
    const result = await env.download(row, { onlyMissing: manual });
    assert.equal(result.saved, 1);
    assert.equal(result.failed, 0);
    assert.equal(fs.readFileSync(path.join(env.grid, '123p.jpg'), 'utf8'), 'new artwork');
    assert.equal(result.rows[0].art.grid.appliedFile, path.join(env.grid, '123p.jpg'));
    assert.ok(!env.calls.includes('read shortcuts'));
    assert.ok(!env.calls.includes('write shortcuts'));
  }
});

it('restores overwritten custom artwork after repeated writes and removes the replacement extension', async (t) => {
  const env = main(t);
  fs.mkdirSync(env.grid, { recursive: true });
  const original = path.join(env.grid, '123p.png');
  const replacement = path.join(env.grid, '123p.jpg');
  fs.writeFileSync(original, 'original');
  for (let i = 0; i < 2; i++) await env.download();
  assert.equal(fs.existsSync(original), false);
  const plan = await env.invoke('steam:purge', { dryRun: true });
  assert.equal(plan.restoreFiles.length, 1);
  assert.equal(plan.deleteFiles.length, 1);
  const result = await env.invoke('steam:purge', { dryRun: false });
  assert.equal(result.failedFiles.length, 0);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  assert.equal(fs.existsSync(replacement), false);
  assert.ok(!env.calls.includes('write shortcuts'));
  assert.equal(env.changes().files.length, 0);
});

it('leaves later user artwork changes alone during Purge', async (t) => {
  const env = main(t);
  await env.download();
  const dest = path.join(env.grid, '123p.jpg');
  fs.writeFileSync(dest, 'user replacement');
  const result = await env.invoke('steam:purge', { dryRun: false });
  assert.equal(result.skippedFiles.length, 1);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'user replacement');
});

it('does not download an unticked type from an earlier automatic selection', async (t) => {
  for (const row of [native(), { ...native(), source: 'folder', folder: 'fixture', exe: 'C:/Games/game.exe' }]) {
    const env = main(t);
    const first = await env.download(row);
    assert.equal(first.rows[0].art.grid.automatic, true);
    const grid = first.rows[0].art.grid.appliedFile;
    const before = store.statSig(grid);
    env.calls.length = 0;
    const result = await env.download(first.rows[0], { kinds: ['logo'] });
    assert.equal(result.saved, 1);
    assert.equal(result.failed, 0);
    assert.equal(env.calls.filter((call) => call === 'download').length, 1);
    assert.deepEqual(store.statSig(grid), before);
  }
});

it('writes native icons to the Steam cache and restores the original icon', async (t) => {
  const hash = 'a'.repeat(40);
  const env = main(t, { icon: hash });
  const icon = path.join(env.root, 'appcache', 'librarycache', '123', `${hash}.jpg`);
  fs.mkdirSync(path.dirname(icon), { recursive: true });
  fs.writeFileSync(icon, 'original icon');
  const result = await env.download(native({ icon: { url: 'https://test.invalid/icon.png' } }), { kinds: [], onlyMissing: true });
  assert.equal(result.saved, 1);
  assert.equal(fs.readFileSync(icon, 'utf8'), 'new artwork');
  assert.equal(result.rows[0].art.icon.appliedFile, icon);
  const stock = await env.invoke('art:current', { row: native(), kind: 'icon', stock: true });
  assert.notEqual(stock.file, icon);
  assert.ok(stock.url.endsWith(Buffer.from('original icon').toString('base64')));
  await env.invoke('steam:purge', { dryRun: false });
  assert.equal(fs.readFileSync(icon, 'utf8'), 'original icon');
  assert.equal(fs.readdirSync(env.grid).length, 0);
});

