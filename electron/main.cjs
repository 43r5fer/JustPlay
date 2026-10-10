'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
// Updates are checked against verified Minecraft-launcher releases, not unrelated repository releases.
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FORGE_METADATA = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const FORGE_HOME = 'https://files.minecraftforge.net/';
const OPTIFINE_HOME = 'https://optifine.net/downloads';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
let mainWindow;
let microsoftSession = null; // Active session stays in memory; the optional cached session is OS-encrypted.
let cachedMinecraftSession = null;
let javaRuntimeCache = null;
let javaRuntimeCacheAt = 0;
let catalogCache = null;
let catalogCacheAt = 0;
let activeLauncher = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = () => ({ setupComplete: false, displayName: '', rootPath: '', accountName: '', localAccountName: '', javaPath: '', minecraftSkin: null, maxRam: '4G', minRam: '1G', installedProfiles: [] });
const localAccountsFile = () => path.join(app.getPath('userData'), 'accounts.json');
const cachedMinecraftSessionFile = () => path.join(app.getPath('userData'), 'minecraft-session.bin');
const CACHED_SESSION_MAX_AGE_MS = 20 * 60 * 60 * 1000;

let updateState = { status: 'idle', currentVersion: app.getVersion() };

function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:update-status', updateState);
}

function parseLauncherVersion(value) {
  const match = String(value || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareLauncherVersions(left, right) {
  const a = parseLauncherVersion(left);
  const b = parseLauncherVersion(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function requestGithubJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'JustPlay-Minecraft-Launcher',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, response => {
      const chunks = [];
      let totalBytes = 0;
      response.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > 5 * 1024 * 1024) {
          request.destroy(new Error('GitHub response was unexpectedly large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GitHub update endpoint returned HTTP ${response.statusCode || 'unknown'}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('GitHub returned invalid update metadata.'));
        }
      });
    });
    request.setTimeout(12000, () => request.destroy(new Error('GitHub update check timed out.')));
    request.on('error', reject);
  });
}

let updateCheckPromise = null;

async function checkForLauncherUpdates() {
  if (updateCheckPromise) return updateCheckPromise;
  publishUpdateState({
    status: 'checking',
    version: '',
    downloadUrl: '',
    releaseUrl: '',
    message: 'Checking published JustPlay Minecraft launcher releases…',
  });

  updateCheckPromise = (async () => {
    try {
      const releases = await requestGithubJson('https://api.github.com/repos/43r5fer/JustPlay/releases?per_page=100');
      if (!Array.isArray(releases)) throw new Error('Unexpected release metadata.');
      // The Minecraft launcher series is v0.2.x. Later v0.3.x tags in this repository belong
      // to a different app and must never be offered as a JustPlay Minecraft update.
      const candidates = releases.filter(release => {
        if (!release || release.draft || release.prerelease || !/^v0\.2\.\d+$/.test(String(release.tag_name || ''))) return false;
        if (!Array.isArray(release.assets)) return false;
        const exactUrl = `https://github.com/43r5fer/JustPlay/releases/download/${release.tag_name}/JustPlay.exe`;
        return release.assets.some(asset => asset && asset.name === 'JustPlay.exe' && asset.browser_download_url === exactUrl);
      }).sort((a, b) => compareLauncherVersions(b.tag_name, a.tag_name));

      if (!candidates.length) throw new Error('No verified JustPlay Minecraft launcher release was found.');
      const latest = candidates[0];
      const latestVersion = latest.tag_name.slice(1);
      const currentVersion = app.getVersion();
      const asset = latest.assets.find(item => item && item.name === 'JustPlay.exe'
        && item.browser_download_url === `https://github.com/43r5fer/JustPlay/releases/download/${latest.tag_name}/JustPlay.exe`);

      if (compareLauncherVersions(latest.tag_name, currentVersion) > 0) {
        publishUpdateState({
          status: 'available',
          version: latestVersion,
          tag: latest.tag_name,
          downloadUrl: asset.browser_download_url,
          releaseUrl: latest.html_url,
          percent: 0,
          message: `JustPlay ${latestVersion} is available. Click Download update to get the official Windows installer.`,
        });
      } else {
        publishUpdateState({
          status: 'not-available',
          version: latestVersion,
          tag: latest.tag_name,
          downloadUrl: '',
          releaseUrl: latest.html_url || '',
          message: `You're up to date. Installed version: ${currentVersion}; latest published Minecraft launcher: ${latestVersion}.`,
        });
      }
    } catch (error) {
      console.warn('[JustPlay updater] Update check failed.');
      publishUpdateState({
        status: 'error',
        version: '',
        downloadUrl: '',
        releaseUrl: '',
        message: 'JustPlay could not check for updates. Check your internet connection and try again.',
      });
    }
    return updateState;
  })();

  try {
    return await updateCheckPromise;
  } finally {
    updateCheckPromise = null;
  }
}

function initializeAutoUpdater() {
  if (!app.isPackaged) return;
  void checkForLauncherUpdates();
}

async function readLocalAccounts() {
  try {
    const parsed = JSON.parse(await fsp.readFile(localAccountsFile(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLocalAccounts(accounts) {
  const file = localAccountsFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(accounts, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temporary, file);
}

function validateLocalUsername(value) {
  const username = String(value || '').trim();
  if (!/^[A-Za-z0-9_. -]{3,24}$/.test(username) || ['__proto__', 'constructor', 'prototype'].includes(username.toLowerCase())) {
    throw new Error('Use a username with 3–24 letters, numbers, spaces, dots, underscores or hyphens.');
  }
  return username;
}

function deriveLocalPasswordHash(password, saltHex) {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}

async function createLocalAccount(usernameInput, passwordInput) {
  const username = validateLocalUsername(usernameInput);
  const password = String(passwordInput || '');
  if (password.length < 8 || password.length > 256) throw new Error('Choose a password that is 8–256 characters long.');
  const key = username.toLowerCase();
  const accounts = await readLocalAccounts();
  if (Object.hasOwn(accounts, key)) throw new Error('That JustPlay username already exists on this computer. Sign in instead.');
  const salt = crypto.randomBytes(16).toString('hex');
  accounts[key] = { username, salt, passwordHash: deriveLocalPasswordHash(password, salt), createdAt: new Date().toISOString() };
  await writeLocalAccounts(accounts);
  const state = await readSettings();
  state.localAccountName = username;
  await writeSettings(state);
  return { ok: true, localAccountName: username, state: publicState(state) };
}

async function signInLocalAccount(usernameInput, passwordInput) {
  const username = validateLocalUsername(usernameInput);
  const password = String(passwordInput || '');
  if (password.length < 1 || password.length > 256) throw new Error('Enter your password.');
  const accounts = await readLocalAccounts();
  const key = username.toLowerCase();
  const account = Object.hasOwn(accounts, key) ? accounts[key] : null;
  if (!account || typeof account.salt !== 'string' || typeof account.passwordHash !== 'string') {
    throw new Error('Username or password is incorrect. This account is stored on this computer only.');
  }
  const actual = Buffer.from(deriveLocalPasswordHash(password, account.salt), 'hex');
  const expected = Buffer.from(account.passwordHash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new Error('Username or password is incorrect. This account is stored on this computer only.');
  }
  const state = await readSettings();
  state.localAccountName = account.username;
  await writeSettings(state);
  return { ok: true, localAccountName: account.username, state: publicState(state) };
}

async function signOutLocalAccount() {
  const state = await readSettings();
  state.localAccountName = '';
  await writeSettings(state);
  return { ok: true, state: publicState(state) };
}

async function readSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsFile(), 'utf8'));
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

async function writeSettings(next) {
  const file = settingsFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
}

function safeSegment(value) {
  const clean = String(value ?? '').trim().replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '').slice(0, 120);
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid version or folder name.');
  return clean;
}

function normalizedError(error) {
  const raw = error && error.message ? error.message : String(error || 'Unknown error');
  if (/ENOENT|not recognized|java.*not found|spawn java/i.test(raw)) return 'Java was not found. Install a Java runtime that matches the Minecraft version, then restart JustPlay.';
  if (/entitlement|not own|demo account|demo mode/i.test(raw)) return 'This Microsoft account does not appear to have Minecraft: Java Edition access. JustPlay does not bypass game ownership.';
  if (/network|fetch|ECONN|ENOTFOUND|timed out/i.test(raw)) return 'A download or network request failed. Check your connection and try again.';
  return raw.slice(0, 600);
}

function sendStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('minecraft:status', payload);
}

function getWindowsDisks() {
  const command = "$items = Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID, FreeSpace, Size; $items | ConvertTo-Json -Compress";
  const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  if (!text) return [];
  const json = JSON.parse(text);
  const items = Array.isArray(json) ? json : [json];
  return items.map(d => ({
    id: String(d.DeviceID || '').trim(),
    freeBytes: Number(d.FreeSpace || 0),
    sizeBytes: Number(d.Size || 0),
  })).filter(d => /^[A-Z]:$/i.test(d.id) && Number.isFinite(d.freeBytes));
}

async function getAvailableDisks() {
  if (process.platform === 'win32') {
    try {
      const disks = getWindowsDisks();
      if (disks.length) return disks.sort((a, b) => b.freeBytes - a.freeBytes);
    } catch { /* fall through to a user-writable home location */ }
  }
  const home = os.homedir();
  try {
    const stat = await fsp.statfs(home);
    return [{ id: home, freeBytes: Number(stat.bavail) * Number(stat.bsize), sizeBytes: Number(stat.blocks) * Number(stat.bsize) }];
  } catch {
    return [{ id: app.getPath('documents'), freeBytes: 0, sizeBytes: 0 }];
  }
}

function readableBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return 'Unknown';
  const units = ['B', 'KB', 'GB', 'TB'];
  let value = n; let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function setupJustPlay(displayName) {
  const cleanName = String(displayName || '').trim().replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 16);
  if (cleanName.length < 2) throw new Error('Choose a player name with at least 2 characters.');
  const disks = await getAvailableDisks();
  const attempts = [];
  for (const disk of disks) {
    const root = /^[A-Z]:$/i.test(disk.id)
      ? path.join(`${disk.id}\\`, 'JustPlay')
      : path.join(disk.id, 'JustPlay');
    try {
      await fsp.mkdir(path.join(root, 'Game Versions'), { recursive: true });
      await fsp.mkdir(path.join(root, 'resource packs'), { recursive: true });
      await fsp.mkdir(path.join(root, 'mods'), { recursive: true });
      await fsp.mkdir(path.join(root, 'config'), { recursive: true });
      const state = await readSettings();
      Object.assign(state, { setupComplete: true, displayName: cleanName, rootPath: root, storageDrive: disk.id, storageFreeBytesAtSetup: disk.freeBytes });
      await writeSettings(state);
      return { ok: true, state: publicState(state), selectedDrive: disk.id, freeBytes: disk.freeBytes, rootPath: root };
    } catch (error) {
      attempts.push(`${disk.id}: ${error.message}`);
    }
  }
  throw new Error(`JustPlay could not create folders on the available drive(s). ${attempts.join(' | ') || 'Check write permissions.'}`);
}

