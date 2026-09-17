'use strict';
/* Scan game folders and score executable candidates by name match, depth,
   size, and blacklist penalties. */
const fs = require('fs');
const path = require('path');
const resolve = require('./resolve');
const { TAG_PATTERNS, toSearchQuery } = require('./strips');

const DIR_BLACKLIST = new Set([
  '_redist', 'redist', 'redists', '_commonredist', 'commonredist',
  'directx', 'directx12', 'dotnet', 'vcredist', 'installer', 'installers',
  'setup', '__installer', 'support', 'docs', 'manual', 'redistributables',
  'easyanticheat', 'battleye', '__redist', 'prerequisites',
]);

const EXE_BLACKLIST_SUBSTRINGS = [
  'uninstall', 'unins', 'setup', 'install', 'update', 'patcher', 'patch',
  'config', 'setting', 'crashhandler', 'crashreport', 'crashsender',
  'report', 'diagnostic', 'helper', 'uploader', 'cef', 'redist',
  'dxsetup', 'vcredist', 'dotnet', 'oalinst', 'physx', 'gdfinstall',
  'eac_', 'battleye', 'anticheat',
];

const GENERIC_SUBDIRS = new Set([
  'bin', 'binaries', 'bin64', 'bin32', 'x64', 'x86', 'win64', 'win32',
  'win', 'game', 'build', 'builds', 'app', 'apps', 'dist', 'release',
  'releases', 'retail', 'final', 'engine', 'content', 'data', 'program',
  'system', 'system32', 'client', 'launch', 'launcher', 'master',
]);

function cleanFolderName(name) {
  let s = String(name).trim();
  for (const pat of TAG_PATTERNS) s = s.replace(pat, '').trim();
  s = s.replace(/_/g, ' ').replace(/\./g, ' ');
  s = s.replace(/\s+/g, ' ').replace(/^[\s\-_.]+|[\s\-_.]+$/g, '');
  return s || name;
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokens(s) {
  return new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []));
}

function exeBlacklistHit(stem) {
  const low = stem.toLowerCase();
  return EXE_BLACKLIST_SUBSTRINGS.find((frag) => low.includes(frag)) || null;
}

function iterExes(gameRoot, maxInnerDepth = 3) {
  const found = []; // [absPath, depth]
  let entries;
  try {
    entries = fs.readdirSync(gameRoot, { withFileTypes: true });
  } catch { return found; }
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
      found.push([path.join(gameRoot, e.name), 0]);
    }
  }
  const stack = entries.filter((e) => e.isDirectory()).map((e) => [path.join(gameRoot, e.name), 1]);
  while (stack.length) {
    const [cur, depth] = stack.pop();
    if (depth > maxInnerDepth) continue;
    if (DIR_BLACKLIST.has(path.basename(cur).toLowerCase())) continue;
    let children;
    try {
      children = fs.readdirSync(cur, { withFileTypes: true });
    } catch { continue; }
    for (const e of children) {
      const full = path.join(cur, e.name);
      if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) found.push([full, depth]);
      else if (e.isDirectory()) stack.push([full, depth + 1]);
    }
  }
  return found;
}

function scoreExe(exePath, depth, size, folderNorm, folderTokens, sizeBonus) {
  const stem = path.basename(exePath, path.extname(exePath));
  const stemNorm = norm(stem);
  const stemTokens = tokens(stem);
  const reasons = [];
  let score = 0;

  if (stemNorm && stemNorm === folderNorm) { score += 100; reasons.push('exe matches folder'); }
  else if (stemNorm && folderNorm && (stemNorm.includes(folderNorm) || folderNorm.includes(stemNorm))) {
    score += 60; reasons.push('exe similar to folder');
  } else {
    const overlap = [...folderTokens].filter((t) => t.length > 2 && stemTokens.has(t));
    if (overlap.length) { score += 15 + 10 * overlap.length; reasons.push(`token match ${overlap.slice(0, 3)}`); }
  }

  if (depth === 0) { score += 30; reasons.push('in game root'); }
  else if (depth === 1) score += 12;
  else if (depth === 2) score += 2;
  else { score -= 20; reasons.push(`deep (d${depth})`); }

  if (size < 500 * 1024) { score -= 50; reasons.push('tiny exe'); }
  else if (size < 2 * 1024 * 1024) score -= 15;
  score += sizeBonus;
  if (sizeBonus >= 19.5) reasons.push('largest exe');

  const hit = exeBlacklistHit(stem);
  if (hit) { score -= 80; reasons.push(`looks like ${hit}`); }
  if (['game-win64-shipping', 'game-win32-shipping', 'ue4game', 'ue5game'].includes(stem.toLowerCase())) {
    score -= 10; reasons.push('generic engine exe');
  }
  return [score, reasons.join('; ')];
}

