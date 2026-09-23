'use strict';
/* Main-process window and IPC handlers. */
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');

if (app.isPackaged) Menu.setApplicationMenu(null);

const store = require('./store');
const steam = require('./steam');
const scanner = require('./scanner');
const resolveMod = require('./resolve');
const strips = require('./strips');
const sgdbMod = require('./sgdb');
const images = require('./images');

let win = null;
let cfg = store.load();
cfg.steam_path = steam.normalizeSteamPath(cfg.steam_path);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function progress(current, total, label) {
  send('job:progress', { current, total, label: label || '' });
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1060,
    minHeight: 660,
    title: `Lib Shammes v${app.getVersion()}`,
    icon: path.join(__dirname, '..', 'assets', 'app-icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e8ecf1', height: 32 },
    backgroundColor: '#101216',
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
ipcMain.handle('cfg:get', () => cfg);
ipcMain.handle('cfg:set', (_e, patch) => {
  const clean = store.sanitizePatch(patch);
  if (Object.prototype.hasOwnProperty.call(clean, 'steam_path')) {
    clean.steam_path = steam.normalizeSteamPath(clean.steam_path);
  }
  Object.assign(cfg, clean);
  store.save(cfg);
  return cfg;
});

// ----------------------------------------------------------------- steam
ipcMain.handle('steam:detect', async (_e, hint) => {
  const found = await steam.findSteamPath(hint || cfg.steam_path || null);
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
      startDir: e.StartDir, icon: e.icon, managed: steam.isManagedEntry(e),
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
ipcMain.handle('app:wipe-data', async () => {
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
  setImmediate(() => { try { app.quit(); } catch { /* already going down */ } });
  return { removed, skipped, cfg };
});

ipcMain.handle('steam:purge', async (_e, opts) => {
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
  const bak = steam.saveEntries(sp, uid, kept);
  if (bak) lines.push(`shortcuts.vdf backed up -> ${path.basename(bak)}`);
  lines.push(`Removed ${entries.length - kept.length} shortcut(s).`);
  let deleted = 0;
  for (const f of plan.deleteFiles) {
    try {
      fs.unlinkSync(f.path);
      deleted++;
    } catch { lines.push(`  could not delete ${f.path}`); }
  }
  for (const s of plan.skippedFiles) lines.push(`  kept ${s.path} - ${s.why}`);
  lines.push(`Deleted ${deleted} art file(s), kept ${plan.skippedFiles.length} changed-by-user.`);
  store.saveChanges(store.blankChanges());
  return { ...plan, lines, executed: true, backup: bak ? path.basename(bak) : null };
});

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

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
ipcMain.handle('util:open-url', (_e, url) => shell.openExternal(url));

// ------------------------------------------------------------------ scan
ipcMain.handle('scan:start', async (_e, req) => {
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
  return games;
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

ipcMain.handle('art:list', async (_e, req) => {
  const sgdbId = Number(req && req.sgdbId);
  if (!Number.isFinite(sgdbId) || sgdbId <= 0) throw new Error('Art list needs an SGDB game id.');
  const kind = req.kind;
  const filters = (req && req.filters) || {};
  const c = client();
  const o = {
    types: filters.animated ? 'static,animated' : 'static',
    nsfw: filters.nsfw ? 'any' : 'false',
    humor: filters.humor ? 'any' : 'false',
    limit: 30,
  };
  if (kind === 'wide') return c.gridsWide(sgdbId, o);
  if (kind === 'grid') return c.gridsVertical(sgdbId, o);
  if (kind === 'hero') return c.heroes(sgdbId, o);
  if (kind === 'logo') return c.logos(sgdbId, o);
  return c.icons(sgdbId, o);
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
      lines.push(`  ${row.display}: Steam ${row.steamAppid} not on SGDB, trying title search…`);
    }
    try {
      // Accept the first SGDB result only when its token recall clears the threshold.
      const query = strips.toSearchQuery(row.query || row.display);
      if (query.replace(/[^a-z0-9]/gi, '').length < 3) {
        lines.push(`  ${row.display}: query too vague, skipped`);
        continue;
      }
      const games = await c.searchGame(query);
      const top = games[0];
      if (top && resolveMod.titleSimilarity(query, top.name) >= resolveMod.MIN_TITLE_RECALL) {
        row.sgdbId = top.id; row.sgdbName = top.name;
        if (persist) store.rememberSgdb(cfg, row.folder, top.id);
        lines.push(`  ${row.display} -> ${top.name} [${top.id}] (title search)`);
        ok++;
      } else if (top) {
        lines.push(`  ${row.display}: no close match (top was '${top.name}')`);
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
async function fetchOneArt(c, gridFolder, stem, row, kind, filters, onlyMissing, changes = null, journalFile = null, shortcut = null) {
  const journal = (p) => { if (changes && journalFile && p) journalFile(p); };
  const suffix = steam.ART_SUFFIXES[kind];
  const sel = (row.art && row.art[kind]) || null;
  if (!sel && onlyMissing && images.gridHasArt(gridFolder, stem, suffix)) {
    return { line: `${row.display} [${kind}]: already present, skip.`, saved: false };
  }
  let data = null;
  let src = '';
  let srcUrl = '';
  if (sel && sel.file) {
    data = fs.readFileSync(sel.file);
    src = `file ${sel.file}`;
    srcUrl = sel.file;
  } else if (sel && sel.url) {
    data = await c.downloadBytes(sel.url);
    src = sel.custom ? 'custom URL' : `#${sel.id}`;
    srcUrl = sel.url;
  } else {
    const o = {
      types: filters.animated ? 'static,animated' : 'static',
      nsfw: filters.nsfw ? 'any' : 'false',
      humor: filters.humor ? 'any' : 'false',
      limit: 30,
    };
    const items = kind === 'wide' ? await c.gridsWide(row.sgdbId, o)
      : kind === 'grid' ? await c.gridsVertical(row.sgdbId, o)
      : kind === 'hero' ? await c.heroes(row.sgdbId, o)
      : kind === 'logo' ? await c.logos(row.sgdbId, o)
      : await c.icons(row.sgdbId, o);
    if (!items.length) return { line: `${row.display} [${kind}]: no image on SGDB.`, saved: false };
    // items arrive score-sorted (community top-voted first): auto-download
    // always takes that default, never a random pick. SGDB exposes no
    // separate "default" flag, so top score IS the default.
    const img = items[0];
    row.art = row.art || {};
    row.art[kind] = { id: img.id, url: img.url, author: img.author, width: img.width, height: img.height };
    data = await c.downloadBytes(img.url);
    src = `#${img.id} ${img.author}`;
    srcUrl = img.url;
  }
  if (kind === 'icon') {
    const destPng = steam.artDest(gridFolder, stem, 'icon', '.png');
    steam.clearConflictingExts(destPng);
    journal(images.saveGridBytes(data, destPng));
    const ico = images.writePngIco(data, path.join(gridFolder, `${stem}_icon.ico`));
    if (ico) {
      journal(ico);
      if (shortcut && String(shortcut.icon || '') !== ico) {
        if (changes) changes.fields.push({ appid: shortcut.appid, field: 'icon', before: String(shortcut.icon || '') });
        shortcut.icon = ico;
      }
    }
    return { line: `  ${row.display} [icon]: saved ${path.basename(destPng)}${ico ? ` + ${stem}_icon.ico` : ' (no .ico: source was not PNG)'}`, saved: true };
  }
  const dest = steam.artDest(gridFolder, stem, kind, images.extFromUrl(srcUrl || '.png'));
  steam.clearConflictingExts(dest);
  journal(images.saveGridBytes(data, dest));
  return { line: `  ${row.display} [${kind}]: saved ${path.basename(dest)} (${src}).`, saved: true };
}

ipcMain.handle('art:download', async (_e, req) => {
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  const rows = (req && Array.isArray(req.rows) ? req.rows : []);
  const kinds = (req && Array.isArray(req.kinds) ? req.kinds : []);
  const onlyMissing = !!(req && req.onlyMissing);
  const filters = (req && req.filters) || {};
  const c = client();
  const gridFolder = steam.gridDir(cfg.steam_path, cfg.steam_user_id);
  fs.mkdirSync(gridFolder, { recursive: true });
  const lines = [];
  const changes = store.loadChanges();
  const journalFile = (p) => {
    const sig = store.statSig(p);
    if (sig) changes.files.push({ path: p, size: sig.size, mtimeMs: sig.mtimeMs });
  };
  let entries;
  try {
    entries = steam.loadEntries(cfg.steam_path, cfg.steam_user_id);
  } catch (err) {
    throw new Error(`Cannot read shortcuts.vdf: ${String((err && err.message) || err)}`);
  }
  let shortcutsChanged = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    progress(i, rows.length, `Art ${i + 1}/${rows.length}: ${row.display}`);
    const indexed = row.shortcutIdx != null ? entries[row.shortcutIdx] : null;
    const hit = (indexed && (row.appid == null || Number(indexed.appid) === Number(row.appid)) ? indexed : null)
      || (row.exe && entries[steam.findByExe(entries, row.exe)]);
    const stem = hit ? steam.gridStemFromEntry(hit)
      : (row.exe && row.display ? steam.gridStemFor(steam.quoteExe(row.exe), row.display) : null);
    if (!stem) {
      lines.push(`  ${row.display}: not in Steam yet - add to Steam first (need shortcut id).`);
      continue;
    }
    for (const kind of kinds) {
      try {
        const beforeIcon = hit && hit.icon;
        const result = await fetchOneArt(c, gridFolder, stem, row, kind, filters, onlyMissing, changes, journalFile, hit);
        lines.push(result.line);
        if (hit && hit.icon !== beforeIcon) shortcutsChanged = true;
      } catch (err) {
        lines.push(`  ${row.display} [${kind}]: ${String((err && err.message) || err)}`);
      }
    }
  }
  if (shortcutsChanged) {
    const bak = steam.saveEntries(cfg.steam_path, cfg.steam_user_id, entries);
    if (bak) lines.push(`shortcuts.vdf backed up -> ${path.basename(bak)}`);
  }
  store.saveChanges(changes);
  progress(0, 0, 'Art download done. Restart Steam.');
  return { rows, lines };
});

// ------------------------------------------------------------ steam add/rm
ipcMain.handle('steam:add', async (_e, req) => {
  if (!cfg.steam_path || !cfg.steam_user_id) throw new Error('Set Steam path + user first in Settings.');
  const rows = (req && Array.isArray(req.rows) ? req.rows : []);
  const autoArt = !!(req && req.autoArt);
  const kinds = (req && Array.isArray(req.kinds) ? req.kinds : []);
  const onlyMissing = !!(req && req.onlyMissing);
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
  let shortcutsChanged = false;
  const changes = store.loadChanges();
  const journalFile = (p) => {
    const sig = store.statSig(p);
    if (sig) changes.files.push({ path: p, size: sig.size, mtimeMs: sig.mtimeMs });
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
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
    const beforeName = old && String(old.AppName || '');
    const entry = steam.buildEntry({
      appName: row.display, exePath: row.exe,
      startDir: exactIdx >= 0 ? old.StartDir : row.startDir,
      icon: old ? old.icon : '',
      launchOptions: old ? old.LaunchOptions : row.launchOptions,
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
      // Journal renames so Purge can restore the original name.
      if (beforeName && beforeName !== entry.AppName) {
        changes.fields.push({ appid: shortcut.appid, field: 'AppName', before: beforeName });
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
        if (!(row.art && row.art[kind]) && (!autoArt || !row.sgdbId)) continue;
        try {
          const beforeIcon = shortcut.icon;
          const res = await fetchOneArt(c, gridFolder, stem, row, kind, filters, onlyMissing, changes, journalFile, shortcut);
          if (shortcut.icon !== beforeIcon) shortcutsChanged = true;
          if (res.saved) artworkSaved++;
          lines.push(res.line);
        } catch (err) {
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
  progress(0, 0, `Done: ${added} added, ${updated} updated, ${artworkSaved} artwork saved. Restart Steam!`);
  return { rows, lines, added, updated, artworkSaved };
});

ipcMain.handle('steam:remove', async (_e, req) => {
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
});

// ------------------------------------------------------------------ boot
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
