'use strict';
/* library and settings ui */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrapText = (s) => esc(s).replace(/([a-z\d])([A-Z])/g, '$1<wbr>$2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1<wbr>$2').replace(/([._-])/g, '<wbr>$1');
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
const S = {
  cfg: null,
  rows: [],
  steamUsers: [],
  filter: '',
  sourceFilter: 'all',
  sortGames: 'az',
  hideOwned: false,
  ownedAppids: new Set(), // Steam appids installed for the user (hide-owned filter)
  detailKey: null,          // rowKey() of selected row
  searchCache: [],          // sgdb search results for detail pane
  matchSearchToken: 0,
  previewCache: {},         // sgdbId -> thumb url
  modal: null,              // artwork picker state
  exePicker: null,
  onboardingStep: 0,
  isDevelopment: false,
  cardArtCache: new Map(),
  coverObserver: null,
  desktop: { rows: [], detail: null, busy: false, coverObserver: null },
};

const cur = () => (S.detailKey ? rowByKey(S.detailKey) : null);

// ------------------------------------------------------------------ log/ui
function log(line, library = 'library') {
  const key = library === 'desktop' ? 'desktop' : library === 'settings' || library === 'onboarding' ? 'settings' : 'library';
  (S.logs ||= { library: [], desktop: [], settings: [] })[key].push(String(line));
  if (Nav.current() !== key) return;
  const box = $('#log');
  const div = document.createElement('div');
  div.textContent = line;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function renderLog() {
  const box = $('#log');
  box.replaceChildren(...(S.logs?.[Nav.current()] || []).map(line => {
    const div = document.createElement('div');
    div.textContent = line;
    return div;
  }));
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
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3200);
}
function handleAction(name, fn) {
  return () => {
    const library = Nav.current();
    return fn().catch((e) => {
      const message = e?.message || String(e);
      setBar(0, 0);
      log(`${name} failed: ${message}`, library);
      status(`${name} failed.`);
      toast(`${name} failed: ${message}`);
    });
  };
}
function confirmDlg(title, body, opts = {}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const ov = document.createElement('div');
    ov.id = 'confirm-overlay';
    ov.innerHTML = `<div id="confirm-box" role="alertdialog">
      <h3>${esc(title)}</h3><p class="muted${opts.danger ? ' danger-text' : ''}${opts.small ? ' small' : ''}">${esc(body)}</p>
      <div class="confirm-btns">
        <button class="btn sm" data-v="0">${esc(opts.cancelText || 'Cancel')}</button>
        <button class="btn primary sm" data-v="1">${esc(opts.confirmText || 'Continue')}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const close = (value) => {
      ov.remove();
      document.removeEventListener('keydown', keydown, true);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const keydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      const focusable = $$('button:not(:disabled)', ov);
      if (!focusable.length) return;
      const at = focusable.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); focusable.at(-1).focus(); }
      else if (!e.shiftKey && at === focusable.length - 1) { e.preventDefault(); focusable[0].focus(); }
    };
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b && e.target !== ov) return;
      const v = b ? b.dataset.v === '1' : false;
      close(v);
    });
    document.addEventListener('keydown', keydown, true);
    $('button[data-v="1"]', ov).focus({ preventScroll: true });
  });
}
async function syncCfg() { S.cfg = await window.api.cfgGet(); }
// cfgSet returns the saved config. Keep the renderer copy in sync.
async function savePatch(patch) {
  S.cfg = await window.api.cfgSet(patch);
  if (['api_key', 'artwork_filters', 'include_animated', 'include_nsfw', 'include_humor'].some(key => Object.hasOwn(patch, key))) {
    S.cardArtCache.clear();
    S.previewCache = {};
  }
  applyTheme();
  renderChecklist().catch(() => {});
}
function applyTheme() {
  const mode = ['dark', 'light'].includes(S.cfg.theme) ? S.cfg.theme : 'system';
  const theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = theme;
  $('#theme').value = mode;
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
      btn.querySelector('.cl-state').textContent = done ? '✓' : '';
      if (!done) allDone = false;
    });
    box.hidden = allDone;
  }
}

// ------------------------------------------------------------------ router
// Back/Forward history for mouse navigation.
const TITLES = { library: 'Steam library', desktop: 'Desktop library', settings: 'Settings', onboarding: 'Set up Lib Shammes' };
const Nav = {
  stack: ['library'],
  idx: 0,
  current() { return this.stack[this.idx]; },
};
let routeMotion = 0;
let librarySave = Promise.resolve();
function paintRoute() {
  const page = Nav.current();
  const target = $(`#page-${page}`);
  const current = $('.page.on');
  const animate = current && current !== target && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const outgoing = animate ? { opacity: getComputedStyle(current).opacity, transform: getComputedStyle(current).transform } : null;
  const incoming = animate && getComputedStyle(target).display !== 'none'
    ? { opacity: getComputedStyle(target).opacity, transform: getComputedStyle(target).transform } : null;
  const motion = ++routeMotion;
  $$('.page').forEach((p) => {
    p.getAnimations().forEach((animation) => animation.cancel());
    p.classList.remove('on', 'route-exit');
    p.removeAttribute('aria-hidden');
    p.inert = true;
  });
  if (animate) {
    current.classList.add('route-exit');
    current.setAttribute('aria-hidden', 'true');
  }
  target.classList.add('on');
  target.inert = false;
  renderLog();
  $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  $('.navigation-row').hidden = page === 'onboarding';
  $('.steam-controls').hidden = !['library', 'settings'].includes(page);
  if (page === 'settings') renderSettingsCards();
  if (page === 'onboarding') {
    renderOnboarding();
  }
  if (page === 'library') {
    renderChecklist();
    if (current !== target) renderRows();
    if (current !== target) handleAction('Load library', () => loadLibrary())();
  }
  if (page === 'desktop' && current !== target) {
    renderDesktop();
    handleAction('Desktop scan', () => refreshDesktop(false))();
  }
  if (S.cfg?.onboarded && ['library', 'desktop'].includes(page)) {
    const library = page === 'library' ? 'steam' : page;
    librarySave = librarySave.catch(() => {}).then(() => S.cfg.startup_library !== library && savePatch({ startup_library: library }));
    librarySave.catch((e) => log(`Startup library: ${e.message}`));
  }
  document.title = `Lib Shammes - ${TITLES[page]}`;
  if (animate) {
    const order = Object.keys(TITLES);
    const direction = order.indexOf(page) >= order.indexOf(current.id.slice(5)) ? 1 : -1;
    const exit = current.animate(
      [outgoing, { opacity: 0, transform: `translateX(${-direction * 12}px)` }],
      { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
    const enter = target.animate(
      [incoming || { opacity: 0, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: 'translateX(0)' }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
    );
    Promise.allSettled([exit.finished, enter.finished]).then(() => {
      if (motion !== routeMotion) return;
      current.classList.remove('route-exit');
      current.removeAttribute('aria-hidden');
      exit.cancel();
      enter.cancel();
    });
  }
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
  if (!pickerOpen() && Nav.idx > 0) { Nav.idx -= 1; paintRoute(); }
}
function navFwd() {
  if (!pickerOpen() && Nav.idx < Nav.stack.length - 1) { Nav.idx += 1; paintRoute(); }
}
function pickerOpen() { return !!(S.modal || S.exePicker); }
// Mouse back/forward click can arrive twice - once from the DOM, once from Electron.
// Second one inside the window is the echo, the following code drops it.
let lastMouseNav = 0;
let lastIpcNav = 0;
const NAV_ECHO_MS = 500;

// ---------------------------------------------------------- shared cards
let lastDetectedSteamPath = '';
function renderOnboarding() {
  const steps = [
    ['Connect Steam', 'Choose the Steam installation and account you want to use.', steamCard],
    ['Find artwork', 'Add an SGDB API key. You can do this later in Settings.', keyCard],
    ['Add your game folders', 'Choose the folders you want Lib Shammes to scan. You can add more later.', foldersCard],
  ];
  const [title, description, card] = steps[S.onboardingStep];
  $('#onboarding-title').textContent = title;
  $('#onboarding-description').textContent = description;
  $('#onboarding-cards').replaceChildren(card());
  $('.onboarding-steps').querySelectorAll('button').forEach((button, i) => {
    button.disabled = i > S.onboardingStep;
    if (i === S.onboardingStep) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  $('#onboarding-back').disabled = S.onboardingStep === 0;
  $('#onboarding-skip').hidden = S.onboardingStep !== 0;
  $('#onboarding-close').hidden = !S.isDevelopment || !S.cfg.onboarded;
  $('#onboarding-continue').textContent = S.onboardingStep === 2 ? 'Open library' : 'Next';
}
function steamCard() {
  const d = document.createElement('div');
  d.className = 'card settings-block settings-connection';
  // No Detect button by design: detection runs itself on boot and every time
  // this card appears. Browse is the only manual action.
  d.innerHTML = `<h3>Steam installation</h3>
    <div class="row"><input type="text" data-r="path" style="flex:1" placeholder="detecting…">
    <button class="btn sm" data-r="browse">Browse…</button></div>
    <div class="row"><span class="muted">User:</span>
    <select data-r="user" style="flex:1"></select></div>
    <div class="status-line" data-r="status">Detecting…</div>
    <div class="note">Steam closes while changes are applied and reopens afterward if it was running.</div>`;
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
      if (r.path && folderKey(r.path) !== lastDetectedSteamPath) log(`Steam found at ${r.path}`);
      lastDetectedSteamPath = folderKey(r.path);
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
  d.className = 'card settings-block settings-artwork';
  d.innerHTML = `<h3>SteamGridDB API key</h3>
    <div class="row"><input type="password" data-r="key" style="flex:1" placeholder="paste key…" autocomplete="off">
    <button class="btn sm" data-r="show">Show</button></div>
    <div class="row"><button class="btn sm" data-r="validate">Validate</button>
    <button class="btn sm" data-r="get">Get key…</button></div>
    <div class="status-line" data-r="status">Optional. Needed for online matches and artwork search.</div>
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
      log('SGDB API key valid.', 'settings');
    } else {
      q('status').textContent = `Key rejected: ${r.error}`;
      q('status').className = 'status-line bad';
      log(`Key rejected: ${r.error}`, 'settings');
    }
  });
  return d;
}

function foldersCard() {
  const d = document.createElement('div');
  d.className = 'card full settings-block settings-folders';
  d.innerHTML = `<h3>Game Folders</h3>
    <div class="row"><select data-r="list" size="4" style="flex:1"></select>
    <span style="display:flex;flex-direction:column;gap:6px">
    <button class="btn sm" data-r="add">Add…</button>
    <button class="btn sm" data-r="remove">Remove</button></span></div>
    <label class="row">Game folder depth <select data-r="depth" aria-label="Game folder depth">${[0, 1, 2, 3, 4, 5, 6].map((n) => `<option>${n}</option>`).join('')}</select></label>
    <div class="note">Choose the folder containing your games and use depth 1. For a single game folder, use 0. Use 2 if your game folders are inside another folder; increase it for further levels. The app looks up to 3 levels inside each game folder for its executable.</div>`;
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
      log(`Games folder added: ${p}`, 'settings');
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
  prefs.className = 'card settings-block settings-defaults';
  prefs.innerHTML = `<h3>Artwork defaults</h3>
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
        'Artwork searches and automatic artwork selection can include NSFW images when this is enabled.\n\nResults can change how you look at the games characters forever.',
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
  danger.className = 'card settings-block settings-danger';
  danger.innerHTML = `<h3>Danger zone</h3>
    <div class="row"><button class="btn danger sm" data-r="purge">Purge</button>
    <button class="btn danger sm" data-r="wipe">Delete app data</button></div>`;
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
  if (!plan.removeAppids.length && !plan.restoreFields.length && !plan.deleteFiles.length && !plan.restoreFiles.length) {
    toast("Nothing to purge - Steam is clean of the app's changes.");
    log('Purge check: nothing to undo.');
    return;
  }
  const sample = plan.names.slice(0, 8).map((n) => `• ${n}`).join('\n')
    + (plan.names.length > 8 ? `\n… and ${plan.names.length - 8} more` : '');
  const msg = `Remove everything this app changed in Steam?\n\n`
    + `${plan.removeAppids.length} shortcut(s), ${plan.restoreFields.length} restored shortcut setting(s), `
    + `${plan.deleteFiles.length} art file(s), ${plan.restoreFiles.length} restored art file(s)`
    + (plan.skippedFiles.length ? `, ${plan.skippedFiles.length} user-changed file(s) kept` : '')
    + (sample ? `\n\n${sample}` : '')
    + `\n\nShortcuts are backed up before changes. Your games and Steam itself are untouched. Steam will close and reopen if it is running.`;
  if (!await confirmDlg('Purge everything', msg)) return;
  const res = await window.api.steamPurge({ dryRun: false });
  (res.lines || []).forEach(log);
  await refreshSteamState();
  await syncSteamLibrary();
  status('Purge complete.');
  toast(res.warning || 'Purge complete.');
}

// ---------------------------------------------------------------- library
const SOURCE_LABEL = { folder: 'Folder', shortcut: 'Shortcut', steam: 'Steam' };
const needsReview = (row) => row.source !== 'steam' && !row.sgdbId && row.idMethod === 'folder';

function visibleSteamRows() {
  const f = S.filter.trim().toLocaleLowerCase();
  return S.rows.filter((r) => {
    if (S.sourceFilter !== 'all' && r.source !== S.sourceFilter) return false;
    if (f && !`${r.display} ${r.folder} ${r.exe || ''}`.toLocaleLowerCase().includes(f)) return false;
    // Hide-owned only trusts certain appids. Shortcut rows carry guesses,
    // so they never hide.
    if (S.hideOwned && r.source !== 'shortcut' && r.steamAppid != null && S.ownedAppids.has(r.steamAppid)) return false;
    return true;
  }).sort((a, b) => {
    const nameOrder = a.display.localeCompare(b.display, undefined, { sensitivity: 'base', numeric: true });
    if (nameOrder) return S.sortGames === 'za' ? -nameOrder : nameOrder;
    return String(a.exe || a.folder).localeCompare(String(b.exe || b.folder), undefined, { sensitivity: 'base' });
  });
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] || '?').slice(0, 2)).toUpperCase();
}

function cardSource(row) {
  if (row.source === 'steam') return 'Steam';
  if (row.source === 'shortcut') return 'Shortcut';
  return row.fromExecutableSearch ? 'Scanned game' : 'Game folder';
}

function cardSubtitle(row) {
  if (row.source === 'steam') return `Steam app ${row.steamAppid || ''}`.trim();
  const launcher = row.exe ? baseName(row.exe) : row.folderName || 'No launcher';
  return row.source === 'shortcut' && row.launchOptions ? `${launcher} · ${row.launchOptions}` : launcher;
}

function cardStatus(row) {
  if (row.pendingArt || row.pendingDetails) return ['Ready', 'pending'];
  if (row.error) return ['Issue', 'issue'];
  if (row.inSteam) return ['In Steam', ''];
  if (needsReview(row)) return ['Not matched', ''];
  return ['Not added', ''];
}

function coverToken(row) {
  const art = row.art?.grid;
  return `${rowKey(row)}:${art?.appliedFile || art?.file || art?.id || art?.url || art?.thumb || 'current'}:${row.sgdbId || ''}`;
}

async function cardCoverSource(row) {
  const art = row.art?.grid;
  if (!art?.automatic && (art?.appliedFile || art?.file)) {
    const file = art.appliedFile || art.file;
    const local = await window.api.artThumbnail(file).catch(() => window.api.artPreviewFile(file).catch(() => null));
    if (local) return local;
  }
  if (!art?.automatic && art?.thumb) return { src: art.thumb, fallback: art.url };
  if (!art?.automatic && art?.url) return art.url;
  const current = await window.api.artCurrent({ row: rowPayload(row), kind: 'grid', existsOnly: true }).catch(() => null);
  if (current?.file) {
    const local = await window.api.artThumbnail(current.file).catch(() => window.api.artPreviewFile(current.file).catch(() => null));
    if (local) return local;
  }
  if (art?.automatic) {
    if (art.appliedFile || art.file) {
      const file = art.appliedFile || art.file;
      const local = await window.api.artThumbnail(file).catch(() => window.api.artPreviewFile(file).catch(() => null));
      if (local) return local;
    }
    if (art.thumb || art.url) return { src: art.thumb || art.url, fallback: art.url };
  }
  if (!S.cfg.api_key) return null;
  const sgdbId = row.sgdbId || (row.source === 'steam'
    ? (await window.api.sgdbBySteam(row.steamAppid).catch(() => null))?.id : null);
  if (!sgdbId) return null;
  if (S.previewCache[sgdbId]) return S.previewCache[sgdbId];
  const items = await window.api.artList({ sgdbId, kind: 'grid' }).catch(() => []);
  const preview = items[0]?.thumb || items[0]?.url || null;
  if (preview) S.previewCache[sgdbId] = preview;
  return preview ? { src: preview, fallback: items[0]?.url } : null;
}

let coverRequests = 0;
const waitingCovers = [];
async function requestCardCover(row) {
  await new Promise(resolve => {
    if (coverRequests < 4) { coverRequests++; resolve(); }
    else waitingCovers.push(resolve);
  });
  try {
    return await (row.source === 'desktop' ? desktopCardCoverSource(row) : cardCoverSource(row));
  } finally {
    const next = waitingCovers.shift();
    if (next) next();
    else coverRequests--;
  }
}

function loadCardCover(row, tr) {
  const image = $('.game-cover', tr);
  const fallback = $('.cover-fallback', tr);
  const token = image.dataset.coverToken;
  const cached = S.cardArtCache.get(token);
  const request = cached || requestCardCover(row);
  if (!cached) S.cardArtCache.set(token, request);
  let alternate;
  image.onload = () => {
    if (!image.isConnected || image.dataset.coverToken !== token) return;
    image.hidden = false;
    fallback.hidden = true;
  };
  image.onerror = () => {
    if (alternate && image.getAttribute('src') !== alternate) { image.src = alternate; alternate = null; return; }
    image.hidden = true;
    fallback.hidden = false;
    S.cardArtCache.delete(token);
    if (row.sgdbId) delete S.previewCache[row.sgdbId];
  };
  request.then((source) => {
    if (!image.isConnected || image.dataset.coverToken !== token) return;
    if (!source) { S.cardArtCache.delete(token); return; }
    alternate = source.fallback;
    image.src = source.src || source;
  }).catch(() => { S.cardArtCache.delete(token); });
}

function updateLibrarySelection() {
  const body = $('#games-body');
  const selected = checkedRows();
  $('#page-library').classList.toggle('bulk-selection', !!S.bulk);
  $('#select-multiple').setAttribute('aria-pressed', String(!!S.bulk));
  for (const tr of body.querySelectorAll('.game-card-row')) {
    const row = rowByKey(tr.dataset.key);
    if (!row) continue;
    tr.classList.toggle('sel', S.detailKey === rowKey(row));
    tr.classList.toggle('is-checked', !!S.bulk && !!row.checked);
    const checkbox = $('.row-check', tr);
    if (checkbox) checkbox.checked = !!row.checked;
  }
  const visible = S.visibleRows || [];
  const checkedVisible = visible.filter((row) => row.checked).length;
  $('#sel-all').checked = visible.length > 0 && checkedVisible === visible.length;
  $('#sel-all').indeterminate = checkedVisible > 0 && checkedVisible < visible.length;
  $('#sel-all').disabled = !visible.length;
  $('#selection-count').textContent = `${selected.length} selected`;
  const pending = S.rows.filter((row) => row.pendingArt || row.pendingDetails).length;
  $('#library-pending').hidden = pending === 0;
  $('#library-pending').textContent = pending ? `${pending} ready to apply` : '';
  const applyRows = steamApplyRows();
  const canApply = applyRows.some((row) => canWriteShortcut(row)
    || (row.source === 'steam' && Object.values(row.art || {}).some(art => !art.automatic && !art.current)));
  const button = $('#btn-add');
  const busy = S.applyingSteam || S.preparingArt || S.loadingLibrary;
  button.disabled = busy || !canApply;
  button.textContent = !S.bulk || !selected.length ? 'Apply all to Steam'
    : applyRows.length === 1 && canWriteShortcut(applyRows[0]) && !applyRows[0].inSteam
      ? 'Add to Steam' : applyRows.length === 1 && applyRows[0].source === 'steam'
        ? 'Apply artwork' : applyRows.some((row) => row.pendingArt || row.pendingDetails) ? 'Apply changes' : 'Apply to Steam';
  const detailRow = cur();
  const detailCanApply = !!detailRow && (canWriteShortcut(detailRow)
    || (detailRow.source === 'steam' && (detailRow.pendingArt || Object.keys(detailRow.art || {}).length > 0)));
  $('#d-primary-action').disabled = busy || !detailCanApply;
  $('#detail').inert = !!busy;
  $('#btn-refresh').disabled = !!busy;
  $('#d-primary-action').textContent = !detailRow ? 'Apply to Steam'
    : canWriteShortcut(detailRow) && !detailRow.inSteam ? 'Add to Steam'
      : detailRow.source === 'steam' ? 'Apply artwork'
        : detailRow.pendingArt || detailRow.pendingDetails ? 'Apply changes' : 'Apply to Steam';
  $('#btn-remove').disabled = busy || !selected.some((row) => row.inSteam && (row.source === 'shortcut' || row.managed));
  $('#btn-download').disabled = busy || !S.cfg.api_key || !steamArtworkRows().length;
}

function renderRows() {
  const body = $('#games-body');
  body.innerHTML = '';
  S.coverObserver?.disconnect();
  const visible = visibleSteamRows();
  S.visibleRows = visible;
  const observerRoot = $('#page-library');
  S.coverObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        S.coverObserver.unobserve(entry.target);
        loadCardCover(entry.target._gameRow, entry.target);
      }
    }, { root: observerRoot, rootMargin: '420px 0px' }) : null;
  if (!visible.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const message = S.loadingLibrary ? 'Loading games…' : S.rows.length ? 'No games match these filters.' : '';
    if (message) {
      tr.innerHTML = `<td><div class="list-empty">${message}</div></td>`;
      body.appendChild(tr);
    }
  }
  for (const row of visible) {
    const key = rowKey(row);
    const [state, stateClass] = cardStatus(row);
    const detail = cardSubtitle(row);
    const tr = document.createElement('tr');
    tr.className = `game-card-row${S.detailKey === key ? ' sel' : ''}${S.bulk && row.checked ? ' is-checked' : ''}`;
    tr.dataset.key = key;
    tr.innerHTML = `<td><div class="game-tile"><button class="game-open" type="button" aria-label="Open details for ${esc(row.display)}">
      <div class="cover-wrap">
        <div class="cover-fallback"><img src="../assets/app-icon.svg" alt=""><span>${esc(initials(row.display))}</span></div>
        <img class="game-cover" data-cover-token="${esc(coverToken(row))}" alt="Cover art for ${esc(row.display)}" decoding="async" hidden>
      </div>
      <div class="game-card-copy">
        <span class="game-name" title="${esc(row.display)}">${esc(row.display)}</span>
        <span class="game-meta"><span class="source-label" title="${esc(cardSource(row))}">${esc(cardSource(row))}</span>${state ? `<span class="game-state ${stateClass}">${esc(state)}</span>` : ''}</span>
        <span class="game-subtitle" title="${esc(detail)}">${wrapText(detail)}</span>
      </div>
    </button><label class="cover-check" data-act="toggle"><input class="row-check" type="checkbox" aria-label="Select ${esc(row.display)}"${row.checked ? ' checked' : ''}></label></div></td>`;
    tr._gameRow = row;
    body.appendChild(tr);
    if (S.coverObserver) S.coverObserver.observe(tr);
    else loadCardCover(row, tr);
  }
  $('#library-count').textContent = `${S.rows.length} game${S.rows.length === 1 ? '' : 's'}`;
  $('#library-grid-count').textContent = visible.length === S.rows.length ? '' : `${visible.length} shown`;
  updateLibrarySelection();
  renderBanner();
}

