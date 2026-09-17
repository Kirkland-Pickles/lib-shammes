'use strict';
/* Steam integration: auto-detect, shortcut IDs, shortcuts.vdf ops, grid art.
   Detection checks the configured path, then the registry, then defaults.
   A candidate only counts when steam.exe exists at that path.
   Grid scheme in userdata/<id>/config/grid/:
     <id>.ext wide capsule · <id>p.ext vertical · <id>_hero · <id>_logo · <id>_icon
   <id> = crc32(exe + appname) | 0x80000000 (unsigned 32-bit). */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vdf = require('./vdf');

const ART_SUFFIXES = { wide: '', grid: 'p', hero: '_hero', logo: '_logo', icon: '_icon' };
const GRID_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

// ------------------------------------------------------------------ detect
function regQuery(hive, subkey, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', `${hive}\\${subkey}`, '/v', value], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m);
      resolve(m ? m[1].trim() : null);
    });
  });
}

/** A directory only counts as a Steam install if it contains steam.exe.
 *  Bare folders, leftover dirs and userdata-only paths never count. */
function hasSteamExe(dir) {
  try {
    return !!dir && fs.statSync(path.join(String(dir), 'steam.exe')).isFile();
  } catch {
    return false;
  }
}

/** Canonical display form: C:\...\Steam - backslashes, capital drive letter,
 *  no trailing slash. Accepts a direct steam.exe path (manual picking points
 *  at the exe itself) and reduces it to its folder. */
function normalizeSteamPath(p) {
  let s = String(p || '').trim().replace(/\//g, '\\').replace(/\\+$/, '');
  if (!s) return '';
  if (path.basename(s).toLowerCase() === 'steam.exe') s = path.dirname(s);
  s = s.replace(/\\+$/, '');
  const m = s.match(/^([a-z]):\\/i);
  if (m) s = `${m[1].toUpperCase()}:${s.slice(2)}`;
  // True on-disk casing (registry often stores lowercase): best effort.
  try {
    const real = fs.realpathSync.native(s);
    if (real) return real;
  } catch { /* missing path - return the cleaned form */ }
  return s;
}

/** userdata/<id> -> Steam persona name via config/loginusers.vdf.
 *  Returns [{ id, name }] (name falls back to the id when unknown). */
function getUserPersonas(steamPath) {
  const ids = getUserIds(steamPath);
  const names = new Map(); // accountId32 -> persona
  try {
    const text = fs.readFileSync(path.join(steamPath, 'config', 'loginusers.vdf'), 'utf8');
    for (const m of text.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)) {
      const pm = /"PersonaName"\s+"([^"]*)"/.exec(m[2]);
      if (!pm) continue;
      try {
        const accountId = Number(BigInt(m[1]) - 76561197960265728n);
        if (Number.isSafeInteger(accountId) && pm[1]) names.set(String(accountId), pm[1]);
      } catch { /* ignore malformed ids */ }
    }
  } catch { /* no loginusers.vdf yet (never logged in) - ids only */ }
  return ids.map((id) => ({ id, name: names.get(id) || id }));
}

async function findSteamPath(hint) {
  const normHint = normalizeSteamPath(hint);
  if (hasSteamExe(normHint)) return normHint;
  if (process.platform === 'win32') {
    const probes = [
      ['HKCU', 'Software\\Valve\\Steam', 'SteamPath'],
      ['HKLM', 'SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
      ['HKLM', 'SOFTWARE\\Valve\\Steam', 'InstallPath'],
    ];
    for (const [hive, sub, val] of probes) {
      try {
        const v = normalizeSteamPath(await regQuery(hive, sub, val));
        if (hasSteamExe(v)) return v;
      } catch { /* next */ }
    }
  }
  const cands = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
  ];
  if (process.platform !== 'win32') {
    cands.push(path.join(os.homedir(), '.steam', 'steam'), path.join(os.homedir(), '.local', 'share', 'Steam'));
  }
  for (const c of cands) {
    const norm = normalizeSteamPath(c);
    if (hasSteamExe(norm)) return norm;
  }
  return null;
}

function getUserIds(steamPath) {
  try {
    const dir = path.join(steamPath, 'userdata');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // userdata read failures must not fail detection
  }
}

function shortcutsPath(steamPath, userId) {
  return path.join(steamPath, 'userdata', String(userId), 'config', 'shortcuts.vdf');
}

function gridDir(steamPath, userId) {
  return path.join(steamPath, 'userdata', String(userId), 'config', 'grid');
}

