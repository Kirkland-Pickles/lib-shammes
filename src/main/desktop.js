'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const images = require('./images');
const { SGDBClient } = require('./sgdb');
const exec = promisify(execFile);
const RUN_AS_ADMIN = 0x2000;
const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');

function pathKey(file) {
  let value = String(file || '').replace(/^"|"$/g, '');
  if (!value) return '';
  try { value = fs.realpathSync.native(value); } catch { value = path.resolve(value); }
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function linkFlags(bytes) {
  if (bytes.length < 76 || bytes.readUInt32LE(0) !== 76 || !bytes.subarray(4, 20).equals(LINK_CLSID)) {
    throw new Error('Invalid Windows shortcut.');
  }
  return bytes.readUInt32LE(20);
}

function fingerprint(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function shortcutName(name) {
  let clean = String(name || '').replace(/:\s*/g, ' - ').replace(/[<>"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 160).replace(/[ .]+$/, '');
  if (!clean) throw new Error('Enter a shortcut name.');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `_${clean}`;
  return clean;
}

async function sharedDesktop() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath('CommonDesktopDirectory')"],
  { windowsHide: true, timeout: 10000 });
  const folder = stdout.trim();
  if (!path.isAbsolute(folder)) throw new Error('Could not locate the shared Desktop.');
  return folder;
}

async function notifyShell(changes) {
  if (!changes.length) return;
  const events = [...changes, ...[...new Set(changes.map(([, file]) => path.dirname(file)))].map((dir) => [0x1000, dir])];
  const payload = Buffer.from(JSON.stringify(events), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DesktopChanges { [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern void SHChangeNotify(int change, uint flags, string file, string destination); }';
    $changes = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json;
    foreach ($change in $changes) { $destination = $null; if ($change.Count -gt 2) { $destination = [string]$change[2] }; [DesktopChanges]::SHChangeNotify([int]$change[0], 0x1005, [string]$change[1], $destination) }`;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 20000 });
}

function createDesktop({ app, shell, nativeImage, personal, shared, iconDir, elevate }) {
  const iconPreviews = new Map();
  let commonDesktop;
  const common = () => commonDesktop ||= shared ? Promise.resolve(shared) : sharedDesktop().catch((e) => { commonDesktop = null; throw e; });
  const roots = async () => [...new Set([personal || app.getPath('desktop'), await common()])];
  const cacheDir = () => iconDir || path.join(process.env.LOCALAPPDATA, 'Lib Shammes', 'Desktop icons');
  const manifestPath = () => path.join(cacheDir(), 'shortcuts.json');
  const ownsIcon = (file) => !!file && pathKey(path.dirname(file)) === pathKey(cacheDir()) && /^[a-f0-9]{64}\.ico$/.test(path.basename(file));
  function manifest() {
    try {
      const value = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(links =>
        !Array.isArray(links) || links.some(file => file !== null && typeof file !== 'string'))) throw new Error('Invalid icon records.');
      return value;
    } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new Error(`Desktop icon records could not be read. Existing icons were kept. ${e.message}`);
    }
  }
  function saveManifest(value) {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const temp = `${manifestPath()}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(value, null, 2));
      fs.renameSync(temp, manifestPath());
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  function read(file) {
    const bytes = fs.readFileSync(file);
    const flags = linkFlags(bytes);
    return { ...shell.readShortcutLink(file), admin: !!(flags & RUN_AS_ADMIN),
      signature: createHash('sha256').update(bytes).digest('hex') };
  }
  async function discover(games) {
    const byExe = new Map();
    for (const game of games) if (game.exePath && !byExe.has(pathKey(game.exePath))) byExe.set(pathKey(game.exePath), game);
    const primary = new Map(byExe);
    for (const game of primary.values()) for (const candidate of game.candidates || []) {
      if (!byExe.has(pathKey(candidate.path))) byExe.set(pathKey(candidate.path), game);
    }
    const found = new Set();
    const rows = [];
    const warnings = [];
    for (const dir of await roots()) {
      let files;
      try { files = fs.readdirSync(dir); }
      catch (e) { if (e.code !== 'ENOENT') warnings.push(`${dir}: ${e.message}`); continue; }
      for (const name of files.filter((name) => /\.lnk$/i.test(name))) {
        const file = path.join(dir, name);
        try {
          const details = read(file);
          const key = pathKey(details.target);
          const game = byExe.get(key);
          if (!game) continue;
          found.add(pathKey(game.exePath));
          rows.push({ ...game, id: `link:${pathKey(file)}`, shortcut: file, signature: details.signature,
            display: path.basename(file, path.extname(file)), exe: details.target, cwd: details.cwd,
            args: details.args, admin: details.admin, icon: details.icon, iconIndex: details.iconIndex });
        } catch (e) { warnings.push(`${file}: ${e.message}`); }
      }
    }
    for (const [key, game] of primary) if (!found.has(key)) rows.push({ ...game, id: `exe:${key}`,
      display: game.query || game.displayName, exe: game.exePath, cwd: path.dirname(game.exePath),
      args: '', admin: false, icon: '', iconIndex: 0 });
    return { rows, warnings };
  }
  function validateTarget(exe) {
    if (!path.isAbsolute(exe) || path.extname(exe).toLowerCase() !== '.exe' || !fs.statSync(exe, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Choose an existing executable.');
    }
  }
  async function write(row) {
    validateTarget(row.exe);
    const desktopRoots = await roots();
    const original = row.shortcut || null;
    if (original && (!desktopRoots.some((dir) => pathKey(dir) === pathKey(path.dirname(original)))
      || path.extname(original).toLowerCase() !== '.lnk' || fs.lstatSync(original).isSymbolicLink())) {
      throw new Error('Shortcut is not on the Desktop. Refresh and try again.');
    }
    const before = original ? read(original) : null;
    if (before && before.signature !== row.signature) throw Object.assign(new Error('Shortcut refreshed. Review changes and apply again.'), { code: 'DESKTOP_CHANGED' });
    const dir = original ? path.dirname(original) : desktopRoots[0];
    const name = shortcutName(row.display);
    let destination = path.join(dir, `${name}.lnk`);
    for (let suffix = 2; fs.existsSync(destination) && pathKey(destination) !== pathKey(original); suffix++) {
      destination = path.join(dir, `${name} (${suffix}).lnk`);
    }
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-shammes-link-'));
    const temp = path.join(staging, 'shortcut.lnk');
    const options = { target: row.exe, cwd: before ? before.cwd : path.dirname(row.exe), args: String(row.args || ''),
      icon: String(row.icon || ''), iconIndex: Number.isInteger(row.iconIndex) ? row.iconIndex : 0 };
    try {
      if (original) fs.copyFileSync(original, temp, fs.constants.COPYFILE_EXCL);
      if (!shell.writeShortcutLink(temp, original ? 'update' : 'create', options)) throw new Error('Could not write shortcut.');
      const bytes = fs.readFileSync(temp);
      const flags = linkFlags(bytes);
      bytes.writeUInt32LE((row.admin ? flags | RUN_AS_ADMIN : flags & ~RUN_AS_ADMIN) >>> 0, 20);
      fs.writeFileSync(temp, bytes);
      const checked = read(temp);
      if (pathKey(checked.target) !== pathKey(options.target) || checked.args !== options.args
        || checked.cwd !== options.cwd || checked.icon !== options.icon || checked.iconIndex !== options.iconIndex
        || checked.admin !== !!row.admin) throw new Error('Shortcut verification failed.');
      if (original && fingerprint(original) !== row.signature) throw Object.assign(new Error('Shortcut refreshed. Review changes and apply again.'), { code: 'DESKTOP_CHANGED' });
      if (original) {
        const backup = fs.readFileSync(original);
        const fd = fs.openSync(original, 'r+');
        try {
          fs.writeFileSync(fd, bytes);
          fs.ftruncateSync(fd, bytes.length);
          if (!fs.readFileSync(original).equals(bytes)) throw new Error('Shortcut verification failed.');
          if (path.basename(destination) !== path.basename(original)) {
            const quote = (value) => `'${value.replace(/'/g, "''")}'`;
            await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
              `try { Rename-Item -LiteralPath ${quote(original)} -NewName ${quote(path.basename(destination))} -ErrorAction Stop } catch { if ($_.CategoryInfo.Category -eq 'PermissionDenied') { exit 5 }; throw }`],
            { windowsHide: true, timeout: 10000 });
          }
        } catch (e) {
          fs.writeSync(fd, backup, 0, backup.length, 0);
          fs.ftruncateSync(fd, backup.length);
          if (e.code === 5) e.code = 'EACCES';
          throw e;
        } finally { fs.closeSync(fd); }
      } else {
        fs.copyFileSync(temp, destination, fs.constants.COPYFILE_EXCL);
      }
      return { ...row, shortcut: destination, id: `link:${pathKey(destination)}`, signature: checked.signature, cwd: options.cwd };
    } finally {
      try { fs.unlinkSync(temp); } catch {}
      try { fs.rmdirSync(staging); } catch {}
    }
  }
  async function writeWithElevation(row) {
    try { return await write(row); }
    catch (e) {
      if (!elevate || !['EACCES', 'EPERM'].includes(e.code) || !row.shortcut) throw e;
      if (pathKey(path.dirname(row.shortcut)) !== pathKey(await common())) throw e;
      return elevate(row);
    }
  }
  async function prepareIcon(choice) {
    let bytes;
    if (choice.file) {
      const stat = fs.statSync(choice.file, { throwIfNoEntry: false });
      if (!path.isAbsolute(choice.file) || !stat?.isFile()) throw new Error('Choose an existing icon source.');
      if (/\.(exe|dll)$/i.test(choice.file)) {
        return choice.file;
      }
      if (stat.size > 32 * 1024 * 1024) throw new Error('Icon image is too large (maximum 32 MB).');
      bytes = fs.readFileSync(choice.file);
    } else {
      const url = new URL(choice.url);
      if (url.protocol !== 'https:') throw new Error('Icon URLs must use HTTPS.');
      try { bytes = await new SGDBClient().downloadBytes(url, 32 * 1024 * 1024); }
      catch (e) { throw new Error(`Icon download failed: ${url} (${e.cause?.code || e.message})`); }
    }
    if (bytes.length >= 22 && bytes.readUInt32LE(0) === 0x10000) {
      const count = bytes.readUInt16LE(4);
      if (!count || 6 + count * 16 > bytes.length) throw new Error('Invalid icon file.');
      for (let i = 0; i < count; i++) {
        const at = 6 + i * 16;
        const size = bytes.readUInt32LE(at + 8), offset = bytes.readUInt32LE(at + 12);
        if (offset < 6 + count * 16 || offset + size > bytes.length) throw new Error('Invalid icon file.');
        const data = bytes.subarray(offset, offset + size);
        if (!images.isPng(data) && (data.length < 40 || ![40, 108, 124].includes(data.readUInt32LE(0)))) {
          throw new Error('Invalid icon file.');
        }
      }
      const file = path.join(cacheDir(), `${createHash('sha256').update(bytes).digest('hex')}.ico`);
      fs.mkdirSync(cacheDir(), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      return file;
    }
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error('This image cannot be used as an icon.');
    const png = image.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
    const file = path.join(cacheDir(), `${createHash('sha256').update(png).digest('hex')}.ico`);
    if (!fs.existsSync(file)) images.writePngIco(png, file);
    return file;
  }
  async function apply(rows, onProgress = () => {}) {
    let records, recordsError;
    try { records = manifest(); } catch (e) { recordsError = e; }
    const results = [];
    const changes = [];
    for (const row of rows) {
      onProgress(results.length, rows.length, row.display);
      try {
        const icon = row.iconChoice && !row.iconChoice.keepIcon
          ? row.iconChoice.exeIcon ? '' : await prepareIcon(row.iconChoice) : row.icon;
        if (recordsError && (ownsIcon(icon) || ownsIcon(row.icon))) throw recordsError;
        const pending = ownsIcon(icon) && records[icon]?.includes(null);
        if (ownsIcon(icon)) {
          records[icon] ||= [];
          // An unfinished write has an unknown shortcut location; retain its icon during cleanup.
          if (!records[icon].includes(null)) records[icon].push(null);
          saveManifest(records);
        }
        const saved = await writeWithElevation({ ...row, icon, iconIndex: row.iconChoice && !row.iconChoice.keepIcon ? 0 : row.iconIndex });
        const renamed = row.shortcut && row.shortcut !== saved.shortcut;
        if (renamed) changes.push([0x1, row.shortcut, saved.shortcut]);
        changes.push([!row.shortcut ? 0x2 : 0x2000, saved.shortcut]);
        const result = { id: row.id, ok: true, row: { ...saved, iconChoice: null } };
        results.push(result);
        if (records && (ownsIcon(icon) || Object.values(records).some(links => links.some(link => link && pathKey(link) === pathKey(row.shortcut))))) {
          for (const [file, links] of Object.entries(records)) {
            records[file] = links.filter(link => link === null || pathKey(link) !== pathKey(row.shortcut));
          }
          if (ownsIcon(icon)) records[icon] = [...records[icon].filter(link => link !== null || pending), saved.shortcut];
          try { saveManifest(records); }
          catch (e) {
            if (ownsIcon(icon) && !records[icon].includes(null)) records[icon].push(null);
            result.warning = `Shortcut saved, but icon records could not be saved: ${e.message}`;
          }
        }
      } catch (e) {
        if (row.shortcut && e.code === 'ENOENT' && !fs.existsSync(row.shortcut)) {
          results.push({ id: row.id, ok: false, refreshed: true, row: null, error: 'Shortcut no longer exists at this location. Its pending changes were discarded.' });
        } else if (e.code === 'DESKTOP_CHANGED') {
          try {
            const link = read(row.shortcut);
            results.push({ id: row.id, ok: false, refreshed: true, error: e.message, row: { ...row,
              display: path.basename(row.shortcut, path.extname(row.shortcut)), exe: link.target, cwd: link.cwd,
              args: link.args, admin: link.admin, icon: link.icon, iconIndex: link.iconIndex,
              signature: link.signature, iconChoice: null, sgdbId: null } });
          } catch (refreshError) { results.push({ id: row.id, ok: false, error: refreshError.message }); }
        } else results.push({ id: row.id, ok: false, error: e.message });
      }
    }
    try { await notifyShell(changes); }
    catch (e) { for (const result of results) if (result.ok) result.warning = [result.warning, `Shortcut saved, but Desktop refresh failed: ${e.message}`].filter(Boolean).join('\n'); }
    return results;
  }
  async function cleanup() {
    const records = manifest();
    const failures = [];
    const changes = [];
    const dirs = await roots();
    for (const dir of dirs) {
      let names;
      try { names = fs.readdirSync(dir); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      for (const name of names.filter((name) => /\.lnk$/i.test(name))) {
        const file = path.join(dir, name);
        try {
          const link = read(file);
          const owned = Object.keys(records).find((icon) => pathKey(icon) === pathKey(link.icon));
          if (owned) records[owned] = [...new Set([...records[owned], file])];
        } catch (e) { failures.push(`${file}: ${e.message}`); }
      }
    }
    for (const [icon, links] of Object.entries(records)) {
      if (!ownsIcon(icon)) continue;
      let retained = failures.length > 0;
      for (const file of links) {
        try {
          if (file === null || !fs.existsSync(file)) throw new Error('Shortcut location is unknown; its icon was kept.');
          const link = read(file);
          if (pathKey(link.icon) !== pathKey(icon)) continue;
          await writeWithElevation({ shortcut: file, signature: link.signature, display: path.basename(file, path.extname(file)),
            exe: link.target, args: link.args, admin: link.admin, icon: '', iconIndex: 0 });
          changes.push([0x2000, file]);
        } catch (e) { retained = true; failures.push(`${file || icon}: ${e.message}`); }
      }
      if (!retained) { fs.rmSync(icon, { force: true }); delete records[icon]; }
    }
    saveManifest(records);
    if (!Object.keys(records).length) { fs.unlinkSync(manifestPath()); try { fs.rmdirSync(cacheDir()); } catch {} }
    try { await notifyShell(changes); } catch (e) { failures.push(`Desktop refresh failed: ${e.message}`); }
    return failures;
  }
  async function cacheIcon(choice) {
    const records = manifest();
    const file = await prepareIcon(choice);
    if (!ownsIcon(file)) return file;
    records[file] ||= [];
    saveManifest(records);
    return file;
  }
  async function preview(file, index) {
    if (index == null && /\.(exe|dll)$/i.test(file)) index = 0;
    if (index == null || !/\.(exe|dll|ico)$/i.test(file)) return (await app.getFileIcon(file, { size: 'large' })).toDataURL();
    if (!Number.isInteger(index)) throw new Error('Invalid icon index.');
    const stat = await fs.promises.stat(file);
    const key = `${file}:${index}:${stat.size}:${stat.mtimeMs}`;
    if (iconPreviews.has(key)) return iconPreviews.get(key);
    const encodedPath = Buffer.from(file, 'utf8').toString('base64');
    const script = `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Drawing;
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ShortcutIcon { [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count); [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon); }';
      $file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
      $handles = New-Object IntPtr[] 1;
      [void][ShortcutIcon]::ExtractIconEx($file, ${index}, $handles, $null, 1);
      if ($handles[0] -eq [IntPtr]::Zero) { throw 'No icon found in the selected file.' }
      try {
        $icon = [Drawing.Icon]::FromHandle($handles[0]); $bitmap = $icon.ToBitmap(); $stream = New-Object IO.MemoryStream;
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png);
        [Console]::Write([Convert]::ToBase64String($stream.ToArray()));
      } finally {
        if ($stream) { $stream.Dispose() }; if ($bitmap) { $bitmap.Dispose() }; if ($icon) { $icon.Dispose() };
        [void][ShortcutIcon]::DestroyIcon($handles[0]);
      }`;
    const pending = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000 }).then(({ stdout }) => `data:image/png;base64,${stdout.trim()}`)
      .catch((error) => { iconPreviews.delete(key); throw error; });
    if (iconPreviews.size >= 64) iconPreviews.delete(iconPreviews.keys().next().value);
    iconPreviews.set(key, pending);
    return pending;
  }
  return { discover, apply, cleanup, write, read, cacheIcon,
    preview };
}

module.exports = { createDesktop, pathKey, linkFlags, shortcutName, sharedDesktop };
