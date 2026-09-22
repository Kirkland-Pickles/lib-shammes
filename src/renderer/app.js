'use strict';
/* library and settings ui */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMB = (b) => (b >= 1024 * 1024 * 1024 ? `${(b / 1073741824).toFixed(1)} GB`
  : `${Math.max(1, Math.round(b / 1048576))} MB`);
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const folderKey = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
function parentDir(p) {
  const value = String(p || '').replace(/[\\/]+$/, '');
  const cut = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  if (cut < 0) return '';
  return cut === 2 && /^[a-z]:/i.test(value) ? value.slice(0, 3) : value.slice(0, cut);
}
const KIND_LABEL = { wide: 'Wide', grid: 'Grid', hero: 'Hero', logo: 'Logo', icon: 'Icon' };
const S = {
  cfg: null,
  rows: [],
  steamUsers: [],
  filter: '',
  unresolvedOnly: false,
  hideOwned: false,
  ownedAppids: new Set(), // Steam appids installed for the user (hide-owned filter)
  detailKey: null,          // rowKey() of selected row
  searchCache: [],          // sgdb search results for detail pane
  matchSearchToken: 0,
  previewCache: {},         // sgdbId -> thumb url
  modal: null,              // artwork picker state
};

const cur = () => (S.detailKey ? rowByKey(S.detailKey) : null);

// ------------------------------------------------------------------ log/ui
function log(line) {
  const box = $('#log');
  const div = document.createElement('div');
  div.textContent = line;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function status(t) { $('#status').textContent = t; }
function setBar(cur_, total) {
  $('#fill').style.width = total > 0 ? `${(100 * cur_) / total}%` : '0';
  // Hide bar when there's no job
  const wrap = $('#progwrap');
  if (wrap) wrap.hidden = !(total > 0);
}
function toast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3200);
}
function handleAction(name, fn) {
  return () => fn().catch((e) => {
    const message = e?.message || String(e);
    setBar(0, 0);
    log(`${name} failed: ${message}`);
    status(`${name} failed.`);
    toast(`${name} failed: ${message}`);
  });
}
function confirmDlg(title, body, opts = {}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.id = 'confirm-overlay';
    ov.innerHTML = `<div id="confirm-box" role="alertdialog">
      <h3>${esc(title)}</h3><p class="muted${opts.danger ? ' danger-text' : ''}${opts.small ? ' small' : ''}">${esc(body)}</p>
      <div class="confirm-btns">
        <button class="btn sm" data-v="0">Cancel</button>
        <button class="btn primary sm" data-v="1">${esc(opts.confirmText || 'Continue')}</button>
      </div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b && e.target !== ov) return;
      const v = b ? b.dataset.v === '1' : false;
      ov.remove();
      resolve(v);
    });
  });
}
async function syncCfg() { S.cfg = await window.api.cfgGet(); }
// cfgSet returns the saved config. Keep the renderer copy in sync.
async function savePatch(patch) {
  S.cfg = await window.api.cfgSet(patch);
  renderChecklist().catch(() => {});
}

// --------------------------------------------- onboarding checklist
let checklistDismissed = false; // session only; back next boot if still incomplete

async function renderChecklist() {
  const boxes = [...document.querySelectorAll('.checklist')];
  if (!boxes.length) return;
  if (checklistDismissed) { boxes.forEach((b) => { b.hidden = true; }); return; }
  const steamOk = S.cfg.steam_path
    ? await window.api.steamVerify(S.cfg.steam_path).catch(() => false)
    : false;
  const st = {
    steam: !!steamOk,
    key: !!(S.cfg.api_key || '').trim(),
    folders: (S.cfg.games_roots || []).length > 0,
  };
  let allDone = true;
  for (const box of boxes) {
    box.querySelectorAll('.cl-item').forEach((btn) => {
      const done = !!st[btn.dataset.cl];
      btn.classList.toggle('done', done);
      btn.querySelector('.cl-state').textContent = done ? '✓' : '○';
      if (!done) allDone = false;
    });
    box.hidden = allDone;
  }
}

// ------------------------------------------------------------------ router
// Back/Forward history for mouse navigation.
const TITLES = { library: 'Steam library', xbox: 'Xbox library', desktop: 'Desktop shortcuts library', settings: 'Settings' };
const Nav = {
  stack: ['library'],
  idx: 0,
  current() { return this.stack[this.idx]; },
};
function paintRoute() {
  const page = Nav.current();
  $$('.page').forEach((p) => p.classList.remove('on'));
  $(`#page-${page}`).classList.add('on');
  $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  if (page === 'settings') renderSettingsCards();
  if (page === 'library') renderChecklist();
  document.title = `Lib Shammes - ${TITLES[page]}`;
}
function navGo(page, { replace = false } = {}) {
  if (replace) {
    Nav.stack[Nav.idx] = page;
  } else if (Nav.current() !== page) {
    Nav.stack = Nav.stack.slice(0, Nav.idx + 1);
    Nav.stack.push(page);
    Nav.idx += 1;
  }
  paintRoute();
}
function navReset(page) {
  Nav.stack = [page];
  Nav.idx = 0;
  paintRoute();
}
function navBack() {
  if (!S.modal && Nav.idx > 0) { Nav.idx -= 1; paintRoute(); }
}
function navFwd() {
  if (!S.modal && Nav.idx < Nav.stack.length - 1) { Nav.idx += 1; paintRoute(); }
}
// Mouse back/forward click can arrive twice - once from the DOM, once from Electron.
// Second one inside the window is the echo, the following code drops it.
let lastMouseNav = 0;
let lastIpcNav = 0;
const NAV_ECHO_MS = 500;

// ---------------------------------------------------------- shared cards
function steamCard() {
  const d = document.createElement('div');
  d.className = 'card';
  // No Detect button by design: detection runs itself on boot and every time
  // this card appears. Browse is the only manual action.
  d.innerHTML = `<h3>Steam installation</h3>
    <div class="row"><input type="text" data-r="path" style="flex:1" placeholder="detecting…">
    <button class="btn sm" data-r="browse">Browse…</button></div>
    <div class="row"><span class="muted">User:</span>
    <select data-r="user" style="flex:1"></select></div>
    <div class="status-line" data-r="status">Detecting…</div>
    <div class="note">After adding games, fully exit Steam (tray - Exit) and reopen it. (or press Restart Steam in the bottom left of this app)</div>`;
  const q = (s) => d.querySelector(`[data-r="${s}"]`);
  const userLabel = (u) => (u.name && u.name !== u.id ? `${u.name} (${u.id})` : u.id);
  // Shown with steam.exe on the end (same as manual picking); stored as a
  // folder, normalize() bridges the two.
  const steamDisplay = (p) => {
    const s = String(p || '').replace(/\\+$/, '');
    if (!s) return '';
    return /steam\.exe$/i.test(s) ? s : `${s}\\steam.exe`;
  };
  const paintUsers = () => {
    q('user').innerHTML = S.steamUsers.map((u) =>
      `<option value="${esc(u.id)}"${u.id === S.cfg.steam_user_id ? ' selected' : ''}>${esc(userLabel(u))}</option>`).join('');
  };
  // Status always reflects a live steam.exe check - never a saved string,
  // so a stale/invalid path can no longer show "Found".
  const paint = async () => {
    const ok = await window.api.steamVerify(q('path').value.trim()).catch(() => false);
    q('status').textContent = ok
      ? `Found users: ${S.steamUsers.map(userLabel).join(', ') || 'none yet - log into Steam once'}`
      : 'Not detected yet - Browse to it manually.';
    q('status').className = `status-line${ok ? ' ok' : ''}`;
  };
  q('path').value = steamDisplay(S.cfg.steam_path);
  paintUsers();
  detectInto();
  q('path').addEventListener('change', async () => {
    await savePatch({ steam_path: q('path').value.trim() });
    paint();
  });
  q('user').addEventListener('change', () => savePatch({ steam_user_id: q('user').value }));
  q('browse').addEventListener('click', async () => {
    const r = await window.api.steamBrowse();
    if (r && r.error) { toast(r.error); return; }
    if (r && r.path) {
      await savePatch({ steam_path: r.path });
      q('path').value = steamDisplay(r.path);
      await detectInto();
    }
  });
  async function detectInto() {
    // One detect at a time per card (settings rebuilds on every visit).
    // Any failure lands on a real status - never stuck on "Detecting…".
    if (d._detecting) return;
    d._detecting = true;
    q('status').textContent = 'Detecting…';
    q('status').className = 'status-line';
    try {
      const r = await window.api.steamDetect(S.cfg.steam_path || null);
      await syncCfg();
      S.steamUsers = r.users || [];
      q('path').value = steamDisplay(S.cfg.steam_path);
      paintUsers();
      if (r.path) log(`Steam found at ${r.path}`);
    } catch (e) {
      log(`Steam detect failed: ${e.message || e}`);
    } finally {
      d._detecting = false;
      if (d.isConnected) await paint();
    }
  }
  return d;
}

