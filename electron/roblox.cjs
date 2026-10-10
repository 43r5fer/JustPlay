'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const OAUTH_BASE = 'https://apis.roblox.com/oauth/v1';
const REDIRECT_URI = 'http://localhost:53682/callback';
const USERINFO_URL = OAUTH_BASE + '/userinfo';
const AUTH_URL = OAUTH_BASE + '/authorize';
const TOKEN_URL = OAUTH_BASE + '/token';
const CREATOR_DASHBOARD = 'https://create.roblox.com/dashboard/credentials';
const ROBLOX_SIGNUP_URL = 'https://www.roblox.com/';
const GAME_CACHE_MS = 5 * 60 * 1000;

const POPULAR_GAMES = [
  { name: 'Blox Fruits', placeId: '2753915549', genre: 'Adventure', featured: true },
  { name: 'Brookhaven RP', placeId: '4924922222', genre: 'Roleplay', featured: true },
  { name: 'Adopt Me!', placeId: '920587237', genre: 'Roleplay', featured: true },
  { name: 'DOORS', placeId: '6516141723', genre: 'Horror', featured: true },
  { name: 'Dress to Impress', placeId: '15101393044', genre: 'Fashion', featured: true },
  { name: 'Murder Mystery 2', placeId: '142823291', genre: 'Survival', featured: false },
  { name: 'Tower of Hell', placeId: '1962086868', genre: 'Obby', featured: false },
  { name: 'Arsenal', placeId: '286090429', genre: 'FPS', featured: false },
  { name: 'Blade Ball', placeId: '13772394625', genre: 'Action', featured: false },
  { name: 'BedWars', placeId: '6872265039', genre: 'Battles', featured: false },
  { name: 'Grow a Garden', placeId: '126884695634066', genre: 'Simulator', featured: true },
  { name: 'Steal a Brainrot', placeId: '109983668079237', genre: 'Simulator', featured: false },
];

let gamesCache = null;
let gamesCacheAt = 0;

function configPath(app) {
  return path.join(app.getPath('userData'), 'roblox-launcher-config.json');
}
function sessionPath(app) {
  return path.join(app.getPath('userData'), 'roblox-oauth-session.bin');
}
function favoritesPath(app) {
  return path.join(app.getPath('userData'), 'roblox-favorites.json');
}