function parseLibraryFolders(steamPath) {
  const libs = [steamPath];
  for (const vdfPath of [path.join(steamPath, 'steamapps', 'libraryfolders.vdf'),
                         path.join(steamPath, 'config', 'libraryfolders.vdf')]) {
    if (!fs.existsSync(vdfPath)) continue;
    try {
      const text = fs.readFileSync(vdfPath, 'utf8');
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
        const p = m[1].replace(/\\\\/g, '\\');
        if (!libs.includes(p) && fs.existsSync(p)) libs.push(p);
      }
      if (libs.length === 1) {
        // Older files used numbered path entries instead of path objects.
        for (const m of text.matchAll(/"\d+"\s+"([A-Za-z]:\\\\?[^"]+)"/g)) {
          const p = m[1].replace(/\\\\/g, '\\');
          if (!libs.includes(p) && fs.existsSync(p)) libs.push(p);
        }
      }
    } catch { /* ignore */ }
  }
  return libs;
}

// --------------------------------------------------------------------- ids
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(str) {
  const bytes = Buffer.from(str, 'utf8');
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Unsigned 32-bit shortcut id used for grid filenames.
 *  VERIFIED 2026-09-10 against live Steam data (7 shortcuts, 36 grid files):
 *  crc32(exe+appname)|0x80000000 matched 7/7 grid stems AND 7/7 stored appid
 *  fields. The Valve wiki's GenerateAppID sketch (AppName+Exe+NUL order)
 *  matched 0/7 on both - illustrative pseudocode, not the real derivation.
 *  Do not "fix" this to match the wiki. */
function shortcutId(exe, appName) {
  return (crc32(`${exe}${appName}`) | 0x80000000) >>> 0;
}

/** Signed int32 for the shortcuts.vdf appid field (same bits). */
function appidSigned(shortcutIdU32) {
  return (shortcutIdU32 >>> 0) | 0;
}

function quoteExe(exePath) {
  const s = String(exePath);
  return (s.startsWith('"') && s.endsWith('"')) ? s : `"${s}"`;
}

// --------------------------------------------------------------- entries
function loadEntries(steamPath, userId) {
  return vdf.loadShortcuts(shortcutsPath(steamPath, userId));
}

function backupShortcuts(steamPath, userId) {
  const src = shortcutsPath(steamPath, userId);
  if (!fs.existsSync(src)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
  const base = path.join(path.dirname(src), `shortcuts.vdf.bak.${stamp}`);
  for (let n = 0; ; n++) {
    const dst = n ? `${base}-${n}` : base;
    try {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
      return dst;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      throw new Error(`Cannot back up shortcuts.vdf: ${String((err && err.message) || err)}`);
    }
  }
}

function buildEntry({ appName, exePath, startDir, icon = '', launchOptions = '', tags = [] }) {
  // dont let a missing exe path become "null" in shortcuts.vdf
  if (!exePath) throw new Error(`shortcut '${appName || '(unnamed)'}' needs an exe path`);
  const exeQ = quoteExe(exePath);
  const sid = shortcutId(exeQ, appName);
  let dir = startDir;
  if (!dir) dir = path.dirname(exeQ.replace(/^"|"$/g, ''));
  return {
    appid: appidSigned(sid),
    AppName: appName,
    Exe: exeQ,
    StartDir: String(dir || ''),
    icon: icon || '',
    ShortcutPath: '',
    LaunchOptions: launchOptions || '',
    IsHidden: 0,
    AllowDesktopConfig: 1,
    AllowOverlay: 1,
    OpenVR: 0,
    Devkit: 0,
    DevkitGameID: '',
    DevkitOverrideAppID: 0,
    LastPlayTime: 0,
    FlatpakAppID: '',
    tags: Object.fromEntries((tags || []).map((t, i) => [String(i), t])),
  };
}

function findByExe(entries, exePath) {
  const target = String(exePath).replace(/^"|"$/g, '').toLowerCase();
  return entries.findIndex((e) => String(e.Exe || '').replace(/^"|"$/g, '').toLowerCase() === target);
}

const MANAGED_TAG = 'Lib Shammes';
const MANAGED_TAGS = new Set([MANAGED_TAG, 'SGDB Manager']);

function isManagedEntry(entry) {
  return Object.values((entry && entry.tags) || {}).some((tag) => MANAGED_TAGS.has(tag));
}

function upsertEntry(entries, entry, preferredIndex = -1) {
  let idx = findByExe(entries, entry.Exe);
  const preferred = Number.isInteger(preferredIndex)
    && preferredIndex >= 0 && preferredIndex < entries.length
    && isManagedEntry(entries[preferredIndex]);
  if (preferred && idx >= 0 && idx !== preferredIndex) {
    return { index: preferredIndex, updated: false, conflict: true };
  }
  if (preferred) {
    idx = preferredIndex;
  } else if (idx >= 0 && !isManagedEntry(entries[idx])) {
    return { index: idx, updated: false, existing: true };
  }
  if (idx >= 0) {
    const next = vdf.normalizeShortcut({
      ...entries[idx],
      appid: entry.appid,
      AppName: entry.AppName,
      Exe: entry.Exe,
      StartDir: entry.StartDir,
      icon: entry.icon,
      LaunchOptions: entry.LaunchOptions,
    });
    const fields = ['appid', 'AppName', 'Exe', 'StartDir', 'icon', 'LaunchOptions'];
    if (fields.every((field) => entries[idx][field] === next[field])) {
      return { index: idx, updated: false, existing: true };
    }
    entries[idx] = next;
    return { index: idx, updated: true };
  }
  entries.push(vdf.normalizeShortcut(entry));
  return { index: entries.length - 1, updated: false };
}

function saveEntries(steamPath, userId, entries, makeBackup = true) {
  const bak = makeBackup ? backupShortcuts(steamPath, userId) : null;
  vdf.saveShortcuts(shortcutsPath(steamPath, userId), entries);
  return bak;
}

// --------------------------------------------------------------- grid art
function gridStemFor(exeQuotedOrPath, appName) {
  let exe = String(exeQuotedOrPath);
  if (!(exe.startsWith('"') && exe.endsWith('"'))) exe = `"${exe}"`;
  return String(shortcutId(exe, appName));
}

function gridStemFromEntry(entry) {
  return String(shortcutId(String(entry.Exe || ''), String(entry.AppName || '')));
}

function artDest(gridFolder, stem, kind, ext) {
  let e = String(ext).toLowerCase();
  if (e === '.jpeg') e = '.jpg';
  if (!GRID_IMAGE_EXTS.includes(e)) e = '.png';
  return path.join(gridFolder, `${stem}${ART_SUFFIXES[kind]}${e}`);
}

function clearConflictingExts(dest) {
  const dir = path.dirname(dest);
  const base = path.basename(dest, path.extname(dest));
  for (const ext of GRID_IMAGE_EXTS) {
    const cand = path.join(dir, base + ext);
    if (cand !== dest && fs.existsSync(cand)) {
      try { fs.unlinkSync(cand); } catch { /* ignore */ }
    }
  }
}

function isSteamRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('tasklist', ['/FI', 'IMAGENAME eq steam.exe'], (err, stdout) => {
      resolve(!err && String(stdout || '').toLowerCase().includes('steam.exe'));
    });
  });
}