function keyCard() {
  const d = document.createElement('div');
  d.className = 'card';
  d.innerHTML = `<h3>SteamGridDB API key</h3>
    <div class="row"><input type="password" data-r="key" style="flex:1" placeholder="paste key…" autocomplete="off">
    <button class="btn sm" data-r="show">Show</button></div>
    <div class="row"><button class="btn sm" data-r="validate">Validate</button>
    <button class="btn sm" data-r="get">Get key…</button></div>
    <div class="status-line" data-r="status">Free key. you can scan and add games without it. it is needed for game art.</div>
    <div class="note">Go to steamgriddb.com, click profile, click preferences, click API. Stored in %APPDATA%\\Lib Shammes.</div>`;
  const q = (s) => d.querySelector(`[data-r="${s}"]`);
  q('key').value = S.cfg.api_key || '';
  q('key').addEventListener('change', () => savePatch({ api_key: q('key').value.trim() }));
  q('show').addEventListener('click', () => {
    q('key').type = q('key').type === 'password' ? 'text' : 'password';
  });
  q('get').addEventListener('click', () => window.api.openUrl('https://www.steamgriddb.com/profile/preferences/api'));
  q('validate').addEventListener('click', async () => {
    const key = q('key').value.trim();
    if (!key) { q('status').textContent = 'Paste a key first 😊'; return; }
    q('status').textContent = 'Checking…';
    q('status').className = 'status-line';
    const r = await window.api.keyValidate(key);
    await syncCfg();
    if (r.ok) {
      q('status').textContent = `Key works ✓ (found “${r.name}”).`;
      q('status').className = 'status-line ok';
      log('SGDB API key valid.');
    } else {
      q('status').textContent = `Key rejected: ${r.error}`;
      q('status').className = 'status-line bad';
      log(`Key rejected: ${r.error}`);
    }
  });
  return d;
}

