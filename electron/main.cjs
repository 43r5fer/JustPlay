'use strict';

const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let updateState = { status: 'idle', currentVersion: app.getVersion() };

function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('flock:update-status', updateState);
}

function configureUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', info => publishUpdateState({
    status: 'available',
    version: String(info.version || ''),
    message: 'Flock ' + String(info.version || '') + ' is available.'
  }));
  autoUpdater.on('update-not-available', () => publishUpdateState({ status: 'not-available' }));
  autoUpdater.on('download-progress', info => publishUpdateState({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, Number(info.percent) || 0))
  }));
  autoUpdater.on('update-downloaded', info => publishUpdateState({
    status: 'downloaded',
    version: String(info.version || ''),
    message: 'Flock is ready to restart and install the update.'
  }));
  autoUpdater.on('error', () => publishUpdateState({
    status: 'error',
    message: 'Flock could not check for updates right now.'
  }));
  autoUpdater.checkForUpdates().catch(() => {});
}

function configureMediaPermissions() {
  const allowed = new Set(['media', 'audioCapture', 'videoCapture']);
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return String(requestingOrigin || '').startsWith('file://') && allowed.has(permission);
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const origin = details && (details.requestingUrl || details.securityOrigin) || '';
    callback(String(origin).startsWith('file://') && allowed.has(permission));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#111214',
    autoHideMenuBar: true,
    title: 'Flock',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    configureUpdater();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  configureMediaPermissions();
  ipcMain.handle('flock:update-status', () => updateState);
  ipcMain.handle('flock:update-check', async () => {
    if (!app.isPackaged) return { status: 'unsupported', currentVersion: app.getVersion() };
    try { await autoUpdater.checkForUpdates(); }
    catch { publishUpdateState({ status: 'error', message: 'Flock could not check for updates right now.' }); }
    return updateState;
  });
  ipcMain.handle('flock:update-download', async () => {
    if (!app.isPackaged || updateState.status !== 'available') throw new Error('No update is currently available.');
    await autoUpdater.downloadUpdate();
    return { ok: true };
  });
  ipcMain.handle('flock:update-install', async () => {
    if (!app.isPackaged || updateState.status !== 'downloaded') throw new Error('Download a Flock update before installing it.');
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  console.error('[Flock] Startup failed:', error && error.message ? error.message : 'unknown error');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
