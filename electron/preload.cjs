'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('justplay', {
  getState: () => ipcRenderer.invoke('app:state'),
  getDisks: () => ipcRenderer.invoke('app:disks'),
  setup: name => ipcRenderer.invoke('app:setup', name),
  setRam: value => ipcRenderer.invoke('app:set-ram', value),
  signIn: () => ipcRenderer.invoke('account:sign-in'),
  signOut: () => ipcRenderer.invoke('account:sign-out'),
  createLocalAccount: (username, password) => ipcRenderer.invoke('account:local-create', username, password),
  signInLocalAccount: (username, password) => ipcRenderer.invoke('account:local-sign-in', username, password),
  signOutLocalAccount: () => ipcRenderer.invoke('account:local-sign-out'),
  getUpdateStatus: () => ipcRenderer.invoke('app:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('app:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('app:update-download'),
  installUpdate: () => ipcRenderer.invoke('app:update-install'),
  onUpdateStatus: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.removeListener('app:update-status', listener);
  },
  listVersions: () => ipcRenderer.invoke('versions:list'),
  launch: entry => ipcRenderer.invoke('minecraft:launch', entry),
  addFiles: (kind, mcVersion) => ipcRenderer.invoke('files:add', kind, mcVersion),
  listFiles: (kind, mcVersion) => ipcRenderer.invoke('files:list', kind, mcVersion),
  removeFile: (kind, mcVersion, name, folderType) => ipcRenderer.invoke('files:remove', kind, mcVersion, name, folderType),
  openFolder: (target, mcVersion) => ipcRenderer.invoke('folder:open', target, mcVersion),
  openOfficial: kind => ipcRenderer.invoke('external:open', kind),
  onMinecraftStatus: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('minecraft:status', listener);
    return () => ipcRenderer.removeListener('minecraft:status', listener);
  },
});