function foldersCard() {
  const d = document.createElement('div');
  d.className = 'card full';
  d.innerHTML = `<h3>Game Folders</h3>
    <div class="row"><select data-r="list" size="4" style="flex:1;min-height:76px"></select>
    <span style="display:flex;flex-direction:column;gap:6px">
    <button class="btn sm" data-r="add">Add…</button>
    <button class="btn sm" data-r="remove">Remove</button></span></div>
    <label class="row">Game folder depth <select data-r="depth" aria-label="Game folder depth">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option>${n}</option>`).join('')}</select></label>
    <div class="note">For the selected folder: 0 = the game itself, 1 = game folders inside it, 2 = your game folders are one level further inside. Increase the number for additional folder levels. Within each game folder, the app searches up to 3 levels down for an executable.</div>`;
  const q = (s) => d.querySelector(`[data-r="${s}"]`);
  const showDepth = () => {
    q('depth').disabled = !q('list').value;
    q('depth').value = String(S.cfg.folder_depths[folderKey(q('list').value)] ?? 1);
  };
  const paint = (selected = q('list').value) => {
    q('list').innerHTML = (S.cfg.games_roots || []).map((g) => `<option>${esc(g)}</option>`).join('');
    if (S.cfg.games_roots.includes(selected)) q('list').value = selected;
    else q('list').selectedIndex = S.cfg.games_roots.length ? 0 : -1;
    showDepth();
  };
  paint();
  q('list').addEventListener('change', showDepth);
  q('depth').addEventListener('change', () => savePatch({
    folder_depths: { ...S.cfg.folder_depths, [folderKey(q('list').value)]: Number(q('depth').value) },
  }));
  q('add').addEventListener('click', async () => {
    const p = await window.api.foldersBrowse();
    if (p && !S.cfg.games_roots.includes(p)) {
      await savePatch({
        games_roots: [...S.cfg.games_roots, p],
        folder_depths: { ...S.cfg.folder_depths, [folderKey(p)]: 1 },
      });
      paint(p);
      log(`Games folder added: ${p}`);
    }
  });
  q('remove').addEventListener('click', async () => {
    const gone = new Set([...q('list').selectedOptions].map((o) => o.value || o.text));
    if (!gone.size) return;
    await savePatch({ games_roots: S.cfg.games_roots.filter((g) => !gone.has(g)) });
    paint();
  });
  return d;
}

// --------------------------------------------------------------- settings
function renderSettingsCards() {
  const host = $('#settings-cards');
  host.innerHTML = '';
  host.appendChild(steamCard());
  host.appendChild(keyCard());
  host.appendChild(foldersCard());
  const prefs = document.createElement('div');
  prefs.className = 'card';
  prefs.innerHTML = `<h3>Default artwork</h3>
    <div class="row" data-r="kinds"></div>
    <div class="row" data-r="flags"></div>
    <label class="check" style="margin-top:8px"><input type="checkbox" data-r="missing">
    Skip already populated artwork</label>
    <div class="note">Per-game / per-type picks. manually choosing artwork will override these settings</div>`;
  const q = (s) => prefs.querySelector(`[data-r="${s}"]`);
  const kinds = [['wide', 'Wide'], ['grid', 'Grid'], ['hero', 'Hero'], ['logo', 'Logo'], ['icon', 'Icon']];
  q('kinds').innerHTML = kinds.map(([k, label]) =>
    `<label class="check"><input type="checkbox" data-k="${k}"${S.cfg[`want_${k}`] ? ' checked' : ''}> ${label}</label>`).join('');
  q('kinds').addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (k) savePatch({ [`want_${k}`]: e.target.checked });
  });
  const flags = [['include_animated', 'Animated'], ['include_nsfw', 'NSFW'], ['include_humor', 'Humor']];
  q('flags').innerHTML = flags.map(([k, label]) =>
    `<label class="check"><input type="checkbox" data-k="${k}"${S.cfg[k] ? ' checked' : ''}> ${label}</label>`).join('');
  q('flags').addEventListener('change', async (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    // NSFW asks every single time it gets enabled.
    if (k === 'include_nsfw' && e.target.checked) {
      const yes = await confirmDlg('Enable NSFW artwork?',
        'Results can change how you look at the games characters forever.',
        { danger: true, small: true, confirmText: "I don't care" });
      if (!yes) { e.target.checked = false; return; }
      savePatch({ include_nsfw: true });
      return;
    }
    savePatch({ [k]: e.target.checked });
  });
  q('missing').checked = !!S.cfg.only_missing;
  q('missing').addEventListener('change', (e) => savePatch({ only_missing: e.target.checked }));
  host.appendChild(prefs);
  const danger = document.createElement('div');
  danger.className = 'card';
  danger.innerHTML = `<h3>Purge every change this app made to steam</h3>
    <div class="row"><button class="btn danger sm" data-r="purge">Purge…</button></div>
    <hr>
    <div class="note"><b>Delete app data.</b></div>
    <div class="row"><button class="btn danger sm" data-r="wipe">Delete app data…</button></div>`;
  danger.querySelector('[data-r="purge"]').addEventListener('click', handleAction('Purge', doPurge));
  danger.querySelector('[data-r="wipe"]').addEventListener('click', doWipeData);
  host.appendChild(danger);
}

async function doWipeData() {
  if (!await confirmDlg('Delete app data',
    'Delete all app data? This keeps your games and Steam shortcuts, but deletes settings, saved matches, and the change journal.\n\n'
    + 'Purge first if you want to undo changes made to Steam. The app will close.')) return;
  try {
    const res = await window.api.appWipeData();
    // Take the wiped (default) config into memory too - otherwise a stray
    // save between here and quit would resurrect the API key from RAM.
    if (res && res.cfg) S.cfg = res.cfg;
  } catch (e) {
    toast(e.message || String(e));
  }
  // Window closes either way - no session left without its data.
  window.close();
}

async function doPurge() {
  let plan;
  try {
    plan = await window.api.steamPurge({ dryRun: true });
  } catch (e) {
    toast(e.message || String(e));
    return;
  }
  if (!plan.removeAppids.length && !plan.restoreFields.length && !plan.deleteFiles.length) {
    toast('Nothing to purge - Steam is clean of our changes.');
    log('Purge check: nothing to undo.');
    return;
  }
  const sample = plan.names.slice(0, 8).map((n) => `• ${n}`).join('\n')
    + (plan.names.length > 8 ? `\n… and ${plan.names.length - 8} more` : '');
  const msg = `Remove everything this app changed in Steam?\n\n`
    + `${plan.removeAppids.length} shortcut(s), ${plan.restoreFields.length} restored name(s)/icon(s), `
    + `${plan.deleteFiles.length} art file(s)`
    + (plan.skippedFiles.length ? `, ${plan.skippedFiles.length} user-changed file(s) kept` : '')
    + (sample ? `\n\n${sample}` : '')
    + `\n\nA backup of shortcuts.vdf is taken first. Your games and Steam itself are untouched.`;
  if (!await confirmDlg('Purge everything', msg)) return;
  const res = await window.api.steamPurge({ dryRun: false });
  (res.lines || []).forEach(log);
  await refreshSteamState();
  await syncSteamLibrary();
  status('Purge complete - restart Steam.');
  toast('Purge complete - restart Steam.');
}

// ---------------------------------------------------------------- library
const SOURCE_LABEL = { folder: 'Folder', shortcut: 'Shortcut', steam: 'Steam' };

function renderRows() {
  const body = $('#games-body');
  const focusedKey = document.activeElement?.matches('.row-check')
    ? document.activeElement.closest('tr')?.dataset.key : null;
  body.innerHTML = '';
  const f = S.filter.trim().toLowerCase();
  let visible = 0;
  for (const r of S.rows) {
    if (f && !r.display.toLowerCase().includes(f) && !r.folder.toLowerCase().includes(f)) continue;
    if (S.unresolvedOnly && (r.sgdbId || r.idMethod !== 'folder')) continue;
    // Hide-owned only trusts certain appids. Shortcut rows carry guesses,
    // so they never hide.
    if (S.hideOwned && r.source !== 'shortcut' && r.steamAppid != null && S.ownedAppids.has(r.steamAppid)) continue;
    const tr = document.createElement('tr');
    tr.dataset.key = rowKey(r);
    if (S.detailKey === rowKey(r)) tr.classList.add('sel');
    if (!r.exe && r.source !== 'steam') tr.classList.add('noexe');
    const source = SOURCE_LABEL[r.source] || r.source;
    const folder = r.folderName && r.folderName !== r.display ? r.folderName : '';
    const gameMeta = folder ? `${source} · ${folder}` : source;
    const matchName = r.source === 'steam'
      ? `Steam ${r.steamAppid ?? ''}`.trim()
      : r.sgdbId ? r.sgdbName : 'Not matched';
    const matchMeta = r.source === 'steam' ? '' : r.sgdbId ? `SGDB ${r.sgdbId}` : '';
    const steamText = r.source === 'steam' ? 'Installed' : r.inSteam ? 'Added' : 'Not added';
    const steamClass = r.inSteam ? 'ok' : '';
    const exeTxt = r.source === 'steam' ? 'Managed by Steam' : (r.exe ? baseName(r.exe) : 'No launcher');
    const selectable = r.source !== 'steam';
    tr.innerHTML = `<td class="c-add"${selectable ? ' data-act="toggle"' : ''}>${selectable
      ? `<input class="row-check" type="checkbox" aria-label="Select ${esc(r.display)}"${r.checked ? ' checked' : ''}>`
      : ''}</td>
      <td title="${esc(r.display)}"><div class="game-name">${esc(r.display)}</div><div class="cell-meta" title="${esc(gameMeta)}">${esc(gameMeta)}</div></td>
      <td class="c-match" title="${esc(matchMeta ? `${matchName} - ${matchMeta}` : matchName)}"><div class="cell-main">${esc(matchName)}</div>${matchMeta ? `<div class="cell-meta">${esc(matchMeta)}</div>` : ''}</td>
      <td class="c-st"><span class="table-status ${steamClass}">${steamText}</span></td>
      <td class="c-exe" title="${esc(r.exe || '')}">${esc(exeTxt)}</td>`;
    body.appendChild(tr);
    visible++;
  }
  const checked = checkedRows().filter((r) => r.source !== 'steam').length;
  $('#selection-count').textContent = `${checked} selected`;
  $('#library-count').textContent = visible === S.rows.length
    ? `${visible} game${visible === 1 ? '' : 's'}`
    : `${visible} of ${S.rows.length}`;
  $('#btn-add').disabled = !S.rows.some((r) => r.checked && r.source === 'folder' && r.exe);
  $('#btn-remove').disabled = !S.rows.some((r) => r.checked && r.inSteam
    && (r.source === 'shortcut' || r.managed));
  $('#btn-match').disabled = !S.rows.some((r) => r.checked && r.source !== 'steam');
  $('#btn-download').disabled = !S.rows.some((r) => r.checked && r.sgdbId && r.source !== 'steam');
  if (focusedKey) [...body.rows].find((tr) => tr.dataset.key === focusedKey)?.querySelector('.row-check')?.focus();
  renderBanner();
}

function rowKey(r) {
  return `${r.source}:${r.folder}`;
}

function rowByKey(key) {
  return S.rows.find((r) => rowKey(r) === key);
}

// Empty library points back at Settings: an add-folder button when there are
// no folders yet, otherwise setup/scan shortcuts.
function renderBanner() {
  const banner = $('#lib-banner');
  if (!banner) return;
  if (S.rows.length > 0) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.innerHTML = '';
  const hasFolders = (S.cfg.games_roots || []).length > 0;
  const text = document.createElement('span');
  text.textContent = hasFolders ? 'No games yet.' : 'No games yet - add a folder to begin.';
  banner.appendChild(text);
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  banner.appendChild(spacer);
  const mk = (label, primary, fn) => {
    const b = document.createElement('button');
    b.className = `btn sm${primary ? ' primary' : ''}`;
    b.textContent = label;
    b.addEventListener('click', fn);
    banner.appendChild(b);
    return b;
  };
  if (!hasFolders) {
    mk('Add games folder', true, () => navGo('settings'));
  } else {
    mk('Complete setup', false, () => navGo('settings'));
    mk('Scan', true, () => doScan());
  }
}

function selectRow(key) {
  S.detailKey = key;
  $$('#games-body tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.key === key));
  renderDetail();
}

function resetMatchResults(label = 'Search for a game first') {
  S.searchCache = [];
  $('#s-status').classList.remove('ok');
  const results = $('#s-results');
  results.innerHTML = '';
  const option = document.createElement('option');
  option.value = '';
  option.textContent = label;
  results.appendChild(option);
  results.disabled = true;
  $('#s-set').disabled = true;
}

function isCurrentMatchRequest(token, key) {
  const row = cur();
  return token === S.matchSearchToken && !!row && rowKey(row) === key;
}

function artText(row, kind) {
  const a = row.art[kind];
  if (!a) return '(default)';
  if (a.file) return `file ${baseName(a.file)}`;
  if (a.url && !a.id) return 'custom URL';
  if (a.id) return `#${a.id} ${a.author || ''} ${a.width || ''}x${a.height || ''}`.trim();
  return '(default)';
}

