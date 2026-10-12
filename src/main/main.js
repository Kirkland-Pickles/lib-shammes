'use strict';
/* Main-process window and IPC handlers. */
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeTheme, nativeImage } = require('electron');

if (app.isPackaged) Menu.setApplicationMenu(null);

const store = require('./store');
const steam = require('./steam');
const scanner = require('./scanner');
const resolveMod = require('./resolve');
const strips = require('./strips');
const sgdbMod = require('./sgdb');
const images = require('./images');
const { createDesktop } = require('./desktop');
const { elevateShortcut, runShortcutHelper } = require('./desktop-elevation');
const desktop = createDesktop({ app, shell, nativeImage, elevate: (row) => elevateShortcut(app, row) });

let win = null;
let cfg = store.load();
cfg.steam_path = steam.normalizeSteamPath(cfg.steam_path);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function progress(current, total, label) {
  send('job:progress', { current, total, label: label || '' });
}
function windowColors() {
  const light = cfg.theme === 'light' || (cfg.theme !== 'dark' && !nativeTheme.shouldUseDarkColors);
  return light ? { background: '#f7f7f7', text: '#1d1d1d' } : { background: '#0b0d0e', text: '#e9ece7' };
}
function updateWindowTheme() {
  if (!win || win.isDestroyed()) return;
  const colors = windowColors();
  win.setBackgroundColor(colors.background);
  if (process.platform !== 'darwin') win.setTitleBarOverlay({ symbolColor: colors.text });
}
function createWindow() {
  const colors = windowColors();
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1060,
    minHeight: 660,
    title: `Lib Shammes v${app.getVersion()}`,
    icon: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: colors.text, height: 32 },
    backgroundColor: colors.background,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Mouse back/forward buttons (and friends) drive the in-app history router.
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward') { send('nav:cmd', 'back'); e.preventDefault(); }
    else if (cmd === 'browser-forward') { send('nav:cmd', 'fwd'); e.preventDefault(); }
  });
  if (process.env.EXAMPLE_SMOKE) {
    console.log('READY sgdb-app');
    setTimeout(() => app.quit(), 3000);
  }
}

// ---------------------------------------------------------------- config
ipcMain.handle('app:is-development', () => !app.isPackaged);
ipcMain.handle('cfg:get', () => cfg);
ipcMain.handle('cfg:set', (_e, patch) => {
  const clean = store.sanitizePatch(patch);
  if (steamWriteBusy && ['steam_path', 'steam_user_id'].some(key => Object.hasOwn(clean, key) && clean[key] !== cfg[key])) {
    throw new Error('Steam changes are already being applied.');
  }
  if (Object.prototype.hasOwnProperty.call(clean, 'steam_path')) {
    clean.steam_path = steam.normalizeSteamPath(clean.steam_path);
  }
  const next = { ...cfg, ...clean };
  store.save(next);
  Object.assign(cfg, next);
  if (clean.theme !== undefined) updateWindowTheme();
  return cfg;
});

// ----------------------------------------------------------------- steam
ipcMain.handle('steam:detect', async (_e, hint) => {
  if (steamWriteBusy) throw new Error('Steam changes are already being applied.');
  const found = await steam.findSteamPath(hint || cfg.steam_path || null);
  if (steamWriteBusy) throw new Error('Steam changes are already being applied.');
  if (found) {
    cfg.steam_path = found;
    const users = steam.getUserPersonas(found);
    if (users.length && !users.some((u) => u.id === cfg.steam_user_id)) {
      let best = users[0].id;
      for (const u of users) {
        if (fs.existsSync(steam.shortcutsPath(found, u.id))) { best = u.id; break; }
      }
      cfg.steam_user_id = best;
    }
    store.save(cfg);
    return { path: found, users };
  }
  return { path: null, users: [] };
});

ipcMain.handle('steam:browse', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Point at steam.exe',
    defaultPath: cfg.steam_path || 'C:\\Program Files (x86)\\Steam',
    filters: [{ name: 'Steam', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (r.canceled) return { path: null };
  if (path.basename(r.filePaths[0]).toLowerCase() !== 'steam.exe') {
    return { path: null, error: 'that is not steam.exe - please pick the Steam executable itself😊' };
  }
  return { path: steam.normalizeSteamPath(r.filePaths[0]) };
});

ipcMain.handle('steam:users', (_e, steamPath) => steam.getUserPersonas(steamPath));

ipcMain.handle('steam:verify', (_e, steamPath) => steam.hasSteamExe(steam.normalizeSteamPath(steamPath)));

ipcMain.handle('steam:open-grid', async () => {
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  const gd = steam.gridDir(cfg.steam_path, cfg.steam_user_id);
  fs.mkdirSync(gd, { recursive: true });
  await shell.openPath(gd);
  return true;
});

ipcMain.handle('steam:running', () => steam.isSteamRunning());

ipcMain.handle('steam:kill', async () => steam.killSteam());

ipcMain.handle('steam:launch', async () => {
  if (!cfg.steam_path) throw new Error('Set Steam path first in Settings.');
  if (!(await steam.hasSteamExe(cfg.steam_path))) {
    throw new Error(`No steam.exe in ${cfg.steam_path} - check Settings.`);
  }
  return steam.launchSteam(cfg.steam_path);
});

ipcMain.handle('steam:restart', async () => {
  if (!cfg.steam_path) throw new Error('Set Steam path first in Settings.');
  if (!(await steam.hasSteamExe(cfg.steam_path))) {
    throw new Error(`No steam.exe in ${cfg.steam_path} - check Settings.`);
  }
  return steam.restartSteam(cfg.steam_path);
});

ipcMain.handle('steam:prune', async () => {
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  return steam.findStaleShortcuts(steam.loadEntries(cfg.steam_path, cfg.steam_user_id));
});

ipcMain.handle('steam:read', () => {
  if (!cfg.steam_path || !cfg.steam_user_id) return [];
  return steam.loadEntries(cfg.steam_path, cfg.steam_user_id)
    .map((e, i) => ({
      index: i, appid: e.appid, appName: e.AppName, exe: e.Exe,
      startDir: e.StartDir, launchOptions: e.LaunchOptions, icon: e.icon, managed: steam.isManagedEntry(e),
    }));
});

ipcMain.handle('steam:games', () => {
  if (!cfg.steam_path) return [];
  return steam.listInstalledGames(cfg.steam_path);
});

/** Self-uninstall of app data: delete config + Chromium profile, then quit.
 *  Steam and the games are untouched (that's Purge's job).
 *  Order matters: the config FILES go first, individually, because they are
 *  never locked - the live Chromium profile around them always is, so a
 *  whole-dir delete dies on locked files and used to leave config.json
 *  behind (the wipe that never wiped). Profile leftovers are inert now. */
function wipeData() {
  const removed = [];
  const skipped = [];
  for (const f of store.dataFiles()) {
    try {
      if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(f); }
    } catch (e) {
      skipped.push(`${f} (${e.message || e})`);
    }
  }
  // Forget in memory too, so any save between here and quit writes defaults.
  cfg = store.load();
  const dirs = [...new Set([...store.dataDirs(), app.getPath('userData')])];
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
      removed.push(d);
    } catch (e) {
      skipped.push(`${d} (${e.message || e})`);
    }
  }
  return { removed, skipped, cfg };
}