function rowKey(r) {
  return `${r.source}:${r.folder}`;
}

function rowByKey(key) {
  return S.rows.find((r) => rowKey(r) === key);
}

// Empty library points back at Settings: an add-folder button when there are
// no folders yet, otherwise a link to Settings.
function renderBanner() {
  const banner = $('#lib-banner');
  if (!banner) return;
  if (S.loadingLibrary) { banner.hidden = true; return; }
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
  }
}

function selectRow(key) {
  S.detailKey = key;
  updateLibrarySelection();
  renderDetail();
  const detail = $('#detail-content');
  detail.getAnimations().forEach((animation) => animation.cancel());
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    detail.animate(
      [
        { opacity: 0, transform: 'translateY(18px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' },
    );
  }
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

function renderDetail() {
  const row = cur();
  const empty = $('#detail-empty');
  const content = $('#detail-content');
  $('#page-library').classList.toggle('details-open', !!row);
  if (!row) {
    empty.hidden = false;
    content.hidden = true;
    $('#detail-state').textContent = '';
    $('#detail-state').classList.remove('pending');
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  $('#d-title').textContent = row.display;
  const identity = [row.fromExecutableSearch ? 'Executable' : SOURCE_LABEL[row.source] || row.source];
  if (row.steamAppid) identity.push(`Steam ${row.steamAppid}`);
  if (row.source !== 'steam') identity.push(row.idMethod === 'folder' ? 'Not matched' : `${Math.round(row.confidence * 100)}% match`);
  $('#d-identity').textContent = identity.join(' · ');
  const state = row.pendingArt || row.pendingDetails ? 'Ready to apply in Steam'
    : row.artApplied ? 'Applied this session' : row.inSteam ? 'In Steam' : 'Not in Steam yet';
  $('#detail-state').textContent = state;
  $('#detail-state').classList.toggle('pending', !!(row.pendingArt || row.pendingDetails));
  $('#d-name').value = row.display;
  const pick = $('#d-exe-pick');
  pick.innerHTML = '';
  if (row.source === 'steam') {
    const o = document.createElement('option');
    o.value = row.exe || '';
    o.textContent = 'Managed by Steam';
    pick.appendChild(o);
  } else if (row.candidates.length) {
    const names = new Map();
    for (const c of row.candidates) {
      const name = baseName(c.path).toLowerCase();
      names.set(name, (names.get(name) || 0) + 1);
    }
    row.candidates.forEach((c) => {
      const o = document.createElement('option');
      const rel = !row.fromExecutableSearch && c.path.startsWith(row.folder)
        ? c.path.slice(row.folder.length).replace(/^[\\/]/, '') : c.path;
      o.value = c.path;
      o.title = c.path;
      o.textContent = `${names.get(baseName(c.path).toLowerCase()) > 1 ? rel : baseName(c.path)} · ${fmtMB(c.size)}`;
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
  pick.title = pick.value;
  const locked = row.source === 'steam';
  $('#d-name').disabled = locked;
  pick.disabled = locked;
  $('#d-browse').disabled = locked;
  $('#d-apply').disabled = locked;
  $('#steam-launch-settings').hidden = locked;
  const launch = S.cfg.steam_launch?.[folderKey(row.folder)];
  $('#d-startdir').value = launch?.startDir ?? String(row.startDir || '').replace(/^"|"$/g, '');
  $('#d-args').value = launch?.launchOptions ?? row.launchOptions ?? '';
  $('#s-search').value = row.query || row.display;
  S.matchSearchToken++;
  resetMatchResults();
  const matchStatus = $('#s-status');
  matchStatus.textContent = row.sgdbId ? `${row.sgdbName || '(cached)'} · ${row.sgdbId}` : 'Not matched';
  matchStatus.classList.toggle('ok', !!row.sgdbId);
  previewFor(row);
}

async function previewFor(row) {
  const img = $('#d-preview');
  const picked = row.art.grid;
  let alternate;
  img.hidden = true;
  img.onload = () => { if (cur() === row && row.art.grid === picked) img.hidden = false; };
  img.onerror = () => {
    if (cur() !== row || row.art.grid !== picked) return;
    if (alternate && img.getAttribute('src') !== alternate) { img.src = alternate; alternate = null; return; }
    img.hidden = true;
    log(`Game cover failed to load: ${picked?.file || (img.src.startsWith('data:') ? 'local image data' : img.src)}`);
    status('Game cover could not load. Check the log.');
  };
  try {
    const source = await cardCoverSource(row);
    if (cur() !== row || row.art.grid !== picked || !source) return;
    alternate = source.fallback;
    img.src = source.src || source;
  } catch { /* silent: list must stay usable offline */ }
}

// ------------------------------------------------------------ library ops
function toRow(g, useLegacy = false) {
  const folderName = baseName(g.fromExecutableSearch ? g.startDir : g.folder);
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
    fromExecutableSearch: !!g.fromExecutableSearch,
    confidence: g.confidence || 0, source: 'folder',
    checked: !!g.exePath, sgdbId: savedSgdb, sgdbName: savedSgdb ? '(cached)' : '',
    inSteam: false, managed: false, shortcutIdx: null, appid: null, art: {},
    defaults: { folder: g.folder, folderName, display: g.displayName, query: g.displayName,
      exe: g.exePath, startDir: g.startDir, reason: g.reason || '' },
  };
  const savedExe = !g.fromExecutableSearch && S.cfg.exe_map && (S.cfg.exe_map[key]
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
async function syncSteamLibrary(entries, installed) {
  if (!entries) { try { entries = await window.api.steamRead(); } catch { entries = []; } }
  if (!installed) { try { installed = await window.api.steamGames(); } catch { installed = []; } }
  const keep = new Map();
  for (const r of S.rows) {
    if (r.source === 'folder') continue;
    keep.set(r.source === 'steam' ? `steam:${r.steamAppid}` : `${r.source}:${(r.exe || r.display).toLowerCase()}`, r);
  }
  S.rows = S.rows.filter((r) => r.source === 'folder');
  const folderExe = new Set(S.rows.map((r) => (r.exe || '').toLowerCase()).filter(Boolean));
  S.ownedAppids = new Set(installed.map((g) => g.appid));

  for (const e of entries) {
    const exe = String(e.exe || '').replace(/^"|"$/g, '');
    const name = String(e.appName || '(unnamed)');
    if (exe && folderExe.has(exe.toLowerCase())) continue;
    const old = keep.get(`shortcut:${(exe || name).toLowerCase()}`);
    const folder = `shortcut://${e.appid ?? e.index}`;
    const sgdbId = old?.sgdbId || S.cfg.sgdb_map?.[folderKey(folder)] || S.cfg.sgdb_cache?.[folderKey(folder)] || null;
    let query = name;
    let steamAppid = null;
    try {
      const id = await window.api.resolveName(name);
      if (id && id.parsed) { query = id.title; steamAppid = id.steamAppid; }
    } catch { /* display-only guess; matching does the real work */ }
    const startDir = String(e.startDir || parentDir(exe));
    S.rows.push({
      folder, folderName: name, display: name,
      exe: exe || null, startDir, launchOptions: e.launchOptions || '',
      candidates: exe ? [{ path: exe, size: 0, depth: 0, score: 0, reason: 'existing shortcut' }] : [],
      score: 0, reason: 'already in Steam as a non-Steam shortcut', query,
      steamAppid, idMethod: 'shortcut', confidence: 0.5, source: 'shortcut',
      checked: old ? old.checked : false, sgdbId,
      sgdbName: old?.sgdbName || (sgdbId ? '(cached)' : ''), inSteam: true, managed: !!e.managed,
      shortcutIdx: e.index, appid: e.appid, art: old ? old.art || {} : {},
      pendingArt: !!old?.pendingArt, pendingDetails: !!old?.pendingDetails, artApplied: !!old?.artApplied,
      defaults: { display: name, query, exe: exe || null, startDir },
    });
  }
  for (const g of installed) {
    const old = keep.get(`steam:${g.appid}`);
    S.rows.push({
      folder: `steam:${g.appid}`, folderName: g.name, display: g.name,
      exe: null, startDir: g.installdir || '', launchOptions: '', candidates: [],
      score: 0, reason: 'installed Steam store game (managed by Steam)', query: g.name,
      steamAppid: g.appid, idMethod: 'steam', confidence: 1, source: 'steam',
      checked: old ? old.checked : false,
      sgdbId: old ? old.sgdbId : (S.cfg.sgdb_map?.[`steam:${g.appid}`] || S.cfg.sgdb_cache?.[`steam:${g.appid}`] || null),
      sgdbName: old ? old.sgdbName : '', inSteam: true, managed: false,
      shortcutIdx: null, appid: null, art: old ? old.art || {} : {},
      pendingArt: !!old?.pendingArt, artApplied: !!old?.artApplied,
    });
  }
  renderRows();
  if (S.detailKey && !cur()) { S.detailKey = null; renderDetail(); }
}

function scannedRows(games) {
  const prev = new Map(S.rows.map((r) => [r.folder, r]));
  const folderCounts = new Map();
  for (const g of games) {
    const name = baseName(g.folder).toLowerCase();
    folderCounts.set(name, (folderCounts.get(name) || 0) + 1);
  }
  const rows = [];
  for (const g of games) {
    const old = prev.get(g.folder);
    const row = toRow(g, folderCounts.get(baseName(g.folder).toLowerCase()) === 1);
    if (old) {
      row.checked = old.checked;
      row.sgdbId = old.sgdbId;
      row.sgdbName = old.sgdbName;
      row.art = old.art || {};
      row.pendingArt = !!old.pendingArt;
      row.pendingDetails = !!old.pendingDetails;
      row.artApplied = !!old.artApplied;
      row.launchOptions = old.launchOptions || '';
    }
    // No exe, not even a candidate: not a game. Leave it out instead of
    // showing a dead row.
    if (!row.exe && !row.candidates.length) continue;
    if (!row.sgdbName && row.sgdbId) row.sgdbName = '(cached)';
    rows.push(row);
  }
  return rows;
}

function doFindExecutables(context = null) {
  if (context instanceof Event) context = null;
  const roots = (S.cfg.games_roots || []).filter(Boolean);
  if (!roots.length) { toast('Add a games folder first in Settings.'); return; }
  if (S.exePicker) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'exe-picker';
  dialog.setAttribute('aria-labelledby', 'exe-heading');
  dialog.innerHTML = `<h2 id="exe-heading">Find executables</h2>
    <p class="muted">Search added folders up to 10 levels down, including utilities and uninstallers. Select the executables you want to work with in Lib Shammes.</p>
    <p id="exe-summary" role="status" hidden></p>
    <div id="exe-results"></div>
    <div class="modal-foot"><button class="btn sm" id="exe-select-all" hidden>Select all</button>
      <button class="btn sm" id="exe-select-none" hidden>Select none</button><span class="spacer"></span>
      <button class="btn sm" id="exe-cancel">Cancel</button>
      <button class="btn sm primary" id="exe-search">Search</button>
      <button class="btn sm primary" id="exe-add" hidden disabled>Show selected in Lib Shammes</button></div>`;
  document.body.appendChild(dialog);
  S.exePicker = dialog;
  const q = (sel) => dialog.querySelector(sel);
  dialog.addEventListener('close', () => {
    if (S.exePicker === dialog) S.exePicker = null;
    dialog.remove();
  }, { once: true });
  q('#exe-cancel').onclick = () => dialog.close();
  dialog.showModal();
  q('#exe-search').onclick = handleAction('Executable search', async () => {
    const search = q('#exe-search');
    const summary = q('#exe-summary');
    const results = q('#exe-results');
    const add = q('#exe-add');
    const selectAll = q('#exe-select-all');
    const selectNone = q('#exe-select-none');
    search.disabled = true;
    summary.hidden = false;
    summary.textContent = 'Searching…';
    try {
      const claimed = (context ? context.rows : S.rows).filter((r) => r.exe).map((r) => r.exe);
      const { games, truncated } = await window.api.findExecutables({ roots, claimed });
      if (!dialog.open) return;
      summary.textContent = `${games.length} executable(s) found. Already listed executables are excluded.`
        + (truncated ? ' Search limit reached. Search smaller folders to see more results.' : '');
      const selected = new Set();
      const choices = [];
      const updateSelection = () => {
        add.disabled = !selected.size;
        add.textContent = selected.size ? `Show ${selected.size} in Lib Shammes` : 'Show selected in Lib Shammes';
      };
      const fragment = document.createDocumentFragment();
      for (const game of games) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.onchange = () => {
          if (checkbox.checked) selected.add(game); else selected.delete(game);
          updateSelection();
        };
        const name = document.createElement('span');
        name.textContent = game.exePath;
        label.append(checkbox, name);
        fragment.appendChild(label);
        choices.push([checkbox, game]);
      }
      results.replaceChildren(fragment);
      search.hidden = true;
      selectAll.hidden = selectNone.hidden = false;
      selectAll.disabled = selectNone.disabled = !choices.length;
      selectAll.onclick = () => {
        for (const [checkbox, game] of choices) { checkbox.checked = true; selected.add(game); }
        updateSelection();
      };
      selectNone.onclick = () => {
        for (const [checkbox] of choices) checkbox.checked = false;
        selected.clear();
        updateSelection();
      };
      add.hidden = false;
      add.onclick = handleAction('Add executables', async () => {
        if (context) { dialog.close(); await context.add([...selected]); return; }
        await savePatch({ steam_executables: [...(S.cfg.steam_executables || []), ...selected] });
        const known = new Set(S.rows.filter((r) => r.exe).map((r) => r.exe.toLowerCase()));
        let added = 0;
        for (const game of selected) {
          if (known.has(game.exePath.toLowerCase())) continue;
          const row = toRow(game);
          row.checked = false;
          S.rows.push(row);
          known.add(game.exePath.toLowerCase());
          added++;
        }
        dialog.close();
        renderRows();
        log(`Showing ${added} executable(s) in Lib Shammes.`);
        status(`Found ${added} executable(s).`);
        await refreshSteamState();
      });
    } catch (e) {
      summary.textContent = 'Search failed. You can try again.';
      throw e;
    } finally {
      search.disabled = false;
    }
  });
}

async function refreshSteamState(entries) {
  try {
    entries ||= await window.api.steamRead();
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
      r.startDir = hit.startDir || r.startDir;
      r.launchOptions = hit.launchOptions || '';
    }
  }
  renderRows();
  if (S.detailKey) renderDetail();
}

let libraryLoad = null;
let loadedLibraryKey = null;
function libraryKey() {
  return JSON.stringify([S.cfg.games_roots, S.cfg.folder_depths, S.cfg.steam_path, S.cfg.steam_user_id]);
}
function loadLibrary(force = false) {
  if (S.applyingSteam || S.preparingArt) return Promise.resolve();
  const key = libraryKey();
  if (libraryLoad) return libraryLoad.then(() => libraryKey() !== loadedLibraryKey ? loadLibrary() : undefined);
  if (!force && key === loadedLibraryKey) return Promise.resolve();
  libraryLoad = refreshLibrary().then(() => { loadedLibraryKey = key; }).finally(() => { libraryLoad = null; });
  return libraryLoad;
}
function doRefresh() {
  if (S.applyingSteam || S.preparingArt) return Promise.resolve();
  return loadLibrary(true);
}

async function refreshLibrary() {
  const button = $('#btn-refresh');
  button.disabled = true;
  S.loadingLibrary = true;
  S.cardArtCache.clear();
  renderRows();
  try {
    const roots = (S.cfg.games_roots || []).filter(Boolean);
    status('Refreshing library…');
    const [games, entries, installed] = await Promise.all([
      roots.length || S.cfg.steam_executables?.length ? window.api.scanStart({ roots }) : [],
      window.api.steamRead(), window.api.steamGames(),
    ]);
    S.rows = [...scannedRows(games), ...S.rows.filter((r) => r.source !== 'folder')];
    await syncSteamLibrary(entries, installed);
    await refreshSteamState(entries);
    status('Steam library refreshed.');
  } finally {
    S.loadingLibrary = false;
    button.disabled = false;
    renderRows();
  }
}

async function doClear() {
  if (!await confirmDlg('Clear unapplied changes?',
    "Clear changes that haven't been applied to Steam?\n\nNames and launchers already in Steam will be kept. Artwork already written to Steam won't be deleted. Your selection will stay the same.",
    { confirmText: 'Clear' })) return;
  const entries = await window.api.steamRead();
  const byAppid = new Map(entries.map((entry) => [Number(entry.appid), entry]));
  const byExe = new Map(entries.map((entry) => [folderKey(String(entry.exe || '').replace(/^"|"$/g, '')), entry]));
  const patch = Object.fromEntries(['title_map', 'exe_map', 'sgdb_map', 'sgdb_cache', 'steam_launch']
    .map((key) => [key, { ...S.cfg[key] }]));
  const resets = [];
  for (const row of S.rows) {
    delete patch.steam_launch[folderKey(row.folder)];
    if (row.source === 'steam') {
      for (const key of ['sgdb_map', 'sgdb_cache']) delete patch[key][folderKey(row.folder)];
      resets.push([row, { art: {}, sgdbId: null, sgdbName: '', pendingArt: false, pendingDetails: false, artApplied: false }, null]);
      continue;
    }
    const reset = { ...row.defaults, art: {}, sgdbId: null, sgdbName: '', pendingArt: false, pendingDetails: false, artApplied: false };
    const entry = (row.appid != null && byAppid.get(Number(row.appid)))
      || (row.exe && byExe.get(folderKey(row.exe))) || (reset.exe && byExe.get(folderKey(reset.exe)));
    if (entry) {
      reset.display = reset.query = entry.appName;
      reset.exe = String(entry.exe || '').replace(/^"|"$/g, '');
      reset.startDir = String(entry.startDir || '').replace(/^"|"$/g, '') || parentDir(reset.exe);
      if (row.fromExecutableSearch) {
        reset.folder = reset.exe;
        reset.folderName = baseName(reset.startDir);
      }
    }
    for (const map of Object.values(patch)) {
      for (const key of [folderKey(row.folder), folderKey(row.defaults?.folder), row.folderName, row.display, row.defaults?.display]) delete map[key];
    }
    resets.push([row, reset, entry]);
  }
  for (const [row, reset, entry] of resets) {
    if (entry && row.source === 'folder') {
      const folder = reset.folder || row.folder;
      patch.title_map[folderKey(folder)] = reset.display;
      if (!row.fromExecutableSearch) patch.exe_map[folderKey(folder)] = reset.exe.startsWith(folder)
        ? reset.exe.slice(folder.length).replace(/^[\\/]/, '') : baseName(reset.exe);
    }
  }
  await savePatch(patch);
  let detail = cur();
  for (const [row, reset] of resets) Object.assign(row, reset);
  const folderExes = new Set(S.rows.filter((row) => row.source === 'folder' && row.exe).map((row) => folderKey(row.exe)));
  const unique = new Map();
  S.rows = S.rows.filter((row) => {
    const key = row.exe && folderExes.has(folderKey(row.exe)) ? `exe:${folderKey(row.exe)}` : rowKey(row);
    const existing = unique.get(key);
    if (!existing) { unique.set(key, row); return true; }
    existing.checked ||= row.checked;
    if (detail === row) detail = existing;
    return false;
  });
  S.detailKey = detail ? rowKey(detail) : null;
  await refreshSteamState(entries);
  status('Unapplied changes cleared.');
}

function needKey() {
  if (!S.cfg.api_key) {
    toast('Add your SteamGridDB API key first in Settings.');
    return true;
  }
  return false;
}

async function doAutoMatch(selected = checkedRows()) {
  const rows = selected.filter((r) => !r.sgdbId);
  if (!rows.length && selected.length) return;
  if (!rows.length) { toast('Nothing to match - scan a folder first.'); return; }
  if (needKey()) return;
  status(`Auto-matching ${rows.length} games…`);
  log(`Auto-matching ${rows.length} games…`);
  const payload = rows.map((r) => ({
    folder: r.folder, folderName: r.folderName, display: r.display,
    query: r.query, steamAppid: r.steamAppid, sgdbId: r.sgdbId, source: r.source,
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
    source: r.source, shortcutIdx: r.shortcutIdx, appid: r.appid, steamAppid: r.steamAppid,
    launchSettings: S.cfg.steam_launch?.[folderKey(r.folder)],
  };
}

async function writeArtwork(rows, kinds) {
  const result = await window.api.artDownload({
    rows: rows.map(rowPayload),
    kinds,
    onlyMissing: !!S.cfg.only_missing,
    filters: { animated: S.cfg.include_animated, nsfw: S.cfg.include_nsfw, humor: S.cfg.include_humor },
  });
  const byFolder = new Map(result.rows.map((r) => [r.folder, r]));
  for (const r of S.rows) {
    const u = byFolder.get(r.folder);
    if (u) {
      r.art = { ...r.art, ...u.art };
      for (const kind of u.appliedKinds || []) if (!u.art[kind]) delete r.art[kind];
      r.pendingArt = !!u.failedKinds?.length;
      r.artApplied ||= !!u.appliedKinds?.length;
    }
  }
  S.cardArtCache.clear();
  result.lines.forEach(log);
  renderRows();
  if (S.detailKey) renderDetail();
  return result;
}

function reportArtwork({ saved, failed, warning }, success) {
  const message = failed ? `${saved} artwork saved, ${failed} failed. Check the log.`
    : saved ? success : 'No artwork changed. Check the log for skipped images.';
  log(message);
  status(message);
  toast(warning ? `${message} ${warning}` : message);
}

async function doDownloadArt() {
  if (S.preparingArt || S.applyingSteam || S.loadingLibrary || needKey()) return;
  const rows = steamArtworkRows();
  if (!rows.length) return;
  const kinds = wantedKinds();
  if (!kinds.length) { toast('Choose at least one artwork type in Settings.'); return; }
  S.preparingArt = true;
  renderRows();
  try {
    if (rows.some(row => !row.sgdbId)) await doAutoMatch(rows);
    status('Finding artwork…');
    const previous = new Map(rows.map(row => [row, { ...row.art }]));
    const result = await window.api.artPrepare({ rows: rows.filter(row => row.sgdbId).map(rowPayload), kinds });
    for (const updated of result.rows) {
      const row = rows.find(row => row.folder === updated.folder);
      if (row && S.rows.includes(row)) for (const [kind, choice] of Object.entries(updated.art)) {
        if (row.art[kind] === previous.get(row)[kind] && JSON.stringify(choice) !== JSON.stringify(row.art[kind])) {
          row.art[kind] = choice;
          row.pendingArt = true;
        }
      }
    }
    result.lines.forEach(log);
    const message = `${result.prepared} artwork choices ready. Review them, then apply to Steam.`
      + (result.failed ? ` ${result.failed} failed. Check the log.` : '');
    status(message); toast(message);
  } finally { S.preparingArt = false; renderRows(); if (S.detailKey) renderDetail(); }
}

function wantedKinds() {
  return ['wide', 'grid', 'hero', 'logo', 'icon'].filter((k) => S.cfg[`want_${k}`]);
}

// ---------------------------------------------------------- steam add/rm
function canWriteShortcut(row) {
  return !!row.exe && (row.source === 'folder' || (row.source === 'shortcut' && row.managed));
}
function steamApplyRows() {
  const selected = S.bulk ? S.rows.filter(row => row.checked) : [];
  return selected.length ? selected : visibleSteamRows().filter(row => canWriteShortcut(row) || row.source === 'steam' && row.pendingArt);
}
function steamArtworkRows() {
  const selected = S.bulk ? S.rows.filter(row => row.checked) : [];
  return (selected.length ? selected : visibleSteamRows()).filter(row => canWriteShortcut(row) || row.source === 'steam');
}
async function doAddToSteam(targetRows = null) {
  if (S.applyingSteam || S.preparingArt || S.loadingLibrary) return;
  S.applyingSteam = true;
  updateLibrarySelection();
  try { await applyToSteam(targetRows); }
  finally { S.applyingSteam = false; updateLibrarySelection(); }
}
async function applyToSteam(targetRows) {
  const selected = targetRows || steamApplyRows();
  const editing = cur();
  if (selected.includes(editing) && canWriteShortcut(editing)
    && ($('#d-name').value.trim() !== editing.display || $('#d-exe-pick').value.trim() !== editing.exe
      || $('#d-startdir').value.trim() !== (S.cfg.steam_launch?.[folderKey(editing.folder)]?.startDir ?? String(editing.startDir || '').replace(/^"|"$/g, ''))
      || $('#d-args').value !== (S.cfg.steam_launch?.[folderKey(editing.folder)]?.launchOptions ?? editing.launchOptions ?? ''))) {
    if (!await applyDetails()) return;
  }
  const native = selected.filter((r) => r.source === 'steam');
  const nativeArt = native.map((r) => ({ ...r, art: Object.fromEntries(
    Object.entries(r.art || {}).filter(([, art]) => !art.automatic && !art.current)
  ) })).filter((r) => Object.keys(r.art).length);
  const eligible = selected.filter(canWriteShortcut);
  const noExe = selected.filter((r) => !r.exe && r.source !== 'steam');
  if (noExe.length) log(`Skipping ${noExe.length} without exe: ${noExe.slice(0, 5).map((r) => r.display).join(', ')}`);
  if (!eligible.length) {
    if (native.length) {
      if (!nativeArt.length) { toast('Choose artwork first.'); return; }
      if (!await confirmDlg('Apply artwork to Steam', `Apply chosen artwork to ${nativeArt.length} Steam game${nativeArt.length === 1 ? '' : 's'}? Steam will close and reopen if it is running.`)) return;
      status(`Applying artwork to ${nativeArt.length} Steam games…`);
      reportArtwork(await writeArtwork(nativeArt, []), 'Artwork applied to Steam.');
      return;
    }
    toast('No selected games with a .exe.'); return;
  }
  const updates = eligible.filter((row) => row.inSteam && row.managed).length;
  let summary = updates ? `Add ${eligible.length - updates} game(s) and update ${updates} existing Steam shortcut(s)?`
    : `Add ${eligible.length} game(s) to Steam as non-Steam shortcuts?`;
  if (nativeArt.length) summary += '\n\nChosen artwork will also be applied to the selected native Steam games.';
  if (!await confirmDlg('Add to Steam', `${summary}\n\nSteam will close and reopen if it is running.`)) return;
  let autoArt = false;
  let missingArt = false;
  if (S.cfg.api_key) {
    for (const row of eligible) {
      for (const kind of wantedKinds()) {
        if (row.art?.[kind] && !row.art[kind].automatic) continue;
        if (!await window.api.artCurrent({ row: rowPayload(row), kind, existsOnly: true })) {
          missingArt = true;
          break;
        }
      }
      if (missingArt) break;
    }
  }
  if (missingArt) {
    autoArt = await confirmDlg('Artwork',
      'Also find artwork automatically for types you did not choose?',
      { confirmText: 'Find artwork', cancelText: 'Add without artwork' });
  }
  if (autoArt) await doAutoMatch(eligible);
  const kinds = [...new Set([...wantedKinds(), ...eligible.flatMap((r) =>
    Object.keys(r.art).filter((kind) => !r.art[kind].automatic && !r.art[kind].current)
  )])];
  status(`Adding ${eligible.length} games to Steam…`);
  log(`Adding ${eligible.length} games…`);
  try {
    const { rows: back, nativeRows = [], lines, added, updated, artworkSaved, artworkFailed = 0, warning } = await window.api.steamAdd({
      rows: eligible.map(rowPayload),
      nativeRows: nativeArt.map(rowPayload),
      autoArt,
      kinds,
      filters: { animated: S.cfg.include_animated, nsfw: S.cfg.include_nsfw, humor: S.cfg.include_humor },
    });
    const byFolder = new Map(back.map((r) => [r.folder, r]));
    for (const r of S.rows) {
      const u = byFolder.get(r.folder);
      if (u) {
        r.shortcutIdx = u.shortcutIdx;
        r.appid = u.appid;
        r.managed = u.managed;
        if (r.source === 'shortcut') {
          const focused = S.detailKey === rowKey(r);
          r.folder = `shortcut://${u.appid}`;
          if (focused) S.detailKey = rowKey(r);
        }
        r.inSteam = true;
        r.pendingArt = !!u.failedKinds?.length;
        r.pendingDetails = false;
        r.artApplied = !!Object.keys(u.art || {}).length || r.artApplied;
        if (u.art) r.art = u.art;
      }
    }
    await syncCfg();
    S.cardArtCache.clear();
    lines.forEach(log);
    for (const row of nativeRows) {
      const original = S.rows.find(r => r.folder === row.folder);
      if (original) { original.art = row.art; original.pendingArt = !!row.failedKinds?.length; original.artApplied ||= !!row.appliedKinds?.length; }
    }
    renderRows();
    if (S.detailKey) renderDetail();
    const failed = artworkFailed;
    const changed = added + updated + artworkSaved;
    const message = changed || failed ? `${added} added, ${updated} updated, ${artworkSaved} artwork saved.`
      + (failed ? ` ${failed} failed. Check the log.` : '')
      : 'No changes were made. Check the log.';
    log(message);
    status(message);
    toast(warning ? `${message} ${warning}` : message);
  } catch (e) {
    log(`FAILED: ${e.message || e}`);
    toast(`Write failed: ${e.message || e}`);
  }
}

async function doRemoveFromSteam() {
  const rows = checkedRows().filter((r) => r.inSteam
    && (r.source === 'shortcut' || r.managed));
  const skipped = checkedRows().filter((r) => r.source === 'steam');
  if (!rows.length) { toast('None of the checked games are in Steam.'); return; }
  if (skipped.length) log(`Skipping ${skipped.length} Steam store game(s) - those are not shortcuts.`);
  const names = rows.slice(0, 12).map((r) => `• ${r.display}`).join('\n')
    + (rows.length > 12 ? `\n… and ${rows.length - 12} more` : '');
  if (!await confirmDlg('Remove from Steam',
    `Remove ${rows.length} shortcuts?\n\n${names}\n\nArt files are left alone. Steam will close and reopen if it is running.`)) return;
  const { removed, backup, warning } = await window.api.steamRemove({
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
  log(`Removed ${removed} shortcuts. Backup: ${backup || 'none'}.`);
  status(`Removed ${removed}.`);
  if (warning) { log(warning); toast(warning); }
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
    const { restarted, lines } = await window.api.steamRestart();
    lines.forEach(log);
    if (!restarted) { status(lines.at(-1) || 'Steam did not restart.'); return; }
    // Check that steam.exe is running before reporting success.
    let seen = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        if (await window.api.steamRunning()) { seen = true; break; }
      } catch { /* keep polling */ }
    }
    if (seen) {
      status('Steam restarted.');
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
    toast('No stale shortcuts - every game the app added still exists.');
    log('Prune check: nothing stale.');
    return;
  }
  const names = stale.slice(0, 12).map((s) => `• ${s.display}`).join('\n')
    + (stale.length > 12 ? `\n… and ${stale.length - 12} more` : '');
  if (!await confirmDlg('Prune missing games',
    `${stale.length} shortcut(s) the app added point at exes that no longer exist:\n\n${names}\n\nRemove them? Art files are left alone. Steam will close and reopen if it is running.`)) return;
  const { removed, backup, warning } = await window.api.steamRemove({
    rows: stale.map((s) => ({ display: s.display, exe: s.exe })),
  });
  await refreshSteamState();
  await syncSteamLibrary();
  log(`Pruned ${removed} stale shortcuts. Backup: ${backup || 'none'}.`);
  status(`Pruned ${removed}.`);
  if (warning) { log(warning); toast(warning); }
}

let desktopSave = Promise.resolve();
function saveDesktopDraft(row) {
  row.saved = false;
  const draft = Object.fromEntries(['display', 'exe', 'args', 'admin', 'iconChoice', 'sgdbId', 'sgdbName', 'signature']
    .map((key) => [key, row[key]]));
  row.draft = draft;
  desktopSave = desktopSave.catch(() => {}).then(() => savePatch({ desktop_overrides: {
    ...S.cfg.desktop_overrides, [row.id]: draft,
  } }));
  return desktopSave;
}

async function refreshDesktop(force = true) {
  const d = S.desktop;
  if (d.busy) return;
  const key = JSON.stringify([S.cfg.games_roots, S.cfg.folder_depths, S.cfg.desktop_executables, S.cfg.desktop_destination]);
  if (!force && d.loadedKey === key) return;
  if (force) S.cardArtCache.clear();
  d.busy = true;
  renderDesktop();
  try {
    await desktopSave;
    const old = new Map(d.rows.map((row) => [row.id, row]));
    const result = await window.api.desktopScan();
    d.rows = result.rows.map((row) => {
      const previous = old.get(row.id);
      let draft = previous?.draft || S.cfg.desktop_overrides[row.id];
      if (draft?.display === '(cached)' && draft.sgdbName === '(cached)' && row.query) {
        draft = { ...draft, display: row.query, sgdbName: row.query, exe: row.exe, args: row.args };
      }
      const stale = draft && draft.signature !== row.signature;
      const pending = draft && Object.hasOwn(draft, 'args');
      const sameGame = folderKey(draft?.exe || previous?.exe) === folderKey(row.exe);
      const match = stale && sameGame ? { sgdbId: draft.sgdbId, sgdbName: draft.sgdbName } : {};
      return { ...row, ...match, ...(stale ? {} : draft), source: 'desktop', checked: previous?.checked || false,
        draft: stale || !pending ? null : draft, art: draft?.iconChoice && !stale ? { icon: draft.iconChoice } : {},
        saved: !stale && previous?.saved, error: '' };
    });
    result.warnings.forEach(line => log(line, 'desktop'));
    if (!d.rows.some((row) => row.id === d.detail)) d.detail = null;
    d.loadedKey = key;
    status(d.rows.length ? 'Desktop library refreshed.' : 'Add game folders in Settings, then refresh.');
  } finally { d.busy = false; renderDesktop(); }
}

function desktopVisible() {
  const query = $('#desktop-filter').value.toLocaleLowerCase();
  const direction = $('#desktop-sort').value === 'za' ? -1 : 1;
  return S.desktop.rows.filter((row) => (!$('#desktop-hide').checked || !row.shortcut)
    && `${row.display} ${row.exe} ${row.shortcut || ''} ${row.args}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => direction * a.display.localeCompare(b.display, undefined, { sensitivity: 'base', numeric: true }));
}

function desktopSelected() {
  const d = S.desktop;
  const visible = desktopVisible();
  const selected = d.bulk ? visible.filter(row => row.checked) : [];
  return selected.length ? selected : visible.filter(row => row.exe);
}

async function desktopCardCoverSource(row) {
  const choice = row.iconChoice || row.art?.icon;
  if (choice?.exeIcon) return window.api.desktopIcon(row.exe).catch(() => null);
  if (choice?.file) return /\.(exe|dll)$/i.test(choice.file)
    ? window.api.desktopIcon(choice.file, 0).catch(() => null)
    : window.api.artThumbnail(choice.file).catch(() => window.api.artPreviewFile(choice.file).catch(() => null));
  if (choice?.thumb) return { src: choice.thumb, fallback: choice.url };
  if (choice?.url) return choice.url;
  return desktopIconPreview(row).catch(() => null);
}

function renderDesktop(detail = true, rebuildGrid = true) {
  const d = S.desktop;
  const visible = desktopVisible();
  const selected = desktopSelected();
  $('#page-desktop').classList.toggle('bulk-selection', !!d.bulk);
  $('#page-desktop').classList.toggle('details-open', !!d.detail);
  $('#desktop-multiple').setAttribute('aria-pressed', String(!!d.bulk));
  $('#desktop-multiple').disabled = d.busy;
  $('#desktop-destination').value = S.cfg.desktop_destination || 'desktop';
  $('#desktop-destination').disabled = d.busy;
  $('#desktop-add').textContent = S.cfg.desktop_destination === 'start-menu' ? 'Apply to Start menu'
    : S.cfg.desktop_destination === 'both' ? 'Apply shortcuts' : 'Apply to Desktop';
  $('#desktop-count').textContent = `${S.desktop.rows.length} game${S.desktop.rows.length === 1 ? '' : 's'}`;
  const pending = d.rows.filter((row) => !!row.draft).length;
  $('#desktop-pending').hidden = pending === 0;
  $('#desktop-pending').textContent = pending ? `${pending} ready to apply` : '';
  $('#desktop-grid-count').textContent = visible.length === S.desktop.rows.length ? '' : `${visible.length} shown`;
  $('#desktop-selection-count').textContent = `${visible.filter(row => row.checked).length} selected`;
  if (rebuildGrid) {
    const body = $('#desktop-games tbody');
    body.innerHTML = '';
    d.coverObserver?.disconnect();
    const root = $('#page-desktop');
    d.coverObserver = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.isIntersecting) {
          d.coverObserver.unobserve(entry.target);
          loadCardCover(entry.target._desktopRow, entry.target);
        }
      }, { root, rootMargin: '420px 0px' }) : null;
    if (!visible.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty-row';
      tr.innerHTML = `<td><div class="list-empty">${d.busy ? 'Loading Desktop games…' : S.desktop.rows.length ? 'No games match these filters.' : 'Add a game folder in Settings, then refresh.'}</div></td>`;
      body.appendChild(tr);
    }
    for (const row of visible) {
      const state = row.error ? ['Issue', 'issue'] : row.draft ? ['Ready', 'pending']
        : row.saving ? ['Saving…', 'pending'] : row.saved ? ['Applied', '']
          : row.shortcut ? ['Existing', ''] : ['Not added', ''];
      const destination = row.destination === 'start-menu' ? 'Start menu'
        : row.destination === 'both' ? 'Desktop + Start menu' : 'Desktop';
      const token = desktopCoverToken(row);
      const tr = document.createElement('tr');
      tr.className = `game-card-row${row.id === d.detail ? ' sel' : ''}${d.bulk && row.checked ? ' is-checked' : ''}`;
      tr.dataset.key = row.id;
      const subtitle = [baseName(row.exe) || 'No launcher', row.args || ''].filter(Boolean).join(' · ');
      tr.innerHTML = `<td><div class="game-tile"><button class="game-open" type="button" aria-label="Open details for ${esc(row.display)}">
        <div class="cover-wrap desktop-cover-wrap">
          <div class="cover-fallback"><img src="../assets/app-icon.svg" alt=""><span>${esc(initials(row.display))}</span></div>
          <img class="game-cover desktop-cover" data-cover-token="${esc(token)}" alt="Shortcut icon for ${esc(row.display)}" decoding="async" hidden>
        </div>
        <div class="game-card-copy"><span class="game-name" title="${esc(row.display)}">${esc(row.display)}</span>
          <span class="game-meta"><span class="source-label">${esc(destination)}</span><span class="game-state ${state[1]}">${esc(state[0])}</span></span>
          <span class="game-subtitle" title="${esc(`${row.exe || ''}${row.args ? ` · ${row.args}` : ''}`)}">${wrapText(subtitle)}</span></div>
      </button><label class="cover-check" data-act="toggle"><input type="checkbox" class="row-check" aria-label="Select ${esc(row.display)}"${row.checked ? ' checked' : ''}></label></div></td>`;
      tr._desktopRow = row;
      body.appendChild(tr);
      if (d.coverObserver) d.coverObserver.observe(tr);
      else loadCardCover(row, tr);
    }
  }
  for (const tr of $('#desktop-games tbody').querySelectorAll('.game-card-row')) {
    const row = d.rows.find((item) => item.id === tr.dataset.key);
    if (!row) continue;
    tr.classList.toggle('sel', row.id === d.detail);
    tr.classList.toggle('is-checked', !!d.bulk && !!row.checked);
    const checkbox = $('.row-check', tr);
    if (checkbox) checkbox.checked = !!row.checked;
  }
  for (const id of ['desktop-add', 'desktop-refresh', 'desktop-find', 'desktop-download']) $('#' + id).disabled = d.busy;
  $('#desktop-add').disabled ||= !selected.length;
  $('#desktop-download').disabled ||= !S.cfg.api_key || !selected.length;
  $('#desktop-all').checked = !!visible.length && visible.every((row) => row.checked);
  $('#desktop-all').indeterminate = visible.some((row) => row.checked) && !$('#desktop-all').checked;
  $('#desktop-all').disabled = !visible.length || d.busy;
  $('#desktop-games').inert = d.busy && !d.applying;
  for (const id of ['desktop-all', 'desktop-hide']) $('#' + id).disabled = d.busy && !d.applying;
  if (detail) renderDesktopDetail();
  $('#desktop-detail').inert = d.busy && (!d.applying || !!d.rows.find((row) => row.id === d.detail)?.saving);
}

function desktopCoverToken(row) {
  return `desktop:${JSON.stringify([row.id, row.exe, row.icon, row.iconIndex, row.signature, row.iconChoice || row.art?.icon])}`;
}
function desktopIconPreview(row) {
  if (/\.(ico|png|jpe?g|webp|bmp)$/i.test(row.icon || '')) return window.api.artPreviewFile(row.icon);
  if (/\.(exe|dll)$/i.test(row.icon || '')) return window.api.desktopIcon(row.icon, row.iconIndex || 0);
  return window.api.desktopIcon(row.icon ? row.shortcut || row.icon : row.exe);
}

function localArtPreview(file) {
  return /\.(exe|dll)$/i.test(file) ? window.api.desktopIcon(file, 0) : window.api.artPreviewFile(file);
}

function renderDesktopDetail() {
  const d = S.desktop;
  const row = d.rows.find((item) => item.id === d.detail);
  const host = $('#desktop-detail');
  if (!row) { host.innerHTML = '<button class="text-btn detail-close" id="desktop-detail-close" type="button">Back to games</button><div class="detail-empty"><h2>Select a game</h2><p>Review its shortcut name, launcher and icon.</p></div>'; return; }
  const exes = [...new Set([row.exe, ...(row.candidates || []).map((item) => item.path)])];
  host.innerHTML = `<button class="text-btn detail-close" id="desktop-detail-close" type="button">Back to games</button>
    <div class="det-head"><button class="cover-button" data-desktop="icon" title="Choose icon"><img class="desktop-icon" alt="Shortcut icon"><span class="cover-edit">Change icon</span></button>
      <div class="det-titles"><div class="page-kicker">${esc(row.destination === 'start-menu' ? 'START MENU' : 'DESKTOP SHORTCUT')}</div><h2>${esc(row.display)}</h2>
      <div class="detail-state${row.draft ? ' pending' : ''}" role="status">${row.error ? esc(row.error) : row.draft ? 'Ready to apply' : row.saved ? 'Applied this session' : row.shortcut ? 'Existing shortcut' : 'Not added yet'}</div>
      <button class="btn primary" id="desktop-detail-apply" type="button" ${d.busy ? 'disabled' : ''}>${S.cfg.desktop_destination === 'start-menu' ? 'Apply to Start menu' : S.cfg.desktop_destination === 'both' ? 'Apply shortcuts' : 'Apply to Desktop'}</button></div></div>
    <label class="fld"><span>Shortcut name</span><input type="text" data-field="display" value="${esc(row.display)}"></label>
    <label class="field-label" for="desktop-exe">Launcher</label><div class="control-combo"><select id="desktop-exe" data-field="exe" title="${esc(row.exe)}">${exes.map((exe) => `<option value="${esc(exe)}" ${exe === row.exe ? 'selected' : ''}>${esc(baseName(exe))}</option>`).join('')}</select>
    <button class="btn sm" data-desktop="browse" type="button">Browse</button></div>
    <label class="fld"><span>Launch arguments</span><input type="text" data-field="args" value="${esc(row.args)}"></label>
    <label class="check desktop-admin"><input type="checkbox" data-field="admin" ${row.admin ? 'checked' : ''}> Run as administrator</label>
    <div class="status-line">${esc(row.error || row.shortcut || '')}</div>
    <section class="detail-section"><div class="section-head match-head"><h3>Game match</h3>
    <span class="match-status${row.sgdbId ? ' ok' : ''}" role="status">${row.sgdbId ? `${esc(row.sgdbName || '(cached)')} · ${row.sgdbId}` : 'Not matched'}</span></div>
    ${S.cfg.api_key ? '' : '<p class="muted small">Matching requires SGDB API key.</p>'}
    <div class="control-combo"><input type="text" data-desktop="query" value="${esc(row.display)}" placeholder="Search SteamGridDB" aria-label="Search SteamGridDB" autocomplete="off"><button class="btn sm" data-desktop="search" ${S.cfg.api_key ? '' : 'disabled'}>Search</button></div>
    <div class="control-combo match-results"><select data-desktop="matches" aria-label="SteamGridDB search results"><option value="">Search for a game first</option></select><button class="btn sm" data-desktop="use" disabled>Use match</button></div>
    <button class="text-btn auto-match" data-desktop="auto" ${S.cfg.api_key ? '' : 'disabled'}>Match automatically</button></section>`;
  const image = $('.desktop-icon', host);
  image.onload = () => image.classList.add('loaded');
  image.onerror = () => { image.classList.remove('loaded'); log(`Icon preview could not load: ${row.display}`, 'desktop'); };
  const choice = row.iconChoice;
  const preview = choice?.file ? localArtPreview(choice.file)
    : choice?.url ? Promise.resolve(choice.thumb || choice.url)
      : choice?.exeIcon ? window.api.desktopIcon(row.exe) : desktopIconPreview(row);
  preview.then((src) => { if (image.isConnected) image.src = src; }).catch((e) => { log(`Icon preview: ${e.message}`, 'desktop'); });
  $('#desktop-detail-apply', host).onclick = handleAction('Add to Desktop', () => applyDesktopShortcuts([row]));
  for (const input of $$('[data-field]', host)) input.onchange = handleAction('Save Desktop changes', async () => {
    row[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
    if (input.dataset.field === 'display') $('h2', host).textContent = row.display;
    await saveDesktopDraft(row);
    renderDesktop(input.dataset.field === 'exe');
  });
  $('[data-desktop="icon"]', host).onclick = () => openArtModal(row, 'icon');
  $('[data-desktop="browse"]', host).onclick = handleAction('Choose launcher', async () => {
    const exe = await window.api.filesPickExe(parentDir(row.exe));
    if (exe) { row.exe = exe; await saveDesktopDraft(row); renderDesktop(); }
  });
  let searchToken = 0;
  $('[data-desktop="search"]', host).onclick = handleAction('Game search', async () => {
    const token = ++searchToken;
    $('[data-desktop="use"]', host).disabled = true;
    let matches;
    try { matches = await window.api.sgdbSearch($('[data-desktop="query"]', host).value); }
    catch (e) { if (token === searchToken && host.contains(image)) throw e; return; }
    if (token !== searchToken || !host.contains(image)) return;
    const select = $('[data-desktop="matches"]', host);
    select.innerHTML = matches.map((match) => `<option value="${match.id}">${esc(match.name)}</option>`).join('');
    const use = $('[data-desktop="use"]', host);
    use.disabled = !matches.length;
    use.onclick = handleAction('Use match', async () => {
      const match = matches.find((item) => item.id === Number(select.value));
      if (!match) return;
      row.display = match.name; row.sgdbId = match.id; row.sgdbName = match.name;
      await saveDesktopDraft(row); renderDesktop();
    });
  });
  $('[data-desktop="query"]', host).onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) $('[data-desktop="search"]', host).click(); };
  $('[data-desktop="auto"]', host).onclick = handleAction('Match Desktop game', async () => {
    const result = await window.api.matchAuto({ rows: [{ ...row }], force: true, persist: false });
    if (!host.contains(image)) return;
    const match = result.rows[0];
    if (match?.sgdbId) {
      row.sgdbId = match.sgdbId; row.display = row.sgdbName = match.sgdbName;
      await saveDesktopDraft(row); renderDesktop();
    }
    result.lines.forEach(line => log(line, 'desktop'));
  });
}

async function renderDesktopIconChoices() {
  const m = S.modal;
  const exe = await window.api.desktopIcon(m.row.exe);
  if (S.modal !== m) return;
  const slot = $('#art-stock');
  slot.hidden = false;
  slot.replaceChildren(artThumb({ url: exe, width: 256, height: 256 }, 'Executable icon', { exeIcon: true, current: !m.row.icon }));
  const choice = m.row.iconChoice;
  const url = choice?.file ? await localArtPreview(choice.file) : choice?.url
    || (m.row.icon ? await desktopIconPreview(m.row) : null);
  if (S.modal !== m || !url || choice?.exeIcon) return;
  const current = $('#art-choice');
  current.hidden = false;
  current.replaceChildren(artThumb({ ...choice, url, width: 256, height: 256 }, 'Current icon', choice || { current: true, keepIcon: true }));
  $$('#art-grid > .thumb').forEach((cell) => { cell.hidden = cell._broken || sameArtwork(choice, cell._art); });
}

function wireDesktop() {
  $('#desktop-destination').onchange = handleAction('Change shortcut destination', async () => {
    await savePatch({ desktop_destination: $('#desktop-destination').value });
    await refreshDesktop();
  });
  $('#desktop-refresh').onclick = handleAction('Refresh Desktop', refreshDesktop);
  $('#desktop-find').onclick = () => doFindExecutables({ rows: S.desktop.rows, add: async (games) => {
    await savePatch({ desktop_executables: [...(S.cfg.desktop_executables || []), ...games] });
    await refreshDesktop();
  } });
  $('#desktop-filter').addEventListener('input', () => renderDesktop(false));
  $('#desktop-hide').addEventListener('change', () => renderDesktop(false));
  $('#desktop-sort').addEventListener('change', () => renderDesktop(false));
  $('#desktop-all').onchange = (e) => { desktopVisible().forEach((row) => { row.checked = e.target.checked; }); renderDesktop(false, false); };
  $('#desktop-multiple').onclick = () => {
    const d = S.desktop;
    d.bulk = !d.bulk;
    if (d.bulk) d.rows.forEach(row => { row.checked = row.id === d.detail; });
    renderDesktop(false, false);
  };
  $('#desktop-games tbody').onclick = (e) => {
    const card = e.target.closest('.game-card-row');
    const row = S.desktop.rows.find((item) => item.id === card?.dataset.key);
    if (!row) return;
    if (e.target.closest('[data-act="toggle"]')) {
      if (!e.target.matches('.row-check')) return;
      row.checked = e.target.checked;
      renderDesktop(false, false);
    }
    else { S.desktop.detail = row.id; renderDesktop(true, false); }
  };
  $('#desktop-games tbody').ondblclick = (e) => {
    if (S.desktop.busy || !e.target.closest('.cover-wrap')) return;
    const row = S.desktop.rows.find(item => item.id === e.target.closest('.game-card-row')?.dataset.key);
    if (row) openArtModal(row, 'icon');
  };
  $('#desktop-detail').addEventListener('click', (e) => {
    if (!e.target.closest('#desktop-detail-close')) return;
    S.desktop.detail = null;
    renderDesktop(false, false);
    renderDesktopDetail();
  });
  $('#desktop-download').onclick = handleAction('Find Desktop icons', async () => {
    const d = S.desktop;
    if (d.busy) return;
    d.busy = true; renderDesktop(false);
    try {
      const selected = desktopSelected();
      const missing = selected.filter(row => !row.sgdbId);
      if (missing.length) {
        const matched = await window.api.matchAuto({ rows: missing.map(row => ({ ...row })), persist: false });
        for (let i = 0; i < missing.length; i++) if (matched.rows[i]?.sgdbId) {
          missing[i].sgdbId = matched.rows[i].sgdbId;
          missing[i].display = missing[i].sgdbName = matched.rows[i].sgdbName;
          await saveDesktopDraft(missing[i]);
        }
        matched.lines.forEach(line => log(line, 'desktop'));
      }
      const results = await window.api.desktopDownload(selected);
      for (const result of results) {
        const row = d.rows.find((item) => item.id === result.id);
        if (result.skipped) { log(`${row.display}: ${result.skipped}`, 'desktop'); continue; }
        if (result.error) { log(`${row.display}: ${result.error}`, 'desktop'); continue; }
        row.iconChoice = result.choice; row.art = { icon: result.choice };
        await saveDesktopDraft(row);
        log(`${row.display}: SGDB icon #${result.choice.id} downloaded.`, 'desktop');
      }
      status(`${results.filter((result) => result.choice).length} icon(s) downloaded; ${results.filter((result) => result.skipped).length} skipped; ${results.filter((result) => result.error).length} failed.`);
    } finally { d.busy = false; renderDesktop(); }
  });
  $('#desktop-add').onclick = handleAction('Add to Desktop', () => applyDesktopShortcuts());
}

async function applyDesktopShortcuts(rowsOverride = null) {
  const d = S.desktop;
  if (d.busy) return;
  d.busy = true; renderDesktop(false);
  try {
    await desktopSave;
    const rows = rowsOverride || desktopSelected();
    if (!rows.length) return;
    const updates = rows.filter((row) => row.shortcut).length;
    const title = rowsOverride ? $('#desktop-detail-apply')?.textContent || $('#desktop-add').textContent : $('#desktop-add').textContent;
    if (!await confirmDlg(title, `Create ${rows.length - updates} shortcut(s) and update ${updates} existing shortcut(s)?`)) return;
    d.applying = true;
    rows.forEach((row) => { row.saving = true; });
    renderDesktop(false);
    const results = await window.api.desktopApply(rows);
    await syncCfg();
    for (const result of results) {
      const row = d.rows.find((item) => item.id === result.id);
      if (result.ok || result.refreshed) {
        if (d.detail === row.id) d.detail = result.row?.id || null;
        if (result.row) Object.assign(row, result.row, { draft: null, art: {}, error: '', saved: result.ok, checked: row.checked });
        else d.rows = d.rows.filter(item => item !== row);
      } else row.error = result.error;
      log(`${row.display}: ${result.ok ? 'Shortcut saved.' : result.error}`, 'desktop');
      if (result.warning) log(result.warning, 'desktop');
    }
    const refreshed = results.filter((result) => result.refreshed).length;
    status(`${results.filter((result) => result.ok).length} shortcut(s) saved; ${results.filter((result) => !result.ok && !result.refreshed).length} failed.`);
    if (refreshed) toast('Shortcut refreshed. Review changes and apply again.');
  } finally {
    d.busy = false; d.applying = false;
    d.rows.forEach((row) => { row.saving = false; });
    renderDesktop();
  }
}

// ------------------------------------------------------- artwork modal
const ART_TABS = [['wide', 'Wide Capsule'], ['grid', 'Vertical Grid'], ['hero', 'Hero'], ['logo', 'Logo'], ['icon', 'Icon']];
const modalTabs = () => S.modal?.row.source === 'desktop' ? [['icon', 'Icon']] : [...ART_TABS, ['manage', 'Manage']];
let artModalMotion = 0;

function animateArtModal(open) {
  const overlay = $('#art-overlay');
  const modal = $('#art-modal');
  const motion = ++artModalMotion;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const opacity = overlay.hidden || reduced ? 0 : getComputedStyle(overlay).opacity;
  const transform = overlay.hidden || reduced ? 'translateY(8px) scale(.99)' : getComputedStyle(modal).transform;
  overlay.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
  overlay.inert = !open;
  if (reduced) {
    overlay.hidden = !open;
    return;
  }
  overlay.hidden = false;
  const options = { duration: open ? 240 : 150, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' };
  const animations = [
    overlay.animate([{ opacity }, { opacity: open ? 1 : 0 }], options),
    modal.animate([{ transform }, { transform: open ? 'none' : 'translateY(4px) scale(.99)' }], options),
  ];
  Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    if (motion !== artModalMotion) return;
    overlay.hidden = !open;
    animations.forEach(animation => animation.cancel());
  });
}

function pickerFilters(kind) {
  return { static: true, animated: !!S.cfg.include_animated, untagged: true,
    nsfw: !!S.cfg.include_nsfw, humor: !!S.cfg.include_humor, epilepsy: true,
    ...S.cfg.artwork_filters?.[kind], ...(S.modal?.row.source === 'desktop' ? { static: true, animated: false } : {}) };
}

function artworkCacheKey(m) {
  return `${m.sgdbId}:${m.tab}:${JSON.stringify(pickerFilters(m.tab))}`;
}

function renderArtFilters() {
  const m = S.modal;
  if (!m) return;
  const kind = m.tab;
  $('#art-filters').hidden = kind === 'manage';
  $('#art-clear').hidden = m.row.source === 'desktop' || kind === 'manage';
  $('#art-clear').textContent = m.row.source === 'steam' || m.row.inSteam ? 'Restore default' : 'Clear selection';
  $('#art-file').hidden = kind === 'manage';
  $('#art-url').hidden = m.row.source === 'desktop' || kind === 'manage';
  if (kind === 'manage') return;
  const values = pickerFilters(kind);
  const styles = kind === 'logo' ? ['official', 'white', 'black', 'custom']
    : kind === 'icon' ? ['official', 'custom']
    : ['alternate', ...(kind === 'hero' ? [] : ['white_logo', 'no_logo']), 'blurred', 'material'];
  const dimensions = kind === 'grid' ? ['600x900', '342x482', '660x930', '512x512', '1024x1024']
    : kind === 'wide' ? ['460x215', '920x430', '512x512', '1024x1024']
    : kind === 'hero' ? ['1920x620', '3840x1240', '1600x650']
    : kind === 'icon' ? [1024, 768, 512, 310, 256, 194, 192, 180, 160, 152, 150, 144, 128, 120, 114,
      100, 96, 90, 80, 76, 72, 64, 60, 57, 56, 54, 48, 40, 35, 32, 28, 24, 20, 16, 14, 10, 8].map(String) : [];
  const formats = kind === 'icon' ? ['image/png', 'image/vnd.microsoft.icon']
    : kind === 'logo' ? ['image/png', 'image/webp'] : ['image/png', 'image/jpeg', 'image/webp'];
  const labels = { static: 'Static', animated: 'Animated', untagged: 'Untagged', nsfw: 'Adult Content',
    humor: 'Humor', epilepsy: 'Epilepsy', material: 'Minimal', white_logo: 'White Logo', no_logo: 'No Logo',
    'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/vnd.microsoft.icon': 'ICO' };
  const groups = [['Types', null, ['static', 'animated']], ['Tags', null, ['untagged', 'nsfw', 'humor', 'epilepsy']],
    ['Styles', 'styles', styles], ['File types', 'mimes', formats], ['Dimensions', 'dimensions', dimensions]];
  const host = $('#art-filter-fields');
  host.innerHTML = groups.filter(([, , options]) => options.length).map(([title, field, options]) =>
    `<fieldset${field === 'dimensions' ? ' class="filter-dimensions"' : ''}><legend>${title}</legend>${options.map(value => {
      const selected = field ? values[field]?.includes(value) ?? (field !== 'dimensions' || kind === 'icon' || !value.includes('512') && !value.includes('1024')) : values[value];
      const label = field === 'dimensions' && kind === 'icon' ? `${value}x${value}` : labels[value] || value.charAt(0).toUpperCase() + value.slice(1);
      return `<label class="check"><input type="checkbox" data-filter="${field || value}" value="${value}" ${selected ? 'checked' : ''}
        ${m.row.source === 'desktop' && ['static', 'animated'].includes(value) ? 'disabled' : ''}>${label}</label>`;
    }).join('')}</fieldset>`).join('');
  host.onchange = event => handleAction('Artwork filters', async () => {
    const inputs = [...event.target.closest('fieldset').querySelectorAll('input')];
    if (!inputs.some(input => input.checked) && ['static', 'animated'].includes(event.target.dataset.filter)) {
      inputs.find(input => input !== event.target).checked = true;
    }
    const next = { ...values };
    for (const input of host.querySelectorAll('input')) {
      const field = input.dataset.filter;
      if (['styles', 'mimes', 'dimensions'].includes(field)) {
        next[field] = [...host.querySelectorAll(`input[data-filter="${field}"]:checked`)].map(node => node.value);
      } else next[field] = input.checked;
    }
    await savePatch({ artwork_filters: { ...S.cfg.artwork_filters, [kind]: next } });
    if (S.modal !== m || m.tab !== kind) return;
    await loadArtTabs();
  })();
  $('#art-filter-reset').onclick = handleAction('Reset filters', async () => {
    const filters = { ...S.cfg.artwork_filters, [kind]: { nsfw: pickerFilters(kind).nsfw } };
    await savePatch({ artwork_filters: filters });
    if (S.modal !== m || m.tab !== kind) return;
    renderArtFilters();
    await loadArtTabs();
  });
}

async function openArtModal(row, focusKind) {
  S.modal = {
    row, tab: focusKind || 'grid',
    returnFocus: document.activeElement,
    sgdbId: row.sgdbId || null,
    cache: {},           // `${sgdbId}:${kind}` -> items
    current: {},
    stock: {},
    sel: { ...(row.art || {}) },
    games: [],
  };
  $('#art-title').textContent = `Artwork - ${row.display}`;
  const writesSteam = row.source !== 'desktop' && (row.source === 'steam' || row.inSteam);
  $('#art-apply').textContent = writesSteam ? 'Apply to Steam' : 'Apply selection';
  $('#art-apply-note').textContent = writesSteam
    ? 'Steam closes while artwork is applied, then reopens if it was running.'
    : 'Select images, then apply your choices.';
  $('#art-url').hidden = row.source === 'desktop';
  $('#art-clear').hidden = row.source === 'desktop';
  $('#art-q').value = row.query || row.display;
  $('#art-id').value = row.sgdbId || '';
  $('#art-games').innerHTML = '';
  for (const id of ['art-q', 'art-search', 'art-games', 'art-id', 'art-load']) $('#' + id).disabled = !S.cfg.api_key;
  $('#art-url-entry').hidden = true;
  closeArtPreview();
  $('#art-grid').replaceChildren();
  renderArtTabs();
  renderArtFilters();
  animateArtModal(true);
  if (row.source !== 'desktop') {
    const m = S.modal;
    window.api.artLogoPosition(rowPayload(row)).then(position => {
      if (S.modal !== m || m.logoPosition !== undefined) return;
      m.initialLogoPosition = position;
      renderLogoPosition();
    }).catch(e => log(`Logo position: ${e.message}`));
  }
  const focusTarget = $('#art-q').disabled ? $('#art-file') : $('#art-q');
  focusTarget.focus({ preventScroll: true });
  if (!S.cfg.api_key || !row.sgdbId) renderArtGrid();
  if (!S.cfg.api_key) artStatus(row.source === 'desktop'
    ? 'Choose an executable icon or a local image.'
    : 'Choose local artwork, or add an API key for online search.');
  else if (row.sgdbId) loadArtTabs();
  else if (row.source === 'steam') {
    const m = S.modal;
    artStatus('Matching Steam AppID…');
    const game = await window.api.sgdbBySteam(row.steamAppid).catch(() => null);
    if (S.modal !== m) return;
    if (game) {
      m.sgdbId = game.id;
      m.games = [game];
      $('#art-id').value = game.id;
      await loadArtTabs();
    } else await artSearch();
  } else await artSearch();
}

function closeArtModal(save) {
  const m = S.modal;
  if (!m || m.applying) return;
  m.moreObserver?.disconnect();
  if (m.previewLoader) m.previewLoader.src = '';
  $('#art-url-entry').hidden = true;
  S.modal = null;
  animateArtModal(false);
  if (save) {
    if (m.row.source === 'desktop') {
      m.row.iconChoice = m.sel.icon || null;
      m.row.art = { ...m.sel };
      m.row.pendingArt = true;
      const match = m.games.find((game) => game.id === m.sgdbId);
      if (match && m.sgdbId !== m.row.sgdbId) { m.row.display = m.row.sgdbName = match.name; }
      m.row.sgdbId = m.sgdbId;
      handleAction('Save Desktop changes', () => saveDesktopDraft(m.row))();
      renderDesktop();
      restoreArtFocus(m);
      return;
    }
    if (m.sgdbId && m.sgdbId !== m.row.sgdbId) {
      m.row.sgdbId = m.sgdbId;
      m.row.sgdbName = m.games.find((game) => game.id === m.sgdbId)?.name || '(picked)';
      S.cfg.sgdb_map[folderKey(m.row.folder)] = m.sgdbId;
      savePatch({ sgdb_map: S.cfg.sgdb_map });
    }
    const artworkChanged = JSON.stringify(m.row.art || {}) !== JSON.stringify(m.sel || {});
    m.row.art = { ...m.sel };
    if (artworkChanged) m.row.pendingArt = true;
    S.cardArtCache.delete(coverToken(m.row));
    renderRows();
    renderDetail();
    log(`'${m.row.display}': artwork selection updated.`);
  }
  restoreArtFocus(m);
}

async function applyArtModal() {
  const m = S.modal;
  if (!m || m.applying) return;
  if (m.row.source === 'desktop' || !m.row.inSteam && m.row.source !== 'steam') {
    closeArtModal(true);
    return;
  }
  const changed = Object.fromEntries(Object.entries(m.sel).filter(([kind, image]) =>
    JSON.stringify(image) !== JSON.stringify(m.row.art?.[kind])));
  if (!Object.keys(changed).length && m.logoPosition === undefined) { closeArtModal(true); return; }
  m.applying = true;
  $('#art-apply').disabled = true;
  $('#art-modal').inert = true;
  try {
    const payload = { ...rowPayload(m.row), sgdbId: m.sgdbId, art: changed,
      ...(m.logoPosition !== undefined ? { logoPosition: m.logoPosition } : {}) };
    const result = await window.api.artDownload({ rows: [payload], kinds: [], onlyMissing: false });
    result.lines.forEach(line => log(line, 'library'));
    const applied = result.rows[0]?.art || {};
    m.row.art ||= {};
    for (const kind of result.rows[0]?.appliedKinds || []) {
      if (applied[kind]) m.row.art[kind] = applied[kind];
      else delete m.row.art[kind];
    }
    m.row.artApplied ||= result.saved > 0;
    S.cardArtCache.clear();
    S.previewCache = {};
    renderRows(); renderDetail();
    if (result.rows[0]?.logoPositionApplied) { m.initialLogoPosition = m.logoPosition; delete m.logoPosition; }
    if (result.failed) {
      for (const kind of result.rows[0]?.appliedKinds || []) {
        if (m.row.art[kind]) m.sel[kind] = m.row.art[kind];
        else delete m.sel[kind];
      }
      artStatus('Some artwork could not be applied. Check the log and try again.');
      return;
    }
    m.sel = { ...m.row.art };
    m.row.pendingArt = false;
    await syncCfg();
    m.applying = false;
    closeArtModal(true);
    reportArtwork(result, 'Artwork applied to Steam.');
  } finally {
    m.applying = false;
    $('#art-apply').disabled = false;
    $('#art-modal').inert = false;
  }
}

function renderLogoPosition() {
  const m = S.modal;
  $('#art-logo-position').hidden = !m || m.row.source === 'desktop' || m.tab !== 'logo';
  const position = m?.logoPosition !== undefined ? m.logoPosition : m?.initialLogoPosition;
  $('#art-logo-anchor').value = position?.pinnedPosition || 'BottomLeft';
  $('#art-logo-width').value = position?.nWidthPct || 50;
  $('#art-logo-height').value = position?.nHeightPct || 50;
}

function restoreArtFocus(m) {
  const target = m.returnFocus?.isConnected ? m.returnFocus
    : m.row.source === 'desktop' ? $('#desktop-detail [data-desktop="icon"]')
      : $('#d-preview-open');
  if (target?.isConnected) target.focus({ preventScroll: true });
}

function artStatus(t) { $('#art-status').textContent = t; }

function renderArtTabs() {
  const m = S.modal;
  const host = $('#art-tabs');
  renderLogoPosition();
  host.innerHTML = '';
  for (const [kind, label] of modalTabs()) {
    const b = document.createElement('button');
    b.className = `tab${m.tab === kind ? ' on' : ''}`;
    b.textContent = label;
    const picked = m.sel[kind];
    if (picked) b.textContent += ' ★';
    b.addEventListener('click', () => { $('#art-url-entry').hidden = true; m.tab = kind; renderArtTabs(); renderArtFilters(); loadArtTabs(); });
    host.appendChild(b);
  }
  $$('#art-grid .thumb').forEach((cell) => {
    const picked = isPicked(m.tab, cell._art);
    cell.classList.toggle('picked', picked);
    $('.thumb-select', cell)?.setAttribute('aria-pressed', String(picked));
  });
}

function closeArtPreview() {
  const wasOpen = !$('#art-preview').hidden;
  if (S.modal) {
    S.modal.previewItem = null;
    if (S.modal.previewLoader) S.modal.previewLoader.src = '';
    S.modal.previewLoader = null;
  }
  $('#art-preview').hidden = true;
  $('#art-grid').hidden = false;
  $('#art-preview-image').removeAttribute('src');
  if (wasOpen) $('.thumbScroll').scrollTop = S.modal?.galleryScroll || 0;
}

async function openArtPreview(item) {
  const m = S.modal;
  const kind = m.tab;
  if (!item) return;
  const src = item.thumb || item.url || (item.file ? await localArtPreview(item.file) : null);
  if (S.modal !== m || m.tab !== kind) return;
  m.previewItem = item;
  m.galleryScroll = $('.thumbScroll').scrollTop;
  $('#art-preview').hidden = false;
  $('#art-grid').hidden = true;
  $('.thumbScroll').scrollTop = 0;
  $('#art-preview-image').src = src;
  if (item.thumb && item.url && item.thumb !== item.url) {
    const full = new Image();
    m.previewLoader = full;
    full.decoding = 'async';
    full.src = item.url;
    artStatus('Loading full-size artwork…');
    full.decode().then(() => {
      if (S.modal !== m || m.previewItem !== item) return;
      $('#art-preview-image').src = item.url;
      m.previewLoader = null;
      artStatus('Full-size artwork loaded.');
    }).catch(() => {
      if (S.modal === m && m.previewItem === item) artStatus('Full-size image could not load. Showing the preview.');
    });
  }
}

function filters() {
  return { animated: S.cfg.include_animated, nsfw: S.cfg.include_nsfw, humor: S.cfg.include_humor };
}

async function loadArtTabs(more = false) {
  const m = S.modal;
  if (!m) return;
  if (m.tab === 'manage') { await renderArtManage(); return; }
  if (!m.sgdbId || !S.cfg.api_key) { renderArtGrid(); return; }
  const { sgdbId, tab: kind } = m;
  const key = artworkCacheKey(m);
  const page = m.cache[key] ||= { items: [], next: 0, more: true, pending: null };
  const start = more ? page.items.length : 0;
  if (!more && (!page.next || page.pending)) renderArtGrid(true);
  if (more && (!page.more || page.pending)) return;
  if (!page.next || more || page.pending) {
    artStatus(`Loading artwork for SGDB ${sgdbId}…`);
    if ($('#art-more')) $('#art-more').disabled = true;
  }
  try {
    if (!page.pending && (!page.next || more)) {
      page.pending = window.api.artList({ sgdbId, kind, page: page.next,
        filters: pickerFilters(kind) })
        .then(items => {
          const urls = new Set(page.items.map(item => item.url));
          page.items.push(...items.filter(item => !urls.has(item.url)));
          page.next++;
          page.more = items.length === 30;
        }).finally(() => { page.pending = null; });
    }
    await page.pending;
    if (S.modal !== m || artworkCacheKey(m) !== key) return;
    artStatus(`SGDB ${sgdbId}: ${page.items.length} images. Click to select per type.`);
    renderArtGrid(false, start);
  } catch (e) {
    if (S.modal !== m || artworkCacheKey(m) !== key) return;
    artStatus(`Load failed: ${e.message || e}`);
    if ($('#art-more')) $('#art-more').disabled = false;
  }
}

function sameArtwork(a, b) {
  return !!(a && b && ((a.file && a.file === b.file) || (a.url && a.url === b.url)
    || (a.exeIcon && b.exeIcon) || (a.keepIcon && b.keepIcon)));
}

async function stockArtwork(m, kind) {
  m.stock[kind] ||= window.api.artCurrent({ row: rowPayload(m.row), kind, stock: true })
    .then(current => current || (m.row.source === 'steam' ? window.api.artOfficial({ row: rowPayload(m.row), kind }) : null))
    .catch(e => { log(`Stock artwork: ${e.message}`); return null; });
  return m.stock[kind];
}

async function renderArtManage() {
  const m = S.modal;
  m.moreObserver?.disconnect();
  closeArtPreview();
  const grid = $('#art-grid');
  grid.replaceChildren();
  artStatus('Review artwork by type. Restore removes custom artwork when you apply.');
  await Promise.all(ART_TABS.map(async ([kind, label]) => {
    const cell = document.createElement('div');
    cell.className = 'manage-artwork';
    cell.innerHTML = `<strong>${label}</strong><img alt="${esc(label)}" hidden><span class="muted small">Loading…</span>
      <div class="row"><button class="btn sm" data-manage="change">Change</button><button class="btn sm" data-manage="restore">${m.row.source === 'steam' || m.row.inSteam ? 'Restore default' : 'Clear selection'}</button></div>`;
    grid.appendChild(cell);
    $('[data-manage="change"]', cell).onclick = () => { m.tab = kind; renderArtTabs(); renderArtFilters(); loadArtTabs(); };
    $('[data-manage="restore"]', cell).onclick = () => {
      restoreArtKind(kind);
      $('span', cell).textContent = m.sel[kind]?.reset ? 'Default artwork will be restored.' : 'Selection cleared.';
      renderArtTabs();
    };
    const choice = m.sel[kind];
    const current = choice?.reset ? await stockArtwork(m, kind)
      : choice?.file || choice?.url ? choice : await window.api.artCurrent({ row: rowPayload(m.row), kind }).catch(() => null);
    if (S.modal !== m || m.tab !== 'manage' || !cell.isConnected) return;
    $('span', cell).textContent = choice?.reset ? 'Default artwork will be restored.'
      : choice && !choice.appliedFile ? 'Selected artwork' : current ? 'Current artwork' : 'No custom artwork';
    if (current) {
      const image = $('img', cell);
      image.onload = () => { image.hidden = false; };
      image.onerror = () => { image.hidden = true; $('span', cell).textContent = 'Preview could not load.'; };
      image.src = current.thumb || current.url || await localArtPreview(current.file).catch(() => null) || '';
    }
  }));
}

function isPicked(kind, item) {
  const choice = S.modal.sel[kind];
  return choice ? sameArtwork(choice, item) : !!item.current;
}

async function renderArtChoice() {
  const m = S.modal;
  const kind = m.tab;
  const current = await m.current[kind];
  const stock = await m.stock[kind];
  if (S.modal !== m || m.tab !== kind) return;
  const choice = m.row.art[kind];
  const applied = current && (!choice || choice.file === current.file || choice.appliedFile === current.file);
  const item = applied ? current : choice || current;
  const url = item?.url || (item?.file ? await window.api.artPreviewFile(item.file).catch((e) => {
    log(`Artwork preview failed for ${item.file}: ${e.message || e}`);
    return null;
  }) : null);
  if (S.modal !== m || m.tab !== kind || m.row.art[kind] !== choice) return;
  const slot = $('#art-choice');
  if (!slot) return;
  const stockSlot = $('#art-stock');
  stockSlot.hidden = !stock;
  stockSlot.replaceChildren(...(stock ? [artThumb(stock, 'Stock Steam artwork', { file: stock.file, current: !choice && sameArtwork(stock, current) })] : []));
  slot.hidden = !item || sameArtwork(stock, item);
  slot.replaceChildren(...(item && !sameArtwork(stock, item) ? [artThumb({ ...item, url }, applied ? 'Current artwork' : '',
    choice || { file: current.file, current: true })] : []));
  $$('#art-grid > .thumb').forEach((cell) => { cell.hidden = cell._broken || sameArtwork(choice, cell._art); });
}

function renderArtGrid(loading = false, start = 0) {
  closeArtPreview();
  const m = S.modal;
  m?.moreObserver?.disconnect();
  const grid = $('#art-grid');
  if (!start) grid.innerHTML = '';
  else $('#art-more')?.remove();
  if (!m) return;
  const kind = m.tab;
  for (const id of start ? [] : ['art-stock', 'art-choice']) {
    const slot = document.createElement('div');
    slot.id = id;
    slot.hidden = true;
    grid.appendChild(slot);
  }
  if (m.row.source === 'desktop') handleAction('Icon preview', renderDesktopIconChoices)();
  else {
    m.current[kind] ||= window.api.artCurrent({ row: rowPayload(m.row), kind }).catch(() => null);
    stockArtwork(m, kind);
    handleAction('Artwork preview', renderArtChoice)();
  }
  if (!S.cfg.api_key) return;
  if (loading || !m.sgdbId) {
    grid.insertAdjacentHTML('beforeend', `<div class="muted">${m.sgdbId ? 'Loading…' : 'Search or enter an SGDB game ID first.'}</div>`);
    return;
  }
  const page = m.cache[artworkCacheKey(m)];
  const items = page?.items || [];
  if (!items.length) {
    grid.insertAdjacentHTML('beforeend', '<div class="muted">No SGDB images of this type.</div>');
    return;
  }
  for (const im of items.slice(start)) grid.appendChild(artThumb(im));
  if (page.more) {
    const button = document.createElement('button');
    button.id = 'art-more';
    button.className = 'btn';
    button.textContent = 'Load more';
    button.addEventListener('click', () => loadArtTabs(true));
    grid.appendChild(button);
    const sgdbId = m.sgdbId;
    m.moreObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || !button.isConnected
        || S.modal !== m || m.tab !== kind || m.sgdbId !== sgdbId || button.disabled) return;
      m.moreObserver.disconnect();
      loadArtTabs(true);
    }, { root: grid.parentElement, rootMargin: '100px' });
    m.moreObserver.observe(button);
  }
}

