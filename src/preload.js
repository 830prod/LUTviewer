'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('lutviewer', {
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    read: (id) => ipcRenderer.invoke('library:read', id),
    import: (paths) => ipcRenderer.invoke('library:import', paths),
    update: (id, patch) => ipcRenderer.invoke('library:update', id, patch),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    reveal: () => ipcRenderer.invoke('library:reveal'),
  },
  dialogs: {
    luts: () => ipcRenderer.invoke('dialog:luts'),
    media: () => ipcRenderer.invoke('dialog:media'),
  },
  media: {
    prepare: (p) => ipcRenderer.invoke('media:prepare', p),
    proxy: (p) => ipcRenderer.invoke('media:proxy', p),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  win: {
    pin: (on) => ipcRenderer.invoke('window:pin', on),
    dock: () => ipcRenderer.invoke('window:dock'),
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
  progress: (info) => ipcRenderer.send('app:progress', info),
  ready: () => ipcRenderer.send('app:ready'),
  onOpenPaths: on('app:open-paths'),
  onSplashProgress: on('splash:progress'),
  onMenu: (name, fn) => on(`menu:${name}`)(fn),
  update: {
    install: () => ipcRenderer.invoke('update:install'),
    skip: () => ipcRenderer.invoke('update:skip'),
    check: () => ipcRenderer.invoke('update:check'),
    onAvailable: on('update:available'),
    onProgress: on('update:progress'),
  },
  version: () => ipcRenderer.invoke('app:version'),
  rating: { send: (stars) => ipcRenderer.invoke('rating:send', stars) },
  about: { info: () => ipcRenderer.invoke('about:info'), rate: () => ipcRenderer.invoke('about:rate') },
  openUrl: (url) => ipcRenderer.invoke('shell:open-url', url),
  exportVideo: {
    save: (data, name) => ipcRenderer.invoke('export:save', data, name),
    reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  },
});
