'use strict';
const { app, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const net = require('net');
const { randomUUID } = require('crypto');
const { createDesktop, linkFlags, shortcutName } = require('../src/main/desktop');
const { runShortcutHelper } = require('../src/main/desktop-elevation');
const root = process.argv[2];
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const personal = path.join(root, 'Personal Desktop');
  const shared = path.join(root, 'Shared Desktop');
  const iconDir = path.join(root, 'Desktop icons');
  const startMenu = path.join(root, 'Programs'), sharedStartMenu = path.join(root, 'Common Programs');
  for (const dir of [personal, shared]) fs.mkdirSync(dir);
  const exe = path.join(root, 'Game 日本語.exe');
  fs.copyFileSync(process.execPath, exe);
  const desktop = createDesktop({ app, shell, nativeImage, personal, shared, iconDir });
  const resourcePreview = await desktop.preview(exe, 0);
  assert.ok(!nativeImage.createFromDataURL(resourcePreview).isEmpty());
  assert.equal(await desktop.preview(exe, 0), resourcePreview);
  assert.equal(await desktop.preview(exe), resourcePreview);
  const games = [{ exePath: exe, displayName: 'Game', query: 'Game title', candidates: [{ path: exe }] }];
  let { rows } = await desktop.discover([...games, { exePath: exe, query: 'game' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].display, 'Game title');
  assert.equal(rows[0].admin, false);
  const alternate = path.join(root, 'Launcher.exe');
  fs.writeFileSync(alternate, 'fixture');
  const alternateLink = path.join(personal, 'Existing launcher.lnk');
  assert.ok(shell.writeShortcutLink(alternateLink, 'create', { target: alternate }));
  const alternateRows = (await desktop.discover([{ ...games[0], candidates: [{ path: exe }, { path: alternate }] }])).rows;
  assert.equal(alternateRows.length, 1);
  assert.equal(alternateRows[0].shortcut, alternateLink);
  assert.equal(alternateRows[0].exe, alternate);
  fs.unlinkSync(alternateLink);
  const unrelated = path.join(personal, 'Game title.lnk');
  fs.writeFileSync(unrelated, 'not a shortcut');
  let result = await desktop.apply([{ ...rows[0], args: '--profile "two words" & literal', admin: true }]);
  assert.equal(result[0].ok, true, result[0].error);
  let saved = result[0].row;
  assert.equal(path.basename(saved.shortcut), 'Game title (2).lnk');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'not a shortcut');
  fs.unlinkSync(unrelated);
  let read = desktop.read(saved.shortcut);
  assert.equal(read.target, exe);
  assert.equal(read.args, '--profile "two words" & literal');
  assert.equal(read.cwd, root);
  assert.equal(read.admin, true);
  assert.ok(linkFlags(fs.readFileSync(saved.shortcut)) & 0x2000);
  const initialFlags = linkFlags(fs.readFileSync(saved.shortcut));
  const originalFileId = fs.statSync(saved.shortcut).ino;
  result = await desktop.apply([{ ...saved, admin: false }]);
  assert.equal(result[0].ok, true, result[0].error);
  saved = result[0].row;
  assert.equal(desktop.read(saved.shortcut).admin, false);
  assert.equal(fs.statSync(saved.shortcut).ino, originalFileId);
  assert.equal(linkFlags(fs.readFileSync(saved.shortcut)), initialFlags & ~0x2000);
  result = await desktop.apply([{ ...saved, display: saved.display.toUpperCase() }]);
  assert.equal(result[0].ok, true, result[0].error);
  saved = result[0].row;
  assert.ok(fs.readdirSync(personal).includes(`${saved.display}.lnk`));
  assert.equal(fs.statSync(saved.shortcut).ino, originalFileId);

  const variant = path.join(shared, 'Other variant.lnk');
  assert.ok(shell.writeShortcutLink(variant, 'create', { target: exe, cwd: personal, args: '-windowed', description: 'keep this', icon: exe, iconIndex: 0 }));
  rows = (await desktop.discover(games)).rows;
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.id)).size, 2);
  const sharedRow = rows.find((row) => row.shortcut === variant);
  const variantFileId = fs.statSync(variant).ino;
  result = await desktop.apply([{ ...sharedRow, display: 'Renamed 日本語', args: '-fullscreen', admin: true }]);
  assert.equal(result[0].ok, true, result[0].error);
  assert.equal(path.dirname(result[0].row.shortcut), shared);
  assert.equal(fs.statSync(result[0].row.shortcut).ino, variantFileId);
  read = desktop.read(result[0].row.shortcut);
  assert.equal(read.cwd, personal);
  assert.equal(read.description, 'keep this');
  assert.equal(read.icon, exe);
  assert.equal(read.admin, true);
  assert.equal(desktop.read(saved.shortcut).args, '--profile "two words" & literal');

  assert.ok(shell.writeShortcutLink(saved.shortcut, 'update', { args: '-external' }));
  saved.sgdbId = 17;
  saved.sgdbName = 'Matched game';
  result = await desktop.apply([{ ...saved, args: '-should-not-write' }]);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].refreshed, true);
  assert.equal(result[0].row.args, '-external');
  assert.equal(result[0].row.iconChoice, null);
  assert.equal(result[0].row.sgdbId, 17);
  assert.equal(result[0].row.sgdbName, 'Matched game');
  assert.equal(desktop.read(saved.shortcut).args, '-external');
  assert.ok(shell.writeShortcutLink(saved.shortcut, 'update', { target: alternate }));
  const retargeted = (await desktop.apply([saved]))[0];
  assert.equal(retargeted.refreshed, true);
  assert.equal(retargeted.row.sgdbId, null);
  assert.ok(shell.writeShortcutLink(saved.shortcut, 'update', { target: exe }));
  saved = (await desktop.discover(games)).rows.find((row) => row.shortcut === saved.shortcut);
  const resource = await desktop.apply([{ ...saved, iconChoice: { file: exe } }]);
  assert.equal(resource[0].ok, true, resource[0].error);
  saved = resource[0].row;
  assert.equal(desktop.read(saved.shortcut).icon, exe);
  const image = path.join(root, 'custom.png');
  fs.writeFileSync(image, nativeImage.createFromBitmap(Buffer.alloc(16, 255), { width: 2, height: 2 }).toPNG());
  const batchPersonal = path.join(root, 'Batch Desktop'), batchShared = path.join(root, 'Batch Shared');
  for (const dir of [batchPersonal, batchShared]) fs.mkdirSync(dir);
  const batch = createDesktop({ app, shell, nativeImage, personal: batchPersonal, shared: batchShared,
    iconDir: path.join(root, 'Batch icons') });
  const batchRows = Array.from({ length: 4 }, (_, id) => ({ id: `batch:${id}`, exe, display: `Batch game ${id}`,
    args: `--profile ${id}`, admin: false, iconChoice: { file: image } }));
  const created = await batch.apply(batchRows);
  assert.equal(created.filter(result => result.ok).length, 4, JSON.stringify(created));
  for (const result of created) {
    const link = batch.read(result.row.shortcut);
    assert.equal(link.target, exe);
    assert.equal(link.args, result.row.args);
    assert.ok(fs.existsSync(link.icon));
    assert.equal(path.basename(result.row.shortcut), `${result.row.display}.lnk`);
  }
  const updated = await batch.apply(created.map(result => ({ ...result.row, args: '--updated', iconChoice: { exeIcon: true } })));
  assert.equal(updated.filter(result => result.ok).length, 4, JSON.stringify(updated));
  assert.equal(fs.readdirSync(batchPersonal).filter(file => file.endsWith('.lnk')).length, 4);
  for (const result of updated) {
    assert.equal(batch.read(result.row.shortcut).args, '--updated');
    assert.equal(batch.read(result.row.shortcut).icon, '');
  }
  const menus = createDesktop({ app, shell, nativeImage, personal, shared, startMenu, sharedStartMenu,
    iconDir: path.join(root, 'Menu icons') });
  const menuRows = (await menus.discover(games, 'both')).rows;
  assert.equal(menuRows.filter(row => row.destination === 'start-menu').length, 1);
  assert.equal(menuRows.filter(row => row.destination === 'desktop').length, 2);
  const menuResult = await menus.apply([{ ...menuRows.find(row => row.destination === 'start-menu'), iconChoice: { file: image } }]);
  assert.equal(menuResult[0].ok, true, menuResult[0].error);
  const menuLink = menuResult[0].row;
  assert.equal(path.dirname(menuLink.shortcut), startMenu);
  assert.equal(menus.read(menuLink.shortcut).target, exe);
  const menuIcon = menus.read(menuLink.shortcut).icon;
  const publisher = path.join(sharedStartMenu, 'Publisher');
  fs.mkdirSync(publisher, { recursive: true });
  const nested = path.join(publisher, 'Variant.lnk');
  assert.ok(shell.writeShortcutLink(nested, 'create', { target: exe, args: '-variant' }));
  const menuVariants = (await menus.discover(games, 'start-menu')).rows;
  assert.equal(menuVariants.length, 2);
  const nestedResult = await menus.apply([{ ...menuVariants.find(row => row.shortcut === nested), args: '-updated' }]);
  assert.equal(nestedResult[0].ok, true, nestedResult[0].error);
  assert.equal(menus.read(nested).args, '-updated');
  assert.equal(menus.read(menuLink.shortcut).args, '');
  const startup = path.join(startMenu, 'Startup');
  fs.mkdirSync(startup);
  const startupLink = path.join(startup, 'Game.lnk');
  assert.ok(shell.writeShortcutLink(startupLink, 'create', { target: exe }));
  assert.equal((await menus.discover(games, 'start-menu')).rows.length, 2);
  const forbidden = await menus.apply([{ ...menuLink, icon: '', shortcut: startupLink, signature: menus.read(startupLink).signature }]);
  assert.equal(forbidden[0].ok, false);
  assert.deepEqual(await menus.cleanup(), []);
  assert.equal(menus.read(menuLink.shortcut).icon, '');
  assert.equal(fs.existsSync(menuIcon), false);
  result = await desktop.apply([{ ...saved, iconChoice: { file: image } }]);
  assert.equal(result[0].ok, true, result[0].error);
  saved = result[0].row;
  const icon = desktop.read(saved.shortcut).icon;
  assert.equal(path.dirname(icon), iconDir);
  assert.ok(fs.existsSync(icon));
  assert.ok(fs.existsSync(path.join(iconDir, 'shortcuts.json')));
  const icoChoice = await desktop.apply([{ ...saved, iconChoice: { file: icon } }]);
  assert.equal(icoChoice[0].ok, true, icoChoice[0].error);
  const bitmapIcon = Buffer.alloc(86);
  bitmapIcon.writeUInt16LE(1, 2); bitmapIcon.writeUInt16LE(1, 4);
  bitmapIcon[6] = bitmapIcon[7] = 2;
  bitmapIcon.writeUInt16LE(1, 10); bitmapIcon.writeUInt16LE(32, 12);
  bitmapIcon.writeUInt32LE(64, 14); bitmapIcon.writeUInt32LE(22, 18);
  bitmapIcon.writeUInt32LE(40, 22); bitmapIcon.writeInt32LE(2, 26); bitmapIcon.writeInt32LE(4, 30);
  bitmapIcon.writeUInt16LE(1, 34); bitmapIcon.writeUInt16LE(32, 36);
  bitmapIcon.fill(255, 62, 78);
  const previousFetch = global.fetch;
  try {
    global.fetch = async () => new Response(bitmapIcon);
    const [downloaded] = await desktop.apply([{ ...icoChoice[0].row, iconChoice: { url: 'https://example.invalid/icon.ico' } }]);
    assert.equal(downloaded.ok, true, downloaded.error);
    assert.equal(downloaded.warning, undefined);
    assert.deepEqual(fs.readFileSync(desktop.read(downloaded.row.shortcut).icon), bitmapIcon);
  } finally { global.fetch = previousFetch; }
  const beforeCleanup = desktop.read(saved.shortcut);
  assert.deepEqual(await desktop.cleanup(), []);
  read = desktop.read(saved.shortcut);
  assert.equal(read.icon, '');
  assert.equal(read.args, beforeCleanup.args);
  assert.equal(read.cwd, beforeCleanup.cwd);
  assert.equal(read.admin, beforeCleanup.admin);
  assert.equal(fs.existsSync(icon), false);

  saved = (await desktop.discover(games)).rows.find((row) => row.shortcut === saved.shortcut);
  result = await desktop.apply([{ ...saved, iconChoice: { file: image } }]);
  saved = result[0].row;
  const retainedIcon = desktop.read(saved.shortcut).icon;
  const failedCleanup = createDesktop({ app, nativeImage, personal, shared, iconDir,
    shell: { ...shell, writeShortcutLink: () => false } });
  assert.ok((await failedCleanup.cleanup()).length > 0);
  assert.ok(fs.existsSync(retainedIcon));
  assert.equal(desktop.read(saved.shortcut).icon, retainedIcon);
  assert.deepEqual(await desktop.cleanup(), []);

  const denied = createDesktop({ app, nativeImage, personal, shared, iconDir,
    shell: { ...shell, writeShortcutLink() { const e = new Error('denied'); e.code = 'EACCES'; throw e; } },
    elevate: async () => { throw new Error('Permission cancelled'); } });
  const victim = (await desktop.discover(games)).rows.find((row) => path.dirname(row.shortcut) === shared);
  const before = fs.readFileSync(victim.shortcut);
  result = await denied.apply([{ ...victim, args: '-new' }]);
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /cancelled/);
  assert.deepEqual(fs.readFileSync(victim.shortcut), before);
  assert.ok(!fs.readdirSync(shared).some((name) => name.startsWith('.lib-shammes-')));
  saved = (await desktop.discover(games)).rows.find((row) => row.shortcut === saved.shortcut);
  result = await desktop.apply([{ ...victim, exe: path.join(root, 'missing.exe') }, saved]);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].error, 'Choose an existing executable.');
  assert.equal(result[1].ok, true, result[1].error);
  const missingIcon = await desktop.apply([{ ...result[1].row, iconChoice: { file: path.join(root, 'missing.png') } }]);
  assert.equal(missingIcon[0].error, 'Choose an existing icon source.');

  let manifestWrites = 0;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(iconDir, 'shortcuts.json') && ++manifestWrites === 2) throw new Error('manifest write denied');
    return rename(from, to);
  };
  const fresh = { ...games[0], id: 'exe:retry', exe, display: 'Retry fixture', iconChoice: { file: image } };
  try { result = await desktop.apply([fresh]); }
  finally { fs.renameSync = rename; }
  assert.equal(result[0].ok, true);
  assert.match(result[0].warning, /icon records could not be saved/);
  const count = fs.readdirSync(personal).length;
  const retry = await desktop.apply([result[0].row]);
  assert.equal(retry[0].ok, true);
  assert.equal(fs.readdirSync(personal).length, count);
  const iconRecords = path.join(iconDir, 'shortcuts.json');
  assert.ok(Object.values(JSON.parse(fs.readFileSync(iconRecords))).some(links => links.includes(null)));
  assert.ok((await desktop.cleanup()).length > 0);
  assert.ok(fs.existsSync(result[0].row.icon));

  const isolatedIcons = path.join(root, 'Moved icons');
  const movedDesktop = createDesktop({ app, shell, nativeImage, personal, shared, iconDir: isolatedIcons });
  let moved = (await movedDesktop.apply([{ ...fresh, display: 'Move fixture' }]))[0].row;
  moved = (await movedDesktop.apply([{ ...moved, display: 'Renamed fixture' }]))[0].row;
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(path.join(isolatedIcons, 'shortcuts.json')))), [[moved.shortcut]]);
  const subfolder = path.join(personal, 'Games'); fs.mkdirSync(subfolder);
  const movedPath = path.join(subfolder, path.basename(moved.shortcut));
  fs.renameSync(moved.shortcut, movedPath);
  const missingLink = (await movedDesktop.apply([moved]))[0];
  assert.equal(missingLink.refreshed, true);
  assert.equal(missingLink.row, null);
  assert.ok((await movedDesktop.cleanup()).length > 0);
  assert.ok(fs.existsSync(movedDesktop.read(movedPath).icon));

  fs.writeFileSync(iconRecords, '{bad');
  const ordinary = await desktop.apply([{ ...fresh, display: 'No custom icon', iconChoice: null }]);
  assert.equal(ordinary[0].ok, true);
  await assert.rejects(desktop.cacheIcon({ file: image }), /Desktop icon records could not be read/);
  await assert.rejects(desktop.cleanup(), /Desktop icon records could not be read/);
  assert.equal(fs.readFileSync(iconRecords, 'utf8'), '{bad');
  assert.equal(shortcutName('CON'), '_CON');
  assert.equal(shortcutName('LEGO Batman: Legacy of the Dark Knight'), 'LEGO Batman - Legacy of the Dark Knight');
  assert.equal(shortcutName('a/b*? '), 'a_b__');
  const pipe = `\\\\.\\pipe\\lib-shammes-desktop-${randomUUID()}`;
  let reply;
  const response = new Promise((resolve) => { reply = resolve; });
  const server = net.createServer((socket) => {
    let received = '';
    socket.setEncoding('utf8');
    socket.write(JSON.stringify(victim) + '\n');
    socket.on('data', (chunk) => {
      received += chunk;
      if (received.includes('\n')) { reply(JSON.parse(received)); socket.end(); }
    });
  });
  await new Promise((resolve) => server.listen(pipe, resolve));
  try {
    const helper = runShortcutHelper(app, shell, nativeImage, pipe);
    assert.match((await response).error, /Only existing shared Desktop/);
    await helper;
    assert.deepEqual(fs.readFileSync(victim.shortcut), before);
  } finally { server.close(); }
  console.log('Desktop fixture checks passed');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