ipcMain.handle('app:wipe-data', () => {
  if (steamWriteBusy) throw new Error('Steam changes are already being applied.');
  const result = wipeData();
  setImmediate(() => { try { app.quit(); } catch { /* already going down */ } });
  return result;
});

function purgeSteam(opts) {
  // Fail closed: absent input means dry run; only an explicit false arms it.
  const dryRun = !opts || opts.dryRun !== false;
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  const sp = cfg.steam_path;
  const uid = cfg.steam_user_id;
  const entries = steam.loadEntries(sp, uid);
  const changes = store.loadChanges();
  const plan = steam.planPurge(entries, changes, [steam.gridDir(sp, uid)]);
  if (dryRun) return { ...plan, executed: false };
  const lines = [];
  const byAppid = new Map(entries.map((e) => [Number(e.appid), e]));
  for (const f of plan.restoreFields) {
    const e = byAppid.get(Number(f.appid));
    if (e) {
      e[f.field] = f.before;
      lines.push(`  restored ${f.field} on '${e.AppName}'`);
    }
  }
  const removeSet = new Set(plan.removeAppids.map(Number));
  const kept = entries.filter((e) => !removeSet.has(Number(e.appid)));
  const bak = removeSet.size || plan.restoreFields.length ? steam.saveEntries(sp, uid, kept) : null;
  if (bak) lines.push(`shortcuts.vdf backed up -> ${path.basename(bak)}`);
  lines.push(`Removed ${entries.length - kept.length} shortcut(s).`);
  let deleted = 0;
  const failedFiles = [];
  for (const f of plan.restoreFiles) {
    try {
      fs.copyFileSync(f.before, f.path);
      lines.push(`  restored ${f.path}`);
    } catch {
      lines.push(`  could not restore ${f.path}`);
      failedFiles.push(changes.files.find((entry) => entry.path === f.path));
    }
  }
  for (const f of plan.deleteFiles) {
    try {
      fs.unlinkSync(f.path);
      deleted++;
    } catch {
      lines.push(`  could not delete ${f.path}`);
      failedFiles.push(changes.files.find((entry) => entry.path === f.path) || { path: f.path });
    }
  }
  for (const s of plan.skippedFiles) lines.push(`  kept ${s.path} - ${s.why}`);
  lines.push(`Deleted ${deleted} art file(s), kept ${plan.skippedFiles.length} changed-by-user.`);
  store.saveChanges({ ...store.blankChanges(), files: failedFiles });
  for (const f of changes.files) {
    if (f.before && !failedFiles.includes(f)) {
      try { fs.unlinkSync(f.before); } catch {}
    }
  }
  return { ...plan, lines, failedFiles, executed: true, backup: bak ? path.basename(bak) : null };
}

ipcMain.handle('steam:purge', (_e, opts) => opts?.dryRun === false
  ? withSteamClosed(() => purgeSteam(opts)) : purgeSteam(opts));

async function uninstallCleanup() {
  if (process.argv.includes('--purge-steam')) {
    if (await steam.isSteamRunning()) throw new Error('Close Steam completely, then run the uninstaller again.');
    const result = purgeSteam({ dryRun: false });
    if (result.failedFiles.length) throw new Error('Some artwork could not be removed. The undo history was kept. Close any programs using it and try again.');
  }
  if (process.argv.includes('--delete-desktop-icons')) {
    let failures;
    try { failures = await desktop.cleanup(); }
    catch (e) { failures = [e.message]; }
    if (failures.length) await dialog.showMessageBox({ type: 'warning', title: 'Some shortcut icons remain',
      message: 'Icons still needed by shortcuts were kept.', detail: failures.join('\n'), buttons: ['OK'] });
  }
  if (process.argv.includes('--delete-app-data')) {
    let skipped;
    try { skipped = wipeData().skipped; }
    catch (e) { skipped = [e.message || String(e)]; }
    if (skipped.length) {
      await dialog.showMessageBox({
        type: 'warning', title: 'Some app data remains',
        message: 'Lib Shammes will be uninstalled, but some app data could not be removed and will remain on disk.',
        detail: skipped.join('\n'), buttons: ['OK'],
      });
    }
  }
  return 0;
}

