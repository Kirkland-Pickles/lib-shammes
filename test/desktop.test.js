'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('Desktop shortcuts round-trip through Electron without touching the real Desktop', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-shammes-desktop-'));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    for (const script of ['desktop.electron.cjs', 'desktop-ui.electron.cjs']) {
      const result = spawnSync(require('electron'), [path.join(__dirname, script), dir],
        { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
      assert.equal(result.status, 0, `${script}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Desktop fixture checks passed/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