function pickExe(gameRoot, displayName, maxInnerDepth = 3) {
  const folderNorm = norm(displayName);
  const folderTokens = tokens(displayName);
  const found = iterExes(gameRoot, maxInnerDepth);
  if (!found.length) return { exe: null, candidates: [], reason: 'no .exe found' };
  const sized = [];
  for (const [p, d] of found) {
    let sz = 0;
    try { sz = fs.statSync(p).size; } catch { /* ignore */ }
    sized.push({ path: p, depth: d, size: sz });
  }
  if (!sized.length) return { exe: null, candidates: [], reason: 'no .exe found' };
  const order = sized.map((_, i) => i).sort((a, b) => sized[a].size - sized[b].size);
  const bonus = {};
  order.forEach((idx, rank) => { bonus[idx] = sized.length > 1 ? (20 * rank) / (sized.length - 1) : 10; });
  const candidates = sized.map(({ path: p, depth: d, size: sz }, i) => {
    const [score, reason] = scoreExe(p, d, sz, folderNorm, folderTokens, bonus[i]);
    return { path: p, size: sz, depth: d, score, reason };
  });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return { exe: best.path, candidates, reason: best.reason };
}

function hasDirectExe(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .some((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe'));
  } catch { return false; }
}

function childDirs(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(folder, e.name))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch { return []; }
}

/** Decide whether a folder without an exe is a container or the game root. */
function subGames(folder) {
  const subs = childDirs(folder).filter((d) => !DIR_BLACKLIST.has(path.basename(d).toLowerCase()));
  if (!subs.length) return [folder];
  const nonGeneric = subs.filter((d) => !GENERIC_SUBDIRS.has(path.basename(d).toLowerCase()));
  if (subs.length === 1 && GENERIC_SUBDIRS.has(path.basename(subs[0]).toLowerCase())) {
    // A generic child can be an engine folder or a nested game. Use exe-name
    // similarity to break the tie.
    const parentNorm = norm(path.basename(folder));
    const childNorm = norm(path.basename(subs[0]));
    if (parentNorm !== childNorm) {
      const stems = iterExes(subs[0], 1)
        .map(([p]) => norm(path.basename(p, path.extname(p))));
      const match = (s, name) => s && (s === name || s.includes(name) || name.includes(s));
      const childHit = stems.some((s) => match(s, childNorm));
      const parentHit = stems.some((s) => match(s, parentNorm));
      if (childHit && !parentHit) return subs;
    }
    return [folder]; // the exe name does not make it clear if the child folder is the game. keep the parent folder
  }
  if (nonGeneric.length >= 2 || subs.length === 1) {
    return nonGeneric.length ? nonGeneric : subs;
  }
  return [folder]; // mixed child folders are too ambiguous to treat them as separate games. keep the parent folder
}

