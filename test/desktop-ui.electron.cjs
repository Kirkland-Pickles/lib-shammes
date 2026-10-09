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
  'art:current': () => null,
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
  'art:list': (req) => { artRequests.push(req); return []; },
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
  await click('#desktop-games input');
  assert.deepEqual(await selection(), [true, false]);
  await click('#desktop-games .game-name');
  await wait("document.querySelector('#desktop-detail img').complete && document.querySelector('#desktop-detail img').naturalWidth > 0");
  assert.ok(iconPreviews > 0);
  assert.equal(await run("getComputedStyle(document.querySelector('#desktop-detail img')).visibility"), 'visible');
  assert.ok(await run("document.querySelector('#desktop-detail').textContent.includes('requires SGDB API key')"));
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
  assert.equal(await run("document.querySelector('#desktop-games tbody tr td:last-child').textContent"), 'Saved');
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
  await click('[data-page=xbox]');
  await wait(() => cfg.startup_library === 'xbox');
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
  await click('#desktop-games input');
  await click('#desktop-add');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await idle();
  assert.equal(await run("document.querySelectorAll('#desktop-games tbody tr').length"), 1);
  assert.equal(await run("document.querySelector('#desktop-games .game-name').textContent"), 'Variant 2');
  assert.equal(cfg.desktop_overrides['link:1'], undefined);
  steamEntries = [{ managed: true, appName: 'Old name', exe: 'C:/Games/game.exe', index: 0, appid: 1 }];
  await click('[data-page=library]');
  await wait("document.querySelectorAll('#games tbody tr').length === 1 && !document.querySelector('#btn-refresh').disabled");
  await click('#games tbody input');
  await click('#games .game-name');
  await change('#d-name', 'New name');
  await click('#btn-add');
  await wait("!!document.querySelector('#confirm-overlay')");
  await click('#confirm-overlay [data-v="1"]');
  await wait("document.querySelector('#confirm-overlay h3')?.textContent === 'Artwork'");
  assert.equal(await run(`document.querySelector('#confirm-overlay [data-v="0"]').textContent`), 'Add without artwork');
  await click('#confirm-overlay [data-v="0"]');
  await wait("document.querySelector('#status').textContent.includes('updated')");
  assert.equal(steamRequest.rows[0].display, 'New name');
  assert.equal(steamRequest.autoArt, false);
  console.log('Desktop fixture checks passed');
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
