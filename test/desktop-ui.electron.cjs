'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../src/main/store');
app.setPath('userData', path.join(process.argv[2], 'ui-profile'));
app.disableHardwareAcceleration();
let cfg = { ...DEFAULTS, desktop_overrides: {}, games_roots: ['C:\\Games'] };
let scans = 0, writes = 0, iconPreviews = 0, searches = 0, externalChange = false;
let pauseApply = false, finishApply, lastDesktopApply;
let steamRequest;
let steamEntries = [];
let pendingSearches = null;
let failNextArtList = false;
const artRequests = [];
const artworkWrites = [];
const rows = [1, 2].map((i) => ({ id: `link:${i}`, shortcut: `C:\\Desktop\\Variant ${i}.lnk`, signature: 'original',
  display: `Variant ${i}`, exe: 'C:\\Games\\Game.exe', args: `-profile ${i}`, admin: false, icon: 'C:\\Icons\\game.ico', iconIndex: 0,
  confidence: 1, candidates: [{ path: 'C:\\Games\\Game.exe' }] }));
const icon = nativeImage.createFromBitmap(Buffer.alloc(16, 255), { width: 2, height: 2 }).toDataURL();
const downloadedIcon = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toDataURL();
let foundLaunchers = [];
let installedGames = [];
const handlers = {
  'cfg:get': () => cfg,
  'cfg:set': (patch) => {
    if ('api_key' in patch && patch.api_key !== cfg.api_key) cfg.api_key_check = null;
    return (cfg = { ...cfg, ...patch });
  },
  'app:is-development': () => false,
  'key:validate': key => {
    const result = key === 'fixture' ? { ok: true, name: 'Half-Life 2 [220]' } : { ok: false };
    if (cfg.api_key === key) cfg.api_key_check = result;
    return result;
  },
  'steam:detect': () => {
    cfg = { ...cfg, steam_path: 'C:/Fixture/Steam', steam_user_id: '1' };
    return { path: cfg.steam_path, users: [{ id: '1', name: 'Fixture' }] };
  },
  'steam:verify': () => true,
  'steam:drafts-save': ({ scope, updates }) => {
    const drafts = cfg.steam_art_drafts ||= {};
    const rows = drafts[scope] ||= {};
    for (const [key, draft] of Object.entries(updates)) {
      if (draft) rows[key] = draft;
      else delete rows[key];
    }
  },
  'cover:cache-get': () => null,
  'cover:cache-put': () => true,
  'desktop:scan': async () => { scans++; await new Promise((resolve) => setTimeout(resolve, 30)); return { rows, warnings: [] }; },
  'desktop:icon': (file) => { assert.ok(!file.endsWith('.lnk')); return icon; },
  'art:preview-file': (file) => { assert.ok(['C:\\Icons\\game.ico', 'C:\\Icons\\downloaded.ico'].includes(file)); iconPreviews++; return file.endsWith('downloaded.ico') ? downloadedIcon : icon; },
  'art:thumbnail': (file) => { assert.ok(['C:\\Icons\\game.ico', 'C:\\Icons\\downloaded.ico', 'C:\\Images\\applied-grid.png'].includes(file)); return file.endsWith('game.ico') ? icon : downloadedIcon; },
  'art:current': () => null,
  'art:official': () => null,
  'art:logo-position': () => null,
  'art:download': (req) => {
    artworkWrites.push(req);
    return { rows: req.rows.map(row => ({ ...row,
      art: { ...row.art, ...(row.art.grid ? { grid: { ...row.art.grid, appliedFile: 'C:\\Images\\applied-grid.png' } } : {}) },
      appliedKinds: Object.keys(row.art), logoPositionApplied: row.logoPosition !== undefined })),
      lines: ['Artwork applied to Steam.'], saved: req.rows.reduce((n, row) => n + Object.keys(row.art).length, 0), failed: 0 };
  },
  'steam:read': () => steamEntries,
  'steam:games': () => installedGames,
  'sgdb:by-steam': () => null,
  'scan:start': () => cfg.steam_executables,
  'resolve:name': () => null,
  'steam:running': () => false,
  'steam:add': (req) => { steamRequest = req; return { rows: req.rows, lines: ['Saved shortcuts.vdf: 0 added, 1 updated.', 'Artwork results ready.'], added: 0, updated: 1, artworkSaved: 0 }; },
  'desktop:apply': async (selected) => {
    lastDesktopApply = selected;
    writes++;
    if (pauseApply) await new Promise((resolve) => { finishApply = resolve; });
    return selected.map((row) => {
      if (!externalChange) return { id: row.id, ok: true, row };
      delete cfg.desktop_overrides[row.id];
      return { id: row.id, ok: false, refreshed: true, error: 'Shortcut refreshed. Review changes and apply again.',
        row: externalChange === 'removed' ? null : { ...row, args: '-external', signature: 'changed', iconChoice: null } };
    });
  },
  'art:list': (req) => {
    artRequests.push(req);
    if (failNextArtList) { failNextArtList = false; throw new Error('temporary fixture failure'); }
    if (req.kind === 'icon' && req.filters.dimensions?.length === 0) return [];
    return Array.from({ length: req.page ? 2 : 30 }, (_, i) => ({ id: req.page * 30 + i + 1,
      url: `${icon}#${req.page * 30 + i}`, thumb: icon, width: 2, height: 2 }));
  },
  'sgdb:search': () => { searches++; return pendingSearches
    ? new Promise((resolve) => pendingSearches.push(resolve)) : [{ id: 17, name: 'Matched game' }]; },
  'scan:find-executables': () => ({ games: foundLaunchers, truncated: false }),
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, (_event, ...args) => handler(...args));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const run = (code) => win.webContents.executeJavaScript(code).catch((error) => { throw new Error(`${code}\n${error.message}`); });
  const wait = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (typeof condition === 'function' ? await condition() : await run(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${condition}`);
  };
  const capture = async name => {
    if (process.env.SHAMMES_UI_CAPTURE) {
      await wait("!document.querySelector('.route-exit')");
      win.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 100));
      const fs = require('fs');
      fs.mkdirSync(process.env.SHAMMES_UI_CAPTURE, { recursive: true });
      fs.writeFileSync(path.join(process.env.SHAMMES_UI_CAPTURE, name + '.png'), (await win.webContents.capturePage()).toPNG());
    }
  };
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => run(`{
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  const dismissBackdrop = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)})?.open`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
    await wait(`!document.querySelector(${JSON.stringify(selector)})?.open`);
  };
  const selectDestination = async value => {
    await change('#desktop-destination', value);
    await wait("!document.querySelector('#desktop-destination').disabled");
  };
  const idle = () => wait("!document.querySelector('#desktop-refresh').disabled");
  await wait("document.querySelector('#page-library').classList.contains('on')");
  assert.equal(await run("!document.querySelector('#connect-steam')"), true);
  assert.equal(await run("document.querySelector('#library-setup').hidden"), false);
  assert.match(await run("document.querySelector('#log').textContent"), /\[\d{2}:\d{2}:\d{2}\]/);
  await capture('library');
  await selectDestination('desktop');
  await wait("document.querySelector('#page-desktop').classList.contains('on') && document.querySelectorAll('#desktop-games tbody tr').length === 2");
  await idle();
  assert.equal(writes, 0);
  assert.equal(scans, 1);
  await click('#desktop-games .game-name');
  await wait("!document.querySelector('#desktop-games .game-cover').hidden && document.querySelector('#desktop-games .cover-fallback').hidden");
  assert.equal(await run("document.querySelector('#desktop-add').disabled"), true);
  assert.equal(await run("document.querySelector('#desktop-add').textContent"), 'Review changes');
  await wait("document.querySelector('#art-grid .manage-artwork img')?.naturalWidth > 0");
  assert.ok(iconPreviews > 0);
  assert.equal(await run("document.querySelector('#art-search').disabled"), true);
  assert.deepEqual(await run("Array.from(document.querySelectorAll('#art-tabs button'), button => button.textContent)"), ['Icon', 'Manage']);
  await run("document.querySelector('#desktop-game-settings details').open = true");
  assert.ok(await run(`{
    const label = document.querySelector('.desktop-admin');
    const box = label.querySelector('input').getBoundingClientRect();
    const text = document.createRange();
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && !walker.currentNode.textContent.trim()) {}
    text.selectNodeContents(walker.currentNode);
    const words = text.getBoundingClientRect();
    box.width > 0 && words.width > 0 && box.right <= words.left
      && Math.abs((box.top + box.bottom - words.top - words.bottom) / 2) < 4;
  }`), 'Administrator checkbox and text should be beside each other and vertically aligned');
  await change('#desktop-game-settings [data-field=args]', '-edited');
  await wait(() => cfg.desktop_overrides['link:1']?.args === '-edited');
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  await run("document.querySelector('#desktop-refresh').click(); document.querySelector('#desktop-refresh').click()");
  await idle();
  assert.ok(scans >= 1);
  await click('#desktop-games .game-name');
  assert.equal(await run("document.querySelector('#desktop-game-settings [data-field=args]').value"), '-edited');
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  await click('#desktop-games tbody tr:nth-child(2) .game-name');
  assert.equal(await run("document.querySelector('#desktop-game-settings [data-field=args]').value"), '-profile 2');
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  await click('#desktop-games .cover-wrap');
  await wait("!!document.querySelector('#art-choice img') && document.querySelector('#art-choice img').naturalWidth > 0");
  assert.deepEqual(await run("Array.from(document.querySelectorAll('#art-tabs button'), button => button.textContent)"), ['Icon', 'Manage']);
  assert.equal(await run("document.querySelector('#art-search').disabled"), true);
  await click('#art-cancel');
  await click('#preferences > summary');
  await capture('settings-cog');
  await change('#settings-cards [data-r=key]', 'fixture');
  await wait(() => cfg.api_key === 'fixture');
  await selectDestination('desktop');
  await idle();
  cfg.artwork_filters.icon = {};
  await click('#desktop-games .cover-wrap');
  await wait("document.querySelector('#art-id').value === '17'");
  await wait(() => artRequests.length > 0);
  assert.ok(artRequests.every(req => req.kind === 'icon' && req.filters.animated === false));
  assert.equal(searches, 1);
  await wait("document.querySelectorAll('#art-grid > .thumb').length >= 30");
  await run("globalThis.firstTile = document.querySelector('#art-grid > .thumb .thumb-select'); firstTile.click()");
  await run("document.querySelector('#art-more')?.scrollIntoView({block: 'end'})");
  await wait("document.querySelectorAll('#art-grid > .thumb').length === 32");
  assert.equal(await run("firstTile === document.querySelector('#art-grid > .thumb .thumb-select') && firstTile.closest('.thumb').classList.contains('picked')"), true);
  assert.equal(await run("document.querySelector('#art-more')"), null);
  assert.deepEqual(artRequests.map(req => req.page), [0, 1]);
  const galleryHeight = await run("document.querySelector('.thumbScroll').clientHeight");
  await click('#art-filters summary');
  assert.equal(await run("document.querySelector('.thumbScroll').clientHeight"), galleryHeight);
  await capture('artwork-filter-popover');
  assert.equal(await run(`(() => {
    const fields = document.querySelector('#art-filter-fields');
    const groups = [...fields.querySelectorAll('fieldset')].map(node => node.getBoundingClientRect());
    return fields.scrollWidth <= fields.clientWidth && groups[0].right <= groups[1].left
      && document.querySelector('.thumbScroll').getBoundingClientRect().height > 100;
  })()`), true);
  await run("document.querySelector('#art-filter-fields input[data-filter=humor]').checked = false");
  await click('#art-filter-fields input[data-filter=humor]');
  await wait(() => cfg.artwork_filters?.icon?.humor === true);
  const beforeUntagged = artRequests.length;
  await click('#art-filter-fields input[data-filter=untagged]');
  await wait(() => artRequests.slice(beforeUntagged).some(req => req.page === 0 && req.filters.untagged === false && req.filters.humor === true));
  await click('#art-filter-fields input[data-filter=epilepsy]');
  await wait(() => artRequests.at(-1).filters.epilepsy === false);
  await click('#art-filter-fields input[data-filter=humor]');
  await wait(() => artRequests.at(-1).filters.humor === false);
  assert.equal(await run("document.querySelectorAll('#art-filter-fields fieldset:nth-child(2) input:checked').length"), 0);
  await click('#art-filter-reset');
  await wait("document.querySelector('#art-filter-fields input[data-filter=untagged]').checked");
  assert.equal(await run("document.querySelector('#art-filter-fields input[data-filter=nsfw]').checked"), false);
  assert.equal(await run("document.querySelector('#art-filter-fields input[data-filter=static]').checked"), true);
  await click('#art-filter-fields input[data-filter=dimensions][value="512"]');
  await wait(() => cfg.artwork_filters.icon.dimensions?.includes('256') && !cfg.artwork_filters.icon.dimensions.includes('512'));
  await wait(() => artRequests.at(-1).filters.dimensions?.includes('256') && !artRequests.at(-1).filters.dimensions.includes('512'));
  await run(`{
    const inputs = [...document.querySelectorAll('#art-filter-fields input[data-filter=dimensions]')];
    inputs.forEach(input => { input.checked = false; });
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await wait(() => cfg.artwork_filters.icon.dimensions?.length === 0);
  await run("document.querySelector('#art-filter-fields input[data-filter=humor]').checked = false");
  await click('#art-filter-fields input[data-filter=humor]');
  await wait(() => cfg.artwork_filters.icon.humor === true);
  assert.equal(cfg.artwork_filters.icon.static, undefined);
  assert.equal(cfg.artwork_filters.icon.animated, undefined);
  assert.equal(artRequests.at(-1).filters.static, true);
  assert.equal(artRequests.at(-1).filters.animated, false);
  assert.equal(await run("document.querySelector('#art-apply').hidden"), true);
  assert.equal(await run("document.querySelector('#art-save').textContent"), 'Save');
  assert.equal(await run("document.querySelector('#art-modal .modal-foot').lastElementChild.id"), 'art-save');
  await wait("document.querySelector('#art-grid .art-load-error button')?.textContent === 'Reset filters'");
  await click('#art-grid .art-load-error button');
  await wait("document.querySelector('#art-grid .thumb-select') && !document.querySelector('#art-grid .art-load-error button')");

  await wait("document.querySelector('#art-filter-fields input[data-filter=dimensions][value=\"512\"]').checked");
  await click('#art-filters summary');
  await click('#art-title');
  assert.equal(await run("document.querySelector('#art-filters').open"), false);
  await click('#art-save');
  await wait(() => cfg.desktop_overrides['link:1']?.sgdbId === 17);
  await wait("document.querySelector('#art-overlay').hidden");

  await click('#desktop-add');
  await wait("document.querySelector('#page-review').open");
  assert.equal(await run("getComputedStyle(document.querySelector('#review-title')).userSelect"), 'none');
  await capture('review-dialog');
  await dismissBackdrop('#page-review');
  assert.equal(writes, 0);
  await click('#desktop-add');

  assert.equal(await run("document.querySelector('#page-desktop').classList.contains('on')"), true);
  await run("document.dispatchEvent(new MouseEvent('mouseup', { button: 3 }))");
  assert.equal(await run("document.querySelector('#page-review').open"), false);
  await run("document.dispatchEvent(new MouseEvent('mouseup', { button: 4 }))");
  assert.equal(await run("document.querySelector('#page-review').open"), true);
  await run("document.querySelector('#page-review').dispatchEvent(new Event('cancel', { cancelable: true }))");
  assert.equal(await run("document.querySelector('#page-review').open"), false);
  assert.equal(writes, 0);
  pauseApply = true;
  await click('#desktop-add');
  await click('#review-apply');
  await wait(() => typeof finishApply === 'function');
  finishApply();
  pauseApply = false;
  await idle();
  assert.equal(writes, 1);
  assert.equal(await run("document.querySelector('#desktop-games .game-state').textContent"), 'Applied');
  externalChange = true;
  await click('#desktop-games .game-name');
  await click('#desktop-game-apply');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await idle();
  await click('#desktop-games .game-name');
  assert.equal(await run("document.querySelector('#desktop-game-settings [data-field=args]').value"), '-external');
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  assert.equal(cfg.desktop_overrides['link:1'], undefined);
  assert.equal(await run("document.querySelector('[data-page=xbox]')"), null);
  await selectDestination('steam');
  await selectDestination('desktop');
  await idle();
  assert.ok(scans >= 1);
  await click('#add-folders');
  assert.equal(await run("getComputedStyle(document.querySelector('#add-title')).userSelect"), 'none');
  await capture('add-folders-dialog');
  assert.equal(await run("document.querySelector('#page-add').open && document.querySelector('#source-folders').textContent.includes('Games')"), true);
  assert.equal(await run("document.querySelector('#page-add select')"), null);
  await dismissBackdrop('#page-add');
  const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.reload();
  await reloaded;
  await wait("document.querySelector('#page-desktop').classList.contains('on')");
  await selectDestination('desktop');
  await wait("document.querySelector('#page-desktop').classList.contains('on') && document.querySelectorAll('#desktop-games tbody tr').length === 2");
  await idle();
  await click('#desktop-games .game-name');
  pendingSearches = [];
  await click('#art-search');
  await run("document.querySelector('#art-q').value='new query'; document.querySelector('#art-search').click()");
  assert.equal(pendingSearches.length, 2);
  pendingSearches[1]([{ id: 22, name: 'New result' }]);
  await wait("document.querySelector('#art-id').value === '22'");
  pendingSearches[0]([{ id: 11, name: 'Old result' }]);
  await idle();
  assert.equal(await run("document.querySelector('#art-id').value"), '22');
  pendingSearches = null;
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  await click('#desktop-games .game-name');
  externalChange = 'removed';
  await click('#desktop-game-apply');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await idle();
  assert.equal(await run("document.querySelectorAll('#desktop-games tbody tr').length"), 1);
  assert.equal(await run("document.querySelector('#desktop-games .game-name').textContent"), 'Variant 2');
  assert.equal(cfg.desktop_overrides['link:1'], undefined);
  steamEntries = [{ managed: true, appName: 'Old name', exe: 'C:/Games/game.exe', index: 0, appid: 1 }];
  await selectDestination('steam');
  await wait("document.querySelectorAll('#games tbody tr').length === 1 && !document.querySelector('#btn-refresh').disabled");
  assert.equal(await run("document.querySelector('#game-settings').hidden"), true);
  await click("#games .game-name");
  assert.equal(await run("document.querySelector('#art-tabs .on').textContent"), 'Manage');
  await run("document.querySelector('#steam-game-settings .launcher-editor').open = true");
  assert.equal(await run("!document.querySelector('#btn-remove').hidden && !document.querySelector('#btn-remove').disabled"), true);
  assert.equal(await run("document.querySelector('#btn-add').disabled"), true);
  assert.equal(await run("document.querySelector('#btn-add').textContent"), 'Review changes');
  await click('#d-primary-action');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="0"]');
  assert.equal(steamRequest, undefined);
  await change('#d-name', 'New name');
  await run("document.querySelector('#steam-launch-settings').open = true");
  await change('#d-startdir', 'C:/Games/Working directory');
  await change('#d-args', '--windowed "two words"');
  await click('#d-primary-action');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await wait("document.querySelector('#status').textContent.includes('updated')");
  assert.equal(steamRequest.rows[0].display, 'New name');
  assert.ok(await run("document.querySelector('#log').textContent.includes('Saved shortcuts.vdf') && document.querySelector('#log').textContent.includes('Artwork results ready.')"));
  assert.deepEqual(steamRequest.rows[0].launchSettings, { startDir: 'C:/Games/Working directory', launchOptions: '--windowed "two words"' });
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  failNextArtList = true;
  await click('#games .game-open');
  await wait("document.querySelector('#art-grid .art-load-error button')?.textContent === 'Retry'");
  await click('#art-grid .art-load-error button');
  await wait("document.querySelectorAll('#art-grid > .thumb').length > 0");
  assert.equal(await run("document.querySelector('#art-tabs .on').textContent.startsWith('Cover')"), true);
  await click('#art-grid > .thumb .thumb-select');
  await run("document.querySelector('#art-grid > .thumb .thumb-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await wait("!document.querySelector('#art-preview').hidden");
  await click('#art-preview-back');
  await click('#art-cancel');
  assert.equal(artworkWrites.length, 0);
  await click('#games .game-open');
  await wait("document.querySelectorAll('#art-grid > .thumb').length > 0");
  await click('#art-grid > .thumb .thumb-select');
  await run("[...document.querySelectorAll('#art-tabs button')].find(button => button.textContent.startsWith('Logo')).click()");
  await wait("!document.querySelector('#art-logo-position').hidden && document.querySelectorAll('#art-grid > .thumb').length > 0");
  await click('#art-grid > .thumb .thumb-select');
  await change('#art-logo-width', '60');
  await click('#art-save');
  await wait("document.querySelector('#art-overlay').hidden");
  assert.equal(artworkWrites.length, 0);
  await click('#games .game-open');
  await wait("document.querySelectorAll('#art-grid > .thumb').length > 0");
  await run("[...document.querySelectorAll('#art-tabs button')].find(button => button.textContent.startsWith('Logo')).click()");
  await wait("!document.querySelector('#art-logo-position').hidden && document.querySelectorAll('#art-grid > .thumb').length > 0");
  await change('#art-logo-width', '70');
  assert.equal(await run("document.querySelector('#art-apply').hidden"), false);
  assert.equal(await run("document.querySelector('#art-modal .modal-foot').lastElementChild.id"), 'art-save');
  await click('#art-apply');
  await wait("document.querySelector('#art-overlay').hidden");
  await wait(`!document.querySelector('#games .game-cover').hidden && document.querySelector('#games .game-cover').src === ${JSON.stringify(downloadedIcon)}`);
  assert.equal(artworkWrites.length, 1);
  assert.deepEqual(Object.keys(artworkWrites[0].rows[0].art).sort(), ['grid', 'logo']);
  assert.equal(artworkWrites[0].rows[0].logoPosition.nWidthPct, 70);
  assert.equal(artworkWrites[0].kinds.length, 0);
  await click('#games .game-open');
  await run("[...document.querySelectorAll('#art-tabs button')].find(button => button.textContent === 'Manage').click()");
  await wait("document.querySelectorAll('#art-grid .manage-artwork').length === 5");
  await click('#art-grid [data-manage=restore]');
  await click('#art-cancel');
  assert.equal(artworkWrites.length, 1);
  await selectDestination('desktop');
  assert.ok(!await run("document.querySelector('#log').textContent.includes('Artwork applied to Steam.')"));
  await idle();
  await change('#desktop-destination', 'start-menu');
  await wait(() => cfg.desktop_destination === 'start-menu');
  await idle();
  assert.equal(await run("document.querySelector('#desktop-add').textContent"), 'Review changes');
  rows[1].destination = 'start-menu';
  rows[1].shortcut = 'C:\\Programs\\Other name.lnk';
  await change('#desktop-destination', 'both');
  await wait(() => cfg.desktop_destination === 'both');
  await idle();
  assert.equal(await run("document.querySelector('#desktop-add').textContent"), 'Review changes');
  assert.equal(await run("document.querySelector('#desktop-count').textContent"), '1 game');
  assert.equal(await run("document.querySelectorAll('#desktop-games .game-card-row').length"), 1);
  assert.equal(await run("document.querySelector('#desktop-games .source-label').textContent"), 'Desktop + Start menu');
  externalChange = false;
  await click('#desktop-games .game-name');
  await run("document.querySelector('#desktop-game-settings details').open = true");
  await change('#desktop-game-settings [data-field=display]', 'Paired variant');
  await wait(() => Object.values(cfg.desktop_overrides).filter(row => row.display === 'Paired variant').length === 2);
  await click('#desktop-game-apply');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await idle();
  assert.equal(lastDesktopApply.length, 2);
  assert.deepEqual(lastDesktopApply.map(row => row.destination).sort(), ['desktop', 'start-menu']);
  assert.ok(lastDesktopApply.every(row => row.display === 'Paired variant'));
  assert.equal(lastDesktopApply[0].args, lastDesktopApply[1].args);
  assert.deepEqual(lastDesktopApply[0].iconChoice, lastDesktopApply[1].iconChoice);
  await run("globalThis.originalMatchMedia = window.matchMedia; window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? { matches: true } : originalMatchMedia(query); undefined");
  await selectDestination('steam');
  await click('#games .game-open');
  assert.equal(await run("document.querySelector('#art-overlay').hidden"), false);
  assert.equal(await run("document.querySelector('#art-overlay').getAnimations({ subtree: true }).length"), 0);
  await click('#art-cancel');
  assert.equal(await run("document.querySelector('#art-overlay').hidden"), true);
  await run("window.matchMedia = originalMatchMedia; delete globalThis.originalMatchMedia");
  await run("document.querySelector('#games .game-open').click(); document.querySelector('#art-cancel').click(); document.querySelector('#games .game-open').click()");
  await wait("!document.querySelector('#art-overlay').hidden && document.querySelector('#art-overlay').getAnimations({ subtree: true }).length === 0");
  assert.equal(await run("document.querySelector('#art-overlay').inert"), false);
  assert.equal(await run("getComputedStyle(document.querySelector('#art-overlay')).opacity"), '1');
  assert.equal(await run("getComputedStyle(document.querySelector('#art-modal')).transform"), 'none');
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  await selectDestination('desktop');
  await idle();
  win.setSize(1060, 740);
  for (const page of ['library', 'desktop']) {
    await selectDestination(page === 'library' ? 'steam' : 'both');
    assert.ok(await run("document.documentElement.scrollWidth <= innerWidth"), `${page} must fit the minimum window width`);
    assert.ok(await run(`{
      const line = document.querySelector('#page-${page} .browse-line');
      const bounds = line.getBoundingClientRect();
      const search = line.querySelector('.search-field').getBoundingClientRect();
      const bar = line.querySelector('.browse-tools').getBoundingClientRect();
      bar.height <= 42 && Math.abs((search.left + search.right - bounds.left - bounds.right) / 2) < 1;
    }`), 'The toolbar stays one row and centers search at minimum width');
    assert.equal(await run("document.querySelector('.library-workspace aside')"), null);
    if (['library', 'desktop'].includes(page)) assert.ok(await run(`{
      const root = document.querySelector('#page-${page}');
      root.querySelector('.list-panel').getBoundingClientRect().width >= root.querySelector('.library-workspace').getBoundingClientRect().width - 1;
    }`), 'The game grid fills the library width');
    await capture(page + '-1060');
  }
  await selectDestination('steam');
  installedGames = [{ name: 'Native game', appid: 42, installdir: 'C:/Games/Native' }];
  foundLaunchers = ['C:/Games/Native/extra.exe', 'C:/Games/Other/extra.exe'].map((exePath, index) => ({
    folder: exePath, startDir: exePath.slice(0, exePath.lastIndexOf('/')), exePath,
    displayName: 'Extra launcher ' + (index + 1), fromExecutableSearch: true,
  }));
  await click('#add-folders');
  await click('#find-overlooked');
  await wait("document.querySelector('#exe-picker')?.open");
  assert.equal(await run("getComputedStyle(document.querySelector('#exe-heading')).userSelect"), 'none');
  await dismissBackdrop('#exe-picker');
  await wait("!document.querySelector('#exe-picker')");
  await click('#add-folders');
  await click('#find-overlooked');
  await wait("document.querySelector('#exe-picker')?.open");
  await click('#exe-search');
  await wait("document.querySelectorAll('#exe-results input').length === 2");
  await click('#exe-select-all');
  await click('#exe-add');
  const launchersShown = () => run("[...document.querySelectorAll('#games .game-name')].filter(item => item.textContent.startsWith('Extra launcher')).length");
  await wait(async () => await launchersShown() === 2);
  await click('#btn-refresh');
  await wait("!document.querySelector('#btn-refresh').disabled");
  assert.equal(await launchersShown(), 2);
  win.setSize(1280, 800);
  installedGames = Array.from({ length: 18 }, (_, i) => ({
    appid: 500 + i, name: `Fixture game ${i + 1} with a title on two lines`,
  }));
  await click('#btn-refresh');
  await wait("!document.querySelector('#btn-refresh').disabled && document.querySelectorAll('#games .game-card-row').length >= 18");
  const layout = await run(`{
    const scroller = document.querySelector('#page-library .list-wrap');
    const cards = [...document.querySelectorAll('#games .game-card-row')];
    scroller.scrollTop = scroller.scrollHeight;
    const lastLabel = cards.at(-1).querySelector('.game-card-copy');
    ({ width: cards[0].getBoundingClientRect().width, lastLabelVisible:
      lastLabel.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().bottom + 1 });
  }`);
  assert.equal(layout.width, 172);
  assert.ok(layout.lastLabelVisible, 'Labels remain reachable by scrolling with the larger covers');
  await run("document.querySelector('#page-library .list-wrap').scrollTop = 0");
  await capture('library-refined-default');
  await click('#hide-owned');
  assert.ok(await run("document.querySelector('#page-library .library-head #library-grid-count').textContent.endsWith('shown')"));
  console.log('Desktop fixture checks passed');
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