// ------------------------------------------------------------------ .lnk
// Resolve standard desktop .lnk files to local executable targets.
function parseLnkTarget(lnkPath) {
  let buf;
  try {
    buf = fs.readFileSync(lnkPath);
  } catch { return null; }
  // The Shell Link header is 76 bytes. LinkInfo offsets are relative to its start.
  if (buf.length < 76 || buf.readUInt32LE(0) !== 0x0000004c) return null;
  const flags = buf.readUInt32LE(20);
  const HAS_IDLIST = 0x01;
  const HAS_LINKINFO = 0x02;
  let off = 76;
  if (flags & HAS_IDLIST) {
    if (off + 2 > buf.length) return null;
    off += 2 + buf.readUInt16LE(off);
  }
  if (!(flags & HAS_LINKINFO) || off + 28 > buf.length) return null;
  const base = off;
  const headerSize = buf.readUInt32LE(base + 4);
  const infoFlags = buf.readUInt32LE(base + 8);
  const HAS_VOLUME_LOCAL = 0x01;
  if (!(infoFlags & HAS_VOLUME_LOCAL)) return null;
  if (headerSize >= 36) {
    const uOff = buf.readUInt32LE(base + 28);
    if (uOff) {
      const end = findUtf16Nul(buf, base + uOff);
      if (end > 0) {
        const p = buf.toString('utf16le', base + uOff, end);
        if (p) return p;
      }
    }
  }
  const aOff = buf.readUInt32LE(base + 16);
  if (!aOff) return null;
  const end = buf.indexOf(0, base + aOff);
  if (end < 0) return null;
  return buf.toString('latin1', base + aOff, end) || null;
}

function findUtf16Nul(buf, off) {
  for (let i = off; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) return i;
  }
  return -1;
}

/** Map lowercased game folders to executable targets from desktop shortcuts. */
function loadDesktopLinks(dirs) {
  const roots = dirs || [
    path.join(process.env.USERPROFILE || '', 'Desktop'),
    path.join(process.env.PUBLIC || '', 'Desktop'),
  ].filter(Boolean);
  const map = new Map();
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith('.lnk')) continue;
      const target = parseLnkTarget(path.join(root, e.name));
      if (target && target.toLowerCase().endsWith('.exe')) {
        map.set(path.dirname(target).toLowerCase(), target);
      }
    }
  }
  return map;
}

