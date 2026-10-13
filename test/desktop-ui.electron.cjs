'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../src/main/store');
app.setPath('userData', path.join(process.argv[2], 'ui-profile'));
app.disableHardwareAcceleration();
let cfg = { ...DEFAULTS, onboarded: false, desktop_overrides: {}, games_roots: ['C:\\Games'] };
let scans = 0, writes = 0, iconPreviews = 0, searches = 0, externalChange = false;
let pauseApply = false, finishApply;
let steamRequest;
let steamEntries = [];
let pendingSearches = null;
const artRequests = [];
const artworkWrites = [];
const rows = [1, 2].map((i) => ({ id: `link:${i}`, shortcut: `C:\\Desktop\\Variant ${i}.lnk`, signature: 'original',
  display: `Variant ${i}`, exe: 'C:\\Games\\Game.exe', args: `-profile ${i}`, admin: false, icon: 'C:\\Icons\\game.ico', iconIndex: 0,
  confidence: 1, candidates: [{ path: 'C:\\Games\\Game.exe' }] }));
const icon = nativeImage.createFromBitmap(Buffer.alloc(16, 255), { width: 2, height: 2 }).toDataURL();
const downloadedIcon = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toDataURL();
const handlers = {
  'cfg:get': () => cfg,
  'cfg:set': (patch) => (cfg = { ...cfg, ...patch }),
  'app:is-development': () => false,
  'steam:detect': () => ({ path: '', users: [] }),
  'steam:verify': () => false,
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
  'steam:games': () => [],
  'scan:start': () => [],
  'resolve:name': () => null,
  'steam:running': () => false,
  'steam:add': (req) => { steamRequest = req; return { rows: req.rows, lines: [], added: 0, updated: 1, artworkSaved: 0 }; },
  'desktop:apply': async (selected) => {
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
    return Array.from({ length: req.page ? 2 : 30 }, (_, i) => ({ id: req.page * 30 + i + 1,
      url: `${icon}#${req.page * 30 + i}`, thumb: icon, width: 2, height: 2 }));
  },
  'sgdb:search': () => { searches++; return pendingSearches
    ? new Promise((resolve) => pendingSearches.push(resolve)) : [{ id: 17, name: 'Matched game' }]; },
  'desktop:download': (selected) => selected.map((row) => ({ id: row.id, choice: { id: 9, file: 'C:\\Icons\\downloaded.ico', automatic: true } })),
  'scan:find-executables': () => ({ games: [], truncated: false }),
};
for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, (_event, ...args) => handler(...args));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
  const run = (code) => win.webContents.executeJavaScript(code).catch((error) => { throw new Error(`${code}\n${error.message}`); });
  const wait = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (typeof condition === 'function' ? await condition() : await run(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${condition}`);
  };
  const click = (selector) => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => run(`{
    const field = document.querySelector(${JSON.stringify(selector)});
    field.value = ${JSON.stringify(value)};
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  const idle = () => wait("!document.querySelector('#desktop-refresh').disabled");
  const selection = () => run("Array.from(document.querySelectorAll('#desktop-games tbody input'), input => input.checked)");
  await wait("document.querySelector('#page-onboarding').classList.contains('on')");
  assert.equal(await run("document.querySelector('#preview-onboarding').hidden"), true);
  await run("document.querySelector('#onboarding-skip').click(); document.querySelector('#onboarding-continue').click()");
  await wait("document.querySelector('#onboarding-continue').textContent === 'Open library'");
  await click('#onboarding-continue');
  await wait("document.querySelector('#page-desktop').classList.contains('on') && document.querySelectorAll('#desktop-games tbody tr').length === 2");
  await idle();
  assert.equal(cfg.onboarded, true);
  assert.equal(cfg.startup_library, 'desktop');
  assert.equal(writes, 0);
  assert.equal(scans, 1);
  assert.equal(await run("document.querySelector('.steam-controls').hidden"), true);
  assert.equal(await run("document.querySelector('#desktop-games .cover-check').getBoundingClientRect().width"), 0);
  await click('#desktop-games .game-name');
  await wait("!document.querySelector('#desktop-games .game-cover').hidden && document.querySelector('#desktop-games .cover-fallback').hidden");
  assert.equal(await run("document.querySelector('#desktop-add').disabled"), false);
  await click('#desktop-multiple');
  assert.deepEqual(await selection(), [true, false]);
  await click('#desktop-games input');
  assert.deepEqual(await selection(), [false, false]);
  await click('#desktop-games input');
  assert.deepEqual(await selection(), [true, false]);
  await click('#desktop-games .cover-check');
  assert.deepEqual(await selection(), [false, false]);
  await click('#desktop-games .cover-check');
  assert.deepEqual(await selection(), [true, false]);
  await click('#desktop-games .game-name');
  await wait("document.querySelector('#desktop-detail img').complete && document.querySelector('#desktop-detail img').naturalWidth > 0");
  assert.ok(iconPreviews > 0);
  assert.equal(await run("getComputedStyle(document.querySelector('#desktop-detail img')).visibility"), 'visible');
  assert.ok(await run("document.querySelector('#desktop-detail').textContent.includes('requires SGDB API key')"));
  await click('#desktop-games .cover-wrap');
  await click('#desktop-games .cover-wrap');
  assert.equal(await run("document.querySelector('#art-overlay').hidden"), true);
  await run("document.querySelector('#desktop-games .cover-wrap').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))");
  await wait("!document.querySelector('#art-overlay').hidden");
  assert.deepEqual(await run("Array.from(document.querySelectorAll('#art-tabs button'), button => button.textContent)"), ['Icon']);
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
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
  await change('#desktop-detail [data-field=args]', '-edited');
  await wait(() => cfg.desktop_overrides['link:1']?.args === '-edited');
  await run("document.querySelector('#desktop-refresh').click(); document.querySelector('#desktop-refresh').click()");
  await idle();
  assert.equal(scans, 2);
  assert.deepEqual(await selection(), [true, false]);
  assert.equal(await run("document.querySelector('#desktop-detail [data-field=args]').value"), '-edited');
  await click('#desktop-games tbody tr:nth-child(2) .game-name');
  assert.equal(await run("document.querySelector('#desktop-detail [data-field=args]').value"), '-profile 2');
  await click('#desktop-games .game-name');
  await click('#desktop-detail [data-desktop=icon]');
  await wait("!!document.querySelector('#art-choice img') && document.querySelector('#art-choice img').naturalWidth > 0");
  assert.deepEqual(await run("Array.from(document.querySelectorAll('#art-tabs button'), button => button.textContent)"), ['Icon']);
  assert.equal(await run("document.querySelector('#art-search').disabled"), true);
  await click('#art-cancel');
  await click('[data-page=settings]');
  assert.equal(await run("document.querySelector('.steam-controls').hidden"), false);
  await change('#settings-cards [data-r=key]', 'fixture');
  await wait(() => cfg.api_key === 'fixture');
  await click('#settings-cards [data-k=include_animated]');
  await wait(() => cfg.include_animated === true);
  await click('[data-page=desktop]');
  await idle();
  await click('#desktop-detail [data-desktop=icon]');
  await wait("document.querySelector('#art-id').value === '17'");
  await wait(() => artRequests.length > 0);
  assert.ok(artRequests.every(req => req.kind === 'icon' && req.filters.animated === false));
  assert.equal(searches, 1);
  await wait("document.querySelectorAll('#art-grid > .thumb').length === 30");
  await run("globalThis.firstTile = document.querySelector('#art-grid > .thumb .thumb-select'); firstTile.click()");
  await run("document.querySelector('#art-more').scrollIntoView({block: 'end'})");
  await wait("document.querySelectorAll('#art-grid > .thumb').length === 32");
  assert.equal(await run("firstTile === document.querySelector('#art-grid > .thumb .thumb-select') && firstTile.closest('.thumb').classList.contains('picked')"), true);
  assert.equal(await run("document.querySelector('#art-more')"), null);
  assert.deepEqual(artRequests.map(req => req.page), [0, 1]);
  await click('#art-filters summary');
  assert.equal(await run(`(() => {
    const fields = document.querySelector('#art-filter-fields');
    const groups = [...fields.querySelectorAll('fieldset')].map(node => node.getBoundingClientRect());
    return fields.scrollWidth <= fields.clientWidth && groups[0].right <= groups[1].left
      && document.querySelector('.thumbScroll').getBoundingClientRect().height > 100;
  })()`), true);
  await click('#art-filter-fields input[data-filter=humor]');
  await wait(() => cfg.artwork_filters?.icon?.humor === true);
  await click('#art-filter-fields input[data-filter=untagged]');
  await wait(() => artRequests.at(-1).filters.untagged === false);
  assert.equal(artRequests.at(-1).page, 0);
  assert.equal(artRequests.at(-1).filters.humor, true);
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
  await click('#art-filter-reset');
  await wait("document.querySelector('#art-filter-fields input[data-filter=dimensions][value=\"512\"]').checked");
  await click('#art-filters summary');
  await click('#art-apply');
  await wait(() => cfg.desktop_overrides['link:1']?.sgdbId === 17);
  assert.ok(await run("document.querySelector('#desktop-detail').textContent.includes('Matched game · 17')"));
  await click('#desktop-download');
  await idle();
  await wait(() => !!cfg.desktop_overrides['link:1']?.iconChoice?.file);
  assert.equal(cfg.desktop_overrides['link:1'].iconChoice.automatic, true);
  await wait(`document.querySelector('#desktop-detail img').src === ${JSON.stringify(downloadedIcon)}`);
  assert.equal(writes, 0);
  await click('#desktop-add');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="0"]');
  await idle();
  assert.equal(writes, 0);
  pauseApply = true;
  await click('#desktop-add');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await wait(() => !!finishApply);
  assert.equal(await run("document.querySelector('#desktop-games').inert"), false);
  assert.equal(await run("document.querySelector('#desktop-detail').inert"), true);
  await click('#desktop-games tbody tr:nth-child(2) .game-name');
  assert.equal(await run("document.querySelector('#desktop-detail').inert"), false);
  await click('#desktop-games input');
  assert.deepEqual(await selection(), [false, false]);
  finishApply();
  pauseApply = false;
  await idle();
  assert.equal(writes, 1);
  assert.deepEqual(await selection(), [false, false]);
  await click('#desktop-games input');
  assert.equal(await run("document.querySelector('#desktop-games .game-state').textContent"), 'Applied');
  externalChange = true;
  await click('#desktop-add');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await idle();
  assert.equal(scans, 2);
  assert.deepEqual(await selection(), [true, false]);
  assert.equal(await run("document.querySelector('#desktop-detail [data-field=args]').value"), '-profile 2');
  await click('#desktop-games .game-name');
  assert.equal(await run("document.querySelector('#desktop-detail [data-field=args]').value"), '-external');
  assert.equal(cfg.desktop_overrides['link:1'], undefined);
  assert.equal(await run("document.querySelector('[data-page=xbox]')"), null);
  await click('[data-page=library]');
  await wait(() => cfg.startup_library === 'steam');
  await click('[data-page=desktop]');
  await wait(() => cfg.startup_library === 'desktop');
  await idle();
  assert.equal(scans, 2);
  await click('[data-page=settings]');
  await change('#settings-cards [data-r=depth]', '2');
  await wait(() => Object.values(cfg.folder_depths).includes(2));
  await click('[data-page=desktop]');
  await idle();
  assert.equal(scans, 3);
  const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.reload();
  await reloaded;
  await wait("document.querySelector('#page-desktop').classList.contains('on') && document.querySelectorAll('#desktop-games tbody tr').length === 2");
  await idle();
  await click('#desktop-games .game-name');
  pendingSearches = [];
  await run("globalThis.oldSearch = document.querySelector('#desktop-detail [data-desktop=search]').onclick(); undefined");
  await run("document.querySelector('#desktop-detail [data-desktop=query]').value='new query'; document.querySelector('#desktop-detail [data-desktop=search]').click()");
  assert.equal(pendingSearches.length, 2);
  pendingSearches[1]([{ id: 22, name: 'New result' }]);
  await wait("document.querySelector('#desktop-detail [data-desktop=matches]').value === '22'");
  pendingSearches[0]([{ id: 11, name: 'Old result' }]);
  await run('oldSearch');
  assert.equal(await run("document.querySelector('#desktop-detail [data-desktop=matches]').value"), '22');
  pendingSearches = null;
  externalChange = 'removed';
  await click('#desktop-detail-apply');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await idle();
  assert.equal(await run("document.querySelectorAll('#desktop-games tbody tr').length"), 1);
  assert.equal(await run("document.querySelector('#desktop-games .game-name').textContent"), 'Variant 2');
  assert.equal(cfg.desktop_overrides['link:1'], undefined);
  steamEntries = [{ managed: true, appName: 'Old name', exe: 'C:/Games/game.exe', index: 0, appid: 1 }];
  await click('[data-page=library]');
  await wait("document.querySelectorAll('#games tbody tr').length === 1 && !document.querySelector('#btn-refresh').disabled");
  assert.equal(await run("document.querySelector('#btn-add').disabled"), false);
  assert.equal(await run("document.querySelector('#btn-add').textContent"), 'Apply all to Steam');
  await click('#btn-add');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="0"]');
  assert.equal(steamRequest, undefined);
  const steamSelection = () => run("Array.from(document.querySelectorAll('#games .row-check'), input => input.checked)");
  const beforeLabel = await steamSelection();
  await click('#select-multiple');
  await click('#games .cover-check');
  assert.deepEqual(await steamSelection(), [!beforeLabel[0]]);
  await click('#games .cover-check');
  assert.deepEqual(await steamSelection(), beforeLabel);
  await click('#select-multiple');
  await click('#games tbody input');
  await click('#games .game-name');
  await change('#d-name', 'New name');
  await run("document.querySelector('#steam-launch-settings').open = true");
  await change('#d-startdir', 'C:/Games/Working directory');
  await change('#d-args', '--windowed "two words"');
  await click('#btn-add');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await wait("document.querySelector('#confirm-overlay h3')?.textContent === 'Artwork'");
  assert.equal(await run(`document.querySelector('#confirm-overlay [data-v="0"]').textContent`), 'Add without artwork');
  await click('#confirm-overlay [data-v="0"]');
  await wait("document.querySelector('#status').textContent.includes('updated')");
  assert.equal(steamRequest.rows[0].display, 'New name');
  assert.deepEqual(steamRequest.rows[0].launchSettings, { startDir: 'C:/Games/Working directory', launchOptions: '--windowed "two words"' });
  assert.equal(steamRequest.autoArt, false);
  await click('#games .cover-wrap');
  await click('#games .cover-wrap');
  assert.equal(await run("document.querySelector('#art-overlay').hidden"), true);
  await run("document.querySelector('#games .cover-wrap').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))");
  await wait("document.querySelectorAll('#art-grid > .thumb').length > 0");
  assert.equal(await run("document.querySelector('#art-tabs .on').textContent.startsWith('Vertical Grid')"), true);
  await click('#art-grid > .thumb .thumb-select');
  await click('#art-cancel');
  assert.equal(artworkWrites.length, 0);
  await click('#d-preview-open');
  await wait("document.querySelectorAll('#art-grid > .thumb').length > 0");
  await click('#art-grid > .thumb .thumb-select');
  await run("[...document.querySelectorAll('#art-tabs button')].find(button => button.textContent.startsWith('Logo')).click()");
  await wait("!document.querySelector('#art-logo-position').hidden && document.querySelectorAll('#art-grid > .thumb').length > 0");
  await click('#art-grid > .thumb .thumb-select');
  await change('#art-logo-width', '60');
  await click('#art-apply');
  await wait("document.querySelector('#art-overlay').hidden");
  await wait(`!document.querySelector('#games .game-cover').hidden && document.querySelector('#games .game-cover').src === ${JSON.stringify(downloadedIcon)}`);
  await wait(`!document.querySelector('#d-preview').hidden && document.querySelector('#d-preview').src === ${JSON.stringify(downloadedIcon)}`);
  assert.equal(artworkWrites.length, 1);
  assert.deepEqual(Object.keys(artworkWrites[0].rows[0].art).sort(), ['grid', 'logo']);
  assert.equal(artworkWrites[0].rows[0].logoPosition.nWidthPct, 60);
  assert.equal(artworkWrites[0].kinds.length, 0);
  await click('#d-preview-open');
  await run("[...document.querySelectorAll('#art-tabs button')].find(button => button.textContent === 'Manage').click()");
  await wait("document.querySelectorAll('#art-grid .manage-artwork').length === 5");
  await click('#art-grid [data-manage=restore]');
  await click('#art-cancel');
  assert.equal(artworkWrites.length, 1);
  await click('[data-page=desktop]');
  assert.ok(!await run("document.querySelector('#log').textContent.includes('Artwork applied to Steam.')"));
  await idle();
  await change('#desktop-destination', 'start-menu');
  await wait(() => cfg.desktop_destination === 'start-menu');
  await idle();
  assert.equal(await run("document.querySelector('#desktop-add').textContent"), 'Apply to Start menu');
  await change('#desktop-destination', 'both');
  await wait(() => cfg.desktop_destination === 'both');
  await idle();
  assert.equal(await run("document.querySelector('#desktop-add').textContent"), 'Apply shortcuts');
  await run("document.querySelector('[data-page=library]').click(); document.querySelector('[data-page=settings]').click(); document.querySelector('[data-page=desktop]').click()");
  await wait("!document.querySelector('.route-exit') && document.querySelectorAll('.page.on').length === 1 && document.querySelector('#page-desktop').getAnimations().length === 0");
  assert.equal(await run("document.querySelector('#page-desktop').inert"), false);
  assert.equal(await run("document.querySelector('#page-settings').inert"), true);
  assert.equal(await run("getComputedStyle(document.querySelector('#page-desktop')).opacity"), '1');
  await run("globalThis.originalMatchMedia = window.matchMedia; window.matchMedia = query => query === '(prefers-reduced-motion: reduce)' ? { matches: true } : originalMatchMedia(query); undefined");
  await click('[data-page=settings]');
  assert.equal(await run("document.querySelector('.route-exit')"), null);
  assert.equal(await run("document.querySelector('#page-settings').getAnimations().length"), 0);
  assert.ok(await run(`{
    const list = document.querySelector('#settings-cards .settings-folders select[size]');
    const box = list.getBoundingClientRect();
    const option = list.options[0].getBoundingClientRect();
    option.top >= box.top + 5 && option.left >= box.left + 5
      && option.right <= box.right - 5 && box.height >= option.height * 3;
  }`), 'Folder selection should be inset inside a usable multi-row list');
  const chromeBounds = () => run(`['#app-header', '#pages', '#bottomdock', '#statusbar'].map(selector => {
    const box = document.querySelector(selector).getBoundingClientRect();
    return [box.y, box.height];
  })`);
  const settingsBounds = await chromeBounds();
  await click('[data-page=desktop]');
  await idle();
  assert.deepEqual(await chromeBounds(), settingsBounds, 'Shared header and bottom controls must not shift between pages');
  await click('[data-page=library]');
  assert.deepEqual(await chromeBounds(), settingsBounds, 'Steam and Desktop should use the same available page bounds');
  await click('#d-preview-open');
  assert.equal(await run("document.querySelector('#art-overlay').hidden"), false);
  assert.equal(await run("document.querySelector('#art-overlay').getAnimations({ subtree: true }).length"), 0);
  await click('#art-cancel');
  assert.equal(await run("document.querySelector('#art-overlay').hidden"), true);
  await run("window.matchMedia = originalMatchMedia; delete globalThis.originalMatchMedia");
  await run("document.querySelector('#d-preview-open').click(); document.querySelector('#art-cancel').click(); document.querySelector('#d-preview-open').click()");
  await wait("!document.querySelector('#art-overlay').hidden && document.querySelector('#art-overlay').getAnimations({ subtree: true }).length === 0");
  assert.equal(await run("document.querySelector('#art-overlay').inert"), false);
  assert.equal(await run("getComputedStyle(document.querySelector('#art-overlay')).opacity"), '1');
  assert.equal(await run("getComputedStyle(document.querySelector('#art-modal')).transform"), 'none');
  await click('#art-cancel');
  await wait("document.querySelector('#art-overlay').hidden");
  console.log('Desktop fixture checks passed');
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
