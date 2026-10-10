'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flockDesktop', {
  platform: process.platform,
  version: process.env.npm_package_version || '',
  getUpdateStatus: () => ipcRenderer.invoke('flock:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('flock:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('flock:update-download'),
  installUpdate: () => ipcRenderer.invoke('flock:update-install'),
  onUpdateStatus: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('flock:update-status', listener);
    return () => ipcRenderer.removeListener('flock:update-status', listener);
  }
});
