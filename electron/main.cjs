'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const https = require('node:https');
const { execFileSync, spawn } = require('node:child_process');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FORGE_METADATA = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
const FORGE_HOME = 'https://files.minecraftforge.net/';
const OPTIFINE_HOME = 'https://optifine.net/downloads';
let mainWindow;
let microsoftSession = null; // Tokens stay in memory; no Microsoft password or refresh token is written to disk.
let catalogCache = null;
let catalogCacheAt = 0;
let activeLauncher = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const defaults = () => ({ setupComplete: false, displayName: '', rootPath: '', accountName: '', maxRam: '4G', minRam: '1G', installedProfiles: [] });

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
  ]);
  const previous = catalogCache || { latest: { release: '', snapshot: '' }, release: [], snapshot: [], legacy: [], forge: [], optifine: [] };
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
  catalogCache = {
    latest: manifest.latest || previous.latest,
    release: vanilla.filter(v => v.type === 'release'),
    snapshot: vanilla.filter(v => v.type === 'snapshot'),
    legacy: vanilla.filter(v => v.type === 'old_beta' || v.type === 'old_alpha'),
    forge,
    optifine: optifine.length ? optifine : [{ id: 'official-optifine-downloads', label: 'Browse all OptiFine releases', mcVersion: '', kind: 'optifine-site', type: 'custom', downloadUrl: OPTIFINE_HOME, installed: false }],
    source: { minecraft: MOJANG_MANIFEST, forge: FORGE_METADATA, optifine: OPTIFINE_HOME },
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
    installed: installed.profiles,
    source: catalog.source,
  };
}

function scrubAuthDiagnostic(value) {
  return String(value ?? 'Unknown error')
    .replace(/([?&](?:code|access_token|refresh_token|client_secret|id_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(\b(?:access_token|refresh_token|id_token|client_secret|password)=)[^&\s,}]+/gi, '$1[redacted]')
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
    if (blocked.test(childKey) || sensitiveKey.test?.(childKey)) continue;
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
    state.accountName = minecraft.profile && minecraft.profile.name ? minecraft.profile.name : 'Microsoft account';
    await writeSettings(state);
    return { ok: true, accountName: state.accountName };
  } catch (error) {
    microsoftSession = null;
    const logPath = await writeAuthDiagnostic(stage, error);
    throw new Error(explainMicrosoftAuthError(stage, error, logPath));
  }
}