function renderDetail() {
  const row = cur();
  const empty = $('#detail-empty');
  const content = $('#detail-content');
  if (!row) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  $('#d-title').textContent = row.display;
  const identity = [SOURCE_LABEL[row.source] || row.source];
  if (row.steamAppid) identity.push(`Steam ${row.steamAppid}`);
  if (row.source !== 'steam') identity.push(row.idMethod === 'folder' ? 'Needs review' : `${Math.round(row.confidence * 100)}% match`);
  $('#d-identity').textContent = identity.join(' · ');
  $('#d-name').value = row.display;
  const pick = $('#d-exe-pick');
  pick.innerHTML = '';
  if (row.source === 'steam') {
    const o = document.createElement('option');
    o.value = row.exe || '';
    o.textContent = 'Managed by Steam';
    pick.appendChild(o);
  } else if (row.candidates.length) {
    row.candidates.forEach((c) => {
      const o = document.createElement('option');
      const rel = c.path.startsWith(row.folder) ? c.path.slice(row.folder.length).replace(/^[\\/]/, '') : c.path;
      o.value = c.path;
      o.textContent = rel.toLowerCase() === baseName(c.path).toLowerCase()
        ? `${baseName(c.path)} · ${fmtMB(c.size)}`
        : `${baseName(c.path)} · ${rel} · ${fmtMB(c.size)}`;
      pick.appendChild(o);
    });
  }
  if (row.exe && ![...pick.options].some((o) => o.value === row.exe)) {
    const o = document.createElement('option');
    o.value = row.exe;
    o.textContent = baseName(row.exe);
    pick.appendChild(o);
  }
  if (!pick.options.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No launcher found';
    pick.appendChild(o);
  }
  pick.value = row.exe || '';
  const locked = row.source === 'steam';
  $('#d-name').disabled = locked;
  pick.disabled = locked;
  $('#d-browse').disabled = locked;
  $('#d-apply').disabled = locked;
  $('#s-search').value = row.query || row.display;
  S.matchSearchToken++;
  resetMatchResults();
  const matchStatus = $('#s-status');
  matchStatus.textContent = row.source === 'steam'
    ? `Steam ${row.steamAppid}`
    : row.sgdbId ? `${row.sgdbName} · ${row.sgdbId}` : 'Not matched';
  matchStatus.classList.toggle('ok', row.source === 'steam' || !!row.sgdbId);
  $('#s-search').disabled = locked;
  $('#s-go').disabled = locked;
  $('#s-auto').disabled = locked;
  $('.artwork-section').hidden = locked;
  const box = $('#art-rows');
  box.innerHTML = '';
  for (const kind of locked ? [] : ['wide', 'grid', 'hero', 'logo', 'icon']) {
    const div = document.createElement('div');
    div.className = 'arow';
    div.innerHTML = `<span class="aname">${KIND_LABEL[kind]}</span>
      <span class="aval">${esc(artText(row, kind))}</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.textContent = 'Choose…';
    btn.addEventListener('click', () => openArtModal(row, kind));
    div.appendChild(btn);
    box.appendChild(div);
  }
  previewFor(row);
}

async function previewFor(row) {
  const img = $('#d-preview');
  if (!row.sgdbId || !S.cfg.api_key) { img.hidden = true; return; }
  if (S.previewCache[row.sgdbId]) {
    img.src = S.previewCache[row.sgdbId];
    img.hidden = false;
    return;
  }
  img.hidden = true;
  try {
    const items = await window.api.artList({
      sgdbId: row.sgdbId,
      kind: 'grid',
      filters: { animated: S.cfg.include_animated, nsfw: S.cfg.include_nsfw, humor: S.cfg.include_humor },
    });
    // Do not paint a late result onto a newly selected row.
    if (items.length && row.sgdbId === cur()?.sgdbId) {
      S.previewCache[row.sgdbId] = items[0].thumb || items[0].url;
      img.src = S.previewCache[row.sgdbId];
      img.hidden = false;
    }
  } catch { /* silent: list must stay usable offline */ }
}

// ------------------------------------------------------------ library ops
function toRow(g, useLegacy = false) {
  const folderName = baseName(g.folder);
  const key = folderKey(g.folder);
  const title = (S.cfg.title_map && (S.cfg.title_map[key]
    || (useLegacy && S.cfg.title_map[folderName]))) || g.displayName;
  const sgdbKeys = [key, ...(useLegacy ? [folderName, title, g.displayName] : [])];
  const savedSgdb = sgdbKeys.map((k) => Number(S.cfg.sgdb_map[k] || S.cfg.sgdb_cache[k]))
    .find((id) => Number.isFinite(id) && id > 0) || null;
  const row = {
    folder: g.folder, folderName, display: title, exe: g.exePath, startDir: g.startDir,
    launchOptions: '', candidates: g.candidates || [], score: g.score || 0, reason: g.reason || '',
    query: title, steamAppid: g.steamAppid ?? null, idMethod: g.idMethod || 'folder',
    confidence: g.confidence || 0, source: 'folder',
    checked: !!g.exePath, sgdbId: savedSgdb, sgdbName: savedSgdb ? '(cached)' : '',
    inSteam: false, managed: false, shortcutIdx: null, appid: null, art: {},
  };
  const savedExe = S.cfg.exe_map && (S.cfg.exe_map[key]
    || (useLegacy && S.cfg.exe_map[folderName]));
  if (savedExe && row.candidates.length) {
    const hit = row.candidates.find((c) =>
      baseName(c.path).toLowerCase() === baseName(savedExe).toLowerCase()
      || c.path.toLowerCase().endsWith(String(savedExe).toLowerCase()));
    if (hit) {
      row.exe = hit.path;
      row.startDir = parentDir(hit.path) || row.startDir;
      row.reason = `saved pick: ${baseName(hit.path)}`;
    }
  }
  return row;
}

// ------------------------------------------------------------------ steam library
// Steam's own rows: existing non-Steam shortcuts ('shortcut') and installed
// store games ('steam'). Folder rows aren't touched here; match/art/checks
// survive rebuilds through stable per-source keys.
async function syncSteamLibrary() {
  const keep = new Map();
  for (const r of S.rows) {
    if (r.source === 'folder') continue;
    keep.set(`${r.source}:${(r.exe || r.display).toLowerCase()}`, r);
  }
  S.rows = S.rows.filter((r) => r.source === 'folder');
  const folderExe = new Set(S.rows.map((r) => (r.exe || '').toLowerCase()).filter(Boolean));
  let entries = [];
  let installed = [];
  try { entries = await window.api.steamRead(); } catch { entries = []; }
  try { installed = await window.api.steamGames(); } catch { installed = []; }
  S.ownedAppids = new Set(installed.map((g) => g.appid));

  for (const e of entries) {
    const exe = String(e.exe || '').replace(/^"|"$/g, '');
    const name = String(e.appName || '(unnamed)');
    if (exe && folderExe.has(exe.toLowerCase())) continue;
    const old = keep.get(`shortcut:${(exe || name).toLowerCase()}`);
    let query = name;
    let steamAppid = null;
    try {
      const id = await window.api.resolveName(name);
      if (id && id.parsed) { query = id.title; steamAppid = id.steamAppid; }
    } catch { /* display-only guess; matching does the real work */ }
    const startDir = String(e.startDir || parentDir(exe));
    S.rows.push({
      folder: `shortcut://${e.appid ?? e.index}`, folderName: name, display: name,
      exe: exe || null, startDir, launchOptions: '',
      candidates: exe ? [{ path: exe, size: 0, depth: 0, score: 0, reason: 'existing shortcut' }] : [],
      score: 0, reason: 'already in Steam as a non-Steam shortcut', query,
      steamAppid, idMethod: 'shortcut', confidence: 0.5, source: 'shortcut',
      checked: old ? old.checked : false, sgdbId: old ? old.sgdbId : null,
      sgdbName: old ? old.sgdbName : '', inSteam: true, managed: !!e.managed,
      shortcutIdx: e.index, appid: e.appid, art: old ? old.art || {} : {},
    });
  }
  for (const g of installed) {
    const old = keep.get(`steam:${String(g.name).toLowerCase()}`);
    S.rows.push({
      folder: `steam:${g.appid}`, folderName: g.name, display: g.name,
      exe: null, startDir: g.installdir || '', launchOptions: '', candidates: [],
      score: 0, reason: 'installed Steam store game (managed by Steam)', query: g.name,
      steamAppid: g.appid, idMethod: 'steam', confidence: 1, source: 'steam',
      checked: false, sgdbId: old ? old.sgdbId : null,
      sgdbName: old ? old.sgdbName : '', inSteam: true, managed: false,
      shortcutIdx: null, appid: null, art: old ? old.art || {} : {},
    });
  }
  renderRows();
  if (S.detailKey && !cur()) { S.detailKey = null; renderDetail(); }
}

