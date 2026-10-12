'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer(api) {
  const button = {};
  const context = vm.createContext({
    window: { api }, document: { addEventListener() {}, querySelector: () => button },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8'), context);
  vm.runInContext('renderRows = () => {}; renderDetail = () => {};', context);
  return { context, button, state: vm.runInContext('S', context), refresh: () => vm.runInContext('doRefresh()', context) };
}

it('invalidates desktop cover previews when switching back to executable icons', async () => {
  const requests = [];
  const { context } = renderer({ desktopIcon: async (file, index) => { requests.push([file, index]); return file; } });
  context.game = { id: 'desktop:game', exe: 'game.exe', icon: 'custom.dll', iconIndex: 2, signature: 'before' };
  const token = () => vm.runInContext('desktopCoverToken(game)', context);
  const original = token();
  assert.equal(await vm.runInContext('desktopCardCoverSource(game)', context), 'custom.dll');
  context.game.iconChoice = { exeIcon: true };
  assert.notEqual(token(), original);
  assert.equal(await vm.runInContext('desktopCardCoverSource(game)', context), 'game.exe');
  assert.deepEqual(requests, [['custom.dll', 2], ['game.exe', undefined]]);
  delete context.game.iconChoice;
  context.game.iconIndex = 3;
  assert.notEqual(token(), original);
  context.game.iconIndex = 2;
  context.game.signature = 'after';
  assert.notEqual(token(), original);
});

it('uses suggested covers when local previews fail and resolves native games without saving a match', async () => {
  let nativeLookups = 0;
  const { context, state } = renderer({
    artCurrent: async () => ({ file: 'unreadable.png' }),
    artThumbnail: async () => { throw new Error('cannot decode'); },
    artPreviewFile: async () => { throw new Error('missing file'); },
    sgdbBySteam: async id => { assert.equal(id, 123); nativeLookups++; return { id: 7 }; },
    artList: async () => [{ thumb: 'https://test.invalid/thumb', url: 'https://test.invalid/full' }],
  });
  state.cfg = { api_key: 'fixture' };
  context.game = { source: 'steam', steamAppid: 123, art: {} };
  const cover = await vm.runInContext('cardCoverSource(game)', context);
  assert.equal(cover.src, 'https://test.invalid/thumb');
  assert.equal(cover.fallback, 'https://test.invalid/full');
  assert.equal(nativeLookups, 1);
  assert.equal(context.game.sgdbId, undefined);
  state.cfg.api_key = '';
  assert.equal(await vm.runInContext('cardCoverSource(game)', context), null);
  assert.equal(nativeLookups, 1);
});

it('shows applied grid artwork from the saved file without reselecting it', async () => {
  const { context } = renderer({
    artThumbnail: async file => { assert.equal(file, 'applied-grid.png'); return 'data:image/png;base64,saved'; },
    artCurrent: async () => { throw new Error('should use the known saved image'); },
  });
  context.game = { source: 'steam', art: { grid: { id: 9, thumb: 'https://test.invalid/thumb',
    url: 'https://test.invalid/full', appliedFile: 'applied-grid.png' } } };
  assert.equal(await vm.runInContext('cardCoverSource(game)', context), 'data:image/png;base64,saved');
});

it('keeps a grid placeholder until its image loads and retries failures on refresh', async () => {
  let requests = 0;
  const { context, state } = renderer({
    desktopIcon: async () => { requests++; return 'data:image/png;base64,fixture'; },
  });
  const image = { isConnected: true, hidden: true, dataset: { coverToken: 'desktop:fixture' } };
  const placeholder = { hidden: false };
  context.card = { isConnected: true, querySelector: selector => selector === '.game-cover' ? image : placeholder };
  context.game = { source: 'desktop', exe: 'game.exe', iconChoice: { exeIcon: true } };
  vm.runInContext('loadCardCover(game, card)', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(image.hidden, true);
  assert.equal(placeholder.hidden, false);
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(placeholder.hidden, true);
  image.onerror();
  assert.equal(image.hidden, true);
  assert.equal(placeholder.hidden, false);
  assert.equal(state.cardArtCache.size, 0);
  vm.runInContext('loadCardCover(game, card)', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
});

it('keeps failed picker choices available and retries only types that were not applied', async () => {
  const requests = [];
  const { context, state } = renderer({ artDownload: async req => {
    requests.push(req);
    const kind = requests.length === 1 ? 'grid' : 'hero';
    return { rows: [{ ...req.rows[0], art: { ...req.rows[0].art, [kind]: { ...req.rows[0].art[kind], appliedFile: `${kind}.png` } },
      appliedKinds: [kind] }], saved: 1, failed: requests.length === 1 ? 1 : 0, lines: [] };
  } });
  vm.runInContext('log = () => {}; syncCfg = async () => {}; reportArtwork = () => {}; closeArtModal = () => { S.modal = null; };', context);
  state.cfg = {};
  const row = { source: 'steam', steamAppid: 123, art: {} };
  state.modal = { row, sel: { grid: { url: 'grid' }, hero: { url: 'hero' } } };
  await vm.runInContext('applyArtModal()', context);
  assert.equal(row.art.grid.appliedFile, 'grid.png');
  assert.equal(row.art.hero, undefined);
  assert.ok(state.modal);
  await vm.runInContext('applyArtModal()', context);
  assert.deepEqual(Object.keys(requests[1].rows[0].art), ['hero']);
  assert.equal(row.art.hero.appliedFile, 'hero.png');
  assert.equal(state.modal, null);
});

it('keeps newer artwork search results when an older request finishes last', async () => {
  const pending = [];
  const { context, state } = renderer({ sgdbSearch: () => new Promise(resolve => pending.push(resolve)) });
  const fields = { '#art-q': { value: 'old' }, '#art-games': { appendChild() {} }, '#art-id': {}, '#art-status': {} };
  context.document.querySelector = selector => fields[selector];
  context.document.createElement = () => ({});
  vm.runInContext('loadArtTabs = async () => {};', context);
  state.modal = {};
  const older = vm.runInContext('artSearch()', context);
  fields['#art-q'].value = 'new';
  const newer = vm.runInContext('artSearch()', context);
  pending[1]([{ id: 22, name: 'New match' }]);
  await newer;
  pending[0]([{ id: 11, name: 'Old match' }]);
  await older;
  assert.equal(fields['#art-id'].value, '22');
  assert.equal(fields['#art-games'].value, '22');
});

it('allows existing app-managed shortcut rows through the Add/update action', () => {
  const { context } = renderer({});
  assert.equal(vm.runInContext("canWriteShortcut({source:'shortcut', exe:'game.exe', managed:true})", context), true);
  assert.equal(vm.runInContext("canWriteShortcut({source:'shortcut', exe:'game.exe', managed:false})", context), false);
  assert.equal(vm.runInContext("canWriteShortcut({source:'shortcut', exe:null, managed:true})", context), false);
});

it('targets the open game unless multiple selection is explicitly enabled', () => {
  const { context, state } = renderer({});
  state.rows = [{ source: 'folder', folder: 'one', checked: true }, { source: 'folder', folder: 'two', checked: true }];
  state.detailKey = 'folder:two';
  assert.deepEqual(Array.from(vm.runInContext('checkedRows()', context)), [state.rows[1]]);
  state.bulk = true;
  assert.equal(vm.runInContext('checkedRows().length', context), 2);
  state.bulk = false;
  state.detailKey = null;
  assert.equal(vm.runInContext('checkedRows().length', context), 0);
});

it('keeps failed artwork pending while recording successful writes', async () => {
  const { context, state } = renderer({ artDownload: async req => ({ rows: [{ ...req.rows[0],
    art: { hero: req.rows[0].art.hero }, appliedKinds: ['grid'], failedKinds: ['hero'] }], lines: [] }) });
  vm.runInContext('log = () => {};', context);
  state.cfg = {};
  state.rows = [{ source: 'steam', folder: 'steam:1', steamAppid: 1, art: { grid: { url: 'grid' }, hero: { url: 'hero' } } }];
  await vm.runInContext('writeArtwork(S.rows, [])', context);
  assert.equal(state.rows[0].pendingArt, true);
  assert.equal(state.rows[0].artApplied, true);
  assert.equal(state.rows[0].art.hero.url, 'hero');
  assert.equal(state.rows[0].art.grid, undefined);
});

it('loads saved Steam-shortcut matches when there is no previous renderer state', async () => {
  const { context, state, refresh } = renderer({
    steamRead: async () => [{ exe: 'game.exe', appid: 10, index: 0, appName: 'Game', managed: true }],
    steamGames: async () => [], resolveName: async () => null,
  });
  const key = vm.runInContext('folderKey("shortcut://10")', context);
  state.cfg = { games_roots: [], sgdb_cache: { [key]: 7 } };
  await refresh();
  assert.equal(state.rows[0].sgdbId, 7);
  assert.equal(state.rows[0].sgdbName, '(cached)');
});

it('loads only the active artwork tab, reuses its request, and ignores stale completion', async () => {
  const requests = [];
  const { context, state, button } = renderer({ artList: req => new Promise(resolve => requests.push({ req, resolve })) });
  vm.runInContext('globalThis.renders = []; renderArtGrid = (...args) => renders.push(args);', context);
  state.cfg = { api_key: 'fixture' };
  state.modal = { sgdbId: 7, tab: 'grid', row: {}, cache: {} };
  const first = vm.runInContext('loadArtTabs()', context);
  const repeated = vm.runInContext('loadArtTabs()', context);
  assert.equal(requests.length, 1);
  state.modal.tab = 'hero';
  const hero = vm.runInContext('loadArtTabs()', context);
  requests[1].resolve([{ url: 'hero' }]);
  await hero;
  const rendered = context.renders.length;
  requests[0].resolve([{ url: 'grid' }]);
  await Promise.all([first, repeated]);
  assert.equal(context.renders.length, rendered);
  assert.match(button.textContent, /1 images/);
  state.modal.tab = 'grid';
  await vm.runInContext('loadArtTabs()', context);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ req }) => [req.kind, req.page]), [['grid', 0], ['hero', 0]]);
});