function findJavaExecutable() {
  const candidates = process.platform === 'win32' ? ['java.exe'] : ['java'];
  return candidates[0];
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

async function launchMinecraft(entry) {
  if (!microsoftSession) throw new Error('Sign in with Microsoft before playing. JustPlay never asks you to enter your Microsoft password inside its own form.');
  const state = await readSettings();
  if (!state.setupComplete || !state.rootPath) throw new Error('Set up JustPlay folders first.');
  const kind = String(entry.kind || 'vanilla');
  const mcVersion = safeSegment(entry.mcVersion || entry.id);
  const instanceRoot = instanceRootFor(state, mcVersion);
  await fsp.mkdir(instanceRoot, { recursive: true });
  await fsp.mkdir(path.join(instanceRoot, 'mods'), { recursive: true });
  await fsp.mkdir(path.join(instanceRoot, 'resourcepacks'), { recursive: true });

  if (kind === 'optifine-site' || kind === 'optifine') {
    await shell.openExternal(OPTIFINE_HOME);
    return { ok: true, external: true, message: 'OptiFine opens on its official downloads page. Install the downloaded profile into the matching JustPlay game folder, then select it under Installed.' };
  }

  const launcher = new Client();
  activeLauncher = launcher;
  launcher.on('debug', line => sendStatus({ state: 'log', message: String(line).slice(0, 240) }));
  launcher.on('data', line => sendStatus({ state: 'log', message: String(line).slice(0, 240) }));
  launcher.on('progress', progress => sendStatus({ state: 'progress', progress: progress && Number(progress.task) ? Math.min(99, Number(progress.task)) : undefined, message: 'Downloading game files and preparing Java…' }));
  launcher.on('download-status', status => sendStatus({ state: 'progress', progress: undefined, message: status && status.name ? `Downloading ${status.name}` : 'Downloading Minecraft files…' }));

  let versionOptions;
  let forgeInstaller = null;
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
  } else if (kind === 'installed-forge' || kind === 'installed-optifine' || kind === 'installed-fabric' || kind === 'installed-quilt' || kind === 'installed-neoforge' || kind === 'installed-custom') {
    gameVersionId = String(entry.mcVersion || mcVersion);
    versionOptions = { number: gameVersionId, type: 'release', custom: String(entry.id) };
  } else {
    gameVersionId = String(entry.id);
    versionOptions = { number: String(entry.id), type: String(entry.type || 'release') };
  }

  // Copy staged assets into the selected per-version instance, without overwriting existing per-instance files.
  await syncStagedAssets(state.rootPath, instanceRoot, 'mods', '.jar');
  await syncStagedAssets(state.rootPath, instanceRoot, 'resource packs', '.zip', 'resourcepacks');

  sendStatus({ state: 'installing', progress: 1, message: `Preparing Minecraft ${gameVersionId}…` });
  try {
    const child = await launcher.launch({
      authorization: microsoftSession,
      root: instanceRoot,
      version: versionOptions,
      memory: { max: state.maxRam || '4G', min: state.minRam || '1G' },
      javaPath: findJavaExecutable(),
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // The Microsoft access token is intentionally memory-only. Forget the cached display name
  // at startup so the UI does not falsely report a signed-in session after a restart.
  const savedState = await readSettings();
  if (savedState.accountName) { savedState.accountName = ''; await writeSettings(savedState); }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('app:state', async () => publicState(await readSettings()));
ipcMain.handle('app:disks', async () => (await getAvailableDisks()).map(d => ({ id: d.id, freeBytes: d.freeBytes, free: readableBytes(d.freeBytes), sizeBytes: d.sizeBytes, size: readableBytes(d.sizeBytes) })));
ipcMain.handle('app:setup', async (_event, name) => setupJustPlay(name));
ipcMain.handle('app:set-ram', async (_event, maxRam) => {
  const allowed = ['2G', '3G', '4G', '6G', '8G', '12G', '16G'];
  if (!allowed.includes(maxRam)) throw new Error('Choose a supported memory value.');
  const state = await readSettings(); state.maxRam = maxRam; state.minRam = '1G'; await writeSettings(state); return { ok: true, maxRam };
});
ipcMain.handle('account:sign-in', async () => signInMicrosoft());
ipcMain.handle('account:sign-out', async () => { microsoftSession = null; const state = await readSettings(); state.accountName = ''; await writeSettings(state); return { ok: true }; });
ipcMain.handle('versions:list', async () => {
  const state = await readSettings();
  const catalog = await getCatalog();
  const installed = await scanInstalledProfiles(state);
  return buildPublicCatalog(catalog, installed);
});
ipcMain.handle('minecraft:launch', async (_event, entry) => launchMinecraft(entry));
ipcMain.handle('files:add', async (_event, kind, mcVersion) => addAsset(kind, mcVersion));
ipcMain.handle('files:list', async (_event, kind, mcVersion) => getAssetList(kind, mcVersion));
ipcMain.handle('files:remove', async (_event, kind, mcVersion, name, folderType) => removeAsset(kind, mcVersion, name, folderType));
ipcMain.handle('folder:open', async (_event, target, mcVersion) => openFolder(target, mcVersion));
ipcMain.handle('external:open', async (_event, kind) => {
  const urls = { forge: FORGE_HOME, optifine: OPTIFINE_HOME, minecraft: 'https://www.minecraft.net/', java: 'https://adoptium.net/temurin/releases/', docs: 'https://www.minecraft.net/en-us/article/minecraft-java-edition' };
  const url = urls[kind];
  if (!url) throw new Error('Unknown official website.');
  await shell.openExternal(url); return { ok: true };
});