async function doScan() {
  const roots = (S.cfg.games_roots || []).filter(Boolean);
  if (!roots.length) {
    toast('Add a games folder first in Settings.');
    return;
  }
  status(`Scanning ${roots.length} folder(s)…`);
  const games = await window.api.scanStart({ roots });
  const prev = new Map(S.rows.map((r) => [r.folder, r]));
  const folderCounts = new Map();
  for (const g of games) {
    const name = baseName(g.folder).toLowerCase();
    folderCounts.set(name, (folderCounts.get(name) || 0) + 1);
  }
  S.rows = [];
  let droppedNoExe = 0;
  for (const g of games) {
    const old = prev.get(g.folder);
    const row = toRow(g, folderCounts.get(baseName(g.folder).toLowerCase()) === 1);
    if (old) {
      row.checked = old.checked;
      row.sgdbId = old.sgdbId;
      row.sgdbName = old.sgdbName;
      row.art = old.art || {};
      row.launchOptions = old.launchOptions || '';
    }
    // No exe, not even a candidate: not a game. Leave it out instead of
    // showing a dead row.
    if (!row.exe && !row.candidates.length) { droppedNoExe++; continue; }
    if (!row.sgdbName && row.sgdbId) row.sgdbName = '(cached)';
    S.rows.push(row);
  }
  renderRows();
  const ok = S.rows.filter((r) => r.exe).length;
  const parsed = S.rows.filter((r) => r.idMethod !== 'folder').length;
  log(`Found ${S.rows.length} games, ${ok} with a .exe, ${parsed} auto-identified (${S.rows.length - parsed} need review).`);
  if (droppedNoExe) log(`  Skipped ${droppedNoExe} folder(s) with no .exe - not games.`);
  status(`Found ${S.rows.length} games.`);
  await refreshSteamState();
  await syncSteamLibrary();
}