function scanGames(root, { maxDepth = 2, innerDepth = 3, linkMap = null, onProgress } = {}) {
  if (!root) return [];
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch { return []; }
  const candidates = [];
  const children = childDirs(root);
  try {
    const files = fs.readdirSync(root, { withFileTypes: true });
    if (files.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.exe'))) candidates.push(root);
  } catch { /* ignore */ }

  for (const child of children) {
    if (DIR_BLACKLIST.has(path.basename(child).toLowerCase())) continue;
    candidates.push(child);
  }
  // Descend while folders have no direct exe: depth 1 = children only,
  // depth 2 = +grandchildren, depth 3 = +great-grandchildren, ...
  for (let level = 1; level < Math.max(1, maxDepth); level++) {
    const next = [];
    const seen = new Set();
    for (const c of candidates) {
      const repl = hasDirectExe(c) ? [c] : subGames(c);
      for (const r of repl) {
        const k = r.toLowerCase();
        if (!seen.has(k)) { seen.add(k); next.push(r); }
      }
    }
    candidates.length = 0;
    candidates.push(...next);
  }

  const results = [];
  candidates.forEach((folder, i) => {
    if (onProgress) { try { onProgress(i, candidates.length, path.basename(folder)); } catch { /* ignore */ } }
    const ident = resolve.resolveFolder(path.basename(folder), cleanFolderName);
    let display = ident.title;
    const { exe, candidates: cands, reason } = pickExe(folder, display, innerDepth);
    let { method, confidence, steamAppid } = ident;
    let finalReason = exe ? reason : 'no .exe found';
    let lnkBoosted = false;
    if (linkMap && exe) {
      // Desktop shortcut pointing into this folder outranks every heuristic.
      const target = linkMap.get(folder.toLowerCase());
      const hit = target && cands.find((c) => c.path.toLowerCase() === String(target).toLowerCase());
      if (hit) {
        hit.score += 200;
        cands.sort((a, b) => b.score - a.score);
        lnkBoosted = cands[0] === hit;
        if (lnkBoosted) finalReason = `${hit.reason || 'desktop shortcut'} + desktop shortcut points here`;
      }
    }
    const best = cands.length ? cands[0].path : exe;
    if (method === 'folder' && best) {
      const exeId = resolve.resolveExeStem(path.basename(best, path.extname(best)));
      if (exeId) {
        display = exeId.title;
        method = exeId.method; confidence = exeId.confidence; steamAppid = exeId.steamAppid;
        finalReason = `${finalReason} + exe says ${display}`;
      } else {
        // Use the exe name for display/search when it has more signal. Identity stays unresolved.
        const GENERIC_EXE_NAMES = new Set(['game', 'launcher', 'client', 'app', 'bin']);
        const stem = path.basename(best, path.extname(best));
        const alpha = (s) => (String(s).match(/[a-z]/gi) || []).length;
        const exeTitle = toSearchQuery(stem);
        if (!exeBlacklistHit(stem) && !GENERIC_EXE_NAMES.has(exeTitle.toLowerCase())
            && alpha(exeTitle) >= 4 && alpha(exeTitle) > alpha(display)) {
          display = exeTitle;
          finalReason = `${finalReason} + exe name looks better`;
        }
      }
    }
    results.push({
      folder, displayName: display, exePath: best,
      startDir: best ? path.dirname(best) : folder,
      candidates: cands, score: cands.length ? cands[0].score : 0,
      reason: finalReason, query: display, lnkBoosted,
      steamAppid, idMethod: method, confidence: confidence,
    });
  });
  if (onProgress) { try { onProgress(candidates.length, candidates.length, 'done'); } catch { /* ignore */ } }
  results.sort((a, b) => Number(a.exePath === null) - Number(b.exePath === null)
    || a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  return results;
}

/** Fallback scan for unassigned executables. Reports when a scan limit was hit. */
function scanOrphans(root, claimedSet, { maxDepth = Infinity, limit = 200, maxDirs = 50000, maxFiles = 10000 } = {}) {
  const claimed = new Set([...(claimedSet || [])].map((p) => String(p).toLowerCase()));
  const orphans = [];
  let capped = false;
  let visited = 0;
  const stack = [[root, 0]];
  while (stack.length && !capped) {
    const [cur, depth] = stack.pop();
    if (depth > maxDepth) continue;
    if (cur !== root && DIR_BLACKLIST.has(path.basename(cur).toLowerCase())) continue;
    if (++visited > maxDirs) { capped = true; break; }
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      try {
        if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
          if (claimed.has(full.toLowerCase())) continue;
          if (exeBlacklistHit(path.basename(e.name, '.exe'))) continue;
          let sz = 0;
          try { sz = fs.statSync(full).size; } catch { /* ignore */ }
          if (sz < 500 * 1024) continue;
          orphans.push([full, depth]);
          if (orphans.length >= maxFiles) { capped = true; break; }
        } else if (e.isDirectory()) {
          stack.push([full, depth + 1]);
        }
      } catch { /* ignore */ }
    }
  }
  const byDir = new Map();
  for (const [p, d] of orphans) {
    const k = path.dirname(p).toLowerCase();
    if (!byDir.has(k)) byDir.set(k, []);
    byDir.get(k).push([p, d]);
  }
  const results = [];
  let truncated = capped;
  for (const [, items] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (results.length >= limit) { truncated = true; break; }
    items.sort((a, b) => {
      const sa = safeSize(a[0]);
      const sb = safeSize(b[0]);
      return sb - sa;
    });
    const best = items[0][0];
    const stem = path.basename(best, path.extname(best));
    const ident = resolve.resolveExeStem(stem);
    const title = ident ? ident.title : cleanFolderName(stem);
    const cands = items.slice(0, 12).map(([p, d]) => ({
      path: p, size: safeSize(p), depth: d, score: safeSize(p), reason: 'orphan exe',
    }));
    results.push({
      folder: path.dirname(best), displayName: title, exePath: best,
      startDir: path.dirname(best), candidates: cands, score: cands[0].size,
      reason: 'deep exe scan (folder unparsed)', query: title,
      steamAppid: ident ? ident.steamAppid : null,
      idMethod: 'orphan-exe', confidence: ident ? ident.confidence : 0.5,
    });
  }
  return { games: results, truncated };
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

module.exports = {
  DIR_BLACKLIST, EXE_BLACKLIST_SUBSTRINGS, GENERIC_SUBDIRS,
  cleanFolderName, pickExe, scanGames, scanOrphans,
  parseLnkTarget, loadDesktopLinks,
};
