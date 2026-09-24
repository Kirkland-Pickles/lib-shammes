'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.join(__dirname, '../src/main/main.js');
const source = fs.readFileSync(filename, 'utf8');
const realRequire = createRequire(filename);

async function uninstall(flags = [], { running = false, backupFails = false, fileFails = false, dataFails = false } = {}) {
  const calls = [];
  let boot;
  const plan = { removeAppids: [1], restoreFields: [], deleteFiles: [{ path: 'art.png' }], skippedFiles: [] };
  const mocks = {
    electron: {
      app: {
        isPackaged: true, whenReady: () => ({ then: (fn) => { boot = fn; } }), on() {},
        getPath: () => 'profile', exit: (code) => calls.push(['exit', code]),
      },
      BrowserWindow: function () { throw new Error('Cleanup must not open the app window'); },
      Menu: { setApplicationMenu() {} }, ipcMain: { handle() {} },
      dialog: {
        showErrorBox: (_, message) => calls.push(['error', message]),
        showMessageBox: (options) => calls.push(['warning', options]),
      },
    },
    fs: {
      existsSync: () => true,
      rmSync: (file) => {
        if (dataFails && file === 'config.json') throw new Error('locked');
        calls.push(['wipe', file]);
      },
      unlinkSync: (file) => { if (fileFails) throw new Error('locked'); calls.push(['delete', file]); },
    },
    './store': {
      load: () => ({ steam_path: 'Steam', steam_user_id: '1' }),
      dataFiles: () => ['config.json', 'changes.json'], dataDirs: () => ['profile'],
      loadChanges: () => ({ files: [{ path: 'art.png', size: 1, mtimeMs: 2 }] }),
      blankChanges: () => ({ shortcuts: [], fields: [], files: [] }),
      saveChanges: (changes) => calls.push(['journal', changes]),
    },
    './steam': {
      normalizeSteamPath: (value) => value, isSteamRunning: async () => running,
      loadEntries: () => [{ appid: 1 }, { appid: 2 }], gridDir: () => 'grid', planPurge: () => plan,
      saveEntries: (_, __, kept) => {
        if (backupFails) throw new Error('Cannot back up shortcuts.vdf');
        calls.push(['purge', kept]);
        return 'shortcuts.vdf.bak';
      },
    },
  };
  vm.runInNewContext(source, {
    require: (name) => mocks[name] || realRequire(name), __dirname: path.dirname(filename),
    process: { argv: ['app.exe', '--uninstall-cleanup', ...flags], platform: 'win32' },
  }, { filename });
  await boot();
  return calls;
}

it('keeps Steam and app data when neither cleanup option is chosen', async () => {
  assert.deepEqual(await uninstall(), [['exit', 0]]);
});

it('can purge Steam without deleting app data', async () => {
  const calls = await uninstall(['--purge-steam']);
  assert.ok(calls.some(([action]) => action === 'purge'));
  assert.ok(!calls.some(([action]) => action === 'wipe'));
  assert.deepEqual(calls.at(-1), ['exit', 0]);
});

it('can delete app data without purging Steam', async () => {
  const calls = await uninstall(['--delete-app-data']);
  assert.ok(calls.some(([action]) => action === 'wipe'));
  assert.ok(!calls.some(([action]) => action === 'purge'));
  assert.deepEqual(calls.at(-1), ['exit', 0]);
});

it('continues uninstall and warns when app data cannot be deleted', async () => {
  const calls = await uninstall(['--delete-app-data'], { dataFails: true });
  const warning = calls.find(([action]) => action === 'warning')[1];
  assert.equal(warning.message, 'Lib Shammes will be uninstalled, but some app data could not be removed and will remain on disk.');
  assert.match(warning.detail, /config\.json \(locked\)/);
  assert.deepEqual(calls.at(-1), ['exit', 0]);
});

it('purges before deleting app data', async () => {
  const calls = await uninstall(['--purge-steam', '--delete-app-data']);
  assert.ok(calls.findIndex(([action]) => action === 'purge') < calls.findIndex(([action]) => action === 'wipe'));
  assert.deepEqual(calls.find(([action]) => action === 'purge')[1], [{ appid: 2 }]);
  assert.deepEqual(calls.at(-1), ['exit', 0]);
});

it('stops before cleanup if Steam is running or its backup fails', async () => {
  for (const options of [{ running: true }, { backupFails: true }]) {
    const calls = await uninstall(['--purge-steam', '--delete-app-data'], options);
    assert.ok(calls.every(([action]) => action === 'error' || action === 'exit'));
    assert.deepEqual(calls.at(-1), ['exit', 1]);
  }
});

it('keeps failed artwork in the journal and does not wipe app data', async () => {
  const calls = await uninstall(['--purge-steam', '--delete-app-data'], { fileFails: true });
  assert.deepEqual(Array.from(calls.find(([action]) => action === 'journal')[1].files), [{ path: 'art.png', size: 1, mtimeMs: 2 }]);
  assert.ok(!calls.some(([action]) => action === 'wipe'));
  assert.deepEqual(calls.at(-1), ['exit', 1]);
});