function isWithin(p, folder) {
  const a = String(p).toLowerCase();
  const b = String(folder).toLowerCase().replace(/[\\/]+$/, '');
  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`);
}

async function doDeepScan() {
  const roots = (S.cfg.games_roots || []).filter(Boolean);
  if (!roots.length) { toast('Add a games folder first in Settings.'); return; }
  const known = new Set(S.rows.map((r) => r.folder.toLowerCase()));
  const claimed = new Set();
  for (const r of S.rows) {
    if (r.exe) claimed.add(r.exe);
    for (const c of r.candidates) claimed.add(c.path);
  }
  status('Deep scan…');
  log('Deep scan: checking unassigned executables under the game folders…');
  let res;
  try {
    res = await window.api.scanOrphans({ roots, claimed: [...claimed] });
  } catch (e) {
    toast(`Deep scan failed: ${e.message || e}`);
    status('Deep scan failed.');
    return;
  }
  const { games: orphans, truncated } = res;
  if (truncated) log('  Deep scan list capped - narrow the folders if games are missing.');
  let attached = 0;
  let added = 0;
  for (const g of orphans) {
    if (known.has(g.folder.toLowerCase())) continue;
    // Fill an existing exe-less row before adding another row.
    const target = g.exePath && S.rows.find((r) => r.source === 'folder' && !r.exe && isWithin(g.exePath, r.folder));
    if (target) {
      target.exe = g.exePath;
      target.startDir = g.startDir;
      target.candidates = g.candidates;
      target.reason = g.reason;
      if (target.idMethod === 'folder' && g.idMethod !== 'folder') {
        target.display = target.query = g.displayName;
        target.steamAppid = g.steamAppid;
        target.idMethod = g.idMethod;
        target.confidence = g.confidence;
      }
      attached++;
      log(`  attached ${baseName(g.exePath)} -> '${target.display}'`);
    } else {
      const row = toRow(g);
      S.rows.push(row);
      known.add(g.folder.toLowerCase());
      added++;
    }
  }
  renderRows();
  await refreshSteamState();
  if (attached || added) {
    log(`Deep scan: ${attached} attached, ${added} new candidates.`);
    status(`Deep scan: +${added} new, ${attached} attached.`);
  } else {
    log('Deep scan: nothing new was found since the standard scan.');
    status('Deep scan: nothing new was found.');
  }
}

async function refreshSteamState() {
  let entries = [];
  try {
    entries = await window.api.steamRead();
  } catch (e) {
    renderRows();
    if (S.detailKey) renderDetail();
    return; // Steam not configured yet - fine on first run
  }
  const byExe = new Map(entries.map((e) => [String(e.exe).replace(/^"|"$/g, '').toLowerCase(), e]));
  const byAppid = new Map(entries.map((e) => [Number(e.appid), e]));
  for (const r of S.rows) {
    if (r.source !== 'folder') continue; // steam-native rows carry their own flags
    const known = r.managed && r.appid != null ? byAppid.get(Number(r.appid)) : null;
    r.inSteam = false;
    r.managed = false;
    r.shortcutIdx = null;
    r.appid = null;
    const hit = known || (r.exe && byExe.get(String(r.exe).toLowerCase()));
    if (hit) {
      r.inSteam = true;
      r.managed = !!hit.managed;
      r.shortcutIdx = hit.index;
      r.appid = hit.appid;
    }
  }
  renderRows();
  if (S.detailKey) renderDetail();
}

async function needKey() {
  if (!S.cfg.api_key) {
    toast('Add your SteamGridDB API key first in Settings.');
    return true;
  }
  return false;
}

async function doAutoMatch() {
  // Folder + shortcut rows can be matched; store games are already canonical.
  const matchable = (r) => r.source !== 'steam';
  let rows = S.rows.filter((r) => r.checked && !r.sgdbId && matchable(r));
  if (!rows.length) rows = S.rows.filter((r) => r.checked && matchable(r));
  if (!rows.length) { toast('Nothing to match - scan a folder first.'); return; }
  if (await needKey()) return;
  status(`Auto-matching ${rows.length} games…`);
  log(`Auto-matching ${rows.length} games…`);
  const payload = rows.map((r) => ({
    folder: r.folder, folderName: r.folderName, display: r.display,
    query: r.query, steamAppid: r.steamAppid, sgdbId: r.sgdbId,
  }));
  const { rows: back, lines, ok } = await window.api.matchAuto({ rows: payload });
  const byFolder = new Map(back.map((r) => [r.folder, r]));
  for (const r of S.rows) {
    const u = byFolder.get(r.folder);
    if (u) { r.sgdbId = u.sgdbId; r.sgdbName = u.sgdbName; }
  }
  await syncCfg();
  lines.forEach(log);
  log(`Auto-match done: ${ok}/${rows.length} matched.`);
  status(`Matched ${ok}/${rows.length}.`);
  renderRows();
  if (S.detailKey) renderDetail();
}

// ------------------------------------------------------- artwork download
function rowPayload(r) {
  return {
    folder: r.folder, display: r.display, exe: r.exe, startDir: r.startDir,
    launchOptions: r.launchOptions, sgdbId: r.sgdbId, art: r.art,
    source: r.source, shortcutIdx: r.shortcutIdx, appid: r.appid,
  };
}

async function doDownloadArt() {
  const rows = checkedRows().filter((r) => r.sgdbId && r.source !== 'steam');
  if (!rows.length) { toast('No matched games selected - run Auto-match first (store games need no art).'); return; }
  if (await needKey()) return;
  const kinds = wantedKinds();
  if (!kinds.length) { toast('Tick at least one artwork type (Settings).'); return; }
  status(`Downloading art for ${rows.length} games…`);
  const { rows: back, lines } = await window.api.artDownload({
    rows: rows.map(rowPayload),
    kinds,
    onlyMissing: !!S.cfg.only_missing,
    filters: { animated: S.cfg.include_animated, nsfw: S.cfg.include_nsfw, humor: S.cfg.include_humor },
  });
  const byFolder = new Map(back.map((r) => [r.folder, r]));
  for (const r of S.rows) {
    const u = byFolder.get(r.folder);
    if (u) r.art = u.art || r.art;
  }
  lines.forEach(log);
  log('Art download done. Restart Steam to see it.');
  status('Art download done. Restart Steam.');
  toast('Artwork downloaded - restart Steam to see it.');
  if (S.detailKey) renderDetail();
}

function wantedKinds() {
  return ['wide', 'grid', 'hero', 'logo', 'icon'].filter((k) => S.cfg[`want_${k}`]);
}

// ---------------------------------------------------------- steam add/rm
async function doAddToSteam() {
  // Only folder rows go in: shortcuts are already there, Steam manages its own.
  const eligible = checkedRows().filter((r) => r.exe && r.source === 'folder');
  const noExe = checkedRows().filter((r) => !r.exe && r.source !== 'steam');
  if (noExe.length) log(`Skipping ${noExe.length} without exe: ${noExe.slice(0, 5).map((r) => r.display).join(', ')}`);
  if (!eligible.length) { toast('No selected games with a .exe.'); return; }
  const needsReview = eligible.filter((r) => r.idMethod === 'folder' && !r.sgdbId);
  let summary = `Add ${eligible.length} selected game(s) to Steam as non-Steam shortcuts?`;
  if (needsReview.length) {
    summary += `\n\nCheck these names first:\n`
      + needsReview.slice(0, 8).map((r) => `• ${r.display}`).join('\n')
      + (needsReview.length > 8 ? `\n… and ${needsReview.length - 8} more` : '');
  }
  if (!await confirmDlg('Add to Steam', summary)) return;
  if (await window.api.steamRunning()) {
    if (!await confirmDlg('Steam is running',
      'Shortcuts can still be written, but you MUST fully exit Steam (tray - Exit) and reopen it afterwards. Continue?')) return;
  }
  let autoArt = false;
  if (S.cfg.api_key) {
    autoArt = await confirmDlg('Artwork',
      'Also find artwork automatically for types you did not choose?');
  }
  const kinds = [...new Set([...wantedKinds(), ...eligible.flatMap((r) => Object.keys(r.art || {}))])];
  status(`Adding ${eligible.length} games to Steam…`);
  log(`Adding ${eligible.length} games…`);
  try {
    const { rows: back, lines, added, updated, artworkSaved } = await window.api.steamAdd({
      rows: eligible.map(rowPayload),
      autoArt,
      kinds,
      onlyMissing: !!S.cfg.only_missing,
      filters: { animated: S.cfg.include_animated, nsfw: S.cfg.include_nsfw, humor: S.cfg.include_humor },
    });
    const byFolder = new Map(back.map((r) => [r.folder, r]));
    for (const r of S.rows) {
      const u = byFolder.get(r.folder);
      if (u) {
        r.shortcutIdx = u.shortcutIdx;
        r.appid = u.appid;
        r.managed = u.managed;
        r.inSteam = true;
        if (u.art) r.art = u.art;
      }
    }
    await syncCfg();
    lines.forEach(log);
    renderRows();
    status(`Done: ${added} added, ${updated} updated, ${artworkSaved} artwork saved. Restart Steam!`);
    toast(`${added} added, ${updated} updated, ${artworkSaved} artwork saved - restart Steam to see them.`);
  } catch (e) {
    log(`FAILED: ${e.message || e}`);
    toast(`Write failed: ${e.message || e}`);
  }
}

async function doRemoveFromSteam() {
  const rows = checkedRows().filter((r) => r.inSteam
    && (r.source === 'shortcut' || r.managed));
  const skipped = checkedRows().filter((r) => r.source === 'steam' && r.checked);
  if (!rows.length) { toast('None of the checked games are in Steam.'); return; }
  if (skipped.length) log(`Skipping ${skipped.length} Steam store game(s) - those are not shortcuts.`);
  const names = rows.slice(0, 12).map((r) => `• ${r.display}`).join('\n')
    + (rows.length > 12 ? `\n… and ${rows.length - 12} more` : '');
  if (!await confirmDlg('Remove from Steam',
    `Remove ${rows.length} shortcuts?\n\n${names}\n\n(Art files are left alone.)`)) return;
  const { removed, backup } = await window.api.steamRemove({
    rows: rows.map(rowPayload),
  });
  for (const r of rows) {
    r.inSteam = false;
    r.managed = false;
    r.shortcutIdx = null;
    r.appid = null;
  }
  await refreshSteamState();
  await syncSteamLibrary(); // drop shortcut rows whose entries just vanished
  log(`Removed ${removed} shortcuts. Backup: ${backup || 'none'}. Restart Steam.`);
  status(`Removed ${removed}. Restart Steam.`);
}

async function steamPathOrToast() {
  if (!S.cfg.steam_path) { toast('Set Steam path first in Settings.'); return null; }
  const ok = await window.api.steamVerify(S.cfg.steam_path).catch(() => false);
  if (!ok) { toast('Steam path is not valid - check Settings.'); return null; }
  return S.cfg.steam_path;
}

async function doKillSteam() {
  if (!await steamPathOrToast()) return;
  if (!await confirmDlg('Kill Steam',
    'Force-close Steam now? Running games will be closed.')) return;
  status('Killing Steam…');
  try {
    const { lines } = await window.api.steamKill();
    lines.forEach(log);
    status(lines[lines.length - 1] || 'Done.');
  } catch (e) {
    toast(e.message || String(e));
  }
}

async function doRestartSteam() {
  if (!await steamPathOrToast()) return;
  const running = await window.api.steamRunning().catch(() => false);
  if (!await confirmDlg('Restart Steam', running
    ? 'Close Steam and launch it again? Running games will be closed.'
    : 'Launch Steam now?')) return;
  status('Restarting Steam…');
  try {
    const { lines } = await window.api.steamRestart();
    lines.forEach(log);
    // Launch call alone means nothing: poll till Steam is actually seen, or
    // the bar says "launching" forever with no verdict.
    let seen = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        if (await window.api.steamRunning()) { seen = true; break; }
      } catch { /* keep polling */ }
    }
    if (seen) {
      status('Steam restarted.');
      toast('Steam restarted.');
    } else {
      status('Steam did not come back - launch it manually.');
      log('Restart issued but Steam was not seen running after 15s.');
    }
  } catch (e) {
    toast(e.message || String(e));
  }
}

async function doPruneMissing() {  let stale;
  try {
    stale = await window.api.steamPrune();
  } catch (e) {
    toast(e.message || String(e));
    return;
  }
  if (!stale.length) {
    toast('No stale shortcuts - every game we added still exists.');
    log('Prune check: nothing stale.');
    return;
  }
  const names = stale.slice(0, 12).map((s) => `• ${s.display}`).join('\n')
    + (stale.length > 12 ? `\n… and ${stale.length - 12} more` : '');
  if (!await confirmDlg('Prune missing games',
    `${stale.length} shortcut(s) we added point at exes that no longer exist:\n\n${names}\n\nRemove them? (Art files are left alone.)`)) return;
  const { removed, backup } = await window.api.steamRemove({
    rows: stale.map((s) => ({ display: s.display, exe: s.exe })),
  });
  await refreshSteamState();
  await syncSteamLibrary();
  log(`Pruned ${removed} stale shortcuts. Backup: ${backup || 'none'}. Restart Steam.`);
  status(`Pruned ${removed}. Restart Steam.`);
}

// ------------------------------------------------------- artwork modal
const ART_TABS = [['wide', 'Wide Capsule'], ['grid', 'Vertical Grid'], ['hero', 'Hero'], ['logo', 'Logo'], ['icon', 'Icon']];

function openArtModal(row, focusKind) {
  if (row.source === 'steam') { toast('Artwork for Steam store games is managed by Steam.'); return; }
  if (!S.cfg.api_key) { toast('Add your SteamGridDB API key first in Settings.'); return; }
  S.modal = {
    row, tab: focusKind || 'grid',
    sgdbId: row.sgdbId || null,
    cache: {},           // `${sgdbId}:${kind}` -> items
    sel: { ...(row.art || {}) },
    games: [],
  };
  $('#art-title').textContent = `Artwork - ${row.display}`;
  $('#art-q').value = row.query || row.display;
  $('#art-id').value = row.sgdbId || '';
  $('#art-games').innerHTML = '';
  renderArtTabs();
  $('#art-overlay').hidden = false;
  if (row.sgdbId) loadArtTabs();
  else artStatus('Pick an SGDB match, then choose art per tab.');
}

function closeArtModal(save) {
  const m = S.modal;
  S.modal = null;
  $('#art-overlay').hidden = true;
  if (save && m) {
    if (m.sgdbId && m.sgdbId !== m.row.sgdbId) {
      m.row.sgdbId = m.sgdbId;
      m.row.sgdbName = m.row.sgdbName && !['(cached)', '(manual)'].includes(m.row.sgdbName)
        ? m.row.sgdbName : '(picked)';
      S.cfg.sgdb_map[folderKey(m.row.folder)] = m.sgdbId;
      savePatch({ sgdb_map: S.cfg.sgdb_map });
    }
    m.row.art = { ...m.sel };
    renderRows();
    renderDetail();
    log(`'${m.row.display}': artwork selection updated.`);
  }
}

function artStatus(t) { $('#art-status').textContent = t; }

function renderArtTabs() {
  const m = S.modal;
  const host = $('#art-tabs');
  host.innerHTML = '';
  for (const [kind, label] of ART_TABS) {
    const b = document.createElement('button');
    b.className = `tab${m.tab === kind ? ' on' : ''}`;
    b.textContent = label;
    const picked = m.sel[kind];
    if (picked) b.textContent += ' ★';
    b.addEventListener('click', () => { m.tab = kind; renderArtTabs(); renderArtGrid(); });
    host.appendChild(b);
  }
}

function filters() {
  return { animated: S.cfg.include_animated, nsfw: S.cfg.include_nsfw, humor: S.cfg.include_humor };
}

async function loadArtTabs() {
  const m = S.modal;
  if (!m || !m.sgdbId) return;
  artStatus(`Loading artwork for SGDB ${m.sgdbId}…`);
  renderArtGrid(true);
  try {
    const jobs = ART_TABS.map(async ([kind]) => {
      const key = `${m.sgdbId}:${kind}`;
      if (!m.cache[key]) {
        m.cache[key] = await window.api.artList({ sgdbId: m.sgdbId, kind, filters: filters() });
      }
    });
    await Promise.all(jobs);
    if (!S.modal || S.modal.sgdbId !== m.sgdbId) return; // user moved on
    let total = 0;
    for (const [kind] of ART_TABS) total += (m.cache[`${m.sgdbId}:${kind}`] || []).length;
    artStatus(`SGDB ${m.sgdbId}: ${total} images. Double-click to select per type.`);
    renderArtTabs();
    renderArtGrid();
  } catch (e) {
    artStatus(`Load failed: ${e.message || e}`);
  }
}

function isPicked(kind, item) {
  const s = S.modal.sel[kind];
  return s && s.id && item.id && s.id === item.id && s.url === item.url;
}

function renderArtGrid(loading = false) {
  const m = S.modal;
  const grid = $('#art-grid');
  grid.innerHTML = '';
  if (!m) return;
  if (loading || !m.sgdbId) {
    grid.innerHTML = `<div class="muted">${m.sgdbId ? 'Loading…' : 'Search or enter an SGDB game ID first.'}</div>`;
    return;
  }
  const items = m.cache[`${m.sgdbId}:${m.tab}`] || [];
  if (!items.length) {
    grid.innerHTML = '<div class="muted">No images of this type.</div>';
    return;
  }
  for (const im of items) {
    const cell = document.createElement('div');
    cell.className = `thumb${isPicked(m.tab, im) ? ' picked' : ''}`;
    cell.innerHTML = `<img loading="lazy" src="${esc(im.thumb || im.url)}" alt="">
      <div class="meta">#${im.id} · ${esc(im.style)} · ${im.width}x${im.height}<br>
      ▲${im.upvotes} score ${im.score} · ${esc(im.author)}</div>`;
    cell.addEventListener('click', () => pickArt(m.tab, im));
    grid.appendChild(cell);
  }
}

function pickArt(kind, item) {
  S.modal.sel[kind] = item;
  artStatus(`${kind}: selected #${item.id} by ${item.author}.`);
  renderArtTabs();
  renderArtGrid();
}

