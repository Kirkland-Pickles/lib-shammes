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

it('uses per-type dimension defaults and preserves explicit dimension selections', () => {
  const { context, state } = renderer({});
  state.cfg = { artwork_filters: {} };
  const dimensions = kind => Array.from(vm.runInContext(`pickerFilters('${kind}').dimensions || []`, context));
  assert.deepEqual(dimensions('grid'), ['600x900', '342x482', '660x930']);
  assert.deepEqual(dimensions('wide'), ['460x215', '920x430']);
  assert.deepEqual(dimensions('hero'), ['1920x620', '3840x1240', '1600x650']);
  assert.deepEqual(dimensions('logo'), []);
  assert.equal(dimensions('icon').length, 37);
  assert.ok(dimensions('icon').includes('256'));
  state.cfg.artwork_filters.grid = { dimensions: ['512x512'] };
  assert.deepEqual(dimensions('grid'), ['512x512']);
  state.cfg.artwork_filters.grid.dimensions = [];
  assert.deepEqual(dimensions('grid'), []);
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

it('keeps a Desktop shortcut name when choosing another icon for the same matched game', async () => {
  const { context, state } = renderer({});
  context.matchMedia = () => ({ matches: true });
  context.document.querySelector = () => ({ getAnimations: () => [], classList: { remove() {} } });
  vm.runInContext('renderDesktop = restoreArtFocus = () => {}; saveDesktopDraft = async () => {}; handleAction = (_label, fn) => fn;', context);
  const row = { source: 'desktop', display: 'My variant', sgdbId: 7 };
  const select = (id, name) => {
    state.modal = { row, sel: { icon: { file: 'chosen.ico' } }, sgdbId: id, games: [{ id, name }] };
    vm.runInContext('closeArtModal(true)', context);
  };
  select(7, '(cached)');
  assert.equal(row.display, 'My variant');
  assert.equal(row.iconChoice.file, 'chosen.ico');
  select(8, 'New matched game');
  assert.equal(row.display, 'New matched game');
  assert.equal(row.sgdbId, 8);
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
  const lastSearch = vm.runInContext('artSearch()', context);
  fields['#art-id'].value = '88';
  await vm.runInContext('artLoadId()', context);
  pending[2]([{ id: 11, name: 'Old match' }]);
  await lastSearch;
  assert.equal(state.modal.sgdbId, 88);
  assert.equal(fields['#art-id'].value, '88');
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

it('applies all eligible Steam rows by default and only narrows to explicit selections', () => {
  const { context, state } = renderer({});
  const first = { source: 'folder', folder: 'one', display: 'One', exe: 'one.exe', checked: false };
  const second = { source: 'folder', folder: 'two', display: 'Two', exe: 'two.exe', checked: false };
  const changedNative = { source: 'steam', display: 'Z Native', steamAppid: 1, pendingArt: true, art: { grid: { url: 'chosen' } } };
  state.rows = [first, second, changedNative, { source: 'steam', display: 'Stock', steamAppid: 2, art: {} },
    { source: 'shortcut', display: 'External', exe: 'external.exe', managed: false }, { source: 'folder', display: 'Missing', exe: null }];
  const targets = () => Array.from(vm.runInContext('steamApplyRows()', context));
  assert.deepEqual(targets(), [first, second, changedNative]);
  state.detailKey = 'folder:two';
  assert.deepEqual(targets(), [first, second, changedNative]);
  state.bulk = true;
  second.checked = true;
  assert.deepEqual(targets(), [second]);
  second.checked = false;
  assert.deepEqual(targets(), [first, second, changedNative]);
  state.filter = 'one';
  assert.deepEqual(targets(), [first]);
});

it('keeps Desktop bulk selections across filters and applies all visible games when none are checked', () => {
  const { context, state } = renderer({});
  const fields = { '#desktop-filter': { value: '' }, '#desktop-sort': { value: 'az' }, '#desktop-hide': { checked: false } };
  context.document.querySelector = selector => fields[selector];
  state.desktop.rows = ['One', 'Two', 'Three', 'Four'].map((display, id) => ({ id, display, exe: 'game.exe', checked: false }));
  state.desktop.detail = 2;
  const targets = () => Array.from(vm.runInContext('desktopSelected()', context));
  assert.equal(targets().length, 4);
  state.desktop.bulk = true;
  assert.equal(targets().length, 4);
  state.desktop.rows[0].checked = true;
  assert.deepEqual(targets(), [state.desktop.rows[0]]);
  fields['#desktop-filter'].value = 'two';
  assert.deepEqual(targets(), [state.desktop.rows[0]]);
  state.desktop.rows[0].checked = false;
  assert.deepEqual(targets(), [state.desktop.rows[1]]);
});

it('preserves Desktop matches after refresh without treating saved metadata as pending edits', async () => {
  const rows = [1, 2].map(id => ({ id, display: 'Game ' + id, exe: 'game.exe', signature: 'same' }));
  const { context, state } = renderer({ desktopScan: async () => ({ rows, warnings: [] }) });
  vm.runInContext('renderDesktop = status = () => {};', context);
  state.cfg = { games_roots: [], desktop_overrides: {
    1: { display: 'Saved game', exe: 'game.exe', sgdbId: 7, sgdbName: 'Matched title', signature: 'same' },
    2: { display: 'Edited game', exe: 'game.exe', args: '', signature: 'same', iconChoice: { file: 'chosen.ico' } },
  } };
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].display, 'Saved game');
  assert.equal(state.desktop.rows[0].sgdbId, 7);
  assert.equal(state.desktop.rows[0].draft, null);
  assert.equal(state.desktop.rows[1].draft.iconChoice.file, 'chosen.ico');
  rows[1].signature = 'external edit';
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].sgdbId, 7);
  assert.equal(state.desktop.rows[1].draft, null);
  assert.equal(state.desktop.rows[1].iconChoice, undefined);
  rows[0].signature = 'external arguments';
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].sgdbId, 7);
  assert.equal(state.desktop.rows[0].draft, null);
  rows[0].exe = 'another-game.exe';
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].sgdbId, undefined);
});

