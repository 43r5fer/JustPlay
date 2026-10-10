'use strict';

const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');
const { registerRobloxIpc } = require('./roblox.cjs');

let mainWindow = null;
let updateState = { status: 'idle', currentVersion: app.getVersion() };

function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:update-status', updateState);
  }
}

function initializeAutoUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', info => publishUpdateState({
    status: 'available',
    version: String(info.version || ''),
    percent: 0,
    message: 'JustPlay ' + String(info.version || '') + ' is available. Download it, then restart to install.',
  }));
  autoUpdater.on('update-not-available', () => publishUpdateState({
    status: 'not-available',
    version: app.getVersion(),
  }));
  autoUpdater.on('download-progress', progress => {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    publishUpdateState({
      status: 'downloading',
      percent: percent,
      message: 'Downloading update… ' + Math.round(percent) + '%',
    });
  });
  autoUpdater.on('update-downloaded', info => publishUpdateState({
    status: 'downloaded',
    version: String(info.version || updateState.version || ''),
    percent: 100,
    message: 'The update is ready. Restart JustPlay to finish installing it.',
  }));
  autoUpdater.on('error', () => {
    console.warn('[JustPlay updater] An update operation failed.');
    publishUpdateState({
      status: 'error',
      message: 'JustPlay could not check or download updates. Check your internet connection and try again.',
    });
  });
  autoUpdater.checkForUpdates().catch(() => publishUpdateState({
    status: 'error',
    message: 'JustPlay could not check for updates. Check your internet connection and try again.',
  }));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: '#101012',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'justplay.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    initializeAutoUpdater();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerRobloxIpc({ ipcMain, app, shell, safeStorage });

  ipcMain.handle('app:update-status', () => updateState);
  ipcMain.handle('app:update-check', async () => {
    if (!app.isPackaged) {
      return { status: 'unsupported', currentVersion: app.getVersion(), message: 'Update checks are available in the installed build.' };
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      publishUpdateState({ status: 'error', message: 'JustPlay could not check for updates. Check your internet connection and try again.' });
    }
    return updateState;
  });
  ipcMain.handle('app:update-download', async () => {
    if (!app.isPackaged) throw new Error('Update downloads are available in the installed build.');
    if (updateState.status !== 'available') throw new Error('There is no update ready to download.');
    await autoUpdater.downloadUpdate();
    return { ok: true };
  });
  ipcMain.handle('app:update-install', async () => {
    if (!app.isPackaged || updateState.status !== 'downloaded') {
      throw new Error('Download an update before installing it.');
    }
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  console.error('[JustPlay] Startup failed:', error && error.message ? error.message : 'unknown error');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});