async function artSearch() {
  const m = S.modal;
  const q = $('#art-q').value.trim();
  if (!q) return;
  artStatus(`Searching SGDB for '${q}'…`);
  try {
    const games = await window.api.sgdbSearch(q);
    m.games = games;
    const sel = $('#art-games');
    sel.innerHTML = '';
    if (!games.length) { artStatus('No SGDB matches. Try another query or paste an ID.'); return; }
    for (const g of games) {
      const o = document.createElement('option');
      o.value = String(g.id);
      o.textContent = `${g.name}  [${g.id}]`;
      sel.appendChild(o);
    }
    const g = games[0];
    m.sgdbId = g.id;
    $('#art-id').value = String(g.id);
    artStatus(`Matched '${g.name}' (${g.id}). Loading artwork…`);
    await loadArtTabs();
  } catch (e) {
    artStatus(`Search failed: ${e.message || e}`);
  }
}

async function artLoadId() {
  const m = S.modal;
  const gid = Number(($('#art-id').value || '').trim());
  if (!Number.isFinite(gid) || gid <= 0) { artStatus('SGDB game ID must be a number.'); return; }
  m.sgdbId = gid;
  await loadArtTabs();
}

// ------------------------------------------------------------------ boot
function wireToolbar() {
  $('#btn-scan').addEventListener('click', doScan);
  $('#btn-deep').addEventListener('click', doDeepScan);
  $('#btn-match').addEventListener('click', handleAction('Auto-match', doAutoMatch));
  $('#btn-download').addEventListener('click', handleAction('Artwork download', doDownloadArt));
  $('#btn-add').addEventListener('click', doAddToSteam);
  $('#btn-remove').addEventListener('click', handleAction('Shortcut removal', doRemoveFromSteam));
  $('#btn-prune').addEventListener('click', handleAction('Prune', doPruneMissing));
  $('#side-kill').addEventListener('click', doKillSteam);
  $('#side-restart').addEventListener('click', doRestartSteam);
  $('#sel-all').addEventListener('click', () => { S.rows.forEach((r) => { r.checked = r.source !== 'steam'; }); renderRows(); });
  $('#sel-none').addEventListener('click', () => { S.rows.forEach((r) => { r.checked = false; }); renderRows(); });
  $('#unresolved-only').addEventListener('change', (e) => { S.unresolvedOnly = e.target.checked; renderRows(); });
  $('#hide-owned').addEventListener('click', () => {
    S.hideOwned = !S.hideOwned;
    const b = $('#hide-owned');
    b.classList.toggle('on', S.hideOwned);
    b.setAttribute('aria-pressed', String(S.hideOwned));
    renderRows();
  });
  $('#filter').addEventListener('input', (e) => { S.filter = e.target.value; renderRows(); });
  // lib-banner buttons are rebuilt by renderBanner() with their own handlers.
  document.querySelectorAll('.checklist').forEach((box) => {
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cl]');
      if (!btn) return;
      if (btn.dataset.cl === 'x') {
        checklistDismissed = true;
        document.querySelectorAll('.checklist').forEach((b) => { b.hidden = true; });
        return;
      }
      navGo('settings');
    });
  });
  $('#games-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.closest('[data-act="toggle"]')) {
      const r = rowByKey(tr.dataset.key);
      if (r) { r.checked = !r.checked; renderRows(); }
      return;
    }
    selectRow(tr.dataset.key);
  });
  $('#d-apply').addEventListener('click', applyDetails);
  $('#d-browse').addEventListener('click', async () => {
    const r = cur();
    const p = await window.api.filesPickExe(r ? r.folder : null);
    if (p) {
      const pick = $('#d-exe-pick');
      if (![...pick.options].some((o) => o.value === p)) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = baseName(p);
        pick.appendChild(o);
      }
      pick.value = p;
    }
  });
  $('#d-open').addEventListener('click', () => {
    const r = cur();
    if (!r) return;
    const folder = r.source === 'steam' ? r.startDir
      : r.source === 'shortcut' ? (r.startDir || parentDir(r.exe)) : r.folder;
    if (folder) window.api.shellOpen(folder);
  });
  $('#detail-choose-art').addEventListener('click', () => {
    const r = cur();
    if (r) openArtModal(r);
  });
  $('#s-go').addEventListener('click', sgdbSearch);
  $('#s-set').addEventListener('click', sgdbUseSelected);
  $('#s-auto').addEventListener('click', sgdbAutoOne);
  $('#s-results').addEventListener('change', () => {
    const picked = S.searchCache.find((g) => String(g.id) === $('#s-results').value);
    if (picked) {
      $('#s-status').textContent = `${picked.name} · ready to use`;
    }
  });
  // modal
  $('#art-search').addEventListener('click', artSearch);
  $('#art-load').addEventListener('click', artLoadId);
  $('#art-games').addEventListener('change', async (e) => {
    const m = S.modal;
    const g = (m.games || []).find((x) => String(x.id) === e.target.value);
    if (g) {
      m.sgdbId = g.id;
      $('#art-id').value = String(g.id);
      await loadArtTabs();
    }
  });
  $('#art-url').addEventListener('click', async () => {
    const m = S.modal;
    const url = prompt(`Direct image URL for '${m.tab}':`);
    if (url && url.trim()) {
      m.sel[m.tab] = { url: url.trim(), custom: true };
      renderArtTabs();
      artStatus(`${m.tab}: custom URL set.`);
    }
  });
  $('#art-file').addEventListener('click', async () => {
    const m = S.modal;
    const p = await window.api.filesPickImage();
    if (p) {
      m.sel[m.tab] = { file: p, custom: true };
      renderArtTabs();
      artStatus(`${m.tab}: local file set.`);
    }
  });
  $('#art-clear').addEventListener('click', () => {
    const m = S.modal;
    delete m.sel[m.tab];
    renderArtTabs();
    renderArtGrid();
    artStatus(`${m.tab}: cleared (default top result will be used).`);
  });
  $('#art-cancel').addEventListener('click', () => closeArtModal(false));
  $('#art-apply').addEventListener('click', () => closeArtModal(true));
  $('#art-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'art-overlay') closeArtModal(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.modal) closeArtModal(false);
    // History shortcuts. Ignored while the modal owns input.
    if (!S.modal && e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navBack(); }
    if (!S.modal && e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navFwd(); }
  });
  // Mouse back/forward at DOM level (buttons 3/4 here = 4th/5th on the mouse).
  // Always fires, unlike the OS path. Deduped against it above.
  document.addEventListener('mouseup', (e) => {
    if (S.modal || (e.button !== 3 && e.button !== 4)) return;
    if (Date.now() - lastIpcNav < NAV_ECHO_MS) return;
    lastMouseNav = Date.now();
    e.preventDefault();
    if (e.button === 3) navBack(); else navFwd();
  });
  $$('.nav').forEach((b) => b.addEventListener('click', () => navGo(b.dataset.page)));
}