it('rebuilds scanned and Steam rows while keeping staged artwork for surviving games', async () => {
  let reads = 0;
  const { state, refresh, button } = renderer({
    scanStart: async ({ roots }) => {
      assert.deepEqual(Array.from(roots), ['games']);
      return [{ folder: 'games/one', exePath: 'game.exe', displayName: 'Game' },
        { folder: 'games/new', exePath: 'new.exe', displayName: 'New game' }];
    },
    steamRead: async () => { reads++; return [{ exe: 'game.exe', appid: 10, index: 0, managed: true }, { exe: 'other.exe', appName: 'New name', appid: 20, index: 1 }]; },
    steamGames: async () => [{ appid: 30, name: 'Installed game' }],
    resolveName: async () => null,
  });
  state.cfg = { games_roots: ['games'], sgdb_map: {}, sgdb_cache: {} };
  const folder = { source: 'folder', folder: 'games/one', exe: 'old.exe', checked: true, art: { grid: 'chosen' } };
  const shortcut = { source: 'shortcut', exe: 'other.exe', checked: true, sgdbId: 5, art: { hero: 'chosen' } };
  state.rows = [folder, shortcut, { source: 'steam', display: 'Removed game' },
    { source: 'folder', folder: 'removed/game', exe: 'removed.exe' }];
  await refresh();
  assert.equal(reads, 1);
  assert.equal(state.rows[0].exe, 'game.exe');
  assert.equal(state.rows[0].inSteam, true);
  assert.equal(state.rows[0].checked, true);
  assert.equal(state.rows[0].art.grid, 'chosen');
  assert.equal(state.rows[1].display, 'New game');
  assert.equal(state.rows[2].display, 'New name');
  assert.equal(state.rows[2].sgdbId, 5);
  assert.equal(state.rows[2].art, shortcut.art);
  assert.equal(state.rows[3].display, 'Installed game');
  assert.equal(state.rows.length, 4);
  assert.equal(button.disabled, false);
});