function execFileAsync(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitSteamGone(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isSteamRunning())) return true;
    if (Date.now() >= deadline) return false;
    await sleep(500);
  }
}

/** Force-close Steam (process tree). Games running through Steam go down too -
 *  callers must confirm first. Returns log lines. */
async function killSteam() {
  if (!(await isSteamRunning())) return { killed: false, lines: ['Steam is not running.'] };
  await execFileAsync('taskkill', ['/F', '/T', '/IM', 'steam.exe']);
  const gone = await waitSteamGone();
  return gone
    ? { killed: true, lines: ['Steam killed.'] }
    : { killed: false, lines: ['Steam did not exit - kill it manually (Task Manager) and retry.'] };
}

/** Launch Steam detached. If a client is already running it just opens it. */
async function launchSteam(steamPath) {
  const exe = path.join(steamPath, 'steam.exe');
  if (!hasSteamExe(steamPath)) throw new Error(`No steam.exe in ${steamPath} - check Settings.`);
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { launched: true, lines: ['Steam launching…'] };
}

/** Restart Steam. Stop a running client, wait for exit, then launch. */
async function restartSteam(steamPath) {
  const lines = [];
  if (await isSteamRunning()) {
    // Graceful first: -shutdown only targets a running client, never starts one.
    try {
      await execFileAsync(path.join(steamPath, 'steam.exe'), ['-shutdown'], { timeout: 10000 });
    } catch { /* fall through to polling/force */ }
    if (!(await waitSteamGone(8000))) {
      const k = await killSteam();
      lines.push(...k.lines);
      if (!k.killed && (await isSteamRunning())) return { restarted: false, lines };
    } else {
      lines.push('Steam exited cleanly.');
    }
  } else {
    lines.push('Steam was not running.');
  }
  const l = await launchSteam(steamPath);
  lines.push(...l.lines);
  return { restarted: true, lines };
}

/** First-party Steam games installed across all libraries (appmanifests).
 *  Read-only display data - never written, never touched. */
