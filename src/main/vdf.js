'use strict';
/* Binary VDF codec (Valve KeyValues) for shortcuts.vdf.
   Types: 0x00 object, 0x01 string, 0x02 int32 LE, 0x07 uint64 LE, 0x08 end.
   Top level: entries, then 0x08. shortcuts.vdf = { shortcuts: { "0": {...} } }. */
const fs = require('fs');
const path = require('path');

const T_OBJECT = 0x00;
const T_STRING = 0x01;
const T_INT = 0x02;
const T_UINT64 = 0x07;
const T_END = 0x08;

const FIELD_ORDER = [
  'appid', 'AppName', 'Exe', 'StartDir', 'icon', 'ShortcutPath',
  'LaunchOptions', 'IsHidden', 'AllowDesktopConfig', 'AllowOverlay',
  'OpenVR', 'Devkit', 'DevkitGameID', 'DevkitOverrideAppID',
  'LastPlayTime', 'FlatpakAppID', 'tags',
];

const FIELD_DEFAULTS = {
  appid: 0, AppName: '', Exe: '', StartDir: '', icon: '', ShortcutPath: '',
  LaunchOptions: '', IsHidden: 0, AllowDesktopConfig: 1, AllowOverlay: 1,
  OpenVR: 0, Devkit: 0, DevkitGameID: '', DevkitOverrideAppID: 0,
  LastPlayTime: 0, FlatpakAppID: '',
};

class Reader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u8() {
    if (this.o >= this.b.length) throw new Error('unexpected EOF in shortcuts.vdf');
    return this.b[this.o++];
  }
  cstr() {
    const end = this.b.indexOf(0, this.o);
    if (end < 0) throw new Error('unterminated string in shortcuts.vdf');
    const s = this.b.toString('utf8', this.o, end);
    this.o = end + 1;
    return s;
  }
  i32() { const v = this.b.readInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  f32() { const v = this.b.readFloatLE(this.o); this.o += 4; return v; }

  readValue(type) {
    if (type === T_OBJECT) return this.readBody();
    const key = this.cstr();
    let value;
    if (type === T_STRING) value = this.cstr();
    else if (type === T_INT) value = this.i32();
    else if (type === T_UINT64) value = Number(this.u64());
    else if (type === 0x03) value = this.f32();
    else if (type === 0x04) value = this.i32() >>> 0;
    else throw new Error(`unknown binary VDF type 0x${type.toString(16)}`);
    return [key, value];
  }

  readBody() {
    const obj = {};
    for (;;) {
      const t = this.u8();
      if (t === T_END) return obj;
      if (t === T_OBJECT) {
        const key = this.cstr();
        obj[key] = this.readBody();
      } else {
        const [key, value] = this.readValue(t);
        obj[key] = value;
      }
    }
  }

  readRoot() {
    const root = {};
    for (;;) {
      if (this.o >= this.b.length) break; // tolerate missing terminator
      const t = this.u8();
      if (t === T_END) break;
      if (t === T_OBJECT) {
        const key = this.cstr();
        root[key] = this.readBody();
      } else {
        const [key, value] = this.readValue(t);
        root[key] = value;
      }
    }
    return root;
  }
}

function wCstr(out, s) {
  out.push(Buffer.from(String(s), 'utf8'));
  out.push(Buffer.from([0]));
}

function wValue(out, key, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    out.push(Buffer.from([T_OBJECT]));
    wCstr(out, key);
    for (const [k, v] of Object.entries(value)) wValue(out, String(k), v);
    out.push(Buffer.from([T_END]));
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= -0x80000000 && value < 0x80000000) {
      out.push(Buffer.from([T_INT]));
      wCstr(out, key);
      const b = Buffer.alloc(4);
      b.writeInt32LE(value);
      out.push(b);
    } else {
      out.push(Buffer.from([T_UINT64]));
      wCstr(out, key);
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(BigInt(value) >>> 0n);
      out.push(b);
    }
  } else if (typeof value === 'number') {
    out.push(Buffer.from([0x03]));
    wCstr(out, key);
    const b = Buffer.alloc(4);
    b.writeFloatLE(value);
    out.push(b);
  } else if (value === null || value === undefined) {
    out.push(Buffer.from([T_STRING]));
    wCstr(out, key);
    out.push(Buffer.from([0]));
  } else {
    out.push(Buffer.from([T_STRING]));
    wCstr(out, key);
    wCstr(out, value);
  }
}

function normalizeShortcut(entry) {
  const out = {};
  for (const f of FIELD_ORDER) {
    if (f === 'tags') {
      const tags = entry.tags || {};
      if (Array.isArray(tags)) {
        out.tags = Object.fromEntries(tags.map((t, i) => [String(i), String(t)]));
      } else {
        out.tags = Object.fromEntries(Object.entries(tags).map(([k, v]) => [String(k), String(v)]));
      }
    } else {
      out[f] = entry[f] !== undefined ? entry[f] : FIELD_DEFAULTS[f];
    }
  }
  for (const [k, v] of Object.entries(entry)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/** shortcuts.vdf -> array of entries (index = position). Missing file -> []. */
function loadShortcuts(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const root = new Reader(fs.readFileSync(filePath)).readRoot();
  const sc = (root && root.shortcuts) || {};
  return Object.keys(sc)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => normalizeShortcut(sc[k]));
}

function dumpShortcuts(entries) {
  const indexed = {};
  entries.forEach((e, i) => { indexed[String(i)] = normalizeShortcut(e); });
  const out = [];
  wValue(out, 'shortcuts', indexed);
  out.push(Buffer.from([T_END]));
  return Buffer.concat(out);
}

// Low-level writer. Production writes use steam.saveEntries() so the file is backed up first.
function saveShortcuts(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, dumpShortcuts(entries));
  fs.renameSync(tmp, filePath);
}

module.exports = {
  FIELD_ORDER, normalizeShortcut, loadShortcuts, dumpShortcuts, saveShortcuts,
};
