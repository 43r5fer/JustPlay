'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('justplay', {
  robloxState: () => ipcRenderer.invoke('roblox:state'),
  configureRoblox: clientId => ipcRenderer.invoke('roblox:configure', clientId),
  openRobloxOAuthDashboard: () => ipcRenderer.invoke('roblox:open-oauth-dashboard'),
  openRobloxSignup: () => ipcRenderer.invoke('roblox:open-signup'),
  openRobloxApp: () => ipcRenderer.invoke('roblox:open-app'),
  signInRoblox: () => ipcRenderer.invoke('roblox:sign-in'),
  signOutRoblox: () => ipcRenderer.invoke('roblox:sign-out'),
  listRobloxGames: query => ipcRenderer.invoke('roblox:games', query),
  launchRobloxGame: placeId => ipcRenderer.invoke('roblox:launch', placeId),
  getRobloxFavorites: () => ipcRenderer.invoke('roblox:favorites'),
  getRobloxFavoriteGames: () => ipcRenderer.invoke('roblox:favorites-games'),
  toggleRobloxFavorite: placeId => ipcRenderer.invoke('roblox:favorite-toggle', placeId),
  getUpdateStatus: () => ipcRenderer.invoke('app:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('app:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('app:update-download'),
  installUpdate: () => ipcRenderer.invoke('app:update-install'),
  onUpdateStatus: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.removeListener('app:update-status', listener);
  },
});