function artThumb(im, label = '', selection = im) {
  const modal = S.modal;
  const kind = S.modal.tab;
  const cell = document.createElement('div');
  cell._art = selection;
  cell.className = `thumb${isPicked(kind, selection) ? ' picked' : ''}`;
  const selectionLabel = label || (im.id ? `${kind} image ${im.id} by ${im.author || 'unknown author'}` : `${kind} image ${baseName(im.file) || im.url || ''}`);
  cell.innerHTML = `<button class="thumb-select" type="button" aria-label="Select ${esc(selectionLabel)}" aria-pressed="${String(isPicked(kind, selection))}">
      <span class="thumb-image"><img loading="lazy" decoding="async" width="${Number(im.width) || 600}" height="${Number(im.height) || 900}" src="${esc(im.thumb || im.url)}" alt=""></span>
      <span class="meta">${label || (im.id ? `#${im.id} · ${esc(im.style)} · ${im.width}x${im.height}<br>
      ${im.upvotes} votes · score ${im.score} · ${esc(im.author)}` : esc(im.file ? baseName(im.file) : im.url))}<span class="art-selected"> · Selected</span></span></button>
      <button class="art-preview-button" type="button" title="Preview artwork" aria-label="Preview ${esc(selectionLabel)}"><svg class="icon" aria-hidden="true"><use href="#i-preview"/></svg></button>`;
  $('.thumb-select', cell).addEventListener('click', () => pickArt(kind, selection));
  const image = $('img', cell);
  image.addEventListener('error', () => {
    log(`Artwork image failed to load: ${im.file || (image.src.startsWith('data:') ? 'local image data' : image.src)}`,
      modal.row.source === 'desktop' ? 'desktop' : 'library');
    if (im.url && image.getAttribute('src') !== im.url) { image.src = im.url; return; }
    cell._broken = true;
    cell.hidden = true;
    if (['art-choice', 'art-stock'].includes(cell.parentElement?.id)) cell.parentElement.hidden = true;
    if (S.modal === modal && modal.tab === kind) artStatus('An image could not load and was hidden. Details are in the log.');
  });
  $('.art-preview-button', cell).addEventListener('click', (e) => {
    e.stopPropagation();
    handleAction('Artwork preview', () => openArtPreview(im))();
  });
  return cell;
}