it('pairs alternate launcher shortcuts with missing destinations without adding duplicate cards', () => {
  const { context, state } = renderer({});
  context.rows = [
    { id: 'desktop-link', exePath: 'game.exe', exe: 'launcher.exe', display: 'Game', shortcut: 'Desktop/Game.lnk', destination: 'desktop' },
    { id: 'missing-menu', exePath: 'game.exe', exe: 'game.exe', display: 'Game', destination: 'start-menu' },
  ];
  state.desktop.groups = vm.runInContext('groupDesktopDestinations(rows)', context);
  state.desktop.rows = state.desktop.groups.flat();
  assert.equal(state.desktop.groups.length, 1);
  const payload = vm.runInContext('desktopApplyRows(desktopCards())', context);
  assert.equal(payload.length, 2);
  assert.equal(payload.filter(row => !row.shortcut).length, 1);
  assert.ok(payload.every(row => row.exe === 'launcher.exe'));
  context.members = state.desktop.rows;
  assert.equal(vm.runInContext('desktopLocationState(members)', context), 'Desktop only');
  context.members[0].destination = 'start-menu';
  assert.equal(vm.runInContext('desktopLocationState(members)', context), 'Start menu only');
  context.members[1].shortcut = 'Desktop/Game.lnk';
  assert.equal(vm.runInContext('desktopLocationState(members)', context), 'Existing');
});

it('groups the same executable despite different shortcut names and arguments', async () => {
  const { context, state } = renderer({ cfgSet: async patch => ({ ...state.cfg, ...patch }) });
  vm.runInContext('applyTheme = () => {}; renderChecklist = async () => {};', context);
  const desktop = { id: 'desktop:game', destination: 'desktop', shortcut: 'Desktop/Game.lnk', signature: 'desktop-sig',
    display: 'My game', exe: 'game.exe', args: '-one', admin: false, icon: 'custom.ico', iconIndex: 2 };
  const menu = { ...desktop, id: 'menu:game', display: 'Other name', args: '-two', destination: 'start-menu', shortcut: 'Programs/Game.lnk', signature: 'menu-sig' };
  context.rows = [desktop, menu, { ...desktop, id: 'desktop:another', display: 'Another game', exe: 'another.exe' },
    { id: 'missing-menu', destination: 'start-menu', display: 'Default title', exe: 'game.exe' }];
  state.desktop.groups = vm.runInContext('groupDesktopDestinations(rows)', context);
  state.desktop.rows = state.desktop.groups.flat();
  assert.equal(state.desktop.groups.length, 2);
  assert.equal(state.desktop.groups[0][0].shortcut, desktop.shortcut);
  assert.equal(state.desktop.groups[0][1].shortcut, menu.shortcut);
  assert.equal(state.desktop.groups[1][1].display, 'Another game');
  assert.equal(state.desktop.groups[1][1].args, '-one');
  assert.equal(state.desktop.groups[1][1].icon, 'custom.ico');
  assert.equal(state.desktop.groups[1][1].shortcut, null);
  assert.equal(new Set(state.desktop.rows.map(row => row.id)).size, 4);
  const payload = vm.runInContext('desktopApplyRows(desktopCards())', context);
  assert.equal(payload[1].display, desktop.display);
  assert.equal(payload[1].args, desktop.args);
  assert.equal(payload[1].shortcut, menu.shortcut);
  assert.equal(payload[1].signature, menu.signature);
  state.cfg = { desktop_overrides: {} };
  context.edited = state.desktop.groups[0][0];
  context.edited.display = 'Renamed';
  context.edited.iconChoice = { file: 'new.ico' };
  await vm.runInContext('saveDesktopDraft(edited)', context);
  assert.equal(state.cfg.desktop_overrides[menu.id].display, 'Renamed');
  assert.equal(state.cfg.desktop_overrides[menu.id].iconChoice.file, 'new.ico');
  assert.equal(state.cfg.desktop_overrides[menu.id].signature, 'menu-sig');
  assert.equal(state.cfg.desktop_overrides[menu.id].args, '-one');
  assert.equal(state.cfg.desktop_overrides[desktop.id].signature, 'desktop-sig');
  assert.equal(state.desktop.groups[1][0].display, 'Another game');
});

