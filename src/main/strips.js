'use strict';
/* Release-group names shared by folder and search-query cleanup.
   Add names here. scanner.js should only use the patterns built below.
   Keep both razor1911 spellings. Bare razer is not a release group.
   List dodi and dodirepacks because dodi does not match the joined form. */

const RELEASE_GROUPS = [
  'fitgirl', 'dodi', 'dodirepacks', 'codex', 'skidrow', 'elamigos',
  'repack', 'cracked', 'gog', 'steamrip', 'goldberg', 'creamapi',
  'onlinefix', 'razor1911', 'razer1911', 'razor', 'tenoke', 'voices38',
  'darksiders', '0xdeadcode', 'reloaded', 'hoodlum',
  'prophet', 'plaza', 'tinyiso', 'kaosx', 'kaos', 'cpy', 'flt',
  'fairlight', 'p2p', 'xatab', 'rgmechanics', 'qoob', 'empress', 'rune',
  'tinke', 'darck', 'decepticon', 'nova', 'mercs', 'wanted', 'license',
  'nota', 'node', 'steamunlocked',
];

const AMBIGUOUS_GROUPS = new Set(['prophet', 'rune', 'nova', 'mercs', 'wanted', 'license', 'nota', 'node']);

// Release groups recognized inside parenthesized tags.
const PARENS_GROUPS = [
  'fitgirl', 'dodi', 'dodirepacks', 'codex', 'skidrow', 'elamigos',
  'razer1911', 'tenoke', 'voices38', 'darksiders', '0xdeadcode',
];

// Generic (non-group) tags allowed inside parentheses, kept as regex sources.
const PARENS_GENERICS = [
  'repack', 'cracked', 'gog', 'steam', 'v\\d+[\\.\\d]*', 'update.*',
  'dlc', 'build.*', 'multilanguage', 'multi\\d+',
];

// Keep this list narrow so subtitles are not stripped as release groups.
const DASH_SUFFIX_GROUPS = ['gog', 'steam', 'fitgirl', 'dodi', 'codex'];

// Built once with the global flag. String.replace resets lastIndex, so sharing is safe.
function tagPatterns() {
  const g = RELEASE_GROUPS.filter((name) => !AMBIGUOUS_GROUPS.has(name)).join('|');
  const ag = [...AMBIGUOUS_GROUPS].map((name) => name.toUpperCase()).join('|');
  const pg = [...PARENS_GROUPS, ...PARENS_GENERICS].join('|');
  const dg = DASH_SUFFIX_GROUPS.join('|');
  return [
    /\[.*?\]/g,
    new RegExp(`\\(.*?(?:${pg}).*?\\)`, 'gi'),
    new RegExp(`[-_.]\\s*(?:${g})\\b.*$`, 'gi'),
    new RegExp(`[-_.]\\s*(?:${ag})\\b.*$`, 'g'),
    /[-_.]\s*(v\d+[\.\d]*|build\d+|update\d+|rev\d+).*$/g,
    new RegExp(`\\s+-\\s+(?:${dg}).*$`, 'gi'),
  ];
}
const TAG_PATTERNS = tagPatterns();

// Build an SGDB query by removing executable suffixes, separators, release groups,
// and version/build tags.
function toSearchQuery(name) {
  const pass = (s) => {
    for (const pat of TAG_PATTERNS) s = s.replace(pat, '').trim();
    return s;
  };
  let s = String(name || '').replace(/\.exe$/i, '');
  // Strip dotted version tokens before replacing separators. Bare numeric tokens remain.
  s = s.replace(/\bv\d[\d.]*\b|\bbuild\d+\b|\bupdate\d+\b|\brev\d+\b/gi, ' ');
  s = pass(s);
  s = s.replace(/[._\-/\\]+/g, ' ');
  s = s.replace(/\(\s*\)|\[\s*\]/g, ' ');
  s = pass(s);
  s = s.replace(/\b(v\d[\d.]*|build\d+|update\d+|rev\d+)\b/gi, ' ');
  return s.replace(/\s+/g, ' ').replace(/^[\s\-_.]+|[\s\-_.]+$/g, '');
}

// Remove at most one trailing release group from a normalized key. Longest names win.
// Leave the key unchanged if stripping would empty it.
const SORTED_GROUPS = [...RELEASE_GROUPS].sort((a, b) => b.length - a.length);

function stripTrailingGroup(key) {
  const k = String(key || '');
  for (const g of SORTED_GROUPS) {
    if (k.length > g.length && k.endsWith(g)) return k.slice(0, -g.length);
  }
  return k;
}

module.exports = {
  RELEASE_GROUPS, PARENS_GROUPS, PARENS_GENERICS, DASH_SUFFIX_GROUPS,
  tagPatterns, TAG_PATTERNS, toSearchQuery, stripTrailingGroup,
};