function pickArt(kind, item) {
  S.modal.sel[kind] = item.file ? { file: item.file, appliedFile: item.appliedFile } : item;
  artStatus(item.id ? `${kind}: selected #${item.id} by ${item.author}.`
    : `${kind}: ${item.file ? 'local file' : 'custom URL'} set.`);
  renderArtTabs();
}

function restoreArtKind(kind) {
  const m = S.modal;
  if (m.row.source === 'steam' || m.row.inSteam) m.sel[kind] = { reset: true };
  else delete m.sel[kind];
  artStatus(m.sel[kind]?.reset ? `${kind}: default artwork will be restored when you apply.` : `${kind}: selection cleared.`);
  renderArtTabs();
}

async function artSearch() {
  const m = S.modal;
  const q = $('#art-q').value.trim();
  if (!q) return;
  const search = m.search = (m.search || 0) + 1;
  artStatus(`Searching SGDB for '${q}'…`);
  try {
    const games = await window.api.sgdbSearch(q);
    if (S.modal !== m || m.search !== search) return;
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
    const g = games.find((game) => game.id === m.sgdbId) || games[0];
    sel.value = String(g.id);
    m.sgdbId = g.id;
    $('#art-id').value = String(g.id);
    artStatus(`Matched '${g.name}' (${g.id}). Loading artwork…`);
    await loadArtTabs();
  } catch (e) {
    if (S.modal === m && m.search === search) artStatus(`Search failed: ${e.message || e}`);
  }
}