it('stages a recovered title for a shortcut previously saved with the cache label', async () => {
  const row = { id: 'link:cached', display: '(cached)', query: 'Resolved game', exe: 'game.exe',
    shortcut: 'Desktop/(cached).lnk', signature: 'original' };
  const { context, state } = renderer({ desktopScan: async () => ({ rows: [row], warnings: [] }) });
  vm.runInContext('renderDesktop = status = () => {};', context);
  state.cfg = { games_roots: [], desktop_overrides: { [row.id]: {
    display: '(cached)', sgdbId: 7, sgdbName: '(cached)', signature: 'original',
  } } };
  await vm.runInContext('refreshDesktop()', context);
  const recovered = state.desktop.rows[0];
  assert.equal(recovered.display, 'Resolved game');
  assert.equal(recovered.draft.display, 'Resolved game');
  assert.equal(recovered.shortcut, row.shortcut);
  assert.equal(recovered.signature, row.signature);
  assert.equal(recovered.sgdbId, 7);
});

it('finds artwork for visible games without selection, matching first and staging only changed choices', async () => {
  const calls = [];
  const { context, state } = renderer({
    matchAuto: async req => { calls.push('match'); return { rows: req.rows.map(row => ({ ...row, sgdbId: 7 })), lines: [], ok: 1 }; },
    cfgGet: async () => state.cfg,
    artPrepare: async req => {
      calls.push('prepare');
      assert.equal(req.rows[0].sgdbId, 7);
      return { rows: req.rows.map(row => ({ ...row, art: { grid: { url: 'chosen' } } })), prepared: 1, failed: 0, lines: [] };
    },
  });
  vm.runInContext('status = log = toast = () => {};', context);
  state.cfg = { api_key: 'fixture', want_grid: true };
  state.rows = [{ source: 'folder', folder: 'one', display: 'One', exe: 'one.exe', art: {} }];
  await vm.runInContext('doDownloadArt()', context);
  assert.deepEqual(calls, ['match', 'prepare']);
  assert.equal(state.rows[0].pendingArt, true);
  assert.equal(state.rows[0].art.grid.url, 'chosen');
  state.rows[0].pendingArt = false;
  await vm.runInContext('doDownloadArt()', context);
  assert.deepEqual(calls, ['match', 'prepare', 'prepare']);
  assert.equal(state.rows[0].pendingArt, false);
});

it('matches during Apply only after accepting automatic artwork and blocks overlapping Apply calls', async () => {
  const calls = [];
  let offerArtwork = true;
  const { context, state } = renderer({
    artCurrent: async () => null,
    cfgGet: async () => state.cfg,
    matchAuto: async req => { calls.push('match'); return { rows: req.rows.map(row => ({ ...row, sgdbId: 7 })), lines: [], ok: 1 }; },
    steamAdd: async req => {
      calls.push('apply');
      assert.equal(req.autoArt, offerArtwork);
      assert.equal(req.rows[0].sgdbId, offerArtwork ? 7 : undefined);
      return { rows: req.rows, lines: [], added: 1, updated: 0, artworkSaved: 0 };
    },
  });
  context.offer = () => offerArtwork;
  vm.runInContext('updateLibrarySelection = status = log = toast = () => {}; confirmDlg = async title => title !== "Artwork" || offer();', context);
  state.cfg = { api_key: 'fixture', want_grid: true };
  state.rows = [{ source: 'folder', folder: 'one', display: 'One', exe: 'one.exe', art: {} }];
  await vm.runInContext('Promise.all([doAddToSteam(), doAddToSteam()])', context);
  assert.deepEqual(calls, ['match', 'apply']);
  offerArtwork = false;
  delete state.rows[0].sgdbId;
  await vm.runInContext('doAddToSteam()', context);
  assert.deepEqual(calls, ['match', 'apply', 'apply']);
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
