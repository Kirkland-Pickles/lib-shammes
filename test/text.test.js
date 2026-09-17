'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('text hygiene', () => {
  it('has no emdash/arrow glyphs in release text files', () => {
    const root = path.join(__dirname, '..');
    const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const bad = [];
    for (const f of files) {
      if (f.startsWith('test/fixtures') || f === 'package-lock.json') continue;
      let text;
      try {
        text = fs.readFileSync(path.join(root, ...f.split('/')), 'utf8');
      } catch { continue; }
      if (text.includes('\ufffd')) continue;
      const hits = [];
      for (const [ch, name] of [['\u2014', 'emdash'], ['\u2192', 'arrow'], ['\u2013', 'endash']]) {
        if (text.includes(ch)) hits.push(name);
      }
      if (hits.length) bad.push(`${f}: ${hits.join(',')}`);
    }
    assert.deepEqual(bad, []);
  });
});