async function artLoadId() {
  const m = S.modal;
  const gid = Number(($('#art-id').value || '').trim());
  if (!Number.isFinite(gid) || gid <= 0) { artStatus('SGDB game ID must be a number.'); return; }
  m.search = (m.search || 0) + 1;
  m.sgdbId = gid;
  await loadArtTabs();
}

// ------------------------------------------------------------------ boot
function wireToolbar() {
  wireDesktop();
  $('#onboarding-skip').addEventListener('click', () => { S.onboardingStep = 1; S.skippedSteam = true; renderOnboarding(); });
  $('#onboarding-continue').addEventListener('click', handleAction('Setup', async () => {
    const button = $('#onboarding-continue');
    if (button.disabled) return;
    button.disabled = true;
    try {
      if (S.onboardingStep === 0 && (!await window.api.steamVerify(S.cfg.steam_path)
        || !S.steamUsers.some((user) => user.id === S.cfg.steam_user_id))) {
        toast('Choose a valid Steam installation and account first.');
        return;
      }
      if (S.onboardingStep === 0) S.skippedSteam = false;
      if (S.onboardingStep < 2) { S.onboardingStep++; renderOnboarding(); return; }
      const completed = S.cfg.onboarded;
      const steamReady = !S.skippedSteam && S.cfg.steam_user_id && await window.api.steamVerify(S.cfg.steam_path);
      if (!completed) await savePatch({ onboarded: true, startup_library: steamReady ? 'steam' : 'desktop' });
      navReset(steamReady ? 'library' : 'desktop');
    } finally { button.disabled = false; }
  }));
  $('#onboarding-back').addEventListener('click', () => { S.onboardingStep--; renderOnboarding(); });
  $('.onboarding-steps').addEventListener('click', (e) => {
    const button = e.target.closest('[data-step]');
    if (!button || button.disabled) return;
    S.onboardingStep = Number(button.dataset.step);
    renderOnboarding();
  });
  $('#onboarding-close').addEventListener('click', () => navReset('library'));
  $('#preview-onboarding').addEventListener('click', () => { S.onboardingStep = 0; navGo('onboarding'); });
  $('#theme').addEventListener('change', handleAction('Theme change', () => savePatch({ theme: $('#theme').value })));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  const dock = $('#bottomdock');
  const dockToggle = $('#dock-toggle');
  dockToggle.addEventListener('click', () => {
    const collapsed = dock.classList.toggle('collapsed');
    dockToggle.setAttribute('aria-expanded', String(!collapsed));
    dockToggle.textContent = collapsed ? 'Show log' : 'Hide log';
  });
  $('#btn-refresh').addEventListener('click', handleAction('Refresh', doRefresh));
  $('#btn-find-executables').addEventListener('click', doFindExecutables);
  $('#btn-download').addEventListener('click', handleAction('Find artwork', doDownloadArt));
  $('#btn-add').addEventListener('click', handleAction('Add to Steam', doAddToSteam));
  $('#d-primary-action').addEventListener('click', handleAction('Add to Steam', () => doAddToSteam([cur()].filter(Boolean))));
  $('#btn-remove').addEventListener('click', handleAction('Shortcut removal', doRemoveFromSteam));
  $('#btn-prune').addEventListener('click', handleAction('Prune', doPruneMissing));
  $('#side-kill').addEventListener('click', doKillSteam);
  $('#side-restart').addEventListener('click', doRestartSteam);
  $('#sel-all').addEventListener('change', (e) => { (S.visibleRows || []).forEach((r) => { r.checked = e.target.checked; }); updateLibrarySelection(); });
  $('#select-multiple').addEventListener('click', () => {
    S.bulk = !S.bulk;
    if (S.bulk) S.rows.forEach(row => { row.checked = row === cur(); });
    updateLibrarySelection();
  });
  $('#btn-clear').addEventListener('click', handleAction('Clear', doClear));
  $('#hide-owned').addEventListener('change', (e) => {
    S.hideOwned = e.target.checked;
    renderRows();
  });
  $('#filter').addEventListener('input', (e) => { S.filter = e.target.value; renderRows(); });
  $('#source-filter').addEventListener('change', (e) => { S.sourceFilter = e.target.value; renderRows(); });
  $('#sort-games').addEventListener('change', (e) => { S.sortGames = e.target.value; renderRows(); });
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
      if (!e.target.matches('.row-check')) return;
      const r = rowByKey(tr.dataset.key);
      if (r) { r.checked = e.target.checked; updateLibrarySelection(); }
      return;
    }
    selectRow(tr.dataset.key);
  });
  $('#games-body').addEventListener('dblclick', (e) => {
    if (S.applyingSteam || S.preparingArt || S.loadingLibrary || !e.target.closest('.cover-wrap')) return;
    const row = rowByKey(e.target.closest('.game-card-row')?.dataset.key);
    if (row) openArtModal(row, 'grid');
  });
  $('#detail-close').addEventListener('click', () => {
    S.detailKey = null;
    updateLibrarySelection();
    renderDetail();
  });
  $('#d-apply').addEventListener('click', applyDetails);
  $('#d-exe-pick').addEventListener('change', (e) => { e.target.title = e.target.value; });
  $('#d-browse').addEventListener('click', async () => {
    const r = cur();
    const p = await window.api.filesPickExe(r ? (r.fromExecutableSearch ? r.startDir : r.folder) : null);
    if (p) {
      const pick = $('#d-exe-pick');
      if (![...pick.options].some((o) => o.value === p)) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = baseName(p);
        pick.appendChild(o);
      }
      pick.value = p;
      pick.title = p;
    }
  });
  $('#d-open').addEventListener('click', () => {
    const r = cur();
    if (!r) return;
    const folder = r.source === 'steam' ? r.startDir
      : r.source === 'shortcut' || r.fromExecutableSearch ? (r.startDir || parentDir(r.exe)) : r.folder;
    if (folder) window.api.shellOpen(folder);
  });
  $('#d-preview-open').addEventListener('click', () => {
    const r = cur();
    if (r) openArtModal(r, 'grid');
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
  for (const [input, button] of [['s-search', 's-go'], ['art-q', 'art-search']]) {
    $(`#${input}`).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
      e.preventDefault();
      $(`#${button}`).click();
    });
  }
  $('#art-load').addEventListener('click', artLoadId);
  $('#art-preview-back').addEventListener('click', closeArtPreview);
  $('#art-preview-image').addEventListener('error', () => {
    const item = S.modal?.previewItem;
    const image = $('#art-preview-image');
    if (!item) return;
    log(`Artwork preview failed to load: ${item.file || (image.src.startsWith('data:') ? 'local image data' : image.src)}`);
    if (item.url && image.getAttribute('src') !== item.url) { image.src = item.url; return; }
    artStatus('Could not preview this image.');
    closeArtPreview();
  });
  $('#art-games').addEventListener('change', async (e) => {
    const m = S.modal;
    const g = (m.games || []).find((x) => String(x.id) === e.target.value);
    if (g) {
      m.search = (m.search || 0) + 1;
      m.sgdbId = g.id;
      $('#art-id').value = String(g.id);
      await loadArtTabs();
    }
  });
  $('#art-url').addEventListener('click', () => {
    $('#art-url-input').value = S.modal.sel[S.modal.tab]?.custom ? S.modal.sel[S.modal.tab].url || '' : '';
    $('#art-url-entry').hidden = false;
    $('#art-url-input').focus();
  });
  $('#art-url-cancel').addEventListener('click', () => { $('#art-url-entry').hidden = true; });
  $('#art-url-entry').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = S.modal;
    const url = $('#art-url-input').value.trim();
    if (url) {
      closeArtPreview();
      m.sel[m.tab] = { url, custom: true };
      renderArtTabs();
      artStatus(`${m.tab}: custom URL set.`);
    }
    $('#art-url-entry').hidden = true;
  });
  $('#art-file').addEventListener('click', handleAction('Artwork preview', async () => {
    const m = S.modal;
    const p = await (m.tab === 'icon' ? window.api.desktopPickIcon() : window.api.filesPickImage());
    if (p) {
      if (S.modal !== m) return;
      closeArtPreview();
      m.sel[m.tab] = { file: p, custom: true };
      renderArtTabs();
      artStatus(`${m.tab}: local file set.`);
      await openArtPreview(m.sel[m.tab]);
    }
  }));
  $('#art-clear').addEventListener('click', () => {
    restoreArtKind(S.modal.tab);
    closeArtPreview();
  });
  $('#art-cancel').addEventListener('click', () => closeArtModal(false));
  $('#art-apply').addEventListener('click', handleAction('Apply artwork', applyArtModal));
  for (const id of ['art-logo-anchor', 'art-logo-width', 'art-logo-height']) $('#' + id).addEventListener('change', () => {
    S.modal.logoPosition = { pinnedPosition: $('#art-logo-anchor').value,
      nWidthPct: Number($('#art-logo-width').value), nHeightPct: Number($('#art-logo-height').value) };
  });
  $('#art-logo-reset').addEventListener('click', () => { S.modal.logoPosition = null; renderLogoPosition(); });
  $('#art-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'art-overlay') closeArtModal(false);
  });
  document.addEventListener('keydown', (e) => {
    if (S.exePicker) return;
    if (S.modal && e.key === 'Tab') {
      const focusable = $$('#art-modal button:not(:disabled), #art-modal input:not(:disabled), #art-modal select:not(:disabled)')
        .filter((element) => !element.closest('[hidden]') && element.getClientRects().length);
      const at = focusable.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!e.shiftKey && at === focusable.length - 1) { e.preventDefault(); focusable[0]?.focus(); }
    }
    if (e.key === 'Escape' && S.modal) {
      if (!$('#art-url-entry').hidden) $('#art-url-entry').hidden = true;
      else closeArtModal(false);
    }
    // History shortcuts. Ignored while the modal owns input.
    if (!pickerOpen() && e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navBack(); }
    if (!pickerOpen() && e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navFwd(); }
  });
  // Mouse back/forward at DOM level (buttons 3/4 here = 4th/5th on the mouse).
  // Always fires, unlike the OS path. Deduped against it above.
  document.addEventListener('mouseup', (e) => {
    if (pickerOpen() || (e.button !== 3 && e.button !== 4)) return;
    if (Date.now() - lastIpcNav < NAV_ECHO_MS) return;
    lastMouseNav = Date.now();
    e.preventDefault();
    if (e.button === 3) navBack(); else navFwd();
  });
  $$('.nav').forEach((b) => b.addEventListener('click', () => navGo(b.dataset.page)));
}