it('keeps the list on read failure and re-enables Refresh', async () => {
  const { state, refresh, button } = renderer({
    steamRead: async () => { throw new Error('read failed'); }, steamGames: async () => [],
  });
  const rows = [{ source: 'folder', exe: 'game.exe' }];
  state.cfg = { games_roots: [] };
  state.rows = rows;
  await assert.rejects(refresh(), /read failed/);
  assert.equal(state.rows, rows);
  assert.equal(button.disabled, false);
});

it('removes scanned rows when no folders remain, but still reloads Steam', async () => {
  const { state, refresh } = renderer({ steamRead: async () => [], steamGames: async () => [] });
  state.cfg = { games_roots: [] };
  state.rows = [{ source: 'folder', folder: 'removed', exe: 'game.exe' }];
  await refresh();
  assert.equal(state.rows.length, 0);
});

it('loads once automatically, shares pending loads, and reloads for settings changes or Refresh', async () => {
  let scans = 0;
  const { context, state, refresh } = renderer({
    scanStart: async () => { scans++; return []; },
    steamRead: async () => [], steamGames: async () => [],
  });
  state.cfg = { games_roots: ['games'], folder_depths: {}, steam_user_id: '1' };
  await vm.runInContext('Promise.all([loadLibrary(), loadLibrary()])', context);
  assert.equal(scans, 1);
  await vm.runInContext('loadLibrary()', context);
  assert.equal(scans, 1);
  state.cfg.folder_depths = { games: 2 };
  await vm.runInContext('loadLibrary()', context);
  assert.equal(scans, 2);
  state.cfg.steam_user_id = '2';
  await vm.runInContext('loadLibrary()', context);
  assert.equal(scans, 3);
  await refresh();
  assert.equal(scans, 4);
});

it('keeps native selections and artwork by AppID when games share a name', async () => {
  const { state, refresh } = renderer({
    steamRead: async () => [], steamGames: async () => [{ appid: 1, name: 'Renamed game' }, { appid: 2, name: 'Game' }],
  });
  state.cfg = { games_roots: [], sgdb_map: {}, sgdb_cache: {} };
  state.rows = [{ source: 'steam', steamAppid: 1, display: 'Game', checked: true, sgdbId: 7, pendingArt: true, art: { grid: 'chosen' } },
    { source: 'steam', steamAppid: 2, display: 'Game', checked: false, art: {} }];
  await refresh();
  assert.equal(state.rows[0].checked, true);
  assert.equal(state.rows[0].sgdbId, 7);
  assert.equal(state.rows[0].art.grid, 'chosen');
  assert.equal(state.rows[0].pendingArt, true);
  assert.equal(state.rows[1].checked, false);
  assert.equal(Object.keys(state.rows[1].art).length, 0);
});