async function readConfig(app) {
  try {
    const value = JSON.parse(await fs.readFile(configPath(app), 'utf8'));
    return { clientId: cleanClientId(value.clientId || '') };
  } catch {
    return { clientId: '' };
  }
}
async function writeConfig(app, value) {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const file = configPath(app);
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, file);
}
function cleanClientId(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{5,80}$/.test(text) ? text : '';
}
function publicProfile(session) {
  if (!session || !session.profile) return null;
  return {
    id: String(session.profile.id || ''),
    username: String(session.profile.username || 'Roblox player'),
    displayName: String(session.profile.displayName || session.profile.username || 'Roblox player'),
    profileUrl: String(session.profile.profileUrl || ''),
    avatarUrl: String(session.profile.avatarUrl || ''),
    connectedAt: String(session.profile.connectedAt || ''),
  };
}
async function readSession(app, safeStorage) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const encrypted = await fs.readFile(sessionPath(app));
    const decoded = safeStorage.decryptString(encrypted);
    const session = JSON.parse(decoded);
    if (!session || !session.profile || !session.profile.id) return null;
    return session;
  } catch {
    return null;
  }
}
async function writeSession(app, safeStorage, session) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this Windows account. JustPlay will not store Roblox sign-in tokens unencrypted.');
  }
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const file = sessionPath(app);
  const temp = file + '.tmp';
  const encrypted = safeStorage.encryptString(JSON.stringify(session));
  await fs.writeFile(temp, encrypted, { mode: 0o600 });
  await fs.rename(temp, file);
}
async function getState(app, safeStorage) {
  const config = await readConfig(app);
  const session = await readSession(app, safeStorage);
  return {
    configured: Boolean(config.clientId),
    clientId: config.clientId,
    redirectUri: REDIRECT_URI,
    profile: publicProfile(session),
    connected: Boolean(session && session.profile),
    canLaunch: true,
  };
}
async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 15000),
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'JustPlay-Roblox-Launcher/0.3.0',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch {
    throw new Error('Roblox returned an unreadable response. Try again in a moment.');
  }
  if (!response.ok) {
    const message = data && data.error_description ? data.error_description : (data && data.message ? data.message : '');
    throw new Error('Roblox request failed (' + response.status + ')' + (message ? ': ' + String(message).slice(0, 200) : '.'));
  }
  return data;
}
async function postForm(url, values) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
    timeout: 20000,
  });
}
function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}
function buildAuthorizeUrl(clientId, state, verifier, nonce) {
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'login');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function waitForOAuthCallback(shell, authorizeUrl, expectedState) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { server.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const server = http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, REDIRECT_URI); } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid callback URL.');
        return;
      }
      if (url.pathname !== '/callback') {
        res.writeHead(404); res.end('Not found.'); return;
      }
      if (url.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>JustPlay</title><p>Sign-in state did not match. Return to JustPlay and try again.</p>');
        finish(new Error('Roblox sign-in could not be verified. Close this tab and try again.'));
        return;
      }
      const errorCode = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (errorCode || !code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>JustPlay</title><h2>Sign-in not completed</h2><p>You can close this page and return to JustPlay.</p>');
        finish(new Error('Roblox sign-in was cancelled or denied' + (errorCode ? ': ' + errorCode : '.') ));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>JustPlay connected</title><body style="font-family:system-ui;background:#101114;color:#f5f5f7;padding:48px"><h2>Roblox connected ✓</h2><p>You can close this browser tab and return to JustPlay.</p></body>');
      finish(null, code);
    });
    server.on('error', error => finish(new Error('Could not open the local Roblox sign-in callback (' + error.message + '). Check whether port 53682 is already in use.')));
    server.listen(53682, '127.0.0.1', async () => {
      try {
        await shell.openExternal(authorizeUrl);
      } catch (error) {
        finish(new Error('Could not open the Roblox authorization page: ' + error.message));
      }
    });
    const timer = setTimeout(() => finish(new Error('Roblox sign-in timed out. Press Sign in with Roblox to try again.')), 5 * 60 * 1000);
    if (timer.unref) timer.unref();
  });
}
async function signIn(app, shell, safeStorage) {
  const config = await readConfig(app);
  if (!config.clientId) {
    throw new Error('Roblox OAuth is not configured yet. Add your public Client ID in Settings. Do not enter your Roblox password in JustPlay.');
  }
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(32));
  const nonce = b64url(crypto.randomBytes(24));
  const code = await waitForOAuthCallback(shell, buildAuthorizeUrl(config.clientId, state, verifier, nonce), state);
  const tokens = await postForm(TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: config.clientId,
    code: code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token) {
    throw new Error('Roblox did not return an access token. Check your OAuth app configuration and redirect URI.');
  }
  const rawProfile = await requestJson(USERINFO_URL, {
    headers: { Authorization: 'Bearer ' + tokens.access_token },
  });
  if (!rawProfile || !rawProfile.sub) {
    throw new Error('Roblox did not return a verified account profile.');
  }
  const username = String(rawProfile.preferred_username || rawProfile.name || rawProfile.nickname || 'Roblox player');
  const picture = String(rawProfile.picture || '');
  const avatarUrl = /^https:\/\/tr\.rbxcdn\.com\//i.test(picture) ? picture : '';
  const profile = {
    id: String(rawProfile.sub),
    username: username,
    displayName: String(rawProfile.nickname || rawProfile.name || username),
    profileUrl: 'https://www.roblox.com/users/' + encodeURIComponent(String(rawProfile.sub)) + '/profile',
    avatarUrl: avatarUrl,
    connectedAt: new Date().toISOString(),
  };
  await writeSession(app, safeStorage, {
    clientId: config.clientId,
    profile: profile,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '',
    accessToken: tokens.access_token,
    expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in) || 900) * 1000,
    savedAt: Date.now(),
  });
  return { ok: true, profile: publicProfile({ profile: profile }), state: await getState(app, safeStorage) };
}
async function signOut(app, safeStorage) {
  try { await fs.unlink(sessionPath(app)); } catch {}
  return { ok: true, state: await getState(app, safeStorage) };
}
function normalizeGame(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const idValue = raw.placeId || raw.rootPlaceId || raw.placeID || raw.rootPlaceID || raw.place_id;
  const placeId = String(idValue || '');
  if (!/^\d{1,24}$/.test(placeId)) return null;
  const name = String(raw.name || raw.title || raw.gameName || raw.displayName || 'Roblox experience').trim().slice(0, 120);
  const creatorObject = raw.creator && typeof raw.creator === 'object' ? raw.creator : null;
  const creator = String(raw.creatorName || raw.creatorDisplayName || (creatorObject && (creatorObject.name || creatorObject.displayName)) || raw.creator || raw.authorName || 'Roblox creator').slice(0, 100);
  const description = String(raw.description || raw.gameDescription || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const imageValue = raw.imageUrl || raw.thumbnailUrl || raw.iconUrl || raw.image || raw.thumbnail || raw.primaryImage || '';
  const image = typeof imageValue === 'string' && /^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//i.test(imageValue) ? imageValue : '';
  const players = Number(raw.playerCount ?? raw.playing ?? raw.currentPlayers ?? 0);
  const visits = Number(raw.totalVisits ?? raw.visits ?? 0);
  return {
    id: placeId,
    placeId: placeId,
    universeId: String(raw.universeId || raw.universeID || ''),
    name: name,
    creator: creator,
    description: description,
    genre: String(raw.genre || raw.genre_l1 || 'Experience').slice(0, 40),
    players: Number.isFinite(players) && players >= 0 ? players : 0,
    visits: Number.isFinite(visits) && visits >= 0 ? visits : 0,
    iconUrl: image,
    url: 'https://www.roblox.com/games/' + placeId,
  };
}
function walkObjects(value, output, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 9) return;
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, output, depth + 1);
    return;
  }
  const item = normalizeGame(value);
  if (item && value.name) output.push(item);
  for (const key of Object.keys(value)) {
    if (value[key] && typeof value[key] === 'object') walkObjects(value[key], output, depth + 1);
  }
}
async function addIcons(games) {
  const missing = games.filter(game => !game.iconUrl);
  if (!missing.length) return games;
  for (let start = 0; start < missing.length; start += 50) {
    const batch = missing.slice(start, start + 50);
    try {
      const url = new URL('https://thumbnails.roblox.com/v1/places/gameicons');
      url.searchParams.set('placeIds', batch.map(game => game.placeId).join(','));
      url.searchParams.set('size', '512x512');
      url.searchParams.set('format', 'Png');
      url.searchParams.set('isCircular', 'false');
      const response = await requestJson(url.toString());
      const imageByPlace = new Map((response.data || []).map(item => [String(item.targetId), item.state === 'Completed' ? item.imageUrl : '']));
      for (const game of batch) {
        const image = imageByPlace.get(game.placeId) || '';
        if (/^https:\/\/[a-z0-9.-]+\.rbxcdn\.com\//i.test(image)) game.iconUrl = image;
      }
    } catch {}
  }
  return games;
}
async function popularGames() {
  if (gamesCache && Date.now() - gamesCacheAt < GAME_CACHE_MS) return gamesCache;
  let games = POPULAR_GAMES.map(item => ({
    id: item.placeId, placeId: item.placeId, name: item.name, creator: 'Roblox creator',
    description: '', genre: item.genre, players: 0, visits: 0, iconUrl: '',
    featured: Boolean(item.featured), url: 'https://www.roblox.com/games/' + item.placeId,
  }));
  try {
    const url = new URL('https://games.roblox.com/v1/games/multiget-place-details');
    url.searchParams.set('placeIds', POPULAR_GAMES.map(item => item.placeId).join(','));
    const details = await requestJson(url.toString());
    if (Array.isArray(details)) {
      const metadata = new Map(details.map(item => [String(item.placeId || item.rootPlaceId || ''), item]));
      games = games.map(game => {
        const item = metadata.get(game.placeId);
        if (!item) return game;
        const merged = normalizeGame({ ...item, placeId: item.placeId || game.placeId, genre: game.genre });
        return merged ? { ...game, ...merged, featured: game.featured, genre: game.genre } : game;
      });
    }
  } catch {}
  games = await addIcons(games);
  gamesCache = games;
  gamesCacheAt = Date.now();
  return games;
}
async function searchGames(query) {
  const clean = String(query || '').trim().slice(0, 100);
  if (!clean) return popularGames();
  try {
    const url = new URL('https://apis.roblox.com/search-api/omni-search');
    url.searchParams.set('SearchQuery', clean);
    url.searchParams.set('SessionId', crypto.randomUUID());
    url.searchParams.set('PageType', 'Games');
    const result = await requestJson(url.toString(), { timeout: 18000 });
    const found = [];
    walkObjects(result, found);
    const byId = new Map();
    for (const game of found) {
      const prior = byId.get(game.placeId);
      if (!prior || (!prior.iconUrl && game.iconUrl)) byId.set(game.placeId, game);
    }
    let games = [...byId.values()].slice(0, 48);
    if (games.length) {
      const noUniverseId = games.filter(game => !game.universeId);
      if (noUniverseId.length) {
        try {
          const url = new URL('https://games.roblox.com/v1/games/multiget-place-details');
          url.searchParams.set('placeIds', noUniverseId.slice(0, 25).map(game => game.placeId).join(','));
          const details = await requestJson(url.toString());
          const detailsById = new Map((Array.isArray(details) ? details : []).map(game => [String(game.placeId || ''), game]));
          games = games.map(game => {
            const detail = detailsById.get(game.placeId);
            if (!detail) return game;
            const merged = normalizeGame({ ...detail, ...game, placeId: game.placeId });
            return merged ? { ...merged, iconUrl: game.iconUrl || merged.iconUrl } : game;
          });
        } catch {}
      }
      games = await addIcons(games);
      return games;
    }
  } catch {}
  const fallback = await popularGames();
  const lower = clean.toLowerCase();
  return fallback.filter(game => (game.name + ' ' + game.creator + ' ' + game.genre).toLowerCase().includes(lower));
}
async function listGames(query) {
  const clean = String(query || '').trim();
  const games = await searchGames(clean);
  return { games: games, query: clean, source: clean ? 'Roblox search' : 'Popular experiences' };
}
async function gamesByPlaceIds(placeIds) {
  const ids = [...new Set((Array.isArray(placeIds) ? placeIds : []).map(String).filter(value => /^\d{1,24}$/.test(value)))].slice(0, 100);
  if (!ids.length) return [];
  const known = new Map(POPULAR_GAMES.map(item => [item.placeId, item]));
  let games = ids.map(id => {
    const item = known.get(id);
    return item ? {
      id: id, placeId: id, name: item.name, creator: 'Roblox creator', description: '',
      genre: item.genre, players: 0, visits: 0, iconUrl: '', featured: Boolean(item.featured),
      url: 'https://www.roblox.com/games/' + id,
    } : null;
  }).filter(Boolean);
  try {
    const url = new URL('https://games.roblox.com/v1/games/multiget-place-details');
    url.searchParams.set('placeIds', ids.join(','));
    const details = await requestJson(url.toString());
    if (Array.isArray(details)) {
      const byId = new Map(details.map(item => [String(item.placeId || item.rootPlaceId || ''), item]));
      const metadataGames = ids.map(id => {
        const item = byId.get(id);
        const normalized = normalizeGame(item ? { ...item, placeId: item.placeId || id } : null);
        if (normalized) return normalized;
        return games.find(game => game.placeId === id) || null;
      }).filter(Boolean);
      if (metadataGames.length) games = metadataGames;
    }
  } catch {}
  return addIcons(games);
}
async function getFavoritePlaceIds(app) {
  try {
    const raw = JSON.parse(await fs.readFile(favoritesPath(app), 'utf8'));
    return Array.isArray(raw) ? raw.map(String).filter(value => /^\d{1,24}$/.test(value)).slice(0, 200) : [];
  } catch { return []; }
}
async function launchGame(shell, placeId) {
  const id = String(placeId || '').trim();
  if (!/^\d{1,24}$/.test(id)) throw new Error('This game does not have a valid Roblox place ID.');
  const deepLink = 'roblox://placeId=' + id;
  try {
    await shell.openExternal(deepLink);
    return { ok: true, placeId: id, deepLink: deepLink, message: 'Opening the Roblox app and joining this experience…' };
  } catch {
    await shell.openExternal('https://www.roblox.com/games/' + id);
    return { ok: true, placeId: id, deepLink: deepLink, fallback: true, message: 'Opening the Roblox game page. Install the official Roblox app if it does not launch automatically.' };
  }
}
function registerRobloxIpc({ ipcMain, app, shell, safeStorage }) {
  ipcMain.handle('roblox:state', () => getState(app, safeStorage));
  ipcMain.handle('roblox:configure', async (_event, clientId) => {
    const value = String(clientId || '').trim();
    const clean = cleanClientId(value);
    if (!clean) throw new Error('Enter the Roblox OAuth Client ID shown in Creator Dashboard.');
    const previous = await readConfig(app);
    await writeConfig(app, { clientId: clean });
    return { ok: true, state: await getState(app, safeStorage), changed: previous.clientId !== clean };
  });
  ipcMain.handle('roblox:open-oauth-dashboard', async () => {
    await shell.openExternal(CREATOR_DASHBOARD);
    return { ok: true };
  });
  ipcMain.handle('roblox:open-signup', async () => {
    await shell.openExternal(ROBLOX_SIGNUP_URL);
    return { ok: true };
  });
  ipcMain.handle('roblox:open-app', async () => {
    try {
      await shell.openExternal('roblox://');
      return { ok: true, message: 'Opening the Roblox app…' };
    } catch {
      await shell.openExternal('https://www.roblox.com/home');
      return { ok: true, fallback: true, message: 'Opening Roblox in your browser. Install the official Roblox app for direct game launches.' };
    }
  });
  ipcMain.handle('roblox:sign-in', () => signIn(app, shell, safeStorage));
  ipcMain.handle('roblox:sign-out', () => signOut(app, safeStorage));
  ipcMain.handle('roblox:games', (_event, query) => listGames(query));
  ipcMain.handle('roblox:launch', (_event, placeId) => launchGame(shell, placeId));
  ipcMain.handle('roblox:favorites', () => getFavoritePlaceIds(app));
  ipcMain.handle('roblox:favorites-games', async () => gamesByPlaceIds(await getFavoritePlaceIds(app)));
  ipcMain.handle('roblox:favorite-toggle', async (_event, placeId) => {
    const id = String(placeId || '').trim();
    if (!/^\d{1,24}$/.test(id)) throw new Error('Invalid Roblox place ID.');
    let favorites = [];
    try { favorites = JSON.parse(await fs.readFile(favoritesPath(app), 'utf8')); } catch {}
    if (!Array.isArray(favorites)) favorites = [];
    favorites = favorites.map(String);
    const exists = favorites.includes(id);
    favorites = exists ? favorites.filter(value => value !== id) : [id, ...favorites].slice(0, 200);
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    await fs.writeFile(favoritesPath(app), JSON.stringify(favorites, null, 2), { mode: 0o600 });
    return { favorites: favorites, favorite: !exists };
  });
}

module.exports = { registerRobloxIpc, REDIRECT_URI };