// ------------------------------------------------------------ key/folders
ipcMain.handle('key:validate', async (_e, key) => {
  try {
    const games = await new sgdbMod.SGDBClient(key).searchGame('Half-Life 2');
    if (games.length) {
      cfg.api_key = String(key).trim();
      store.save(cfg);
      return { ok: true, name: `${games[0].name} [${games[0].id}]` };
    }
    return { ok: false, error: 'Key accepted but search returned nothing.' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('folders:browse', async () => {
  const roots = cfg.games_roots.length ? cfg.games_roots : [];
  const r = await dialog.showOpenDialog(win, {
    title: 'Add a folder containing your games',
    defaultPath: roots[roots.length - 1],
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('files:pick-exe', async (_e, dir) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Pick game executable',
    defaultPath: dir || undefined,
    filters: [{ name: 'Executables', extensions: ['exe'] }, { name: 'All', extensions: ['*'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('files:pick-dir', async (_e, dir) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Pick start folder',
    defaultPath: dir || undefined,
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('files:pick-image', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    properties: ['openFile'],
  });
  return r.canceled ? null : r.filePaths[0];
});

async function previewFile(file, extension = path.extname(String(file))) {
  if (extension === '.bak') {
    const record = store.loadChanges().files.find((f) => f.before === file);
    if (record) extension = path.extname(record.path);
  }
  const ext = extension.slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'webp', 'bmp', 'ico'].includes(ext)) throw new Error('Choose an image file to preview.');
  const stat = await fs.promises.stat(file);
  if (stat.size > 32 * 1024 * 1024) throw new Error('Image is too large to preview (maximum 32 MB).');
  const bytes = await fs.promises.readFile(file);
  const type = images.isWebp(bytes) ? 'webp' : images.isPng(bytes) ? 'png' : ext === 'jpg' ? 'jpeg' : ext === 'ico' ? 'x-icon' : ext;
  return `data:image/${type};base64,${bytes.toString('base64')}`;
}
ipcMain.handle('art:preview-file', (_e, file) => previewFile(file));
ipcMain.handle('art:official', async (_e, req) => {
  const appid = Number(req?.row?.steamAppid);
  if (!Number.isSafeInteger(appid) || appid <= 0 || appid > 0xffffffff || !Object.hasOwn(steam.ART_SUFFIXES, req?.kind)) return null;
  const dir = path.join(store.configDir(), 'official-artwork');
  const file = path.join(dir, `${appid}-${req.kind}.png`);
  if (fs.existsSync(file)) return { file, url: await previewFile(file) };
  const c = client();
  const metadata = cfg.api_key ? await c.steamMetadata(appid).catch(() => ({})) : {};
  let lastError;
  for (const url of sgdbMod.officialArtworkUrls(appid, req.kind, metadata)) {
    try {
      const bytes = await c.downloadBytes(url, 32 * 1024 * 1024);
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw new Error('Steam returned an unreadable image.');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, image.toPNG());
      return { file, url: await previewFile(file) };
    } catch (e) { lastError = e; }
  }
  if (lastError) throw new Error(`Official artwork could not load: ${lastError.message}`);
  return null;
});
ipcMain.handle('art:current', async (_e, req) => {
  let file = steam.currentArtwork(cfg.steam_path, cfg.steam_user_id, req?.row, req?.kind, !!req?.stock);
  const changes = req?.stock ? store.loadChanges().files : [];
  if (!file && req?.stock && req?.row?.source === 'steam' && req.kind === 'icon') {
    const dir = path.join(cfg.steam_path, 'appcache', 'librarycache', String(req.row.steamAppid));
    file = changes.find((f) => path.dirname(f.path) === dir
      && /^[a-f0-9]{40}\.jpg$/i.test(path.basename(f.path)) && f.before)?.path;
  }
  if (!file) return null;
  const extension = path.extname(file);
  if (req.stock) {
    const record = changes.find((f) => f.path === file && Object.hasOwn(f, 'before'));
    if (record) {
      if (!record.before || !fs.existsSync(record.before)) return null;
      file = record.before;
    }
  }
  return { file, ...(req.existsOnly ? {} : { url: await previewFile(file, extension) }) };
});

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
ipcMain.handle('util:open-url', (_e, url) => shell.openExternal(url));

// ------------------------------------------------------------------ scan
function scanFolders(req) {
  const roots = (req && Array.isArray(req.roots) ? req.roots : []).filter(Boolean);
  if (!roots.length) throw new Error('Scan needs at least one folder.');
  const seen = new Set();
  const games = [];
  for (let ri = 0; ri < roots.length; ri++) {
    const part = scanner.scanGames(roots[ri], {
      maxDepth: Math.max(0, Math.min(6, Math.floor(Number(cfg.folder_depths[store.folderKey(roots[ri])] ?? 1)) || 0)),
      onProgress: (i, t, name) => progress(i, t, `[${ri + 1}/${roots.length}] ${i}/${t}: ${name}`),
    });
    for (const g of part) {
      const k = g.folder.toLowerCase();
      if (!seen.has(k)) { seen.add(k); games.push(g); }
    }
  }
  progress(0, 0, '');
  const catalog = cfg.steam_path ? steam.listInstalledGames(cfg.steam_path) : [];
  return games.map(game => resolveMod.identifyFromCatalog(game, catalog));
}
function savedExecutables(library) {
  const catalog = cfg.steam_path ? steam.listInstalledGames(cfg.steam_path) : [];
  return (cfg[`${library}_executables`] || []).filter((game) => {
    try { return /\.exe$/i.test(game.exePath) && fs.statSync(game.exePath).isFile(); }
    catch { return false; }
  }).map(game => resolveMod.identifyFromCatalog(game, catalog));
}
ipcMain.handle('scan:start', (_e, req) => {
  const games = req?.roots?.length ? scanFolders(req) : [];
  const seen = new Set(games.map((game) => store.folderKey(game.exePath)));
  return [...games, ...savedExecutables('steam').filter((game) => {
    const key = store.folderKey(game.exePath);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  })];
});
let desktopJob = false;
ipcMain.handle('desktop:scan', async () => {
  if (desktopJob) throw new Error('Desktop library is busy.');
  desktopJob = true;
  try {
    const games = cfg.games_roots.length ? scanFolders({ roots: cfg.games_roots }) : [];
    return await desktop.discover([...games, ...savedExecutables('desktop')], cfg.desktop_destination);
  } finally { desktopJob = false; }
});
ipcMain.handle('desktop:apply', async (_e, rows) => {
  if (desktopJob) throw new Error('Desktop library is busy.');
  desktopJob = true;
  try {
    const results = await desktop.apply(rows, (i, total, name) => progress(i, total, `Saving shortcut ${i + 1}/${total}: ${name}`));
    for (const result of results) if (result.ok || result.refreshed) {
      delete cfg.desktop_overrides[result.id];
      if (result.ok) cfg.desktop_overrides[result.row.id] = { display: result.row.display, sgdbId: result.row.sgdbId, sgdbName: result.row.sgdbName, signature: result.row.signature };
    }
    try { store.save(cfg); }
    catch (e) {
      for (const result of results) if (result.ok || result.refreshed) {
        result.warning = [result.warning, `App settings could not be saved: ${e.message}`].filter(Boolean).join('\n');
      }
    }
    return results;
  } finally { desktopJob = false; progress(0, 0, ''); }
});
ipcMain.handle('desktop:icon', (_e, file, index) => desktop.preview(file, index));
ipcMain.handle('desktop:download', async (_e, rows) => {
  if (desktopJob) throw new Error('Desktop library is busy.');
  desktopJob = true;
  const results = [];
  try {
    for (const row of rows) {
      try {
        if (!row.sgdbId) { results.push({ id: row.id, skipped: 'Not matched.' }); continue; }
        if (cfg.only_missing && (row.icon || row.iconChoice)) {
          results.push({ id: row.id, skipped: 'Icon already present; skipping is enabled.' }); continue;
        }
        progress(results.length, rows.length, row.display);
        const filters = { ...artworkFilters('icon'), static: true, animated: false };
        const icon = sgdbMod.chooseArtwork(await listArtwork({ sgdbId: row.sgdbId, kind: 'icon', filters }), filters);
        if (!icon) { results.push({ id: row.id, error: 'No icons found.' }); continue; }
        results.push({ id: row.id, choice: { ...icon, file: await desktop.cacheIcon(icon), automatic: true } });
      } catch (e) { results.push({ id: row.id, error: e.message }); }
    }
    return results;
  } finally { desktopJob = false; progress(0, 0, ''); }
});
ipcMain.handle('desktop:pick-icon', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Choose shortcut icon', properties: ['openFile'],
    filters: [{ name: 'Icons, images and programs', extensions: ['ico', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'exe', 'dll'] }] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('scan:find-executables', async (_e, req) => {
  const roots = (req && Array.isArray(req.roots) ? req.roots : []).filter(Boolean);
  const claimed = (req && Array.isArray(req.claimed) ? req.claimed : []);
  const seen = new Set();
  const out = [];
  let truncated = false;
  for (const root of roots) {
    const { games, truncated: t } = scanner.findExecutables(root, claimed);
    truncated = truncated || t;
    for (const g of games) {
      const k = g.exePath.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(g); }
    }
  }
  return { games: out, truncated };
});

// ------------------------------------------------------------------ sgdb
function client() {
  return new sgdbMod.SGDBClient(cfg.api_key);
}

ipcMain.handle('sgdb:search', async (_e, q) => client().searchGame(strips.toSearchQuery(q)));
ipcMain.handle('sgdb:by-steam', async (_e, appid) => client().gameBySteamAppid(appid));

/** Identity guess for an existing shortcut/store name (display only). */
ipcMain.handle('resolve:name', async (_e, name) => {
  return resolveMod.resolveFolder(String(name || ''), scanner.cleanFolderName);
});

ipcMain.handle('art:list', (_e, req) => listArtwork(req));
ipcMain.handle('art:logo-position', (_e, row) => steam.logoPosition(cfg.steam_path, cfg.steam_user_id, row));
function artworkFilters(kind, defaults = {}) {
  return { animated: cfg.include_animated, nsfw: cfg.include_nsfw, humor: cfg.include_humor,
    ...defaults, ...cfg.artwork_filters?.[kind] };
}
async function listArtwork(req, c = client()) {
  const sgdbId = Number(req && req.sgdbId);
  if (!Number.isFinite(sgdbId) || sgdbId <= 0) throw new Error('Art list needs an SGDB game id.');
  const kind = req.kind;
  const filters = req.filters || artworkFilters(kind);
  const o = {
    types: [filters.static !== false && 'static', filters.animated && 'animated'].filter(Boolean).join(','),
    nsfw: filters.nsfw ? 'any' : 'false',
    humor: filters.humor || filters.untagged === false ? 'any' : 'false',
    epilepsy: filters.epilepsy === false && filters.untagged !== false ? 'false' : 'any',
    ...(filters.untagged === false ? { oneoftag: ['nsfw', 'humor', 'epilepsy'].filter(tag => filters[tag]).join(',') } : {}),
    ...Object.fromEntries(['styles', 'dimensions', 'mimes'].filter(key => filters[key]?.length)
      .map(key => [key, filters[key].join(',')])),
    limit: 30,
    page: Number.isSafeInteger(req.page) && req.page >= 0 ? req.page : 0,
  };
  if (kind === 'wide') return c.gridsWide(sgdbId, o);
  if (kind === 'grid') return c.gridsVertical(sgdbId, o);
  if (kind === 'hero') return c.heroes(sgdbId, o);
  if (kind === 'logo') return c.logos(sgdbId, o);
  return c.icons(sgdbId, o);
}

ipcMain.handle('art:prepare', async (_e, req) => {
  const rows = req.rows || [];
  const lines = [];
  let prepared = 0;
  let failed = 0;
  for (const row of rows) {
    row.art ||= {};
    let metadata;
    for (const kind of req.kinds || []) {
      if (!Object.hasOwn(steam.ART_SUFFIXES, kind) || !row.sgdbId) continue;
      try {
        if (cfg.only_missing && (row.art[kind] || steam.currentArtwork(cfg.steam_path, cfg.steam_user_id, row, kind))) continue;
        if (cfg.only_missing && row.source === 'steam') {
          metadata ||= await client().steamMetadata(row.steamAppid).catch(() => ({}));
          if (hasStockArtwork(metadata, kind)) continue;
        }
        const image = sgdbMod.chooseArtwork(await listArtwork({ sgdbId: row.sgdbId, kind }), artworkFilters(kind));
        if (!image) { lines.push(`${row.display} [${kind}]: no matching artwork.`); continue; }
        row.art[kind] = image;
        prepared++;
      } catch (e) { failed++; lines.push(`${row.display} [${kind}]: ${e.message || e}`); }
    }
  }
  return { rows, lines, prepared, failed };
});

// ----------------------------------------------------------------- match
ipcMain.handle('match:auto', async (_e, req) => {
  const rows = (req && Array.isArray(req.rows) ? req.rows : []);
  const force = !!(req && req.force);
  const persist = !req || req.persist !== false;
  const c = client();
  const lines = [];
  let ok = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    progress(i, rows.length, `Matching ${i + 1}/${rows.length}: ${row.display}`);
    const cached = force ? null : store.sgdbIdFor(cfg, row.folder);
    if (cached && !row.sgdbId) {
      row.sgdbId = cached; row.sgdbName = '(cached)';
      if (persist) store.rememberSgdb(cfg, row.folder, cached);
      ok++;
      continue;
    }
    if (row.sgdbId && !force) { ok++; continue; }
    if (row.steamAppid) {
      const direct = await c.gameBySteamAppid(row.steamAppid).catch(() => null);
      if (direct) {
        row.sgdbId = direct.id; row.sgdbName = direct.name;
        if (persist) store.rememberSgdb(cfg, row.folder, direct.id);
        lines.push(`  ${row.display} -> ${direct.name} [${direct.id}] (Steam ${row.steamAppid})`);
        ok++;
        continue;
      }
      if (row.source === 'steam') {
        lines.push(`  ${row.display}: no SGDB match for Steam ${row.steamAppid}; choose a match manually.`);
        continue;
      }
      lines.push(`  ${row.display}: Steam ${row.steamAppid} not on SGDB, trying title search…`);
    }
    try {
      const query = strips.toSearchQuery(row.query || row.display);
      if (query.replace(/[^\p{L}\p{N}]/gu, '').length < 3) {
        lines.push(`  ${row.display}: query too vague, skipped`);
        continue;
      }
      const games = await c.searchGame(query);
      const top = resolveMod.chooseTitleMatch(query, games);
      if (top) {
        row.sgdbId = top.id; row.sgdbName = top.name;
        if (persist) store.rememberSgdb(cfg, row.folder, top.id);
        lines.push(`  ${row.display} -> ${top.name} [${top.id}] (title search)`);
        ok++;
      } else if (games.length) {
        lines.push(`  ${row.display}: no clear match; choose a match manually.`);
      } else {
        lines.push(`  ${row.display}: no match`);
      }
    } catch (err) {
      lines.push(`  ${row.display}: ${String((err && err.message) || err)}`);
    }
  }
  if (persist) store.save(cfg);
  progress(0, 0, `Matched ${ok}/${rows.length}.`);
  return { rows, lines, ok };
});

// ------------------------------------------------------------------- art
function hasStockArtwork(metadata, kind) {
  const key = { wide: 'header_image', grid: 'library_capsule', hero: 'library_hero', logo: 'library_logo', icon: 'icon' }[kind];
  const full = metadata[`${key}_full`];
  return !!(metadata[key] || (kind === 'icon' && metadata.clienticon)
    || [full?.image || full, full?.image2x].some(map => Object.values(map || {}).some(value => typeof value === 'string' && value)));
}

async function fetchOneArt(c, gridFolder, stem, row, kind, filters, onlyMissing, changes = null, shortcut = null, native = null, beforeWrite = native?.beforeWrite) {
  const suffix = steam.ART_SUFFIXES[kind];
  const sel = row.art?.[kind]?.automatic ? null : (row.art && row.art[kind]) || null;
  if (!sel && onlyMissing && images.gridHasArt(gridFolder, stem, suffix)) {
    return { line: `${row.display} [${kind}]: already present, skip.`, saved: false };
  }
  let metadata;
  if (native && ((!sel && onlyMissing) || kind === 'icon')) {
    metadata = await native.metadata().catch(e => { if (kind === 'icon') throw e; return {}; });
    const stock = hasStockArtwork(metadata, kind);
    if (!sel && onlyMissing && stock) return { line: `${row.display} [${kind}]: stock Steam artwork present, skip.`, saved: false };
    if (kind === 'icon' && !/^[a-f0-9]{40}$/i.test(metadata.icon || '')) throw new Error('Steam icon cache filename is unavailable.');
  }
  let data = null;
  let src = '';
  let srcUrl = '';
  if (sel && sel.file) {
    data = kind === 'icon' && /\.(exe|dll|ico)$/i.test(sel.file)
      ? Buffer.from((await desktop.preview(sel.file, 0)).split(',')[1], 'base64') : fs.readFileSync(sel.file);
    src = `file ${sel.file}`;
    srcUrl = store.loadChanges().files.find((f) => f.before === sel.file)?.path || sel.file;
  } else if (sel && sel.url) {
    data = await c.downloadBytes(sel.url);
    src = sel.custom ? 'custom URL' : `#${sel.id}`;
    srcUrl = sel.url;
  } else {
    const items = await listArtwork({ sgdbId: row.sgdbId, kind, filters: artworkFilters(kind, filters) }, c);
    if (!items.length) return { line: `${row.display} [${kind}]: no image on SGDB.`, saved: false };
    const img = sgdbMod.chooseArtwork(items, artworkFilters(kind, filters));
    row.art = row.art || {};
    data = await c.downloadBytes(img.url);
    row.art[kind] = { id: img.id, url: img.url, author: img.author, width: img.width, height: img.height,
      automatic: true };
    src = `#${img.id} ${img.author}`;
    srcUrl = img.url;
  }
  if (native && kind === 'icon') {
    const dest = path.join(cfg.steam_path, 'appcache', 'librarycache', stem, `${metadata.icon}.jpg`);
    const finish = native.beforeWrite(dest, false);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    } finally { finish(); }
    row.art[kind] = { ...row.art[kind], appliedFile: dest };
    return { line: `  ${row.display} [icon]: saved ${path.basename(dest)}.`, saved: true };
  }
  if (kind === 'icon') {
    const destPng = steam.artDest(gridFolder, stem, 'icon', '.png');
    const finishPng = beforeWrite?.(destPng, true);
    try { images.saveGridBytes(data, destPng); steam.clearConflictingExts(destPng); }
    finally { finishPng?.(); }
    const icoFile = path.join(gridFolder, `${stem}_icon.ico`);
    const finishIco = beforeWrite?.(icoFile, false);
    let ico;
    try { ico = images.writePngIco(data, icoFile); }
    finally { finishIco?.(); }
    if (ico) {
      if (shortcut && String(shortcut.icon || '') !== ico) {
        if (changes) changes.fields.push({ appid: shortcut.appid, field: 'icon', before: String(shortcut.icon || '') });
        shortcut.icon = ico;
      }
    }
    row.art[kind] = { ...row.art[kind], appliedFile: ico || destPng };
    return { line: `  ${row.display} [icon]: saved ${path.basename(destPng)}${ico ? ` + ${stem}_icon.ico` : ' (no .ico: source was not PNG)'}`, saved: true };
  }
  const dest = steam.artDest(gridFolder, stem, kind, images.isWebp(data) ? '.png' : images.extFromUrl(srcUrl || '.png'));
  const finish = beforeWrite?.(dest, true);
  try {
    images.saveGridBytes(data, dest);
    steam.clearConflictingExts(dest);
  } finally { if (finish) finish(); }
  if (kind === 'logo' && row.logoPosition === undefined) {
    const file = path.join(gridFolder, `${stem}.json`);
    if (!fs.existsSync(file)) {
      const finishPosition = beforeWrite?.(file, false);
      try {
        store.writeFileAtomic(file, JSON.stringify({ nVersion: 1,
          logoPosition: { pinnedPosition: 'BottomLeft', nWidthPct: 50, nHeightPct: 50 } }));
      } finally { if (finishPosition) finishPosition(); }
    }
  }
  row.art[kind] = { ...row.art[kind], appliedFile: dest };
  return { line: `  ${row.display} [${kind}]: saved ${path.basename(dest)} (${src}).`, saved: true };
}

let steamWriteBusy = false;
async function withSteamClosed(write) {
  if (steamWriteBusy) throw new Error('Steam changes are already being applied.');
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  steamWriteBusy = true;
  const steamPath = cfg.steam_path;
  let reopen = false;
  let result;
  let failure;
  try {
    if (await steam.isSteamRunning()) {
      progress(0, 0, 'Closing Steam…');
      await steam.closeSteam(steamPath);
      reopen = true;
    }
    result = await write();
  } catch (e) {
    failure = e;
  } finally {
    if (reopen) {
      try { await steam.launchSteam(steamPath); }
      catch (e) {
        const warning = `Steam could not reopen: ${e.message || e}. Open Steam manually.`;
        if (failure) failure.message += ` ${warning}`;
        else { result.warning = warning; (result.lines ||= []).push(warning); }
      }
    }
    steamWriteBusy = false;
  }
  if (failure) throw failure;
  return result;
}

ipcMain.handle('art:download', (_e, req) => withSteamClosed(() => downloadArtwork(req)));
function artworkBackup(changes) {
  return (dest, clearOthers) => {
    const base = dest.slice(0, -path.extname(dest).length);
    const paths = [dest, ...(clearOthers ? steam.GRID_IMAGE_EXTS.map((ext) => base + ext).filter((p) => p !== dest && fs.existsSync(p)) : [])];
    const records = paths.map((p) => {
      const sig = store.statSig(p);
      const old = changes.files.find((f) => f.path === p && Object.hasOwn(f, 'before'));
      if (old && (sig ? sig.size === old.size && sig.mtimeMs === old.mtimeMs : old.size === null)) return old;
      let before = null;
      if (sig) {
        const dir = path.join(store.configDir(), 'artwork-backups');
        fs.mkdirSync(dir, { recursive: true });
        before = path.join(dir, `${randomUUID()}.bak`);
        fs.copyFileSync(p, before);
      }
      const record = { path: p, before, ...(sig || { size: null, mtimeMs: null }) };
      changes.files = changes.files.filter((f) => f.path !== p);
      changes.files.push(record);
      return record;
    });
    store.saveChanges(changes);
    return () => {
      for (const record of records) Object.assign(record, store.statSig(record.path) || { size: null, mtimeMs: null });
      store.saveChanges(changes);
    };
  };
}
async function downloadArtwork(req) {
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  const rows = (req && Array.isArray(req.rows) ? req.rows : []);
  const kinds = (req && Array.isArray(req.kinds) ? req.kinds : []).filter((kind) => Object.hasOwn(steam.ART_SUFFIXES, kind));
  const onlyMissing = !!(req && req.onlyMissing);
  const filters = (req && req.filters) || {};
  const c = client();
  const gridFolder = steam.gridDir(cfg.steam_path, cfg.steam_user_id);
  fs.mkdirSync(gridFolder, { recursive: true });
  const lines = [];
  const changes = store.loadChanges();
  const beforeWrite = artworkBackup(changes);
  let entries;
  try {
    entries = rows.some((row) => row.source !== 'steam') ? steam.loadEntries(cfg.steam_path, cfg.steam_user_id) : [];
  } catch (err) {
    throw new Error(`Cannot read shortcuts.vdf: ${String((err && err.message) || err)}`);
  }
  let shortcutsChanged = false;
  let saved = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    progress(i, rows.length, `Art ${i + 1}/${rows.length}: ${row.display}`);
    row.appliedKinds = [];
    row.failedKinds = [];
    const isNative = row.source === 'steam';
    const appid = Number(row.steamAppid);
    if (isNative && (!Number.isInteger(appid) || appid <= 0 || appid > 0xffffffff)) {
      lines.push(`  ${row.display}: invalid Steam AppID.`);
      failed++;
      row.failedKinds = Object.keys(row.art || {});
      continue;
    }
    const indexed = !isNative && row.shortcutIdx != null ? entries[row.shortcutIdx] : null;
    const hit = (indexed && (row.appid == null || Number(indexed.appid) === Number(row.appid)) ? indexed : null)
      || (!isNative && row.exe && entries[steam.findByExe(entries, row.exe)]);
    const stem = isNative ? String(appid) : hit ? steam.gridStemFromEntry(hit)
      : (row.exe && row.display ? steam.gridStemFor(steam.quoteExe(row.exe), row.display) : null);
    if (!stem) {
      lines.push(`  ${row.display}: not in Steam yet - add to Steam first (need shortcut id).`);
      continue;
    }
    let metadata;
    const native = isNative ? { beforeWrite, metadata: () => metadata ||= c.steamMetadata(appid) } : null;
    const rowKinds = [...new Set([...kinds, ...Object.keys(row.art || {}).filter((kind) => Object.hasOwn(steam.ART_SUFFIXES, kind) && !row.art[kind]?.automatic)])];
    for (const kind of rowKinds) {
      if (!row.sgdbId && !row.art?.[kind]) continue;
      try {
        if (row.art?.[kind]?.reset) {
          if (kind === 'icon' && isNative) {
            const original = changes.files.filter(f => f.before && path.dirname(f.path) === path.join(cfg.steam_path, 'appcache', 'librarycache', stem));
            const icon = original.find(f => /^[a-f0-9]{40}\.jpg$/i.test(path.basename(f.path)));
            if (!icon) throw new Error('Choose Stock Steam artwork to restore this icon.');
            const finish = beforeWrite(icon.path, false);
            try { fs.copyFileSync(icon.before, icon.path); } finally { finish(); }
          } else {
            for (const ext of [...steam.GRID_IMAGE_EXTS, ...(kind === 'icon' ? ['.ico'] : [])]) {
              const file = path.join(gridFolder, `${stem}${steam.ART_SUFFIXES[kind]}${ext}`);
              if (!fs.existsSync(file)) continue;
              const finish = beforeWrite(file, false);
              try { fs.unlinkSync(file); } finally { finish(); }
            }
            if (kind === 'icon' && hit?.icon) {
              changes.fields.push({ appid: hit.appid, field: 'icon', before: hit.icon });
              hit.icon = '';
              shortcutsChanged = true;
            }
          }
          delete row.art[kind];
          row.appliedKinds.push(kind);
          saved++;
          lines.push(`${row.display} [${kind}]: restored default artwork.`);
          continue;
        }
        const beforeIcon = hit && hit.icon;
        const result = await fetchOneArt(c, gridFolder, stem, row, kind, filters, onlyMissing, changes, hit, native, beforeWrite);
        lines.push(result.line);
        if (result.saved) { saved++; row.appliedKinds.push(kind); }
        if (hit && hit.icon !== beforeIcon) shortcutsChanged = true;
      } catch (err) {
        failed++;
        row.failedKinds.push(kind);
        lines.push(`  ${row.display} [${kind}]: ${String((err && err.message) || err)}`);
      }
    }
    if (row.logoPosition !== undefined) {
      try {
        const position = row.logoPosition;
        if (position && (!['BottomLeft', 'UpperLeft', 'CenterCenter', 'UpperCenter', 'BottomCenter'].includes(position.pinnedPosition)
          || ![position.nWidthPct, position.nHeightPct].every(n => Number.isFinite(n) && n >= 1 && n <= 100))) {
          throw new Error('Choose a valid logo position and size.');
        }
        const file = path.join(gridFolder, `${stem}.json`);
        let data = {};
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const finish = beforeWrite(file, false);
        try {
          if (position) data.logoPosition = position;
          else delete data.logoPosition;
          store.writeFileAtomic(file, JSON.stringify({ nVersion: 1, ...data }));
        } finally { finish(); }
        saved++;
        row.logoPositionApplied = true;
        lines.push(`${row.display}: logo position saved.`);
      } catch (e) { failed++; lines.push(`${row.display}: ${e.message}`); }
    }
  }
  if (shortcutsChanged) {
    const bak = steam.saveEntries(cfg.steam_path, cfg.steam_user_id, entries);
    if (bak) lines.push(`shortcuts.vdf backed up -> ${path.basename(bak)}`);
  }
  store.saveChanges(changes);
  progress(0, 0, `${saved} artwork saved, ${failed} failed.`);
  return { rows, lines, saved, failed };
}

// ------------------------------------------------------------ steam add/rm
ipcMain.handle('steam:add', (_e, req) => withSteamClosed(async () => {
  const result = await addSteam(req);
  if (req.nativeRows?.length) {
    const native = await downloadArtwork({ rows: req.nativeRows, kinds: [], onlyMissing: true, filters: req.filters });
    result.nativeRows = native.rows;
    result.artworkSaved += native.saved;
    result.artworkFailed += native.failed;
    result.lines.push(...native.lines);
  }
  return result;
}));
async function addSteam(req) {
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  const rows = (req && Array.isArray(req.rows) ? req.rows : []);
  const autoArt = !!(req && req.autoArt);
  const kinds = (req && Array.isArray(req.kinds) ? req.kinds : []);
  const filters = (req && req.filters) || {};
  if (!rows.length) return { rows: [], lines: ['No rows to add - nothing was sent.'], added: 0, updated: 0 };
  const sp = cfg.steam_path;
  const uid = cfg.steam_user_id;
  const lines = [];
  let entries;
  try {
    entries = steam.loadEntries(sp, uid);
  } catch (err) {
    throw new Error(`Cannot read shortcuts.vdf: ${String((err && err.message) || err)}`);
  }
  const hasSelectedArt = rows.some((row) => row && row.art && Object.keys(row.art).length);
  const c = autoArt || hasSelectedArt ? client() : null;
  const gridFolder = c ? steam.gridDir(sp, uid) : null;
  if (gridFolder) fs.mkdirSync(gridFolder, { recursive: true });
  let added = 0;
  let updated = 0;
  let artworkSaved = 0;
  let artworkFailed = 0;
  let shortcutsChanged = false;
  const changes = store.loadChanges();
  const beforeWrite = artworkBackup(changes);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    row.appliedKinds = [];
    row.failedKinds = [];
    progress(i, rows.length, `Adding ${i + 1}/${rows.length}: ${row.display}`);
    if (!row.exe || !row.display) {
      lines.push(`  ${row.display || '(unnamed)'}: skipped, no exe - not added.`);
      continue;
    }
    const exactIdx = steam.findByExe(entries, row.exe);
    const indexed = row.shortcutIdx != null ? entries[Number(row.shortcutIdx)] : null;
    const preferredIdx = indexed && steam.isManagedEntry(indexed)
      && (row.appid == null || Number(indexed.appid) === Number(row.appid))
      ? Number(row.shortcutIdx) : -1;
    const oldIdx = exactIdx >= 0 ? exactIdx : preferredIdx;
    const old = oldIdx >= 0 ? entries[oldIdx] : null;
    const entry = steam.buildEntry({
      appName: row.display, exePath: row.exe,
      startDir: row.launchSettings?.startDir ?? (exactIdx >= 0 ? old.StartDir : row.startDir),
      icon: old ? old.icon : '',
      launchOptions: row.launchSettings?.launchOptions ?? (old ? old.LaunchOptions : row.launchOptions),
      tags: [steam.MANAGED_TAG],
    });
    const r = steam.upsertEntry(entries, entry, preferredIdx);
    if (r.conflict) {
      const shortcut = entries[r.index];
      row.shortcutIdx = r.index;
      row.appid = shortcut.appid;
      row.managed = true;
      lines.push(`  '${row.display}' skipped: that exe belongs to another shortcut`);
      continue;
    }
    const shortcut = entries[r.index];
    row.shortcutIdx = r.index;
    row.appid = shortcut.appid;
    row.managed = steam.isManagedEntry(shortcut);
    if (r.updated) {
      shortcutsChanged = true;
      updated++; lines.push(`  updated '${row.display}'`);
      for (const item of changes.fields) {
        if (item.appid === old.appid) item.appid = shortcut.appid;
      }
      for (const field of ['AppName', 'StartDir', 'LaunchOptions']) {
        if (old[field] !== shortcut[field] && !changes.fields.some(item => item.appid === shortcut.appid && item.field === field)) {
          changes.fields.push({ appid: shortcut.appid, field, before: old[field] || '' });
        }
      }
    } else if (r.existing) {
      lines.push(`  '${row.display}' is already in Steam`);
    } else {
      shortcutsChanged = true;
      added++; lines.push(`  added '${row.display}'`);
      changes.shortcuts.push({ appid: shortcut.appid, appName: shortcut.AppName });
    }
    if (c && kinds.length) {
      const stem = steam.gridStemFromEntry(shortcut);
      for (const kind of kinds) {
        const picked = row.art?.[kind];
        if ((!picked || picked.automatic || picked.current) && (!autoArt || !row.sgdbId)) continue;
        try {
          const beforeIcon = shortcut.icon;
          const res = await fetchOneArt(c, gridFolder, stem, row, kind, filters, true, changes, shortcut, null, beforeWrite);
          if (shortcut.icon !== beforeIcon) shortcutsChanged = true;
          if (res.saved) { artworkSaved++; row.appliedKinds.push(kind); }
          lines.push(res.line);
        } catch (err) {
          artworkFailed++;
          row.failedKinds.push(kind);
          lines.push(`  ${row.display} [${kind}]: ${String((err && err.message) || err)}`);
        }
      }
    }
  }
  let bak = null;
  try {
    if (shortcutsChanged) bak = steam.saveEntries(sp, uid, entries);
    store.saveChanges(changes);
  } catch (err) {
    throw new Error(`FAILED to write shortcuts.vdf: ${String((err && err.message) || err)}`);
  }
  if (bak) lines.push(`shortcuts.vdf backed up -> ${path.basename(bak)}`);
  lines.push(shortcutsChanged
    ? `Saved shortcuts.vdf: ${added} added, ${updated} updated.`
    : 'No shortcut changes needed.');
  progress(0, 0, `Done: ${added} added, ${updated} updated, ${artworkSaved} artwork saved.`);
  return { rows, lines, added, updated, artworkSaved, artworkFailed };
}

ipcMain.handle('steam:remove', (_e, req) => withSteamClosed(() => {
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  const rows = (req && Array.isArray(req.rows) ? req.rows : []);
  let entries = steam.loadEntries(cfg.steam_path, cfg.steam_user_id);
  const idxs = [];
  for (const row of rows) {
    let idx = -1;
    if (row.shortcutIdx != null) {
      const candidate = entries[Number(row.shortcutIdx)];
      if (candidate && (row.appid == null || Number(candidate.appid) === Number(row.appid))
          && (row.source === 'shortcut' || steam.isManagedEntry(candidate))) {
        idx = Number(row.shortcutIdx);
      }
    }
    if (idx < 0 && row.exe) {
      const exact = steam.findByExe(entries, row.exe);
      if (exact >= 0 && (row.source === 'shortcut' || steam.isManagedEntry(entries[exact]))) idx = exact;
    }
    if (idx >= 0) idxs.push(idx);
  }
  const uniqueIdxs = [...new Set(idxs)];
  if (!uniqueIdxs.length) return { removed: 0, backup: null };
  entries = entries.filter((_, i) => !uniqueIdxs.includes(i));
  const bak = steam.saveEntries(cfg.steam_path, cfg.steam_user_id, entries);
  return { removed: uniqueIdxs.length, backup: bak ? path.basename(bak) : null };
}));

// ------------------------------------------------------------------ boot
app.whenReady().then(async () => {
  const helperIndex = process.argv.indexOf('--desktop-shortcut-helper');
  if (helperIndex >= 0) {
    try { await runShortcutHelper(app, shell, nativeImage, process.argv[helperIndex + 1]); app.exit(0); }
    catch { app.exit(1); }
    return;
  }
  if (process.argv.includes('--uninstall-cleanup')) {
    try { app.exit(await uninstallCleanup()); }
    catch (e) {
      dialog.showErrorBox('Uninstall stopped', e.message || String(e));
      app.exit(1);
    }
    return;
  }
  nativeTheme.on('updated', updateWindowTheme);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
