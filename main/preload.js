'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Мост между страницей и главным процессом.
 *
 * Наружу отдаётся только перечисленный API — ни require, ни process
 * в renderer не попадают, поэтому страница входа и галерея не могут
 * запускать произвольные команды.
 */

const listeners = new Map();

function on(channel, callback) {
  const wrapped = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  listeners.set(callback, { channel, wrapped });
  return () => {
    const entry = listeners.get(callback);
    if (entry) {
      ipcRenderer.removeListener(entry.channel, entry.wrapped);
      listeners.delete(callback);
    }
  };
}

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    setTheme: (theme) => ipcRenderer.invoke('settings:setTheme', theme),
    chooseDir: () => ipcRenderer.invoke('settings:chooseDir'),
    resetDir: () => ipcRenderer.invoke('settings:resetDir'),
    openDir: () => ipcRenderer.invoke('settings:openDir')
  },

  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout')
  },

  video: {
    fetch: (url) => ipcRenderer.invoke('video:fetch', url)
  },

  download: {
    start: (payload) => ipcRenderer.invoke('download:start', payload),
    cancel: () => ipcRenderer.invoke('download:cancel'),
    state: () => ipcRenderer.invoke('download:state')
  },

  gallery: {
    list: () => ipcRenderer.invoke('gallery:list'),
    thumbnail: (payload) => ipcRenderer.invoke('gallery:thumbnail', payload),
    delete: (filePath) => ipcRenderer.invoke('gallery:delete', filePath),
    openDir: () => ipcRenderer.invoke('gallery:openDir')
  },

  app: {
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openFile: (filePath) => ipcRenderer.invoke('app:openFile', filePath),
    showInFolder: (filePath) => ipcRenderer.invoke('app:showInFolder', filePath)
  },

  on
});