async function applyDetails() {
  const r = cur();
  if (!r) return false;
  if (r.source === 'steam') { toast('Steam store games cannot be edited here - Steam manages them.'); return false; }
  const oldLaunch = S.cfg.steam_launch?.[folderKey(r.folder)];
  const oldStartDir = oldLaunch?.startDir ?? String(r.startDir || '').replace(/^"|"$/g, '');
  const oldArgs = oldLaunch?.launchOptions ?? r.launchOptions ?? '';
  const name = $('#d-name').value.trim();
  const exe = $('#d-exe-pick').value.trim();
  let startDir = $('#d-startdir').value.trim();
  if (exe !== r.exe && folderKey(startDir) === folderKey(parentDir(r.exe || ''))) startDir = parentDir(exe);
  const fieldsChanged = (!!name && name !== r.display) || (!!exe && exe !== r.exe)
    || startDir !== oldStartDir || $('#d-args').value !== oldArgs;
  if (r.fromExecutableSearch && exe && folderKey(exe) !== folderKey(r.folder)) {
    if (S.rows.some((other) => other !== r && other.exe && folderKey(other.exe) === folderKey(exe))) {
      toast('That executable is already listed.');
      return false;
    }
    const oldKey = folderKey(r.folder);
    const newKey = folderKey(exe);
    for (const map of [S.cfg.title_map, S.cfg.sgdb_map, S.cfg.sgdb_cache, S.cfg.steam_launch ||= {}]) {
      if (Object.hasOwn(map, oldKey)) map[newKey] = map[oldKey];
      else delete map[newKey];
      delete map[oldKey];
    }
    delete S.cfg.exe_map[oldKey];
    r.folder = exe;
    r.folderName = baseName(parentDir(exe));
    S.detailKey = rowKey(r);
  }
  if (name) {
    r.display = name;
    r.query = name;
    S.cfg.title_map[folderKey(r.folder)] = name;
  }
  if (exe) {
    const launcherChanged = exe !== r.exe;
    r.exe = exe;
    if (launcherChanged) r.startDir = parentDir(exe);
    if (!r.fromExecutableSearch) {
      S.cfg.exe_map[folderKey(r.folder)] = exe.startsWith(r.folder)
        ? exe.slice(r.folder.length).replace(/^[\\/]/, '') : baseName(exe);
    }
  }
  r.reason = 'manual';
  S.cfg.steam_launch ||= {};
  S.cfg.steam_launch[folderKey(r.folder)] = { startDir: startDir || parentDir(r.exe), launchOptions: $('#d-args').value };
  if (fieldsChanged) r.pendingDetails = true;
  await savePatch({ title_map: S.cfg.title_map, exe_map: S.cfg.exe_map,
    sgdb_map: S.cfg.sgdb_map, sgdb_cache: S.cfg.sgdb_cache, steam_launch: S.cfg.steam_launch });
  await refreshSteamState();
  log(`Updated '${r.display}'.`);
  return true;
}

