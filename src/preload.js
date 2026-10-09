'use strict';
/* Keep ipcRenderer behind this API. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  isDevelopment: () => ipcRenderer.invoke('app:is-development'),
  desktopScan: () => ipcRenderer.invoke('desktop:scan'),
  desktopApply: (rows) => ipcRenderer.invoke('desktop:apply', rows),
  desktopDownload: (rows) => ipcRenderer.invoke('desktop:download', rows),
  desktopIcon: (file, index) => ipcRenderer.invoke('desktop:icon', file, index),
  desktopPickIcon: () => ipcRenderer.invoke('desktop:pick-icon'),
  // config
  cfgGet: () => ipcRenderer.invoke('cfg:get'),
  cfgSet: (patch) => ipcRenderer.invoke('cfg:set', patch),
  // steam
  steamDetect: (hint) => ipcRenderer.invoke('steam:detect', hint),
  steamVerify: (p) => ipcRenderer.invoke('steam:verify', p),
  steamBrowse: () => ipcRenderer.invoke('steam:browse'),
  steamUsers: (steamPath) => ipcRenderer.invoke('steam:users', steamPath),
  steamOpenGrid: () => ipcRenderer.invoke('steam:open-grid'),
  steamRunning: () => ipcRenderer.invoke('steam:running'),
  steamKill: () => ipcRenderer.invoke('steam:kill'),
  steamLaunch: () => ipcRenderer.invoke('steam:launch'),
  steamRestart: () => ipcRenderer.invoke('steam:restart'),
  steamPrune: () => ipcRenderer.invoke('steam:prune'),
  steamRead: () => ipcRenderer.invoke('steam:read'),
  steamGames: () => ipcRenderer.invoke('steam:games'),
  steamPurge: (opts) => ipcRenderer.invoke('steam:purge', opts),
  appWipeData: () => ipcRenderer.invoke('app:wipe-data'),
  steamAdd: (payload) => ipcRenderer.invoke('steam:add', payload),
  steamRemove: (rows) => ipcRenderer.invoke('steam:remove', rows),
  // folders / files / shell
  foldersBrowse: () => ipcRenderer.invoke('folders:browse'),
  filesPickExe: (dir) => ipcRenderer.invoke('files:pick-exe', dir),
  filesPickDir: (dir) => ipcRenderer.invoke('files:pick-dir', dir),
  filesPickImage: () => ipcRenderer.invoke('files:pick-image'),
  shellOpen: (p) => ipcRenderer.invoke('shell:open', p),
  openUrl: (url) => ipcRenderer.invoke('util:open-url', url),
  // sgdb
  keyValidate: (key) => ipcRenderer.invoke('key:validate', key),
  sgdbSearch: (q) => ipcRenderer.invoke('sgdb:search', q),
  sgdbBySteam: (appid) => ipcRenderer.invoke('sgdb:by-steam', appid),
  resolveName: (name) => ipcRenderer.invoke('resolve:name', name),
  artList: (req) => ipcRenderer.invoke('art:list', req),
  artPreviewFile: (file) => ipcRenderer.invoke('art:preview-file', file),
  artCurrent: (req) => ipcRenderer.invoke('art:current', req),
  // library ops (progress streams back on 'job:progress')
  scanStart: (req) => ipcRenderer.invoke('scan:start', req),
  findExecutables: (req) => ipcRenderer.invoke('scan:find-executables', req),
  matchAuto: (req) => ipcRenderer.invoke('match:auto', req),
  artDownload: (req) => ipcRenderer.invoke('art:download', req),
  // progress + log stream from long jobs
  onProgress: (fn) => ipcRenderer.on('job:progress', (_e, p) => fn(p)),
  onLog: (fn) => ipcRenderer.on('job:log', (_e, line) => fn(line)),
  // mouse back/forward buttons from the OS
  onNav: (fn) => ipcRenderer.on('nav:cmd', (_e, dir) => fn(dir)),
});