function listInstalledGames(steamPath) {
  const games = [];
  const seen = new Set();
  for (const lib of parseLibraryFolders(steamPath)) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(lib, 'steamapps'));
    } catch { continue; }
    for (const f of files) {
      const m = /^appmanifest_(\d+)\.acf$/.exec(f);
      if (!m) continue;
      const appid = Number(m[1]);
      if (seen.has(appid)) continue;
      seen.add(appid);
      try {
        const text = fs.readFileSync(path.join(lib, 'steamapps', f), 'utf8');
        const name = (text.match(/"name"\s+"([^"]+)"/) || [])[1] || `App ${appid}`;
        const inst = (text.match(/"installdir"\s+"([^"]+)"/) || [])[1] || '';
        games.push({ appid, name, installdir: inst ? path.join(lib, 'steamapps', 'common', inst) : '' });
      } catch { /* unreadable manifest - skip */ }
    }
  }
  games.sort((a, b) => a.name.localeCompare(b.name));
  return games;
}

/** Purge plan: combines the change journal with app-tagged shortcuts.
 * Shortcut appids are signed. Building the plan does not change anything.
 * Returns { removeAppids, restoreFields, deleteFiles, skippedFiles, names }. */
function planPurge(entries, changes, gridDirs, fileSig) {
  const sig = fileSig || ((p) => {
    try {
      const st = fs.statSync(p);
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch { return null; }
  });
  const byAppid = new Map(entries.map((e) => [Number(e.appid), e]));
  const tagged = new Set(
    entries
      .filter(isManagedEntry)
      .map((e) => Number(e.appid))
  );
  const journaled = new Set((changes.shortcuts || []).map((s) => Number(s.appid)));
  const removeAppids = [...new Set([...journaled, ...tagged])].filter((id) => byAppid.has(id));
  const removeSet = new Set(removeAppids);

  const restoreFields = [];
  for (const f of changes.fields || []) {
    const id = Number(f.appid);
    if (!byAppid.has(id) || removeSet.has(id)) continue; // gone anyway
    restoreFields.push({ appid: id, field: f.field, before: f.before });
  }

  const deleteFiles = [];
  const skippedFiles = [];
  const seenPaths = new Set();
  const consider = (p, size, mtimeMs, why) => {
    if (!p || seenPaths.has(p)) return;
    seenPaths.add(p);
    const cur = sig(p);
    if (cur && size !== undefined && (cur.size !== size || cur.mtimeMs !== mtimeMs)) {
      skippedFiles.push({ path: p, why: `${why} (changed since we wrote it)` });
    } else if (cur) {
      deleteFiles.push({ path: p, why });
    }
  };
  for (const f of changes.files || []) consider(f.path, f.size, f.mtimeMs, 'artwork we added');
  // Stem-matched leftovers for removed shortcuts (covers pre-journal versions).
  for (const dir of gridDirs || []) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const id of removeAppids) {
      const stem = String(id >>> 0);
      for (const suffix of ['', 'p', '_hero', '_logo', '_icon']) {
        for (const file of files.filter((x) => x.startsWith(stem + suffix + '.'))) {
          consider(path.join(dir, file), undefined, undefined, 'leftover art of removed shortcut');
        }
      }
    }
  }
  const names = removeAppids.map((id) => {
    const e = byAppid.get(id);
    return String((e && e.AppName) || `appid ${id}`);
  });
  return { removeAppids, restoreFields, deleteFiles, skippedFiles, names };
}

/** Candidates for prune: app-tagged shortcuts whose exe path no longer exists. */
function findStaleShortcuts(entries) {
  return entries
    .map((e, i) => ({ entry: e, index: i }))
    .filter(({ entry }) => {
      if (!isManagedEntry(entry)) return false;
      const exe = String(entry.Exe || '').replace(/^"|"$/g, '');
      if (!exe) return false;
      try {
        return !fs.statSync(exe).isFile();
      } catch {
        return true;
      }
    })
    .map(({ entry, index }) => ({
      index,
      display: String(entry.AppName || '(unnamed)'),
      exe: String(entry.Exe || '').replace(/^"|"$/g, ''),
    }));
}

module.exports = {
  ART_SUFFIXES, GRID_IMAGE_EXTS, MANAGED_TAG,
  hasSteamExe, normalizeSteamPath, getUserPersonas,
  findSteamPath, getUserIds, shortcutsPath, gridDir, parseLibraryFolders,
  crc32, shortcutId, appidSigned, quoteExe,
  loadEntries, backupShortcuts, buildEntry, findByExe, isManagedEntry, upsertEntry, saveEntries,
  gridStemFor, gridStemFromEntry, artDest, clearConflictingExts, isSteamRunning,
  killSteam, launchSteam, restartSteam, findStaleShortcuts,
  listInstalledGames, planPurge,
};