async function sgdbSearch() {
  const r = cur();
  if (!r) return;
  const key = rowKey(r);
  const q = $('#s-search').value.trim() || r.display;
  if (!q) return;
  if (needKey()) return;
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
  if (needKey()) return;
  const key = rowKey(r);
  const token = ++S.matchSearchToken;
  resetMatchResults('Matching automatically…');
  $('#s-status').textContent = `Auto-matching '${r.display}'…`;
  try {
    const result = await window.api.matchAuto({ force: true, persist: false, rows: [{
      folder: r.folder, display: r.display, query: r.query,
      steamAppid: r.steamAppid, sgdbId: null, source: r.source,
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
  return S.bulk ? S.rows.filter(r => r.checked) : [cur()].filter(Boolean);
}

async function boot() {
  S.cfg = await window.api.cfgGet();
  applyTheme();
  console.log('RENDERER booted');
  log('ready.');
  try {
    S.steamUsers = S.cfg.steam_path ? await window.api.steamUsers(S.cfg.steam_path) : [];
  } catch { S.steamUsers = []; }
  wireToolbar();
  S.isDevelopment = await window.api.isDevelopment().catch(() => false);
  $('#preview-onboarding').hidden = !S.isDevelopment;
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
  if (!S.cfg.onboarded) {
    navReset('onboarding');
  } else {
    navReset(S.cfg.startup_library === 'desktop' ? 'desktop' : 'library');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    document.body.innerHTML = `<pre style="padding:20px">Failed to start: ${esc(e.message || e)}</pre>`;
  });
});