async function applyDetails() {
  const r = cur();
  if (!r) return;
  if (r.source === 'steam') { toast('Steam store games cannot be edited here - Steam manages them.'); return; }
  const name = $('#d-name').value.trim();
  const exe = $('#d-exe-pick').value.trim();
  if (name) {
    r.display = name;
    r.query = name;
    S.cfg.title_map[folderKey(r.folder)] = name;
  }
  if (exe) {
    const launcherChanged = exe !== r.exe;
    r.exe = exe;
    if (launcherChanged) r.startDir = parentDir(exe);
    S.cfg.exe_map[folderKey(r.folder)] = exe.startsWith(r.folder)
      ? exe.slice(r.folder.length).replace(/^[\\/]/, '') : baseName(exe);
  }
  r.reason = 'manual';
  await savePatch({ title_map: S.cfg.title_map, exe_map: S.cfg.exe_map });
  await refreshSteamState();
  log(`Updated '${r.display}'.`);
}

async function sgdbSearch() {
  const r = cur();
  if (!r) return;
  const key = rowKey(r);
  const q = $('#s-search').value.trim() || r.display;
  if (!q) return;
  if (!S.cfg.api_key) { toast('Add your SteamGridDB API key first in Settings.'); return; }
  const token = ++S.matchSearchToken;
  const sel = $('#s-results');
  const use = $('#s-set');
  resetMatchResults('Searching…');
  $('#s-status').textContent = `Searching '${q}'…`;
  try {
    const games = await window.api.sgdbSearch(q);
    if (!isCurrentMatchRequest(token, key)) return;
    S.searchCache = games;
    sel.innerHTML = '';
    if (!games.length) {
      resetMatchResults('No matches');
      $('#s-status').textContent = 'No matches. Try another search.';
      return;
    }
    for (const g of games) {
      const o = document.createElement('option');
      o.value = String(g.id);
      o.textContent = `${g.name}  [${g.id}]`;
      sel.appendChild(o);
    }
    sel.disabled = false;
    use.disabled = false;
    $('#s-status').textContent = `${games.length} matches found`;
  } catch (e) {
    if (!isCurrentMatchRequest(token, key)) return;
    resetMatchResults('Search failed');
    $('#s-status').textContent = `Search failed: ${e.message || e}`;
  }
}

async function sgdbUseSelected() {
  const r = cur();
  if (!r) return;
  const picked = S.searchCache.find((g) => String(g.id) === $('#s-results').value);
  if (!picked) { toast('Search for a game and choose a match first.'); return; }
  r.sgdbId = picked.id;
  r.sgdbName = picked.name;
  S.cfg.sgdb_map[folderKey(r.folder)] = r.sgdbId;
  await savePatch({ sgdb_map: S.cfg.sgdb_map });
  renderRows();
  renderDetail();
  log(`'${r.display}' -> SGDB ${r.sgdbId}.`);
}

async function sgdbAutoOne() {
  const r = cur();
  if (!r) return;
  if (!S.cfg.api_key) { toast('Add your SteamGridDB API key first in Settings.'); return; }
  const key = rowKey(r);
  const token = ++S.matchSearchToken;
  resetMatchResults('Matching automatically…');
  $('#s-status').textContent = `Auto-matching '${r.display}'…`;
  try {
    const result = await window.api.matchAuto({ force: true, persist: false, rows: [{
      folder: r.folder, display: r.display, query: r.query,
      steamAppid: r.steamAppid, sgdbId: null,
    }] });
    if (!isCurrentMatchRequest(token, key)) return;
    result.lines.forEach(log);
    const match = result.rows[0];
    if (match && match.sgdbId) {
      r.sgdbId = match.sgdbId;
      r.sgdbName = match.sgdbName;
      S.cfg.sgdb_map[folderKey(r.folder)] = r.sgdbId;
      await savePatch({ sgdb_map: S.cfg.sgdb_map });
      renderRows();
      if (isCurrentMatchRequest(token, key)) renderDetail();
    } else {
      resetMatchResults('No close match found');
      $('#s-status').textContent = 'No close match found.';
    }
  } catch (e) {
    if (!isCurrentMatchRequest(token, key)) return;
    resetMatchResults('Auto-match failed');
    $('#s-status').textContent = `Auto-match failed: ${e.message || e}`;
  }
}

function checkedRows() {
  return S.rows.filter((r) => r.checked);
}

async function boot() {
  S.cfg = await window.api.cfgGet();
  console.log('RENDERER booted');
  log('ready.');
  try {
    S.steamUsers = S.cfg.steam_path ? await window.api.steamUsers(S.cfg.steam_path) : [];
  } catch { S.steamUsers = []; }
  wireToolbar();
  renderSettingsCards();
  window.api.onNav((dir) => {
    if (Date.now() - lastMouseNav < NAV_ECHO_MS) return; // DOM handler got it first
    lastIpcNav = Date.now();
    if (dir === 'back') navBack(); else navFwd();
  });
  window.api.onProgress((p) => {
    setBar(p.current || 0, p.total || 0);
    if (p.label) status(p.label);
  });
  window.api.onLog((line) => log(line));
  const steamOk = S.cfg.steam_path
    ? await window.api.steamVerify(S.cfg.steam_path).catch(() => false)
    : false;
  // No separate onboarding page: unconfigured launches land on full Settings
  // (all cards live there); configured launches land on the Steam library.
  if (!steamOk) {
    navReset('settings');
  } else {
    navReset('library');
    await syncSteamLibrary();
    if ((S.cfg.games_roots || []).length) doScan();
    else status('Browse your Steam library or add a games folder in Settings.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    document.body.innerHTML = `<pre style="padding:20px">Failed to start: ${esc(e.message || e)}</pre>`;
  });
});
