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
  state.rows = [{ source: 'steam', steamAppid: 1, display: 'Game', checked: true, sgdbId: 7, art: { grid: 'chosen' } },
    { source: 'steam', steamAppid: 2, display: 'Game', checked: false, art: {} }];
  await refresh();
  assert.equal(state.rows[0].checked, true);
  assert.equal(state.rows[0].sgdbId, 7);
  assert.equal(state.rows[0].art.grid, 'chosen');
  assert.equal(state.rows[1].checked, false);
  assert.equal(Object.keys(state.rows[1].art).length, 0);
});
