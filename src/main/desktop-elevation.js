'use strict';
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { createDesktop, pathKey, sharedDesktop } = require('./desktop');

function elevateShortcut(app, row) {
  return new Promise((resolve, reject) => {
    const pipe = `\\\\.\\pipe\\lib-shammes-desktop-${randomUUID()}`;
    let socket;
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      server.close();
      if (error) reject(error); else resolve(value);
    };
    const server = net.createServer((connection) => {
      if (socket) { connection.destroy(); return; }
      socket = connection;
      socket.setEncoding('utf8');
      socket.write(JSON.stringify(row) + '\n');
      let response = '';
      socket.on('data', (chunk) => {
        response += chunk;
        if (response.length > 1024 * 1024) { finish(new Error('Invalid shortcut helper response.')); return; }
        if (!response.includes('\n')) return;
        try {
          const result = JSON.parse(response);
          finish(result.error ? Object.assign(new Error(result.error), { code: result.code }) : null, result.row);
        } catch (e) { finish(e); }
      });
      socket.on('end', () => { if (!finished) finish(new Error('Shortcut helper closed without a result.')); });
      socket.on('error', finish);
    });
    const timer = setTimeout(() => finish(new Error('Desktop permission request timed out.')), 120000);
    server.on('error', finish);
    server.listen(pipe, () => {
      const quote = (value) => `'${value.replace(/'/g, "''")}'`;
      const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--desktop-shortcut-helper', pipe];
      const commandLine = args.map((value) => `"${value}"`).join(' ');
      const script = `try { Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(commandLine)} -Verb RunAs -WindowStyle Hidden -ErrorAction Stop } catch { exit 1 }`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true }, (error) => { if (error) finish(new Error('Desktop permission request was cancelled or denied.')); });
    });
  });
}

async function runShortcutHelper(app, shell, nativeImage, pipe) {
  if (!/^\\\\\.\\pipe\\lib-shammes-desktop-[a-f0-9-]{36}$/.test(pipe || '')) throw new Error('Invalid shortcut helper request.');
  const common = await sharedDesktop();
  await new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    let request = '';
    let received = false;
    socket.setEncoding('utf8');
    socket.setTimeout(30000, () => socket.destroy(new Error('Shortcut helper timed out.')));
    socket.on('error', reject);
    socket.on('data', async (chunk) => {
      if (received) return;
      request += chunk;
      if (request.length > 1024 * 1024) { socket.destroy(new Error('Shortcut request is too large.')); return; }
      if (!request.includes('\n')) return;
      received = true;
      try {
        const row = JSON.parse(request);
        if (!row.shortcut || pathKey(path.dirname(row.shortcut)) !== pathKey(common)) throw new Error('Only existing shared Desktop shortcuts can be updated.');
        const desktop = createDesktop({ app, shell, nativeImage, personal: common, shared: common });
        const saved = await desktop.write(row);
        socket.end(JSON.stringify({ row: saved }) + '\n');
      } catch (e) { socket.end(JSON.stringify({ error: e.message, code: e.code }) + '\n'); }
    });
    socket.on('close', resolve);
  });
}

module.exports = { elevateShortcut, runShortcutHelper };
