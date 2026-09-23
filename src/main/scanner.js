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

function childDirs(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(folder, e.name))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  } catch { return []; }
}

function scanGames(root, { maxDepth = 1, innerDepth = 3, onProgress } = {}) {
  if (!root) return [];
  try {
    if (!fs.statSync(root).isDirectory()) return [];
  } catch { return []; }
  let candidates = [root];
  for (let level = 0; level < maxDepth; level++) {
    candidates = candidates.flatMap(childDirs);
  }

  const results = [];
  candidates.forEach((folder, i) => {
    if (onProgress) { try { onProgress(i, candidates.length, path.basename(folder)); } catch { /* ignore */ } }
    const ident = resolve.resolveFolder(path.basename(folder), cleanFolderName);
    let display = ident.title;
    const { exe, candidates: cands, reason } = pickExe(folder, display, innerDepth);
    let { method, confidence, steamAppid } = ident;
    let finalReason = exe ? reason : 'no .exe found';
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
      reason: finalReason, query: display,
      steamAppid, idMethod: method, confidence: confidence,
    });
  });
  if (onProgress) { try { onProgress(candidates.length, candidates.length, 'done'); } catch { /* ignore */ } }
  results.sort((a, b) => Number(a.exePath === null) - Number(b.exePath === null)
    || a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
  return results;
}

/** Find individual executables up to 10 folder levels down. */
function findExecutables(root, claimedSet, { maxDepth = 10, limit = 10000, maxDirs = 50000, maxFiles = 10000 } = {}) {
  const claimed = new Set([...(claimedSet || [])].map((p) => String(p).toLowerCase()));
  const executables = [];
  let capped = false;
  let visited = 0;
  const stack = [[root, 0]];
  while (stack.length && !capped) {
    const [cur, depth] = stack.pop();
    if (depth > maxDepth) continue;
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
          executables.push([full, depth]);
          if (executables.length >= maxFiles) { capped = true; break; }
        } else if (e.isDirectory()) {
          if (depth < maxDepth) stack.push([full, depth + 1]);
        }
      } catch { /* ignore */ }
    }
  }
  const results = [];
  let truncated = capped;
  for (const [exe, depth] of executables.sort(([a], [b]) => a.localeCompare(b))) {
    if (results.length >= limit) { truncated = true; break; }
    const stem = path.basename(exe, path.extname(exe));
    const ident = resolve.resolveExeStem(stem);
    const title = ident ? ident.title : cleanFolderName(stem);
    const size = safeSize(exe);
    results.push({
      folder: exe, displayName: title || stem, exePath: exe,
      startDir: path.dirname(exe),
      candidates: [{ path: exe, size, depth, score: size, reason: 'selected executable' }],
      score: size, reason: 'selected executable', query: title || stem,
      steamAppid: ident ? ident.steamAppid : null,
      idMethod: ident ? ident.method : 'folder', confidence: ident ? ident.confidence : 0.5,
      fromExecutableSearch: true,
    });
  }
  return { games: results, truncated };
}

function safeSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

module.exports = {
  DIR_BLACKLIST, EXE_BLACKLIST_SUBSTRINGS,
  cleanFolderName, pickExe, scanGames, findExecutables,
};