function publicState(state) {
  return {
    setupComplete: !!state.setupComplete,
    displayName: state.displayName || '',
    rootPath: state.rootPath || '',
    accountName: state.accountName || '',
    localAccountName: state.localAccountName || '',
    javaPath: state.javaPath || '',
    minecraftSkin: state.minecraftSkin && typeof state.minecraftSkin === 'object' ? state.minecraftSkin : null,
    cachedSessionAvailable: Boolean(getValidCachedMinecraftSession()),
    cachedMinecraftAccountName: getValidCachedMinecraftSession()?.accountName || '',
    cachedSessionExpiresAt: getValidCachedMinecraftSession() ? new Date(Date.parse(getValidCachedMinecraftSession().signedInAt) + CACHED_SESSION_MAX_AGE_MS).toISOString() : '',
    maxRam: state.maxRam || '4G',
    minRam: state.minRam || '1G',
    storageDrive: state.storageDrive || '',
    storageFreeBytesAtSetup: Number(state.storageFreeBytesAtSetup || 0),
    installedProfiles: Array.isArray(state.installedProfiles) ? state.installedProfiles : [],
  };
}

function fetchText(url, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'JustPlayLauncher/0.1.0 (+Minecraft Java launcher)' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve(fetchText(new URL(response.headers.location, url).toString(), timeoutMs));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Official source returned HTTP ${response.statusCode}`));
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 12 * 1024 * 1024) request.destroy(new Error('Source response was too large.')); });
      response.on('end', () => resolve(body));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Network request timed out.')));
    request.on('error', reject);
  });
}

function parseForgeVersions(xml) {
  const list = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1].trim());
  return list.filter(v => /^\d+(?:\.\d+){1,2}-[A-Za-z0-9.+_-]+$/.test(v)).map(full => {
    const split = full.indexOf('-');
    const mcVersion = full.slice(0, split);
    const loaderVersion = full.slice(split + 1);
    return { id: full, label: `Forge ${loaderVersion}`, mcVersion, loaderVersion, kind: 'forge', type: 'custom', releaseTime: '', installed: false };
  }).reverse();
}

function stripHtml(s) {
  return String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function parseOptiFineVersions(html) {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  const entries = [];
  for (const row of rows) {
    const links = [...row.matchAll(/href=["']([^"']*adloadx\?f=[^"']+)["']/gi)];
    if (!links.length) continue;
    const text = stripHtml(row);
    const fileMatch = decodeURIComponent(links[0][1]).match(/f=([^&]+)/i);
    const id = fileMatch ? fileMatch[1] : `optifine-${entries.length + 1}`;
    const mcMatch = id.match(/(?:OptiFine_)?(\d+(?:\.\d+){1,2})/i) || text.match(/(\d+(?:\.\d+){1,2})/);
    entries.push({ id, label: text || id, mcVersion: mcMatch ? mcMatch[1] : '', kind: 'optifine', type: 'custom', downloadUrl: OPTIFINE_HOME, releaseTime: '', installed: false });
  }
  const seen = new Set();
  return entries.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
}

async function scanInstalledProfiles(state) {
  if (!state.rootPath) return { profiles: [], vanillaInstalled: [] };
  const gameVersionsDir = path.join(state.rootPath, 'Game Versions');
  const profiles = [];
  const vanillaInstalled = [];
  let roots = [];
  try { roots = await fsp.readdir(gameVersionsDir, { withFileTypes: true }); } catch { return { profiles, vanillaInstalled }; }
  for (const rootEntry of roots) {
    if (!rootEntry.isDirectory()) continue;
    const instanceRoot = path.join(gameVersionsDir, rootEntry.name);
    const versionsDir = path.join(instanceRoot, 'versions');
    let versions = [];
    try { versions = await fsp.readdir(versionsDir, { withFileTypes: true }); } catch { continue; }
    for (const versionEntry of versions) {
      if (!versionEntry.isDirectory()) continue;
      const versionId = versionEntry.name;
      const jsonPath = path.join(versionsDir, versionId, `${versionId}.json`);
      let meta;
      try { meta = JSON.parse(await fsp.readFile(jsonPath, 'utf8')); } catch { continue; }
      const jarPath = path.join(versionsDir, versionId, `${versionId}.jar`);
      const isCustom = Boolean(meta.inheritsFrom) || /forge|optifine|fabric|quilt|neoforge/i.test(versionId);
      if (isCustom) {
        const kind = /optifine/i.test(versionId) ? 'installed-optifine' : /forge/i.test(versionId) ? 'installed-forge' : /fabric/i.test(versionId) ? 'installed-fabric' : /quilt/i.test(versionId) ? 'installed-quilt' : /neoforge/i.test(versionId) ? 'installed-neoforge' : 'installed-custom';
        profiles.push({ id: versionId, label: versionId, mcVersion: meta.inheritsFrom || rootEntry.name, instanceRoot, kind, type: 'custom', releaseTime: meta.releaseTime || '', installed: true });
      } else {
        vanillaInstalled.push(`${rootEntry.name}|${versionId}`);
      }
    }
  }
  return { profiles, vanillaInstalled };
}

async function getCatalog() {
  if (catalogCache && Date.now() - catalogCacheAt < 10 * 60 * 1000) return catalogCache;
  const results = await Promise.allSettled([
    fetchText(MOJANG_MANIFEST).then(JSON.parse),
    fetchText(FORGE_METADATA),
    fetchText(OPTIFINE_HOME),
    fetchText(`${FABRIC_META}/versions/game`).then(JSON.parse),
  ]);
  const previous = catalogCache || { latest: { release: '', snapshot: '' }, release: [], snapshot: [], legacy: [], forge: [], optifine: [], fabric: [] };
  let manifest = null;
  if (results[0].status === 'fulfilled') manifest = results[0].value;
  if (!manifest && previous.release.length) manifest = { latest: previous.latest, versions: [...previous.release, ...previous.snapshot, ...previous.legacy] };
  if (!manifest) throw new Error('Could not load the official Minecraft version list. Check your internet connection and try again.');
  const vanilla = (manifest.versions || []).map(v => ({
    id: v.id,
    label: v.id,
    mcVersion: v.id,
    kind: 'vanilla',
    type: v.type,
    releaseTime: v.releaseTime || '',
    installed: false,
  }));
  const forge = results[1].status === 'fulfilled' ? parseForgeVersions(results[1].value) : previous.forge;
  const optifine = results[2].status === 'fulfilled' ? parseOptiFineVersions(results[2].value) : previous.optifine;
  const fabricGames = results[3].status === 'fulfilled' && Array.isArray(results[3].value) ? results[3].value : null;
  const supportedFabricVersions = fabricGames
    ? new Set(fabricGames.filter(item => item && item.stable === true).map(item => String(item.version)))
    : new Set((previous.fabric || []).map(item => String(item.mcVersion)));
  const fabric = vanilla
    .filter(v => v.type === 'release' && supportedFabricVersions.has(v.id))
    .map(v => ({ id: `fabric-${v.id}`, label: `Fabric ${v.id}`, mcVersion: v.id, kind: 'fabric', type: 'custom', releaseTime: '', installed: false }));
  catalogCache = {
    latest: manifest.latest || previous.latest,
    release: vanilla.filter(v => v.type === 'release'),
    snapshot: vanilla.filter(v => v.type === 'snapshot'),
    legacy: vanilla.filter(v => v.type === 'old_beta' || v.type === 'old_alpha'),
    forge,
    optifine: optifine.length ? optifine : [{ id: 'official-optifine-downloads', label: 'Browse all OptiFine releases', mcVersion: '', kind: 'optifine-site', type: 'custom', downloadUrl: OPTIFINE_HOME, installed: false }],
    fabric,
    source: { minecraft: MOJANG_MANIFEST, forge: FORGE_METADATA, optifine: OPTIFINE_HOME, fabric: FABRIC_META },
  };
  catalogCacheAt = Date.now();
  return catalogCache;
}

function instanceRootFor(state, mcVersion) {
  if (!state.rootPath) throw new Error('Set up your JustPlay folders first.');
  return path.join(state.rootPath, 'Game Versions', safeSegment(mcVersion));
}

function buildPublicCatalog(catalog, installed) {
  const installedMap = new Map();
  for (const profile of installed.profiles) installedMap.set(`${profile.mcVersion}|${profile.id}`, profile);
  const vanillaInstalledSet = new Set(installed.vanillaInstalled);
  const attachVanilla = entry => ({ ...entry, installed: vanillaInstalledSet.has(`${entry.mcVersion}|${entry.id}`) });
  return {
    latest: catalog.latest,
    release: catalog.release.map(attachVanilla),
    snapshot: catalog.snapshot.map(attachVanilla),
    legacy: catalog.legacy.map(attachVanilla),
    forge: catalog.forge.map(entry => ({ ...entry, installed: installed.profiles.some(p => p.kind === 'installed-forge' && p.mcVersion === entry.mcVersion && (p.id.includes(entry.loaderVersion) || p.id === entry.id)) })),
    optifine: catalog.optifine.map(entry => ({ ...entry, installed: installed.profiles.some(p => p.kind === 'installed-optifine' && (p.id === entry.id || p.id.includes(entry.mcVersion))) })),
    fabric: (catalog.fabric || []).map(entry => ({ ...entry, installed: installed.profiles.some(p => p.kind === 'installed-fabric' && p.mcVersion === entry.mcVersion) })),
    installed: installed.profiles,
    source: catalog.source,
  };
}

function scrubAuthDiagnostic(value) {
  return String(value ?? 'Unknown error')
    .replace(/([?&](?:code|access_token|refresh_token|client_secret|id_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(\b(?:access_token|refresh_token|id_token|client_secret|password)=)[^&\s,}]+/gi, '$1[redacted]')
    .replace(/("(?:access_token|refresh_token|id_token|client_secret|password|authorization|cookie|token)"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    .slice(0, 1200);
}

function safeAuthDiagnosticValue(value, depth = 0, seen = new WeakSet(), keyName = '') {
  const key = String(keyName || '');
  const sensitiveKey = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|authorization|cookie|device[_-]?code|code[_-]?verifier|bearer|^token$|^mstoken$|^xbltoken$|^state$|^nonce$|private[_-]?key)/i.test(key);
  if (sensitiveKey) return '[redacted]';

  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    // Preserve known auth/API error identifiers, but never expose OAuth authorization codes.
    if (/^code$/i.test(key) && !/^(?:error\.(?:auth|gui)\.[A-Za-z0-9_.-]+|invalid_grant|interaction_required|AADSTS\d+|ECONN[A-Z]+|ENOTFOUND|ETIMEDOUT|ERR_[A-Z0-9_]+|\d{3})$/i.test(value)) {
      return '[redacted]';
    }
    return scrubAuthDiagnostic(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return scrubAuthDiagnostic(String(value));
  if (depth >= 6) return '[nested details truncated]';
  if (seen.has(value)) return '[circular reference]';
  seen.add(value);

  // Axios, fetch wrappers, MSMC, and Xbox libraries expose errors in different shapes.
  // Keep only safe, diagnostic fields from nested response/data/errors; never log raw
  // headers, request configs, request objects, stacks, or token-bearing properties.
  const allowed = new Set([
    'name', 'message', 'code', 'errorCode', 'error', 'error_description',
    'errorDescription', 'errorMessage', 'description', 'reason', 'status',
    'statusCode', 'httpStatus', 'statusText', 'type', 'key', 'cause',
    'details', 'issues', 'title', 'errno', 'syscall', 'url', 'data',
    'response', 'errors', 'messageText', 'Message', 'XErr', 'xerr',
    'Redirect', 'redirect', 'path', 'field', 'expected', 'received',
    'traceId', 'correlationId', 'serverError', 'validation',
  ]);
  const blocked = /^(?:request|headers|config|body|rawbody|responsebody|stack|identity|claims|profile|user|account|cookies)$/i;
  let entries = [];
  try {
    const candidates = new Map();
    if (value instanceof Error) {
      for (const field of ['name', 'message', 'code', 'errorCode', 'cause', 'status', 'statusCode', 'response', 'data', 'errors', 'error', 'details', 'type']) {
        try {
          if (value[field] !== undefined && value[field] !== null) candidates.set(field, value[field]);
        } catch { /* Ignore getters that throw. */ }
      }
    }
    for (const [field, child] of Object.entries(value)) {
      if (!candidates.has(field)) candidates.set(field, child);
    }
    // Read known non-enumerable fields on popular HTTP/library error objects where possible.
    for (const field of ['status', 'statusCode', 'response', 'data', 'errors', 'error', 'error_description', 'errorMessage', 'XErr', 'Message', 'cause']) {
      if (candidates.has(field)) continue;
      try {
        if (value[field] !== undefined && value[field] !== null) candidates.set(field, value[field]);
      } catch { /* Ignore getters that throw. */ }
    }
    entries = [...candidates.entries()];
  } catch { return { message: 'Could not inspect the error object safely', type: 'unreadable object' }; }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map(item => safeAuthDiagnosticValue(item, depth + 1, seen, key));
  }

  const out = {};
  for (const [childKey, childValue] of entries.slice(0, 36)) {
    if (blocked.test(childKey) || sensitiveKey.test(childKey)) continue;
    if (!allowed.has(childKey)) continue;
    out[childKey] = safeAuthDiagnosticValue(childValue, depth + 1, seen, childKey);
  }

  if (!Object.keys(out).length) {
    const fields = [];
    try {
      for (const field of Object.keys(value).slice(0, 20)) {
        if (!sensitiveKey.test(field) && !blocked.test(field)) fields.push(field);
      }
    } catch { /* Ignore objects with unusual property traps. */ }
    return {
      type: Array.isArray(value) ? 'array' : (value.constructor && value.constructor.name ? scrubAuthDiagnostic(value.constructor.name) : 'object'),
      availableFields: fields,
    };
  }
  return out;
}

function authErrorText(error) {
  if (error === null || error === undefined) return 'Unknown error';
  if (typeof error === 'string') return scrubAuthDiagnostic(error);
  const safe = safeAuthDiagnosticValue(error);
  if (typeof safe === 'string') return safe;
  try { return scrubAuthDiagnostic(JSON.stringify(safe)); }
  catch { return 'Unable to safely serialize authentication error details'; }
}

async function writeAuthDiagnostic(stage, error) {
  // Save safe structured error details, never raw token objects or request/response payloads.
  const logPath = path.join(app.getPath('userData'), 'logs', 'microsoft-auth.log');
  const safe = safeAuthDiagnosticValue(error);
  const record = {
    time: new Date().toISOString(),
    stage,
    errorName: scrubAuthDiagnostic(error && typeof error.name === 'string' ? error.name : (safe && safe.name) || 'Error'),
    errorCode: scrubAuthDiagnostic(error && (error.errorCode || (typeof error.code === 'string' && /^error\./i.test(error.code) ? error.code : '')) ? (error.errorCode || error.code) : (safe && (safe.errorCode || safe.code)) || ''),
    message: authErrorText(error),
    details: safe,
  };
  try {
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    await fsp.appendFile(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch { /* Keep the original sign-in failure if the log cannot be written. */ }
  return logPath;
}

function explainMicrosoftAuthError(stage, error, logPath) {
  const raw = authErrorText(error);
  const lower = raw.toLowerCase();
  let reason;

  if (/error\.gui\.closed|window was closed|login window.*closed|cancelled|canceled/.test(lower)) {
    reason = 'The Microsoft sign-in window was closed before JustPlay finished verifying the account. Try again and leave it open until JustPlay returns.';
  } else if (/error\.auth\.xsts\.child|xsts\.child|child account|parental control|family safety/.test(lower)) {
    reason = 'Microsoft/Xbox family settings blocked sign-in. The family organizer may need to approve Xbox access for this account.';
  } else if (/error\.auth\.xsts\.usernotfound|does not have an xbox account|doesn't have an xbox account|no xbox profile/.test(lower)) {
    reason = 'Microsoft sign-in succeeded, but this account does not have a usable Xbox profile yet. Sign in at xbox.com and complete the profile setup, then retry.';
  } else if (/error\.auth\.minecraft\.entitlements|entitlement|demo account|demo mode|not own minecraft|does not own minecraft|no game license/.test(lower)) {
    reason = 'Microsoft/Xbox authentication reached the Minecraft ownership check, but Java Edition access could not be confirmed. Use the Microsoft account that owns Minecraft: Java Edition or has an active eligible subscription.';
  } else if (/error\.auth\.minecraft\.profile|failed to fetch minecraft profile|without a minecraft java profile|minecraft profile/.test(lower)) {
    reason = 'Microsoft sign-in completed, but JustPlay could not retrieve the Minecraft Java profile. Confirm this account has a Minecraft Java profile and try again.';
  } else if (/error\.auth\.xboxlive|error\.auth\.xsts|xbox live|xsts/.test(lower)) {
    reason = 'Microsoft sign-in completed, but Xbox Live verification failed. Check the network, Xbox profile, region availability, and any family restrictions.';
  } else if (/error\.auth\.microsoft|failed to login to microsoft account|invalid_grant|interaction_required/.test(lower)) {
    reason = 'Microsoft returned an authentication error before JustPlay could finish sign-in. Retry once. If it repeats, the saved diagnostic log contains the failing stage and error code.';
  } else if (/network|fetch|econn|enotfound|timed out|timeout|429|502|503|504/.test(lower)) {
    reason = 'A network request failed during sign-in. Check your connection, system date/time, VPN or proxy, and try again.';
  } else {
    reason = `Sign-in failed during ${stage}.`;
  }

  const detail = raw && !/^error\./i.test(raw) && raw.length < 520 ? ` Details: ${raw}` : '';
  return `${reason}${detail}\n\nDiagnostic log: ${logPath}`;
}

async function signInMicrosoft() {
  let stage = 'opening the Microsoft sign-in window';
  try {
    const auth = new Auth('select_account');
    // MSMC supports the Electron UI framework when called from Electron's main process.
    const xbox = await auth.launch('electron');

    stage = 'verifying Xbox Live and Minecraft Java Edition access';
    const minecraft = await xbox.getMinecraft();
    if (!minecraft || typeof minecraft.mclc !== 'function') {
      throw new Error('Microsoft sign-in completed without a Minecraft Java profile.');
    }
    if (typeof minecraft.isDemo === 'function' && minecraft.isDemo()) {
      throw new Error('This account appears to have demo access only. JustPlay does not bypass Minecraft ownership.');
    }

    stage = 'creating the JustPlay session';
    const session = minecraft.mclc();
    if (!session || typeof session !== 'object') throw new Error('Minecraft authentication returned an empty launcher session.');
    microsoftSession = session;
    const state = await readSettings();
    state.accountName = minecraft.profile && minecraft.profile.name ? minecraft.profile.name : (session.name || 'Microsoft account');
    await writeSettings(state);
    const cachedForOffline = await persistCachedMinecraftSession(session, state.accountName).catch(() => false);
    return { ok: true, accountName: state.accountName, cachedSessionAvailable: cachedForOffline };
  } catch (error) {
    microsoftSession = null;
    const logPath = await writeAuthDiagnostic(stage, error);
    throw new Error(explainMicrosoftAuthError(stage, error, logPath));
  }
}

function minimumJavaMajor(mcVersion) {
  const match = String(mcVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return 17;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] || 0);
  if (major > 1 || (major === 1 && minor >= 21)) return 21;
  if (major === 1 && minor === 20 && patch >= 5) return 21;
  if (major === 1 && minor >= 18) return 17;
  if (major === 1 && minor === 17) return 16;
  return 8;
}

function executableCandidatesFromHome(home) {
  if (!home || typeof home !== 'string') return [];
  const root = home.replace(/^["']|["']$/g, '').trim();
  const names = process.platform === 'win32' ? ['java.exe', 'javaw.exe'] : ['java'];
  return [
    ...names.map(name => path.join(root, 'bin', name)),
    ...names.map(name => path.join(root, name)),
  ];
}

function javaVersionForExecutable(executable) {
  try {
    const result = spawnSync(executable, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const output = (result.stdout || '') + '\n' + (result.stderr || '');
    const match = output.match(/version\s+["'](?:1\.)?(\d+)/i) || output.match(/\b(?:openjdk|java)\s+(?:version\s+)?["']?(?:1\.)?(\d+)/i);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

async function detectJavaRuntimes(force = false) {
  if (!force && javaRuntimeCache && Date.now() - javaRuntimeCacheAt < 60 * 1000) return javaRuntimeCache.map(item => ({ ...item }));
  const seen = new Set();
  const candidates = [];
  const addCandidate = file => {
    if (!file || typeof file !== 'string') return;
    const absolute = path.resolve(file);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(absolute);
  };
  const addHome = home => {
    for (const candidate of executableCandidatesFromHome(home)) addCandidate(candidate);
  };

  addHome(process.env.JAVA_HOME);
  for (const folder of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const root = folder.replace(/^["']|["']$/g, '');
    addCandidate(path.join(root, process.platform === 'win32' ? 'java.exe' : 'java'));
    if (process.platform === 'win32') addCandidate(path.join(root, 'javaw.exe'));
  }

  const env = process.env;
  const roots = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'Java'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Java'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Eclipse Adoptium'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Amazon Corretto'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Zulu'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft'),
    env.APPDATA && path.join(env.APPDATA, '.minecraft', 'runtime'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Minecraft Launcher', 'runtime'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Minecraft Launcher', 'runtime'),
  ].filter(Boolean);

  async function walk(root, depth, budget) {
    if (depth < 0 || budget.count <= 0) return;
    let entries;
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice(0, 250)) {
      if (budget.count-- <= 0) return;
      const child = path.join(root, entry.name);
      if (entry.isFile() && /^(java|javaw)(\.exe)?$/i.test(entry.name)) addCandidate(child);
      else if (entry.isDirectory() && depth > 0) {
        if (depth >= 4 || /(java|jdk|jre|runtime|temurin|adoptium|corretto|zulu|microsoft)/i.test(entry.name)) {
          await walk(child, depth - 1, budget);
        }
      }
    }
  }

  for (const root of roots) await walk(root, root.toLowerCase().includes('runtime') ? 7 : 4, { count: 1200 });

  const results = [];
  for (const candidate of candidates) {
    let stat;
    try { stat = await fsp.stat(candidate); } catch { continue; }
    if (!stat.isFile()) continue;
    const major = javaVersionForExecutable(candidate);
    if (!major) continue;
    const twin = process.platform === 'win32' ? candidate.replace(/javaw\.exe$/i, 'java.exe') : candidate;
    const launchPath = twin !== candidate && fs.existsSync(twin) ? twin : candidate;
    if (!results.some(item => (process.platform === 'win32' ? item.path.toLowerCase() : item.path) === (process.platform === 'win32' ? launchPath.toLowerCase() : launchPath))) {
      results.push({ path: launchPath, major, label: 'Java ' + major + ' — ' + launchPath });
    }
  }
  javaRuntimeCache = results.sort((a, b) => a.major - b.major || a.path.localeCompare(b.path));
  javaRuntimeCacheAt = Date.now();
  return javaRuntimeCache.map(item => ({ ...item }));
}

async function chooseJavaExecutable(state, mcVersion) {
  const runtimes = await detectJavaRuntimes();
  const required = minimumJavaMajor(mcVersion);
  const configured = state.javaPath && runtimes.find(item => item.path === state.javaPath);
  let chosen = configured && (configured.major === required || (required >= 16 && configured.major > required)) ? configured : null;
  if (!chosen) {
    chosen = runtimes.find(item => item.major === required)
      || (required >= 16 ? runtimes.find(item => item.major > required) : runtimes.find(item => item.major > required && item.major <= 11))
      || null;
  }
  if (!chosen) {
    const versions = runtimes.map(item => item.major).filter((major, index, all) => all.indexOf(major) === index).join(', ');
    throw new Error('Minecraft ' + mcVersion + ' requires Java ' + required + ' or newer. JustPlay could not find a compatible Java runtime' + (versions ? ' (found: ' + versions + ')' : '') + '. Install a matching runtime or use Settings → Java Runtime → Auto-detect.');
  }
  if (state.javaPath !== chosen.path) {
    state.javaPath = chosen.path;
    await writeSettings(state);
  }
  return chosen.path;
}

async function persistCachedMinecraftSession(session, accountName) {
  if (!safeStorage.isEncryptionAvailable()) {
    cachedMinecraftSession = null;
    return false;
  }
  if (!session || typeof session.access_token !== 'string' || !session.access_token) return false;
  const record = { schema: 1, session, accountName: String(accountName || session.name || 'Minecraft player'), signedInAt: new Date().toISOString() };
  const encrypted = safeStorage.encryptString(JSON.stringify(record));
  const file = cachedMinecraftSessionFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await fsp.writeFile(temporary, encrypted, { mode: 0o600 });
  await fsp.rename(temporary, file);
  cachedMinecraftSession = record;
  return true;
}

function getValidCachedMinecraftSession() {
  const record = cachedMinecraftSession;
  if (!record || record.schema !== 1 || !record.session || typeof record.session.access_token !== 'string') return null;
  const signedInAt = Date.parse(record.signedInAt);
  if (!Number.isFinite(signedInAt) || Date.now() < signedInAt || Date.now() - signedInAt > CACHED_SESSION_MAX_AGE_MS) return null;
  return record;
}

async function loadCachedMinecraftSession() {
  cachedMinecraftSession = null;
  if (!safeStorage.isEncryptionAvailable()) return;
  try {
    const encrypted = await fsp.readFile(cachedMinecraftSessionFile());
    const parsed = JSON.parse(safeStorage.decryptString(encrypted));
    if (parsed && parsed.schema === 1 && parsed.session && typeof parsed.session.access_token === 'string') {
      cachedMinecraftSession = parsed;
      if (!getValidCachedMinecraftSession()) cachedMinecraftSession = null;
    }
  } catch {
    cachedMinecraftSession = null;
  }
}

async function clearCachedMinecraftSession() {
  cachedMinecraftSession = null;
  try { await fsp.unlink(cachedMinecraftSessionFile()); } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

async function syncMinecraftSkin() {
  const cached = getValidCachedMinecraftSession();
  const session = microsoftSession || (cached && cached.session);
  if (!session || typeof session.access_token !== 'string' || !session.access_token) {
    throw new Error('Sign in with Microsoft and complete Minecraft Java profile verification before syncing your skin.');
  }
  const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: 'Bearer ' + session.access_token, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Minecraft profile access expired or was denied. Sign in with Microsoft again, then retry.');
  }
  if (!response.ok) throw new Error('Minecraft profile service returned HTTP ' + response.status + '. Check your connection and try again.');
  const profile = await response.json();
  if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') {
    throw new Error('The signed-in account did not return a compatible Minecraft Java profile.');
  }
  const skins = Array.isArray(profile.skins) ? profile.skins : [];
  const active = skins.find(skin => String(skin.state || '').toLowerCase() === 'active') || skins[0] || null;
  if (!active || typeof active.url !== 'string') {
    throw new Error('No active skin was returned for this Minecraft profile.');
  }
  let textureUrl;
  try { textureUrl = new URL(active.url); } catch { throw new Error('Minecraft returned an invalid skin URL.'); }
  if (textureUrl.protocol !== 'https:' || textureUrl.hostname !== 'textures.minecraft.net') {
    throw new Error('The skin URL was not on the official Minecraft texture host.');
  }
  const result = { uuid: profile.id, playerName: profile.name, variant: String(active.variant || 'CLASSIC').toUpperCase(), textureUrl: textureUrl.toString(), syncedAt: new Date().toISOString() };
  const state = await readSettings();
  state.minecraftSkin = result;
  await writeSettings(state);
  return { ok: true, skin: result, state: publicState(state) };
}


async function downloadForgeInstaller(fullVersion) {
  const match = String(fullVersion).match(/^(\d+(?:\.\d+){1,2})-([A-Za-z0-9.+_-]+)$/);
  if (!match) throw new Error('Invalid Forge version ID. Refresh the official catalogue and try again.');
  const versionFolder = safeSegment(fullVersion);
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${versionFolder}/forge-${versionFolder}-installer.jar`;
  sendStatus({ state: 'downloading-forge', progress: 5, message: `Downloading the official Forge installer for Minecraft ${match[1]}…` });
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Forge installer download returned HTTP ${response.status}. This build may no longer be available.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100000) throw new Error('The Forge installer file looked incomplete; the install was stopped.');
  const file = path.join(app.getPath('temp'), 'JustPlay', `forge-${versionFolder}-installer.jar`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buffer);
  sendStatus({ state: 'downloading-forge', progress: 38, message: 'Forge installer downloaded. Preparing the selected game version…' });
  return { file, mcVersion: match[1], loaderVersion: match[2] };
}

