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