async function latestFabricLoaderVersion(mcVersion) {
  const versions = JSON.parse(await fetchText(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`));
  if (!Array.isArray(versions)) throw new Error(`Fabric did not return compatible loaders for Minecraft ${mcVersion}.`);
  const selected = versions.find(item => item && item.loader && item.loader.stable === true && item.loader.version)
    || versions.find(item => item && item.loader && item.loader.version);
  if (!selected) throw new Error(`No Fabric Loader build is available for Minecraft ${mcVersion}.`);
  return String(selected.loader.version);
}

async function downloadFabricInstaller() {
  const versions = JSON.parse(await fetchText(`${FABRIC_META}/versions/installer`));
  const selected = Array.isArray(versions)
    ? (versions.find(item => item && item.stable === true && typeof item.url === 'string')
      || versions.find(item => item && typeof item.url === 'string'))
    : null;
  if (!selected || !selected.url || !selected.version) {
    throw new Error('Fabric installer metadata is unavailable. Refresh the version catalog and try again.');
  }
  const installerUrl = new URL(selected.url);
  if (installerUrl.protocol !== 'https:' || installerUrl.hostname !== 'maven.fabricmc.net') {
    throw new Error('Fabric returned an unexpected installer download URL. The download was blocked.');
  }
  sendStatus({ state: 'installing-fabric', progress: 20, message: `Downloading Fabric Installer ${selected.version}…` });
  const response = await fetch(installerUrl.toString(), { redirect: 'follow' });
  if (!response.ok) throw new Error(`Fabric installer download returned HTTP ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100000) throw new Error('The Fabric installer download looked incomplete; the install was stopped.');
  const file = path.join(app.getPath('temp'), 'JustPlay', `fabric-installer-${safeSegment(selected.version)}.jar`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buffer);
  return file;
}

async function runFabricInstaller(installerFile, javaPath, instanceRoot, mcVersion, loaderVersion) {
  await fsp.mkdir(instanceRoot, { recursive: true });
  sendStatus({ state: 'installing-fabric', progress: 42, message: `Installing Fabric Loader ${loaderVersion} for Minecraft ${mcVersion}…` });
  await new Promise((resolve, reject) => {
    const child = spawn(javaPath, [
      '-jar', installerFile, 'client',
      '-dir', instanceRoot,
      '-mcversion', mcVersion,
      '-loader', loaderVersion,
    ], { cwd: instanceRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = chunk => { output = (output + String(chunk)).slice(-2400); };
    if (child.stdout) child.stdout.on('data', capture);
    if (child.stderr) child.stderr.on('data', capture);
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Fabric installer exited with code ${code}.${output.trim() ? ` Details: ${output.trim()}` : ''}`));
    });
  });
}

async function assertCachedProfileReady(instanceRoot, selectedVersionId) {
  const versionsDir = path.join(instanceRoot, 'versions');
  const seen = new Set();
  const chain = [];
  let nextId = String(selectedVersionId || '');
  for (let depth = 0; depth < 8 && nextId && !seen.has(nextId); depth++) {
    seen.add(nextId);
    const file = path.join(versionsDir, nextId, nextId + '.json');
    let metadata;
    try { metadata = JSON.parse(await fsp.readFile(file, 'utf8')); } catch {
      if (depth === 0) throw new Error('This profile is not fully installed locally yet. Connect to the internet and install it before using saved-session play.');
      break;
    }
    chain.push({ id: nextId, metadata });
    nextId = String(metadata.inheritsFrom || '');
  }
  if (!chain.length) throw new Error('Saved-session play requires the selected version metadata to be installed locally.');

  let jarAvailable = false;
  for (const item of chain) {
    const jarFile = path.join(versionsDir, item.id, item.id + '.jar');
    try { await fsp.access(jarFile); jarAvailable = true; break; } catch {}
  }
  if (!jarAvailable) {
    throw new Error('The Minecraft client JAR is missing from this install. Launch this version online once to complete its files, then retry saved-session play.');
  }

  const librariesDir = path.join(instanceRoot, 'libraries');
  function libraryAppliesToWindows(library) {
    const rules = Array.isArray(library.rules) ? library.rules : null;
    if (!rules || !rules.length) return true;
    let allowed = false;
    for (const rule of rules) {
      if (rule.features && Object.keys(rule.features).length) continue;
      if (!rule.os || !rule.os.name || rule.os.name === 'windows') allowed = rule.action === 'allow';
    }
    return allowed;
  }
  async function requireLibraryFile(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    const target = path.resolve(librariesDir, normalized);
    if (target !== path.resolve(librariesDir) && !target.startsWith(path.resolve(librariesDir) + path.sep)) {
      throw new Error('The installed profile contains an unsafe library path.');
    }
    try { await fsp.access(target); } catch {
      throw new Error('A Minecraft library is missing from this profile. Launch it online once to finish downloading dependencies before using saved-session play.');
    }
  }
  for (const item of chain) {
    for (const library of (Array.isArray(item.metadata.libraries) ? item.metadata.libraries : [])) {
      if (!libraryAppliesToWindows(library)) continue;
      const artifact = library.downloads && library.downloads.artifact;
      if (artifact && artifact.path) await requireLibraryFile(artifact.path);
      const nativeSelector = library.natives && library.natives.windows;
      if (nativeSelector && library.downloads && library.downloads.classifiers) {
        const arch = process.arch === 'ia32' ? '32' : '64';
        const classifierName = String(nativeSelector).replace(/\$\{arch\}/g, arch);
        const classifier = library.downloads.classifiers[classifierName];
        if (classifier && classifier.path) await requireLibraryFile(classifier.path);
      }
    }
  }

  const assetRef = chain.map(item => item.metadata.assetIndex && item.metadata.assetIndex.id || item.metadata.assets).find(Boolean);
  if (assetRef) {
    const indexFile = path.join(instanceRoot, 'assets', 'indexes', String(assetRef) + '.json');
    let assetIndex;
    try { assetIndex = JSON.parse(await fsp.readFile(indexFile, 'utf8')); } catch {
      throw new Error('The local Minecraft asset index is missing. Connect to the internet and launch this version once before using saved-session play.');
    }
    const objects = Object.values(assetIndex.objects || {}).filter(item => item && typeof item.hash === 'string');
    const objectRoot = path.join(instanceRoot, 'assets', 'objects');
    for (let start = 0; start < objects.length; start += 128) {
      const chunk = objects.slice(start, start + 128);
      const existing = await Promise.all(chunk.map(async item => {
        try { await fsp.access(path.join(objectRoot, item.hash.slice(0, 2), item.hash)); return true; }
        catch { return false; }
      }));
      if (existing.some(ok => !ok)) {
        throw new Error('Some Minecraft assets are not cached locally. Connect to the internet and launch this version once before using saved-session play.');
      }
    }
  }
}

async function launchMinecraft(entry, mode = 'online') {
  const launchMode = mode === 'cached' ? 'cached' : 'online';
  const cached = launchMode === 'cached' ? getValidCachedMinecraftSession() : null;
  const authorization = launchMode === 'cached' ? cached && cached.session : microsoftSession;
  if (!authorization) {
    if (launchMode === 'cached') throw new Error('No recent, successfully authenticated Minecraft session is available. Sign in with Microsoft while online first.');
    throw new Error('Sign in with Microsoft before playing. A JustPlay account is not Minecraft authentication.');
  }
  const state = await readSettings();
  if (!state.setupComplete || !state.rootPath) throw new Error('Set up JustPlay folders first.');
  const kind = String(entry.kind || 'vanilla');
  const mcVersion = safeSegment(entry.mcVersion || entry.id);
  const instanceRoot = instanceRootFor(state, mcVersion);
  if (launchMode === 'cached') {
    const installed = await scanInstalledProfiles(state);
    const isVanillaInstalled = installed.vanillaInstalled.includes(mcVersion + '|' + String(entry.id));
    const isCustomInstalled = installed.profiles.some(profile => profile.id === String(entry.id) && profile.instanceRoot === instanceRoot);
    const isForgeInstalled = kind === 'forge' && installed.profiles.some(profile => profile.kind === 'installed-forge' && profile.mcVersion === mcVersion && (profile.id.includes(String(entry.loaderVersion || '')) || profile.id === String(entry.id)));
    const isFabricInstalled = kind === 'fabric' && installed.profiles.some(profile => profile.kind === 'installed-fabric' && profile.mcVersion === mcVersion && profile.instanceRoot === instanceRoot);
    if (!isVanillaInstalled && !isCustomInstalled && !isForgeInstalled && !isFabricInstalled) {
      throw new Error('Saved-session play is only available for a Minecraft version already installed through JustPlay. Connect to the internet and launch it normally first.');
    }
    if (kind === 'forge' && !isForgeInstalled && !isCustomInstalled) {
      throw new Error('Saved-session mode cannot install a new Forge profile. Install it online first.');
    }
  }
  await fsp.mkdir(instanceRoot, { recursive: true });
  await fsp.mkdir(path.join(instanceRoot, 'mods'), { recursive: true });
  await fsp.mkdir(path.join(instanceRoot, 'resourcepacks'), { recursive: true });

  if (kind === 'optifine-site' || kind === 'optifine') {
    await shell.openExternal(OPTIFINE_HOME);
    return { ok: true, external: true, message: 'OptiFine opens on its official downloads page. Install the downloaded profile into the matching JustPlay game folder, then select it under Installed.' };
  }

  const javaPath = await chooseJavaExecutable(state, mcVersion);
  const launcher = new Client();
  activeLauncher = launcher;
  launcher.on('debug', line => sendStatus({ state: 'log', message: String(line).slice(0, 240) }));
  launcher.on('data', line => sendStatus({ state: 'log', message: String(line).slice(0, 240) }));
  launcher.on('progress', progress => sendStatus({ state: 'progress', progress: progress && Number(progress.task) ? Math.min(99, Number(progress.task)) : undefined, message: 'Downloading game files and preparing Java…' }));
  launcher.on('download-status', status => sendStatus({ state: 'progress', progress: undefined, message: status && status.name ? `Downloading ${status.name}` : 'Downloading Minecraft files…' }));

  let versionOptions;
  let forgeInstaller = null;
  let fabricInstaller = null;
  let gameVersionId;
  if (kind === 'forge') {
    const installed = await scanInstalledProfiles(state);
    const existingForge = installed.profiles.find(p => p.kind === 'installed-forge' && p.mcVersion === mcVersion && (p.id.includes(String(entry.loaderVersion || '')) || p.id === entry.id));
    if (existingForge) {
      gameVersionId = existingForge.id;
      versionOptions = { number: mcVersion, type: 'release', custom: existingForge.id };
    } else {
      const forge = await downloadForgeInstaller(entry.id);
      forgeInstaller = forge.file;
      gameVersionId = forge.mcVersion;
      versionOptions = { number: forge.mcVersion, type: 'release', forge: forgeInstaller };
      sendStatus({ state: 'progress', progress: 42, message: 'Installing Forge into the selected Game Versions folder…' });
    }
  } else if (kind === 'fabric') {
    const installed = await scanInstalledProfiles(state);
    const existingFabric = installed.profiles.find(profile => profile.kind === 'installed-fabric' && profile.mcVersion === mcVersion && profile.instanceRoot === instanceRoot);
    if (existingFabric) {
      gameVersionId = mcVersion;
      versionOptions = { number: mcVersion, type: 'release', custom: existingFabric.id };
    } else {
      const loaderVersion = await latestFabricLoaderVersion(mcVersion);
      fabricInstaller = await downloadFabricInstaller();
      await runFabricInstaller(fabricInstaller, javaPath, instanceRoot, mcVersion, loaderVersion);
      const refreshed = await scanInstalledProfiles(state);
      const installedFabric = refreshed.profiles.find(profile => profile.kind === 'installed-fabric' && profile.mcVersion === mcVersion && profile.instanceRoot === instanceRoot);
      if (!installedFabric) throw new Error('Fabric Installer finished, but JustPlay could not find the installed profile. Check the Fabric installer output and try again.');
      gameVersionId = mcVersion;
      versionOptions = { number: mcVersion, type: 'release', custom: installedFabric.id };
      await fsp.unlink(fabricInstaller).catch(() => {});
      fabricInstaller = null;
    }
  } else if (kind === 'installed-forge' || kind === 'installed-optifine' || kind === 'installed-fabric' || kind === 'installed-quilt' || kind === 'installed-neoforge' || kind === 'installed-custom') {
    gameVersionId = String(entry.mcVersion || mcVersion);
    versionOptions = { number: gameVersionId, type: 'release', custom: String(entry.id) };
  } else {
    gameVersionId = String(entry.id);
    versionOptions = { number: String(entry.id), type: String(entry.type || 'release') };
  }

  if (launchMode === 'cached') await assertCachedProfileReady(instanceRoot, versionOptions.custom || gameVersionId);

  // Copy staged assets into the selected per-version instance, without overwriting existing per-instance files.
  await syncStagedAssets(state.rootPath, instanceRoot, 'mods', '.jar');
  await syncStagedAssets(state.rootPath, instanceRoot, 'resource packs', '.zip', 'resourcepacks');

  sendStatus({ state: 'installing', progress: 1, message: `Preparing Minecraft ${gameVersionId}…` });
  try {
    const child = await launcher.launch({
      authorization,
      root: instanceRoot,
      version: versionOptions,
      memory: { max: state.maxRam || '4G', min: state.minRam || '1G' },
      javaPath,
    });
    const key = `${mcVersion}|${gameVersionId}`;
    state.installedProfiles = Array.isArray(state.installedProfiles) ? state.installedProfiles : [];
    if (!state.installedProfiles.includes(key)) state.installedProfiles.push(key);
    if (kind === 'forge') {
      const forgeKey = `${mcVersion}|${mcVersion}-forge-${entry.loaderVersion || entry.id.split('-').slice(1).join('-')}`;
      if (!state.installedProfiles.includes(forgeKey)) state.installedProfiles.push(forgeKey);
    }
    await writeSettings(state);
    sendStatus({ state: 'ready', progress: 100, message: 'Minecraft started. This version is ready to play again from JustPlay.' });
    if (child && typeof child.once === 'function') {
      child.once('close', code => {
        sendStatus({ state: 'closed', code: Number(code), message: Number(code) === 0 ? 'Minecraft closed normally.' : `Minecraft exited with code ${code}. Open Docs if it did not start correctly.` });
        if (forgeInstaller) fsp.unlink(forgeInstaller).catch(() => {});
      });
      child.once('error', error => sendStatus({ state: 'error', message: normalizedError(error) }));
    }
    return { ok: true, started: true, mcVersion, instanceRoot };
  } catch (error) {
    if (forgeInstaller) fsp.unlink(forgeInstaller).catch(() => {});
    if (fabricInstaller) fsp.unlink(fabricInstaller).catch(() => {});
    sendStatus({ state: 'error', message: normalizedError(error) });
    throw new Error(normalizedError(error));
  }
}

async function syncStagedAssets(rootPath, instanceRoot, sourceFolder, extension, targetFolder = sourceFolder) {
  const source = path.join(rootPath, sourceFolder);
  const destination = path.join(instanceRoot, targetFolder);
  await fsp.mkdir(destination, { recursive: true });
  let entries = [];
  try { entries = await fsp.readdir(source, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== extension) continue;
    const dest = path.join(destination, path.basename(entry.name));
    try { await fsp.access(dest); } catch { await fsp.copyFile(path.join(source, entry.name), dest); }
  }
}

async function getAssetList(kind, mcVersion) {
  const state = await readSettings();
  if (!state.rootPath) return [];
  const isMod = kind === 'mods';
  const sharedFolder = path.join(state.rootPath, isMod ? 'mods' : 'resource packs');
  const instanceFolder = path.join(instanceRootFor(state, mcVersion || 'latest'), isMod ? 'mods' : 'resourcepacks');
  const results = [];
  for (const [folderType, folder] of [['shared', sharedFolder], ['instance', instanceFolder]]) {
    let entries = [];
    try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (isMod ? ext !== '.jar' : ext !== '.zip') continue;
      const full = path.join(folder, ent.name);
      try {
        const st = await fsp.stat(full);
        results.push({ name: ent.name, size: st.size, folderType, folder, modified: st.mtime.toISOString(), key: `${folderType}:${ent.name}` });
      } catch { /* ignore files that changed during scan */ }
    }
  }
  const unique = new Map();
  for (const row of results) unique.set(`${row.folderType}:${row.name}`, row);
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function addAsset(kind, mcVersion) {
  const isMod = kind === 'mods';
  if (!isMod && kind !== 'resourcepacks') throw new Error('Unknown file category.');
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: isMod ? 'Add mods to JustPlay' : 'Add resource packs to JustPlay',
    properties: ['openFile', 'multiSelections'],
    filters: isMod ? [{ name: 'Java mods', extensions: ['jar'] }] : [{ name: 'Minecraft Java resource packs', extensions: ['zip'] }],
  });
  if (selected.canceled || !selected.filePaths.length) return { ok: true, cancelled: true };
  const state = await readSettings();
  if (!state.rootPath) throw new Error('Set up JustPlay folders first.');
  const stageDir = path.join(state.rootPath, isMod ? 'mods' : 'resource packs');
  const instanceDir = path.join(instanceRootFor(state, mcVersion || 'latest'), isMod ? 'mods' : 'resourcepacks');
  await fsp.mkdir(stageDir, { recursive: true });
  await fsp.mkdir(instanceDir, { recursive: true });
  const copied = [];
  for (const source of selected.filePaths) {
    const ext = path.extname(source).toLowerCase();
    if (isMod ? ext !== '.jar' : ext !== '.zip') continue;
    const stat = await fsp.stat(source);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024 * 1024) continue;
    const name = path.basename(source).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180);
    if (!name || name === ext) continue;
    const staged = path.join(stageDir, name);
    const instance = path.join(instanceDir, name);
    await fsp.copyFile(source, staged);
    await fsp.copyFile(source, instance);
    copied.push(name);
  }
  return { ok: true, copied, count: copied.length };
}

async function removeAsset(kind, mcVersion, name, folderType) {
  const isMod = kind === 'mods';
  if (!isMod && kind !== 'resourcepacks') throw new Error('Unknown file category.');
  const cleanName = path.basename(String(name || ''));
  const requiredExt = isMod ? '.jar' : '.zip';
  if (cleanName !== name || path.extname(cleanName).toLowerCase() !== requiredExt) throw new Error('Invalid filename.');
  const state = await readSettings();
  const folder = folderType === 'shared'
    ? path.join(state.rootPath, isMod ? 'mods' : 'resource packs')
    : path.join(instanceRootFor(state, mcVersion || 'latest'), isMod ? 'mods' : 'resourcepacks');
  const target = path.resolve(folder, cleanName);
  if (path.dirname(target) !== path.resolve(folder)) throw new Error('Invalid file location.');
  await fsp.unlink(target);
  return { ok: true };
}

async function openFolder(target, mcVersion) {
  const state = await readSettings();
  if (!state.rootPath) throw new Error('Set up JustPlay folders first.');
  let folder;
  if (target === 'root') folder = state.rootPath;
  else if (target === 'game') folder = path.join(state.rootPath, 'Game Versions');
  else if (target === 'mods') folder = path.join(state.rootPath, 'mods');
  else if (target === 'resourcepacks') folder = path.join(state.rootPath, 'resource packs');
  else if (target === 'instance') folder = instanceRootFor(state, mcVersion || 'latest');
  else throw new Error('Unknown folder.');
  await fsp.mkdir(folder, { recursive: true });
  const result = await shell.openPath(folder);
  if (result) throw new Error(result);
  return { ok: true, path: folder };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1020,
    minHeight: 720,
    show: false,
    backgroundColor: '#0d1014',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); initializeAutoUpdater(); });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // Clear only live UI identities on restart. A recent successfully verified Minecraft
  // session, if available, is stored separately with OS-provided encryption.
  const savedState = await readSettings();
  if (savedState.accountName || savedState.localAccountName) {
    savedState.accountName = '';
    savedState.localAccountName = '';
    await writeSettings(savedState);
  }
  await loadCachedMinecraftSession();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('app:state', async () => publicState(await readSettings()));
ipcMain.handle('app:java-detect', async () => {
  const runtimes = await detectJavaRuntimes(true);
  const state = await readSettings();
  const configured = state.javaPath && runtimes.find(item => item.path === state.javaPath);
  const best = configured || runtimes.find(item => item.major === 21) || runtimes.find(item => item.major === 17) || runtimes.find(item => item.major === 8) || runtimes[runtimes.length - 1] || null;
  if (best && state.javaPath !== best.path) {
    state.javaPath = best.path;
    await writeSettings(state);
  }
  return { runtimes, selectedPath: state.javaPath || (best && best.path) || '', selectedMajor: (runtimes.find(item => item.path === (state.javaPath || (best && best.path))) || {}).major || 0 };
});
ipcMain.handle('app:java-select', async (_event, selectedPath) => {
  const value = String(selectedPath || '').trim();
  if (!value) {
    const state = await readSettings();
    state.javaPath = '';
    await writeSettings(state);
    return { ok: true, state: publicState(state) };
  }
  const runtimes = await detectJavaRuntimes(true);
  const selected = runtimes.find(item => item.path === value);
  if (!selected) throw new Error('Choose a Java runtime JustPlay detected on this computer. Try Auto-detect first.');
  const state = await readSettings();
  state.javaPath = selected.path;
  await writeSettings(state);
  return { ok: true, selected, state: publicState(state) };
});
ipcMain.handle('minecraft:skin-sync', async () => syncMinecraftSkin());
ipcMain.handle('account:local-create', async (_event, username, password) => createLocalAccount(username, password));
ipcMain.handle('account:local-sign-in', async (_event, username, password) => signInLocalAccount(username, password));
ipcMain.handle('account:local-sign-out', async () => signOutLocalAccount());
ipcMain.handle('app:update-status', async () => updateState);
ipcMain.handle('app:update-check', async () => checkForLauncherUpdates());
ipcMain.handle('app:update-download', async () => {
  if (updateState.status !== 'available') throw new Error('There is no newer JustPlay release ready to download.');
  const url = String(updateState.downloadUrl || '');
  if (!/^https:\/\/github\.com\/43r5fer\/JustPlay\/releases\/download\/v0\.2\.\d+\/JustPlay\.exe$/.test(url)) {
    throw new Error('The update download URL did not pass validation.');
  }
  await shell.openExternal(url);
  publishUpdateState({
    status: 'download-started',
    message: `The JustPlay ${String(updateState.version || '')} installer opened in your browser. After it downloads, close JustPlay and run the downloaded installer.`,
  });
  return { ok: true };
});
ipcMain.handle('app:update-install', async () => {
  throw new Error('To finish updating, close JustPlay and run the installer downloaded in your browser.');
});
ipcMain.handle('app:disks', async () => (await getAvailableDisks()).map(d => ({ id: d.id, freeBytes: d.freeBytes, free: readableBytes(d.freeBytes), sizeBytes: d.sizeBytes, size: readableBytes(d.sizeBytes) })));
ipcMain.handle('app:setup', async (_event, name) => setupJustPlay(name));
ipcMain.handle('app:set-ram', async (_event, maxRam) => {
  const allowed = ['2G', '3G', '4G', '6G', '8G', '12G', '16G'];
  if (!allowed.includes(maxRam)) throw new Error('Choose a supported memory value.');
  const state = await readSettings(); state.maxRam = maxRam; state.minRam = '1G'; await writeSettings(state); return { ok: true, maxRam };
});
ipcMain.handle('account:sign-in', async () => signInMicrosoft());
ipcMain.handle('account:sign-out', async () => { microsoftSession = null; await clearCachedMinecraftSession(); const state = await readSettings(); state.accountName = ''; await writeSettings(state); return { ok: true, state: publicState(state) }; });
ipcMain.handle('versions:list', async () => {
  const state = await readSettings();
  const catalog = await getCatalog();
  const installed = await scanInstalledProfiles(state);
  return buildPublicCatalog(catalog, installed);
});
ipcMain.handle('minecraft:launch', async (_event, entry, mode) => launchMinecraft(entry, mode));
ipcMain.handle('files:add', async (_event, kind, mcVersion) => addAsset(kind, mcVersion));
ipcMain.handle('files:list', async (_event, kind, mcVersion) => getAssetList(kind, mcVersion));
ipcMain.handle('files:remove', async (_event, kind, mcVersion, name, folderType) => removeAsset(kind, mcVersion, name, folderType));
ipcMain.handle('folder:open', async (_event, target, mcVersion) => openFolder(target, mcVersion));
ipcMain.handle('external:open', async (_event, kind) => {
  const urls = { forge: FORGE_HOME, fabric: 'https://fabricmc.net/', optifine: OPTIFINE_HOME, minecraft: 'https://www.minecraft.net/', java: 'https://adoptium.net/temurin/releases/', docs: 'https://www.minecraft.net/en-us/article/minecraft-java-edition' };
  const url = urls[kind];
  if (!url) throw new Error('Unknown official website.');
  await shell.openExternal(url); return { ok: true };
});
