'use strict';

const $ = id => document.getElementById(id);
const config = window.FLOCK_CONFIG || {};
const SUPABASE_URL = config.supabaseUrl || '';
const SUPABASE_KEY = config.supabasePublishableKey || '';
const BUCKET = config.storageBucket || 'flock-media';
function getSavedFlockSession() {
  try { return localStorage.getItem('flock.session') || sessionStorage.getItem('flock.session') || ''; }
  catch { return ''; }
}
function createFlockDatabase(sessionToken) {
  if (!window.supabase || !SUPABASE_URL || !SUPABASE_KEY) return null;
  const headers = sessionToken ? { 'x-flock-session': sessionToken } : {};
  return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'flock-no-supabase-auth' },
    global: { headers }
  });
}
let flockSessionToken = getSavedFlockSession();
let db = createFlockDatabase(flockSessionToken);
async function flockAuth(action, payload, token) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Clines account service is not configured.');
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  const session = token === undefined ? flockSessionToken : token;
  if (session) headers['x-flock-session'] = session;
  const response = await fetch(SUPABASE_URL + '/functions/v1/flock-auth', {
    method: 'POST', headers, cache: 'no-store',
    body: JSON.stringify(Object.assign({ action }, payload || {}))
  });
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.error || 'Clines could not complete that request. Please try again.');
  return result;
}
function persistFlockSession(token, remember) {
  flockSessionToken = String(token || '');
  try {
    localStorage.removeItem('flock.session');
    sessionStorage.removeItem('flock.session');
    if (flockSessionToken) {
      if (remember) localStorage.setItem('flock.session', flockSessionToken);
      else sessionStorage.setItem('flock.session', flockSessionToken);
    }
  } catch {
    if (flockSessionToken) throw new Error('This device cannot securely remember Clines here. Check browser storage settings and try again.');
  }
  if (realtimeChannel && db) db.removeChannel(realtimeChannel);
  if (presenceChannel && db) db.removeChannel(presenceChannel);
  if (authSubscription && db) db.removeChannel(authSubscription);
  realtimeChannel = null;
  presenceChannel = null;
  authSubscription = null;
  db = createFlockDatabase(flockSessionToken);
}


let user = null;
let profile = null;
let activeConversation = null;
let activeConversationMembers = [];
let conversations = [];
let friends = [];
let friendRequests = [];
let currentMessages = [];
let statuses = [];
let realtimeChannel = null;
let presenceChannel = null;
let authSubscription = null;
let conversationPoller = null;
let globalPoller = null;
let conversationPollBusy = false;
let globalPollBusy = false;
let toastTimer = null;
let typingTimer = null;
let readTimer = null;
let recordingTimer = null;
let recordingStartedAt = 0;
let mediaRecorder = null;
let activeMediaStream = null;
let recordingChunks = [];
let recordingKind = 'voice';
let recordingConversationId = null;
let pendingReply = null;
let openedStatusIndex = 0;
let modalPrimaryHandler = null;
let modalCancelHandler = null;
let mandatoryUpdateActive = false;
let updateDownloadInProgress = false;
let notificationBaselineReady = false;
let notificationPermissionAsked = false;
const notificationLatestIds = new Map();
let signedUrlCache = new Map();
let lastStatusLoad = 0;
let suppressAuthCallback = false;
let currentSidebarTab = 'chats';
let activeCall = null;
let pendingIncomingCall = null;
let callSignalPoller = null;
let callSignalPollBusy = false;
const processedCallSignalIds = new Set();

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}
function safeInitial(value) {
  const text = String(value || 'C').trim();
  return Array.from(text)[0] ? Array.from(text)[0].toUpperCase() : 'F';
}
function cleanFriendCode(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 10);
}
function fmtTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Today';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function fmtBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}
function fmtDuration(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}
function toast(title, message, isError) {
  $('toastTitle').textContent = title || 'Clines';
  $('toastMessage').textContent = message || '';
  $('toast').classList.toggle('is-error', Boolean(isError));
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4500);
}
function feedback(id, message, isError) {
  const node = $(id);
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('is-error', Boolean(isError));
}
function requireDb() {
  if (!db) throw new Error('Clines is not connected to Supabase. Check src/flock-config.js and reload the app.');
}
function assertUser() {
  if (!user) throw new Error('Please sign in to Clines first.');
}
function resetModalHandlers() {
  modalPrimaryHandler = null;
  modalCancelHandler = null;
}
function showModal(options) {
  const opt = options || {};
  if (mandatoryUpdateActive && opt.mandatoryUpdate !== true) return;
  mandatoryUpdateActive = opt.mandatoryUpdate === true;
  document.body.classList.toggle('mandatory-update-lock', mandatoryUpdateActive);
  $('modalKicker').textContent = opt.kicker || 'CLINES / YOUR SPACE';
  $('modalTitle').textContent = opt.title || 'Make it yours.';
  $('modalDescription').textContent = opt.description || '';
  $('modalBody').innerHTML = opt.body || '';
  $('modalFeedback').textContent = '';
  $('modalFeedback').classList.remove('is-error');
  $('modalPrimaryBtn').textContent = opt.primary || 'Save';
  $('modalPrimaryBtn').hidden = opt.hidePrimary === true;
  $('modalCancelBtn').textContent = opt.cancel || 'Cancel';
  $('modalCancelBtn').hidden = opt.hideCancel === true || mandatoryUpdateActive;
  $('closeModalBtn').hidden = mandatoryUpdateActive;
  $('modalFooter').hidden = opt.hideFooter === true;
  resetModalHandlers();
  modalPrimaryHandler = opt.onPrimary || null;
  modalCancelHandler = opt.onCancel || null;
  $('modalBackdrop').hidden = false;
  document.body.classList.add('modal-open');
}
function closeModal() {
  if (mandatoryUpdateActive) return;
  if (modalCancelHandler) {
    const handler = modalCancelHandler;
    modalCancelHandler = null;
    try { handler(); } catch {}
  }
  $('modalBackdrop').hidden = true;
  $('modalBody').innerHTML = '';
  document.body.classList.remove('modal-open');
  resetModalHandlers();
}
async function modalPrimaryClick() {
  if (!modalPrimaryHandler) { closeModal(); return; }
  const btn = $('modalPrimaryBtn');
  btn.disabled = true;
  try { await modalPrimaryHandler(); }
  catch (error) { feedback('modalFeedback', error.message || 'Something went wrong.', true); }
  finally { if (!$('modalBackdrop').hidden) btn.disabled = false; }
}
function showAuthScreen(signUp) {
  $('authScreen').hidden = false;
  $('appScreen').hidden = true;
  $('mobileNav').hidden = true;
  $('showSignInTab').classList.toggle('active', !signUp);
  $('showSignUpTab').classList.toggle('active', Boolean(signUp));
  $('signInForm').hidden = Boolean(signUp);
  $('signUpForm').hidden = !signUp;
  $('authHeading').textContent = signUp ? 'Make a little space.' : 'Good to see you.';
  $('authSubheading').textContent = signUp ? 'Create your account and get your own friend code.' : 'Sign in and pick up right where you left off.';
  feedback('authFeedback', '');
}
function showApp() {
  $('authScreen').hidden = true;
  $('appScreen').hidden = false;
  $('mobileNav').hidden = false;
  renderProfile();
}
async function refreshProfile() {
  assertUser();
  const { data, error } = await db.from('flock_profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Your Clines profile is still being created. Please refresh in a moment.');
  profile = data;
  if (profile.avatar_path) await getSignedUrl(profile.avatar_path).catch(() => '');
  if (profile.background_path) await getSignedUrl(profile.background_path).catch(() => '');
  renderProfile();
  return profile;
}
function renderProfile() {
  const p = profile;
  const displayName = p ? (p.display_name || p.username) : 'Your space';
  $('myDisplayName').textContent = displayName;
  $('myUsername').textContent = p ? '@' + p.username : '@username';
  $('friendCodeText').textContent = p ? p.friend_code : '----------';
  $('myAvatarFallback').textContent = safeInitial(displayName);
  const img = $('myAvatar');
  const url = p && p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
  img.hidden = !url;
  img.src = url || '';
  $('myAvatarFallback').hidden = Boolean(url);
  $('connectionDot').classList.toggle('connected', Boolean(user));
  $('connectionStatus').textContent = user ? 'Synced to Clines' : 'Not connected';
  applyChatWallpaper();
}
async function getSignedUrl(path) {
  if (!path) return '';
  const cached = signedUrlCache.get(path);
  if (cached && cached.expires > Date.now()) return cached.url;
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  signedUrlCache.set(path, { url: data.signedUrl, expires: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}
function peekSignedUrl(path) {
  const item = path ? signedUrlCache.get(path) : null;
  return item && item.expires > Date.now() ? item.url : '';
}
async function uploadMedia(file, folder) {
  assertUser();
  if (!file) throw new Error('Choose a file first.');
  if (file.size > 100 * 1024 * 1024) throw new Error('Files must be 100 MB or smaller.');
  const allowed = new Set([
    'image/jpeg','image/png','image/webp','image/gif',
    'video/mp4','video/webm',
    'audio/webm','audio/ogg','audio/mp4','audio/mpeg',
    'application/pdf','text/plain'
  ]);
  const type = file.type || 'application/octet-stream';
  if (!allowed.has(type)) throw new Error('This file type is not supported yet. Use PNG/JPG/WebP/GIF, MP4/WebM, a supported audio format, PDF or plain text.');
  const extByType = {
    'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
    'video/mp4':'mp4','video/webm':'webm','audio/webm':'webm','audio/ogg':'ogg',
    'audio/mp4':'m4a','audio/mpeg':'mp3','application/pdf':'pdf','text/plain':'txt'
  };
  const ext = extByType[type] || 'bin';
  const nonce = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2));
  const path = user.id + '/' + String(folder || 'uploads') + '/' + nonce + '.' + ext;
  const { error } = await db.storage.from(BUCKET).upload(path, file, {
    contentType: type, upsert: false, cacheControl: '3600'
  });
  if (error) throw error;
  signedUrlCache.delete(path);
  return { path, type, size: file.size, name: String(file.name || ('upload.' + ext)).slice(0, 240) };
}
async function removeMedia(path) {
  if (!path || !user) return;
  const { error } = await db.storage.from(BUCKET).remove([path]);
  if (error) console.warn('[Clines] Media cleanup did not finish.');
  signedUrlCache.delete(path);
}
function renderProfileAvatar(path, fallback, className) {
  const url = path ? peekSignedUrl(path) : '';
  const img = url ? '<img alt="" src="' + escapeHtml(url) + '">' : '';
  return '<span class="' + (className || 'avatar') + '">' + img + (url ? '' : '<span class="avatar-initial">' + escapeHtml(fallback || 'F') + '</span>') + '</span>';
}
async function warmProfileMedia(rows) {
  const paths = Array.from(new Set((rows || []).map(x => x && x.avatar_path).filter(Boolean)));
  await Promise.all(paths.map(path => getSignedUrl(path).catch(() => '')));
}
let lastUpdatePrompt = '';
let lastMobileUpdateVersion = '';
let lastMobileUpdateCheck = 0;
let lastBrowserUpdateCheck = 0;
let browserUpdatePromptVersion = '';
let mobileUpdateDownloadId = null;
function showRequiredUpdate(options) {
  showModal(Object.assign({}, options || {}, { mandatoryUpdate: true, hideCancel: true }));
}
function updateProgressMarkup(text) {
  return '<div class="update-progress-shell"><div id="updateProgressBar" class="update-progress-bar" style="width:0%"></div></div><p id="updateProgressText" class="update-progress-text">' + escapeHtml(text || 'Preparing download…') + '</p>';
}
function setUpdateProgress(percent, text) {
  const bar = $('updateProgressBar');
  const label = $('updateProgressText');
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  if (bar) bar.style.width = value + '%';
  if (label) label.textContent = text || (Math.round(value) + '% downloaded');
}
function renderDesktopDownloadProgress(state) {
  if (!(mandatoryUpdateActive && $('updateProgressBar'))) {
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Updating Clines',
      description: 'This update is required before you can continue chatting.',
      body: updateProgressMarkup('Preparing secure download…'),
      hideFooter: true
    });
  }
  const percent = Math.max(0, Math.min(100, Number(state && state.percent) || 0));
  setUpdateProgress(percent, 'Downloading Clines ' + String(state && state.version || '') + ' · ' + Math.round(percent) + '%');
}
function wireDesktopUpdates() {
  const desktop = window.flockDesktop;
  if (!desktop || typeof desktop.onUpdateStatus !== 'function') return;
  const handle = state => {
    if (!state || !state.status) return;
    if (state.status === 'available') {
      const version = String(state.version || 'new version');
      if (lastUpdatePrompt === 'available:' + version) return;
      lastUpdatePrompt = 'available:' + version;
      showRequiredUpdate({
        kicker: 'CLINES / REQUIRED UPDATE',
        title: 'Update required to continue',
        description: 'Clines ' + version + ' is available. You must install it before using chats again.',
        body: '<div class="confirm-panel"><span class="confirm-icon">↑</span><p>Your account, friends and cloud messages are saved online. Clines will download the update, then restart to install it.</p></div>',
        primary: 'Download and update',
        onPrimary: async () => {
          updateDownloadInProgress = true;
          showRequiredUpdate({
            kicker: 'CLINES / REQUIRED UPDATE',
            title: 'Downloading Clines',
            description: 'Keep this window open. You can continue after the update installs.',
            body: updateProgressMarkup('Starting download…'),
            hideFooter: true
          });
          await desktop.downloadUpdate();
        }
      });
    } else if (state.status === 'downloading') {
      updateDownloadInProgress = true;
      renderDesktopDownloadProgress(state);
    } else if (state.status === 'downloaded') {
      updateDownloadInProgress = false;
      lastUpdatePrompt = 'downloaded:' + String(state.version || '');
      showRequiredUpdate({
        kicker: 'CLINES / REQUIRED UPDATE',
        title: 'Ready to install',
        description: 'Clines ' + String(state.version || '') + ' has finished downloading.',
        body: '<div class="confirm-panel"><span class="confirm-icon">✓</span><p>Clines must restart to finish updating. Your cloud account and messages remain saved.</p></div>',
        primary: 'Restart and install',
        onPrimary: async () => { await desktop.installUpdate(); }
      });
    } else if (state.status === 'error') {
      if (mandatoryUpdateActive || updateDownloadInProgress) {
        showRequiredUpdate({
          kicker: 'CLINES / UPDATE REQUIRED',
          title: 'Update could not finish',
          description: 'Clines needs this update before you continue. Check your internet connection and retry.',
          body: '<div class="confirm-panel"><span class="confirm-icon">!</span><p>' + escapeHtml(state.message || 'The update service could not complete the request.') + '</p></div>',
          primary: 'Retry update check',
          onPrimary: async () => {
            lastUpdatePrompt = '';
            updateDownloadInProgress = false;
            await desktop.checkForUpdates();
          }
        });
      } else if (lastUpdatePrompt !== 'error') {
        lastUpdatePrompt = 'error';
        toast('Update check failed', state.message || 'Check your internet connection later.');
      }
    } else if (state.status === 'not-available' && !mandatoryUpdateActive) {
      lastUpdatePrompt = '';
    }
  };
  desktop.onUpdateStatus(handle);
  if (typeof desktop.getUpdateStatus === 'function') desktop.getUpdateStatus().then(handle).catch(() => {});
}
function nativeClinesPlugin() {
  const cap = window.Capacitor;
  return window.ClinesUpdater || (cap && cap.Plugins && cap.Plugins.ClinesUpdater ? cap.Plugins.ClinesUpdater : null);
}
function mobileCapacitorPlatform() {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return '';
  return typeof cap.getPlatform === 'function' ? cap.getPlatform() : '';
}
function compareVersions(left, right) {
  const parse = value => {
    const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
    if (!match) return null;
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] || '' };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}
function versionFromRelease(release) {
  for (const candidate of [release && release.tag_name, release && release.name]) {
    const match = String(candidate || '').match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i);
    if (match) return match[1];
  }
  return '';
}
function openExternalFlockUrl(url) {
  if (!url || !/^https:\/\//i.test(url)) throw new Error('The update link is not valid.');
  if (mobileCapacitorPlatform() === 'android') {
    window.open(url, '_system');
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
async function pollAndroidUpdateDownload(downloadId, url, version) {
  const native = nativeClinesPlugin();
  if (!native || typeof native.getDownloadStatus !== 'function') throw new Error('The in-app Android updater is unavailable in this installed build.');
  const result = await native.getDownloadStatus({ downloadId });
  const total = Math.max(0, Number(result.totalBytes) || 0);
  const received = Math.max(0, Number(result.bytesDownloaded) || 0);
  const percent = total > 0 ? Math.min(100, received / total * 100) : 0;
  if (result.status === 'downloaded') {
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Download complete',
      description: 'Clines ' + version + ' is ready. Android will ask you to approve the installation.',
      body: '<div class="confirm-panel"><span class="confirm-icon">✓</span><p>The APK is downloaded. Choose Install update to open Android’s system installer. Android requires approval. If it reports a signature mismatch, uninstall the older Clines/Flock app first, then install this APK and sign back in; your cloud account and messages remain online.</p></div>',
      primary: 'Install update',
      onPrimary: async () => {
        await native.installDownloaded({ downloadId });
        toast('Finish the Android install', 'Approve installation in the Android system screen.');
      }
    });
    return;
  }
  if (result.status === 'failed') {
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Download failed',
      description: 'This update is required before you can continue.',
      body: '<div class="confirm-panel"><span class="confirm-icon">!</span><p>' + escapeHtml(result.reason || 'Check your connection and retry the download.') + '</p></div>',
      primary: 'Retry download',
      onPrimary: async () => runAndroidApkUpdate(url, version)
    });
    return;
  }
  if (!(mandatoryUpdateActive && $('updateProgressBar'))) {
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Downloading Clines',
      description: 'This update is required before you can continue chatting.',
      body: updateProgressMarkup('Connecting to the official release…'),
      hideFooter: true
    });
  }
  setUpdateProgress(percent, (total ? fmtBytes(received) + ' of ' + fmtBytes(total) : fmtBytes(received) + ' downloaded') + ' · ' + Math.round(percent) + '%');
  setTimeout(() => pollAndroidUpdateDownload(downloadId, url, version).catch(error => {
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Update download paused',
      description: 'Reconnect and retry to continue using Clines.',
      body: '<div class="confirm-panel"><span class="confirm-icon">!</span><p>' + escapeHtml(error.message || 'The download status could not be checked.') + '</p></div>',
      primary: 'Retry download',
      onPrimary: async () => runAndroidApkUpdate(url, version)
    });
  }), 800);
}
async function runAndroidApkUpdate(url, version) {
  const native = nativeClinesPlugin();
  if (!native || typeof native.startDownload !== 'function') {
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Update required to continue',
      description: 'This installed Android build does not include the new in-app downloader yet. Open the official APK and complete Android’s installer to update.',
      body: '<div class="confirm-panel"><span class="confirm-icon">↑</span><p>Download Clines ' + escapeHtml(version) + ' from GitHub. Android may ask for install approval. If it reports a signing mismatch, uninstall the older app first; your account and cloud messages remain online.</p></div>',
      primary: 'Open official APK',
      onPrimary: async () => { openExternalFlockUrl(url); }
    });
    return;
  }
  showRequiredUpdate({
    kicker: 'CLINES / REQUIRED UPDATE',
    title: 'Starting download',
    description: 'Clines will show download progress here, then open Android’s installer.',
    body: updateProgressMarkup('Starting download…'),
    hideFooter: true
  });
  const result = await native.startDownload({ url });
  const downloadId = Number(result && result.downloadId);
  if (!Number.isFinite(downloadId) || downloadId <= 0) throw new Error('Android did not return a valid download ID.');
  mobileUpdateDownloadId = downloadId;
  await pollAndroidUpdateDownload(downloadId, url, version);
}
async function checkMobileUpdate(options) {
  if (mobileCapacitorPlatform() !== 'android') return;
  const now = Date.now();
  if (!(options && options.force) && now - lastMobileUpdateCheck < 5 * 60 * 1000) return;
  lastMobileUpdateCheck = now;
  const runtime = window.FLOCK_RUNTIME || {};
  const currentVersion = String(runtime.version || '0.0.0');
  const ownerRepo = String((window.FLOCK_CONFIG || {}).githubRepo || '43r5fer/JustPlay');
  try {
    const response = await fetch('https://api.github.com/repos/' + ownerRepo + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error('GitHub release check returned HTTP ' + response.status + '.');
    const release = await response.json();
    const latestVersion = versionFromRelease(release);
    if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) return;
    const promptKey = 'github:' + latestVersion;
    if (lastMobileUpdateVersion === promptKey) return;
    lastMobileUpdateVersion = promptKey;
    const apk = Array.isArray(release.assets) ? release.assets.find(asset => asset.name === 'Clines.apk') : null;
    const targetUrl = apk && apk.browser_download_url ? apk.browser_download_url : release.html_url;
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Update required to continue',
      description: 'Clines ' + latestVersion + ' is available. You must update before you can continue chatting.',
      body: '<div class="confirm-panel"><span class="confirm-icon">↑</span><p>Clines will download the APK and show progress. Android’s system installer must approve the final installation. Your account and cloud chats remain online.</p></div>',
      primary: 'Download and update',
      onPrimary: async () => {
        try {
          if (apk && apk.browser_download_url) await runAndroidApkUpdate(targetUrl, latestVersion);
          else openExternalFlockUrl(targetUrl);
        } catch (error) {
          showRequiredUpdate({
            kicker: 'CLINES / REQUIRED UPDATE',
            title: 'Update could not start',
            description: 'This update is required before you can continue.',
            body: '<div class="confirm-panel"><span class="confirm-icon">!</span><p>' + escapeHtml(error.message || 'Please retry the download.') + '</p></div>',
            primary: 'Retry update',
            onPrimary: async () => runAndroidApkUpdate(targetUrl, latestVersion)
          });
        }
      }
    });
  } catch (error) {
    /* Keep network failures visible only when an update gate is already active. */
    if (mandatoryUpdateActive) {
      showRequiredUpdate({
        kicker: 'CLINES / REQUIRED UPDATE',
        title: 'Can’t verify the update',
        description: 'Connect to the internet and retry. Clines cannot confirm whether this build is current.',
        body: '<div class="confirm-panel"><span class="confirm-icon">!</span><p>' + escapeHtml(error.message || 'The release service is unavailable.') + '</p></div>',
        primary: 'Check again',
        onPrimary: async () => { lastMobileUpdateVersion = ''; lastMobileUpdateCheck = 0; await checkMobileUpdate({ force: true }); }
      });
    }
  }
}
async function checkBrowserUpdate(options) {
  if (window.flockDesktop || mobileCapacitorPlatform() === 'android' || window.location.protocol !== 'https:') return;
  const now = Date.now();
  if (!(options && options.force) && now - lastBrowserUpdateCheck < 5 * 60 * 1000) return;
  lastBrowserUpdateCheck = now;
  const runtime = window.FLOCK_RUNTIME || {};
  const currentVersion = String(runtime.version || '0.0.0');
  const ownerRepo = String((window.FLOCK_CONFIG || {}).githubRepo || '43r5fer/JustPlay');
  try {
    const response = await fetch('https://api.github.com/repos/' + ownerRepo + '/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store'
    });
    if (!response.ok) return;
    const release = await response.json();
    const latestVersion = versionFromRelease(release);
    if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0 || browserUpdatePromptVersion === latestVersion) return;
    browserUpdatePromptVersion = latestVersion;
    showRequiredUpdate({
      kicker: 'CLINES / REQUIRED UPDATE',
      title: 'Refresh Clines to continue',
      description: 'Clines ' + latestVersion + ' is available. Reload the current web app to install the new version.',
      body: '<div class="confirm-panel"><span class="confirm-icon">↻</span><p>The browser build refreshes from the official Clines web app. Your account and cloud conversations remain online.</p></div>',
      primary: 'Reload and update',
      onPrimary: async () => {
        if ('serviceWorker' in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
          await Promise.all(registrations.map(registration => registration.update().catch(() => {})));
        }
        window.location.reload();
      }
    });
  } catch {
    /* Do not block current sessions if the public release feed is temporarily unavailable. */
  }
}
async function checkUpdatesManually() {
  try {
    if (window.flockDesktop && typeof window.flockDesktop.checkForUpdates === 'function') {
      await window.flockDesktop.checkForUpdates();
    } else if (mobileCapacitorPlatform() === 'android') {
      lastMobileUpdateVersion = '';
      lastMobileUpdateCheck = 0;
      await checkMobileUpdate({ force: true });
    } else {
      browserUpdatePromptVersion = '';
      lastBrowserUpdateCheck = 0;
      await checkBrowserUpdate({ force: true });
    }
  } catch (error) {
    toast('Could not check for updates', error.message || 'Try again when connected.', true);
  }
}
function wireMobileUpdates() {
  if (window.flockDesktop) return;
  if (mobileCapacitorPlatform() === 'android') {
    checkMobileUpdate({ force: true }).catch(() => {});
    window.addEventListener('focus', () => checkMobileUpdate().catch(() => {}));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkMobileUpdate().catch(() => {});
    });
    setInterval(() => checkMobileUpdate().catch(() => {}), 5 * 60 * 1000);
    return;
  }
  checkBrowserUpdate({ force: true }).catch(() => {});
  window.addEventListener('focus', () => checkBrowserUpdate().catch(() => {}));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkBrowserUpdate().catch(() => {});
  });
  setInterval(() => checkBrowserUpdate().catch(() => {}), 5 * 60 * 1000);
}
async function requestMessageNotificationPermission() {
  if (notificationPermissionAsked) return;
  notificationPermissionAsked = true;
  try {
    const native = nativeClinesPlugin();
    if (mobileCapacitorPlatform() === 'android' && native && typeof native.requestNotificationsPermission === 'function') {
      await native.requestNotificationsPermission();
      return;
    }
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  } catch {
    /* Notification permission is optional for foreground chat functionality. */
  }
}
async function showIncomingMessageNotification(conversation) {
  const message = conversation && conversation.latest;
  if (!message || message.sender_id === (user && user.id) || message.deleted_at) return;
  if (!document.hidden && activeConversation && activeConversation.id === conversation.id) return;
  const sender = conversation.kind === 'group'
    ? (message.sender && (message.sender.display_name || message.sender.username)) || conversation.title
    : conversation.title;
  const snippets = {
    image: 'Sent a photo',
    video: 'Sent a video',
    video_note: 'Sent a video note',
    voice: 'Sent a voice message',
    youtube: 'Shared a YouTube video'
  };
  const body = message.kind === 'text' ? String(message.body || 'New message').slice(0, 160) : (snippets[message.kind] || 'Sent an attachment');
  const title = conversation.kind === 'group' ? sender + ' · ' + conversation.title : sender;
  const notificationId = Math.abs(Array.from(String(message.id || conversation.id)).reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) | 0, 0)) || 1001;
  try {
    const native = nativeClinesPlugin();
    if (mobileCapacitorPlatform() === 'android' && native && typeof native.showMessageNotification === 'function') {
      await native.showMessageNotification({ id: notificationId, title, body, conversationId: conversation.id });
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      const notification = new Notification(title, { body, tag: 'clines-message-' + conversation.id, silent: false });
      notification.onclick = () => { window.focus(); notification.close(); };
    }
  } catch (error) {
    console.warn('[Clines] Message notification could not be shown:', error && error.message ? error.message : 'permission denied');
  }
}
function notifyNewConversationMessages(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!notificationBaselineReady) {
    list.forEach(conversation => {
      if (conversation.latest) notificationLatestIds.set(conversation.id, conversation.latest.id);
    });
    notificationBaselineReady = true;
    return;
  }
  list.forEach(conversation => {
    const latest = conversation.latest;
    if (!latest) return;
    const previousId = notificationLatestIds.get(conversation.id);
    notificationLatestIds.set(conversation.id, latest.id);
    if (previousId && previousId !== latest.id && latest.sender_id !== user.id && !latest.deleted_at) {
      showIncomingMessageNotification(conversation).catch(() => {});
    }
  });
}
function setAppLoading(message) {
  $('conversationList').innerHTML = '<div class="side-empty">' + escapeHtml(message || 'Loading your chats…') + '</div>';
}
async function refreshFriends() {
  assertUser();
  const { data, error } = await db.from('flock_friendships')
    .select('id,requester_id,addressee_id,status,created_at')
    .or('requester_id.eq.' + user.id + ',addressee_id.eq.' + user.id)
    .order('created_at', { ascending: false }).limit(400);
  if (error) throw error;
  const rows = data || [];
  const friendIds = Array.from(new Set(rows.filter(x => x.status === 'accepted').map(x => x.requester_id === user.id ? x.addressee_id : x.requester_id)));
  const requestIds = Array.from(new Set(rows.filter(x => x.status === 'pending' && x.addressee_id === user.id).map(x => x.requester_id)));
  const otherIds = Array.from(new Set(friendIds.concat(requestIds)));
  let profiles = [];
  if (otherIds.length) {
    const result = await db.from('flock_profiles').select('id,username,display_name,avatar_path,bio,friend_code').in('id', otherIds);
    if (result.error) throw result.error;
    profiles = result.data || [];
  }
  const profileMap = new Map(profiles.map(x => [x.id, x]));
  friends = rows.filter(x => x.status === 'accepted').map(x => {
    const id = x.requester_id === user.id ? x.addressee_id : x.requester_id;
    const p = profileMap.get(id);
    return p ? Object.assign({}, p, { friendship_id: x.id }) : null;
  }).filter(Boolean);
  friendRequests = rows.filter(x => x.status === 'pending' && x.addressee_id === user.id).map(x => {
    const p = profileMap.get(x.requester_id);
    return p ? Object.assign({}, p, { friendship_id: x.id, requested_at: x.created_at }) : null;
  }).filter(Boolean);
  await warmProfileMedia(friends.concat(friendRequests));
  $('friendCount').textContent = String(friends.length);
  renderFriends();
  return { friends, friendRequests };
}
function renderFriends() {
  const q = $('sidebarSearch').value.trim().toLowerCase();
  const rows = friends.filter(p => !q || (p.display_name + ' ' + p.username + ' ' + p.friend_code).toLowerCase().includes(q));
  let html = '';
  if (friendRequests.length) {
    html += '<div class="side-section-caption">FRIEND REQUESTS · ' + friendRequests.length + '</div>';
    html += friendRequests.map(p => {
      const url = p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
      return '<div class="friend-item"><span class="avatar">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span>') + '</span><span class="friend-copy"><strong>' + escapeHtml(p.display_name) + '</strong><span>@' + escapeHtml(p.username) + '</span></span><span class="friend-inline-actions"><button class="mini-action accept" data-accept-friend="' + p.friendship_id + '" title="Accept request">✓</button><button class="mini-action" data-decline-friend="' + p.friendship_id + '" title="Decline request">×</button></span></div>';
    }).join('');
  }
  if (rows.length) {
    html += '<div class="side-section-caption">' + (currentSidebarTab === 'friends' ? 'YOUR FRIENDS' : 'FRIENDS') + ' · ' + rows.length + '</div>';
    html += rows.map(p => {
      const url = p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
      return '<button class="friend-item friend-open" data-open-friend="' + p.id + '"><span class="avatar">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span>') + '</span><span class="friend-copy"><strong>' + escapeHtml(p.display_name) + '</strong><span>@' + escapeHtml(p.username) + ' · code ' + escapeHtml(p.friend_code) + '</span></span><span class="friend-open-glyph">↗</span></button>';
    }).join('');
  }
  if (!html) html = '<div class="side-empty"><strong>' + (q ? 'No matching friends' : 'Your people will show up here') + '</strong>' + (q ? 'Try another name or clear search.' : 'Add someone with their 10-digit friend code.') + '</div>';
  $('friendsList').innerHTML = html;
}
async function addFriendByCode(rawCode) {
  assertUser();
  const code = cleanFriendCode(rawCode);
  if (code.length !== 10) throw new Error('Enter the full 10-digit friend code.');
  const { data: matches, error: findError } = await db.rpc('flock_find_friend_code', { p_friend_code: code });
  if (findError) throw findError;
  const target = Array.isArray(matches) ? matches[0] : matches;
  if (!target) throw new Error('That friend code could not be found.');
  if (target.id === user.id) throw new Error('That is your own friend code.');
  const { data: existing, error: existingError } = await db.from('flock_friendships').select('*')
    .or('and(requester_id.eq.' + user.id + ',addressee_id.eq.' + target.id + '),and(requester_id.eq.' + target.id + ',addressee_id.eq.' + user.id + ')');
  if (existingError) throw existingError;
  const found = (existing || [])[0];
  if (found && found.status === 'accepted') throw new Error('You are already friends.');
  if (found && found.status === 'pending' && found.addressee_id === user.id) {
    const { error } = await db.from('flock_friendships').update({ status: 'accepted' }).eq('id', found.id);
    if (error) throw error;
  } else if (!found) {
    const { error } = await db.from('flock_friendships').insert({ requester_id: user.id, addressee_id: target.id, status: 'pending' });
    if (error) throw error;
  } else if (found.status === 'pending' && found.requester_id === user.id) {
    throw new Error('You already sent this person a friend request.');
  } else {
    throw new Error('This friendship cannot be changed right now.');
  }
  await refreshFriends();
  toast(found && found.status === 'pending' ? 'You are now friends' : 'Friend request sent', 'Find your friends in the Friends list.');
  return target;
}
async function acceptFriendRequest(id, status) {
  const { error } = await db.from('flock_friendships').update({ status: status }).eq('id', id);
  if (error) throw error;
  await refreshFriends();
  await refreshConversations();
  toast(status === 'accepted' ? 'Friend request accepted' : 'Request declined', '');
}
async function openDirectChat(friend) {
  assertUser();
  const { data, error } = await db.rpc('flock_create_direct_conversation', { p_other_user: friend.id });
  if (error) throw error;
  await refreshConversations();
  const conversation = conversations.find(c => c.id === data);
  if (conversation) await openConversation(conversation);
}
async function refreshConversations(options) {
  assertUser();
  if (!(options && options.quiet)) setAppLoading('Syncing your conversations…');
  const memberRes = await db.from('flock_conversation_members')
    .select('conversation_id,role,last_read_at,joined_at')
    .eq('user_id', user.id).order('joined_at', { ascending: false }).limit(300);
  if (memberRes.error) throw memberRes.error;
  const ids = (memberRes.data || []).map(x => x.conversation_id);
  if (!ids.length) {
    conversations = [];
    renderConversations();
    notifyNewConversationMessages(conversations);
    return [];
  }
  const [convRes, memberRowsRes, messagesRes] = await Promise.all([
    db.from('flock_conversations').select('*').in('id', ids).order('updated_at', { ascending: false }),
    db.from('flock_conversation_members').select('conversation_id,user_id,role,last_read_at').in('conversation_id', ids),
    db.from('flock_messages').select('id,conversation_id,sender_id,kind,body,created_at,deleted_at,media_path').in('conversation_id', ids).order('created_at', { ascending: false }).limit(700)
  ]);
  if (convRes.error) throw convRes.error;
  if (memberRowsRes.error) throw memberRowsRes.error;
  if (messagesRes.error) throw messagesRes.error;
  const memberRows = memberRowsRes.data || [];
  const peerIds = Array.from(new Set(memberRows.map(x => x.user_id).filter(x => x !== user.id)));
  let peerProfiles = [];
  if (peerIds.length) {
    const result = await db.from('flock_profiles').select('id,username,display_name,avatar_path,friend_code').in('id', peerIds);
    if (result.error) throw result.error;
    peerProfiles = result.data || [];
  }
  await warmProfileMedia(peerProfiles);
  const pmap = new Map(peerProfiles.map(x => [x.id, x]));
  const localMember = new Map((memberRes.data || []).map(x => [x.conversation_id, x]));
  const latestById = new Map();
  for (const m of messagesRes.data || []) if (!latestById.has(m.conversation_id)) latestById.set(m.conversation_id, m);
  conversations = (convRes.data || []).map(c => {
    const members = memberRows.filter(x => x.conversation_id === c.id);
    const other = members.find(x => x.user_id !== user.id);
    const otherProfile = other ? pmap.get(other.user_id) : null;
    const latest = latestById.get(c.id) || null;
    const mineMember = localMember.get(c.id);
    return Object.assign({}, c, {
      members, myRole: mineMember ? mineMember.role : 'member',
      peer: otherProfile || null, latest,
      title: c.kind === 'group' ? (c.name || 'Untitled group') : (otherProfile ? otherProfile.display_name : 'Conversation'),
      subtitle: c.kind === 'group' ? (members.length + ' members') : (otherProfile ? '@' + otherProfile.username : 'Direct chat'),
      unread: Boolean(latest && latest.sender_id !== user.id && !latest.deleted_at && (!mineMember || !mineMember.last_read_at || new Date(latest.created_at) > new Date(mineMember.last_read_at))),
    });
  });
  notifyNewConversationMessages(conversations);
  conversations.sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
  renderConversations();
  $('chatCount').textContent = String(conversations.length);
  if (activeConversation) {
    const fresh = conversations.find(c => c.id === activeConversation.id);
    if (fresh) activeConversation = fresh;
  }
  return conversations;
}
function renderConversations() {
  const q = $('sidebarSearch').value.trim().toLowerCase();
  const rows = conversations.filter(c => !q || (c.title + ' ' + c.subtitle + ' ' + (c.latest ? c.latest.body : '')).toLowerCase().includes(q));
  $('conversationList').innerHTML = rows.length ? rows.map(c => {
    const p = c.peer;
    const avatarUrl = p && p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
    const initial = safeInitial(c.title);
    let preview = c.latest ? (c.latest.deleted_at ? 'Message deleted' : c.latest.kind === 'text' ? c.latest.body : c.latest.kind === 'youtube' ? 'YouTube video' : c.latest.kind === 'voice' ? 'Voice message' : c.latest.kind === 'video_note' ? 'Video note' : c.latest.kind === 'image' ? 'Photo' : c.latest.kind === 'video' ? 'Video' : 'Attachment') : 'Start a conversation';
    if (c.latest && c.latest.sender_id === user.id) preview = 'You: ' + preview;
    const unread = c.unread ? '<span class="conversation-unread">•</span>' : '';
    return '<button class="conversation-item ' + (activeConversation && activeConversation.id === c.id ? 'active' : '') + '" data-conversation-id="' + c.id + '">' +
      '<span class="avatar">' + (avatarUrl ? '<img src="' + escapeHtml(avatarUrl) + '" alt="">' : '<span class="avatar-initial">' + escapeHtml(initial) + '</span>') + (p ? '<span class="avatar-online-indicator"></span>' : '') + '</span>' +
      '<span class="conversation-copy"><span class="conversation-topline"><strong>' + escapeHtml(c.title) + '</strong><span class="conversation-time">' + escapeHtml(c.latest ? fmtTime(c.latest.created_at) : '') + '</span></span>' +
      '<span class="conversation-bottomline"><span class="conversation-preview">' + escapeHtml(preview).slice(0, 120) + '</span>' + unread + '</span></span></button>';
  }).join('') : '<div class="side-empty"><strong>' + (q ? 'No conversations found' : 'No chats yet') + '</strong>' + (q ? 'Try another search.' : 'Add a friend to start your first conversation.') + '</div>';
  $('conversationList').querySelectorAll('[data-conversation-id]').forEach(btn => btn.addEventListener('click', () => {
    const c = conversations.find(item => item.id === btn.dataset.conversationId);
    if (c) openConversation(c).catch(err => toast('Could not open chat', err.message, true));
  }));
}
function renderFriends() {
  const q = $('sidebarSearch').value.trim().toLowerCase();
  const rows = friends.filter(p => !q || (p.display_name + ' ' + p.username + ' ' + p.friend_code).toLowerCase().includes(q));
  let html = '';
  if (friendRequests.length) {
    html += '<div class="side-section-caption">FRIEND REQUESTS · ' + friendRequests.length + '</div>';
    html += friendRequests.map(p => {
      const url = p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
      return '<div class="friend-item"><span class="avatar">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span>') + '</span><span class="friend-copy"><strong>' + escapeHtml(p.display_name) + '</strong><span>@' + escapeHtml(p.username) + '</span></span><span class="friend-inline-actions"><button class="mini-action accept" data-accept-friend="' + p.friendship_id + '" title="Accept">✓</button><button class="mini-action" data-decline-friend="' + p.friendship_id + '" title="Decline">×</button></span></div>';
    }).join('');
  }
  if (rows.length) {
    html += '<div class="side-section-caption">YOUR FRIENDS · ' + rows.length + '</div>';
    html += rows.map(p => {
      const url = p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
      return '<button class="friend-item friend-open" data-open-friend="' + p.id + '"><span class="avatar">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span>') + '</span><span class="friend-copy"><strong>' + escapeHtml(p.display_name) + '</strong><span>@' + escapeHtml(p.username) + ' · ' + escapeHtml(p.friend_code) + '</span></span><span class="friend-open-glyph">↗</span></button>';
    }).join('');
  }
  if (!html) html = '<div class="side-empty"><strong>' + (q ? 'No matching friends' : 'Your people will show up here') + '</strong>' + (q ? 'Try another name or clear search.' : 'Add someone with their 10-digit friend code.') + '</div>';
  $('friendsList').innerHTML = html;
  $('friendsList').querySelectorAll('[data-accept-friend]').forEach(btn => btn.addEventListener('click', () => acceptFriendRequest(btn.dataset.acceptFriend, 'accepted').catch(err => toast('Could not accept request', err.message, true))));
  $('friendsList').querySelectorAll('[data-decline-friend]').forEach(btn => btn.addEventListener('click', () => acceptFriendRequest(btn.dataset.declineFriend, 'declined').catch(err => toast('Could not decline request', err.message, true))));
  $('friendsList').querySelectorAll('[data-open-friend]').forEach(btn => btn.addEventListener('click', () => {
    const p = friends.find(item => item.id === btn.dataset.openFriend);
    if (p) openDirectChat(p).catch(err => toast('Could not start chat', err.message, true));
  }));
}
async function openConversation(conversation) {
  activeConversation = conversation;
  closeSidebarForMobile();
  $('emptyChat').hidden = true;
  $('chatView').hidden = false;
  $('chatWorkspace').classList.add('chat-has-conversation');
  $('chatTitle').textContent = conversation.title;
  $('chatSubtitle').textContent = conversation.subtitle;
  $('chatHeaderOnline').hidden = conversation.kind === 'group';
  $('chatHeaderAvatarFallback').textContent = safeInitial(conversation.title);
  const peerAvatarPath = conversation.kind === 'direct' && conversation.peer ? conversation.peer.avatar_path : null;
  const peerUrl = peerAvatarPath ? await getSignedUrl(peerAvatarPath).catch(() => '') : '';
  $('chatHeaderAvatar').src = peerUrl;
  $('chatHeaderAvatar').hidden = !peerUrl;
  $('chatHeaderAvatarFallback').hidden = Boolean(peerUrl);
  $('addPeopleBtn').hidden = conversation.kind !== 'group' || !['owner','admin','co_admin'].includes(conversation.myRole);
  $('voiceCallBtn').hidden = conversation.kind !== 'direct' || !conversation.peer;
  $('messageTimeline').innerHTML = '<div class="timeline-start">This is the beginning of something good.</div>';
  $('messageInput').value = '';
  $('sendMessageBtn').disabled = true;
  pendingReply = null;
  $('replyBar').hidden = true;
  await refreshMessages(conversation.id, true);
  await markConversationRead(conversation.id);
  subscribeConversation(conversation.id);
}
async function refreshMessages(conversationId, scrollBottom) {
  const { data, error } = await db.from('flock_messages').select('*')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(150);
  if (error) throw error;
  const rows = (data || []).reverse();
  const ids = rows.map(x => x.id);
  const senderIds = Array.from(new Set(rows.map(x => x.sender_id)));
  const [profilesResult, receiptsResult, reactionsResult] = await Promise.all([
    senderIds.length ? db.from('flock_profiles').select('id,username,display_name,avatar_path').in('id', senderIds) : Promise.resolve({ data: [], error: null }),
    ids.length ? db.from('flock_message_receipts').select('message_id,user_id,read_at,delivered_at').in('message_id', ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? db.from('flock_message_reactions').select('message_id,user_id,emoji').in('message_id', ids) : Promise.resolve({ data: [], error: null })
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (receiptsResult.error) throw receiptsResult.error;
  if (reactionsResult.error) throw reactionsResult.error;
  const pmap = new Map((profilesResult.data || []).map(x => [x.id, x]));
  await warmProfileMedia(profilesResult.data || []);
  const rmap = new Map();
  for (const r of receiptsResult.data || []) {
    if (!rmap.has(r.message_id)) rmap.set(r.message_id, []);
    rmap.get(r.message_id).push(r);
  }
  const rxmap = new Map();
  for (const r of reactionsResult.data || []) {
    if (!rxmap.has(r.message_id)) rxmap.set(r.message_id, []);
    rxmap.get(r.message_id).push(r);
  }
  currentMessages = rows.map(m => Object.assign({}, m, { sender: pmap.get(m.sender_id) || null, receipts: rmap.get(m.id) || [], reactions: rxmap.get(m.id) || [] }));
  await warmMessageMedia(currentMessages);
  renderMessages(currentMessages);
  if (scrollBottom) scrollTimelineToBottom(false);
  else if (scrollBottom !== false) scrollTimelineToBottom(false);
  $('chatSubtitle').textContent = activeConversation && activeConversation.id === conversationId
    ? activeConversation.subtitle + (activeConversation.kind === 'group' ? ' · ' + activeConversation.myRole.replace('_',' ') : '')
    : '';
}
async function warmMessageMedia(rows) {
  const paths = Array.from(new Set((rows || []).map(m => m.media_path).filter(Boolean)));
  await Promise.all(paths.map(p => getSignedUrl(p).catch(() => '')));
}
function scrollTimelineToBottom(smooth) {
  const node = $('messageTimeline');
  requestAnimationFrame(() => { node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' }); });
}
function linkifyText(value) {
  const escaped = escapeHtml(value);
  return escaped.replace(/https?:\/\/[^\s<]+/g, url => {
    const clean = url.replace(/[.,!?;:)]+$/g, '');
    const tail = url.slice(clean.length);
    return '<a href="' + clean + '" target="_blank" rel="noopener noreferrer">' + clean + '</a>' + tail;
  }).replace(/\n/g, '<br>');
}
function messagePayloadMarkup(m) {
  if (m.deleted_at) return '<div class="message-bubble deleted">This message was deleted</div>';
  let body = '';
  if (m.kind === 'text') body = '<div class="message-bubble">' + linkifyText(m.body || '') + '</div>';
  else if (m.kind === 'youtube') {
    const id = m.youtube_id || '';
    body = '<div class="message-youtube"><button class="youtube-thumb" data-youtube-open="' + escapeHtml(id) + '" title="Play YouTube video"><img loading="lazy" src="https://img.youtube.com/vi/' + escapeHtml(id) + '/hqdefault.jpg" alt=""><span class="youtube-play">▶</span></button><div class="youtube-caption">YouTube video shared in Clines<small>Opens YouTube in a new tab</small></div></div>' + (m.body ? '<div class="message-bubble">' + linkifyText(m.body) + '</div>' : '');
  } else if (m.media_path) {
    const url = peekSignedUrl(m.media_path);
    const name = escapeHtml(m.media_name || 'Attachment');
    if (!url) body = '<div class="message-bubble">Media is not available right now.</div>';
    else if (m.kind === 'image') body = '<a class="message-media" href="' + escapeHtml(url) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + escapeHtml(url) + '" alt="' + name + '"></a>' + (m.body ? '<div class="message-bubble">' + linkifyText(m.body) + '</div>' : '');
    else if (m.kind === 'video' || m.kind === 'video_note') body = '<div class="message-media"><video controls preload="metadata" playsinline src="' + escapeHtml(url) + '"></video></div>' + (m.body ? '<div class="message-bubble">' + linkifyText(m.body) + '</div>' : '');
    else if (m.kind === 'voice') body = '<div class="message-bubble voice-bubble"><span class="voice-icon">♫</span><audio class="message-audio" controls preload="metadata" src="' + escapeHtml(url) + '"></audio><small>' + fmtDuration(0) + ' voice note</small></div>';
    else body = '<div class="message-bubble"><a class="message-file-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener" download="' + name + '"><span class="file-visual">↧</span><span><strong>' + name + '</strong><small>' + fmtBytes(m.media_size) + ' · Download file</small></span></a></div>';
  } else body = '<div class="message-bubble">' + linkifyText(m.body || '') + '</div>';
  const myMessage = m.sender_id === user.id;
  const canEdit = myMessage && !m.deleted_at && m.kind === 'text';
  const canDelete = myMessage && !m.deleted_at;
  const reactions = (m.reactions || []).reduce((acc, r) => {
    const prior = acc.find(x => x.emoji === r.emoji);
    if (prior) { prior.count++; if (r.user_id === user.id) prior.mine = true; }
    else acc.push({ emoji: r.emoji, count: 1, mine: r.user_id === user.id });
    return acc;
  }, []);
  const rx = reactions.length ? '<div class="message-reactions">' + reactions.map(r => '<button class="reaction-chip ' + (r.mine ? 'mine' : '') + '" data-react-message="' + m.id + '" data-react-emoji="' + r.emoji + '">' + r.emoji + ' ' + r.count + '</button>').join('') + '</div>' : '';
  const timestamp = fmtTime(m.created_at);
  const seen = myMessage && (m.receipts || []).some(r => r.user_id !== user.id && Boolean(r.read_at));
  const ticks = myMessage && !m.deleted_at ? '<span class="message-ticks ' + (seen ? 'seen' : '') + '" title="' + (seen ? 'Seen' : 'Sent') + '">✓✓</span>' : '';
  const edited = m.edited_at ? '<span class="message-edited">edited</span>' : '';
  const senderName = activeConversation && activeConversation.kind === 'group' && !myMessage ? '<span class="message-sender-name">' + escapeHtml(m.sender ? m.sender.display_name : 'Clines friend') + '</span>' : '';
  const avatarPath = !myMessage && m.sender ? m.sender.avatar_path : null;
  const avatarUrl = avatarPath ? peekSignedUrl(avatarPath) : '';
  const avatar = !myMessage && activeConversation && activeConversation.kind === 'group'
    ? '<span class="message-sender-avatar">' + (avatarUrl ? '<img src="' + escapeHtml(avatarUrl) + '" alt="">' : escapeHtml(safeInitial(m.sender && m.sender.display_name))) + '</span>' : '';
  const actions = '<div class="message-actions">' + (canEdit ? '<button data-edit-message="' + m.id + '" title="Edit message">✎</button>' : '') +
    (myMessage && !m.deleted_at ? '<button data-react-quick="' + m.id + '" title="React">☺</button>' : '') +
    '<button data-reply-message="' + m.id + '" title="Reply">↶</button>' +
    (canDelete ? '<button data-delete-message="' + m.id + '" title="Delete message">×</button>' : '') + '</div>';
  const authorLabel = myMessage ? 'You' : (m.sender ? m.sender.display_name : 'Clines friend');
  return '<div class="message-row ' + (myMessage ? 'mine' : 'theirs') + '" data-message-id="' + m.id + '">' + avatar +
    '<div class="message-stack">' + senderName + body + rx +
    '<div class="message-meta"><span>' + escapeHtml(timestamp) + '</span>' + edited + ticks + '</div>' + actions + '</div></div>';
}
function renderMessages(rows) {
  const timeline = $('messageTimeline');
  if (!rows.length) {
    timeline.innerHTML = '<div class="timeline-start">Say hi. Start something good.</div>';
    return;
  }
  let html = '<div class="timeline-start">Your messages live here.</div>';
  let lastDate = '';
  rows.forEach(m => {
    const date = fmtDate(m.created_at);
    if (date !== lastDate) {
      html += '<div class="date-divider"><span>' + escapeHtml(date) + '</span></div>';
      lastDate = date;
    }
    html += messagePayloadMarkup(m);
  });
  timeline.innerHTML = html;
  timeline.querySelectorAll('[data-edit-message]').forEach(btn => btn.addEventListener('click', () => editMessage(btn.dataset.editMessage)));
  timeline.querySelectorAll('[data-delete-message]').forEach(btn => btn.addEventListener('click', () => deleteMessage(btn.dataset.deleteMessage)));
  timeline.querySelectorAll('[data-reply-message]').forEach(btn => btn.addEventListener('click', () => replyToMessage(btn.dataset.replyMessage)));
  timeline.querySelectorAll('[data-react-quick]').forEach(btn => btn.addEventListener('click', () => openReactionPicker(btn.dataset.reactQuick)));
  timeline.querySelectorAll('[data-react-message]').forEach(btn => btn.addEventListener('click', () => toggleReaction(btn.dataset.reactMessage, btn.dataset.reactEmoji)));
  timeline.querySelectorAll('[data-youtube-open]').forEach(btn => btn.addEventListener('click', () => window.open('https://www.youtube.com/watch?v=' + encodeURIComponent(btn.dataset.youtubeOpen), '_blank', 'noopener')));
  timeline.querySelectorAll('a[target="_blank"]').forEach(a => a.addEventListener('click', () => {}));
}
function subscribeConversation(conversationId) {
  if (realtimeChannel && db) db.removeChannel(realtimeChannel);
  if (presenceChannel && db) db.removeChannel(presenceChannel);
  realtimeChannel = null;
  presenceChannel = null;
  if (conversationPoller) clearInterval(conversationPoller);
  conversationPoller = null;
  const poll = async () => {
    if (conversationPollBusy || !user || !activeConversation || activeConversation.id !== conversationId || document.hidden) return;
    conversationPollBusy = true;
    try {
      await refreshMessages(conversationId, false);
      await db.rpc('flock_mark_conversation_read', { p_conversation_id: conversationId });
      await refreshConversations({ quiet: true });
      if (activeConversation && activeConversation.id === conversationId) renderPresence();
    } catch (error) {
      console.warn('[Clines] Conversation sync paused:', error && error.message ? error.message : 'network error');
    } finally {
      conversationPollBusy = false;
    }
  };
  conversationPoller = setInterval(poll, 2400);
}

function renderPresence() {
  if (!presenceChannel || !activeConversation || activeConversation.kind !== 'direct') return;
  const states = presenceChannel.presenceState();
  const online = Object.keys(states).some(key => key !== user.id && (states[key] || []).some(x => x.user_id !== user.id));
  $('chatHeaderOnline').hidden = !online;
  $('chatSubtitle').textContent = activeConversation.subtitle + (online ? ' · online' : '');
}
async function markConversationRead(conversationId) {
  if (!user || !conversationId) return;
  const { error } = await db.rpc('flock_mark_conversation_read', { p_conversation_id: conversationId });
  if (!error) {
    await refreshConversations().catch(() => {});
    if (activeConversation && activeConversation.id === conversationId) await refreshMessages(conversationId, false).catch(() => {});
  }
}
async function sendMessage(body, kind, media, youtubeId, options) {
  assertUser();
  const targetConversationId = options && options.conversationId ? options.conversationId : (activeConversation && activeConversation.id);
  if (!targetConversationId) throw new Error('Choose a conversation first.');
  const clean = String(body || '').trim();
  const k = kind || 'text';
  if (k === 'text' && !clean) return;
  const row = {
    conversation_id: targetConversationId,
    sender_id: user.id,
    kind: k,
    body: clean,
    media_path: media ? media.path : null,
    media_name: media ? media.name : null,
    media_type: media ? media.type : null,
    media_size: media ? media.size : null,
    youtube_id: youtubeId || null,
    reply_to: activeConversation && activeConversation.id === targetConversationId && pendingReply ? pendingReply.id : null
  };
  const { data, error } = await db.from('flock_messages').insert(row).select('id').single();
  if (error) {
    if (media && media.path) await removeMedia(media.path);
    throw error;
  }
  if (activeConversation && activeConversation.id === targetConversationId) {
    $('messageInput').value = '';
    $('messageInput').style.height = 'auto';
    $('sendMessageBtn').disabled = true;
    pendingReply = null;
    $('replyBar').hidden = true;
    if (presenceChannel) presenceChannel.send({ type: 'broadcast', event: 'typing', payload: { userId: user.id, typing: false } }).catch(() => {});
    await refreshMessages(targetConversationId, true);
  }
  await refreshConversations();
  return data;
}
async function handleSendMessage(event) {
  event.preventDefault();
  const body = $('messageInput').value;
  try { await sendMessage(body, 'text'); }
  catch (error) { toast('Message not sent', error.message || 'Check your connection and try again.', true); }
}
async function sendMediaFile(file, body, kindOverride) {
  if (!file) return;
  const conversationId = activeConversation && activeConversation.id;
  if (!conversationId) throw new Error('Choose a conversation first.');
  const type = file.type || '';
  let kind = kindOverride;
  if (!kind) {
    if (type.startsWith('image/')) kind = 'image';
    else if (type.startsWith('video/')) kind = 'video';
    else if (type.startsWith('audio/')) kind = 'voice';
    else kind = 'file';
  }
  const status = $('composerStatus');
  status.textContent = 'Uploading ' + fmtBytes(file.size) + '…';
  try {
    const media = await uploadMedia(file, 'messages');
    await sendMessage(body || '', kind, media, null, { conversationId });
    toast('Message sent', 'Your media is uploaded and available in this conversation.');
  } finally { status.textContent = ''; }
}
async function editMessage(id) {
  const m = currentMessages.find(x => x.id === id);
  if (!m || m.sender_id !== user.id || m.deleted_at || m.kind !== 'text') return;
  showModal({
    kicker: 'CLINES / MESSAGE',
    title: 'Edit your message',
    description: 'The updated message will be visible to everyone in this chat.',
    body: '<label for="editMessageInput">MESSAGE</label><textarea id="editMessageInput" class="input-field" maxlength="10000" rows="4">' + escapeHtml(m.body || '') + '</textarea>',
    primary: 'Save changes',
    onPrimary: async () => {
      const body = $('editMessageInput').value.trim();
      if (!body) throw new Error('A message cannot be empty. Delete it instead.');
      const { error } = await db.from('flock_messages').update({ body: body, edited_at: new Date().toISOString() }).eq('id', id).eq('sender_id', user.id);
      if (error) throw error;
      closeModal();
      await refreshMessages(activeConversation.id, false);
      toast('Message edited', '');
    }
  });
}
async function deleteMessage(id) {
  const m = currentMessages.find(x => x.id === id);
  if (!m || m.sender_id !== user.id || m.deleted_at) return;
  showModal({
    kicker: 'CLINES / MESSAGE',
    title: 'Delete this message?',
    description: 'Everyone in the conversation will see that the message was deleted.',
    body: '<div class="confirm-panel"><span class="confirm-icon">×</span><p>This cannot be undone. The message content will be replaced with a deleted notice.</p></div>',
    primary: 'Delete message',
    onPrimary: async () => {
      const oldPath = m.media_path;
      const { error } = await db.from('flock_messages').update({
        body: '', media_path: null, media_name: null, media_type: null, media_size: null,
        deleted_at: new Date().toISOString(), edited_at: null
      }).eq('id', id).eq('sender_id', user.id);
      if (error) throw error;
      closeModal();
      if (oldPath) await removeMedia(oldPath);
      await refreshMessages(activeConversation.id, false);
      toast('Message deleted', '');
    }
  });
}
function replyToMessage(id) {
  const m = currentMessages.find(x => x.id === id);
  if (!m) return;
  pendingReply = m;
  const author = m.sender_id === user.id ? 'You' : (m.sender ? m.sender.display_name : 'Friend');
  $('replyText').textContent = author + ': ' + (m.deleted_at ? 'Message deleted' : m.body || (m.kind === 'voice' ? 'Voice note' : m.kind === 'video_note' ? 'Video note' : m.kind === 'image' ? 'Photo' : m.kind === 'video' ? 'Video' : 'Attachment'));
  $('replyBar').hidden = false;
  $('messageInput').focus();
}
async function openReactionPicker(id) {
  const options = ['❤️','😂','👍','😮','😢','🔥','🎉'];
  showModal({
    kicker: 'CLINES / REACTION',
    title: 'React to the moment',
    description: 'Pick a reaction for this message.',
    body: '<div class="reaction-picker">' + options.map(e => '<button class="reaction-option" data-pick-reaction="' + e + '">' + e + '</button>').join('') + '</div>',
    hidePrimary: true,
    onCancel: null
  });
  $('modalBody').querySelectorAll('[data-pick-reaction]').forEach(btn => btn.addEventListener('click', async () => {
    closeModal();
    try { await toggleReaction(id, btn.dataset.pickReaction); }
    catch (error) { toast('Could not add reaction', error.message, true); }
  }));
}
async function toggleReaction(id, emoji) {
  const { data: existing, error: readError } = await db.from('flock_message_reactions')
    .select('message_id,user_id,emoji').eq('message_id', id).eq('user_id', user.id).maybeSingle();
  if (readError) throw readError;
  if (existing && existing.emoji === emoji) {
    const { error } = await db.from('flock_message_reactions').delete().eq('message_id', id).eq('user_id', user.id);
    if (error) throw error;
  } else {
    if (existing) {
      const { error: delError } = await db.from('flock_message_reactions').delete().eq('message_id', id).eq('user_id', user.id);
      if (delError) throw delError;
    }
    const { error } = await db.from('flock_message_reactions').insert({ message_id: id, user_id: user.id, emoji: emoji });
    if (error) throw error;
  }
  if (activeConversation) await refreshMessages(activeConversation.id, false);
}
async function createGroup() {
  await refreshFriends();
  if (!friends.length) {
    showModal({ kicker: 'CLINES / GROUPS', title: 'Bring your people together', description: 'You need at least one friend before creating a group.', body: '<p class="modal-empty-copy">Add a friend with their 10-digit friend code first.</p><button id="modalAddFriendLink" class="button button-primary" type="button">Add a friend</button>', hidePrimary: true });
    $('modalAddFriendLink').addEventListener('click', () => openAddFriend());
    return;
  }
  showModal({
    kicker: 'CLINES / GROUPS',
    title: 'Create a group',
    description: 'Give your group a name and choose people to invite. You’ll be the owner.',
    body: '<label for="groupNameInput">GROUP NAME</label><input id="groupNameInput" class="input-field" maxlength="80" placeholder="The after-hours crew"><label>ADD FRIENDS</label><div class="selection-list">' + friends.map(p => '<label class="selection-row"><input type="checkbox" value="' + p.id + '" data-group-member><span class="avatar">' + escapeHtml(safeInitial(p.display_name)) + '</span><span class="selection-copy"><strong>' + escapeHtml(p.display_name) + '</strong><small>@' + escapeHtml(p.username) + '</small></span></label>').join('') + '</div>',
    primary: 'Create group',
    onPrimary: async () => {
      const name = $('groupNameInput').value.trim();
      const ids = Array.from($('modalBody').querySelectorAll('[data-group-member]:checked')).map(x => x.value);
      if (!name) throw new Error('Choose a group name.');
      const { data, error } = await db.rpc('flock_create_group', { p_name: name, p_member_ids: ids });
      if (error) throw error;
      await refreshConversations();
      closeModal();
      const conv = conversations.find(x => x.id === data);
      if (conv) await openConversation(conv);
      toast('Group created', name + ' is ready for messages.');
    }
  });
}
function openAddFriend() {
  showModal({
    kicker: 'CLINES / FRIENDS',
    title: 'Find your people',
    description: 'Enter the 10-digit friend code someone shared with you.',
    body: '<label for="friendCodeInput">FRIEND CODE</label><input id="friendCodeInput" class="input-field" inputmode="numeric" maxlength="10" placeholder="0123456789"><p class="field-hint">Your code is on the left side of Clines. Share it only with people you trust.</p><div id="friendFound" class="friend-found"></div>',
    primary: 'Send friend request',
    onPrimary: async () => {
      const code = $('friendCodeInput').value;
      await addFriendByCode(code);
      closeModal();
    }
  });
  $('friendCodeInput').addEventListener('input', e => { e.target.value = cleanFriendCode(e.target.value); });
}
async function openProfileEditor() {
  assertUser();
  const avatarUrl = profile.avatar_path ? await getSignedUrl(profile.avatar_path).catch(() => '') : '';
  const backgroundLabel = profile.background_path ? (profile.background_type === 'video' ? 'A video background is set' : 'A photo background is set') : 'No custom chat background';
  showModal({
    kicker: 'CLINES / YOUR PROFILE',
    title: 'Your space, your style.',
    description: 'Your display name, avatar and background sync to your account across devices.',
    body: '<div class="profile-edit-row"><div class="profile-edit-avatar">' + (avatarUrl ? '<img src="' + escapeHtml(avatarUrl) + '" alt="">' : escapeHtml(safeInitial(profile.display_name))) + '</div><div><strong class="profile-edit-name">' + escapeHtml(profile.display_name) + '</strong><div class="field-hint">@' + escapeHtml(profile.username) + ' · username cannot be changed yet</div><button id="chooseAvatarBtn" class="text-button" type="button">Change profile picture ↗</button></div></div><label for="displayNameInput">DISPLAY NAME</label><input id="displayNameInput" class="input-field" maxlength="80" value="' + escapeHtml(profile.display_name) + '"><label for="bioInput">ABOUT YOU</label><textarea id="bioInput" class="input-field" maxlength="180" rows="2" placeholder="A little about you…">' + escapeHtml(profile.bio || '') + '</textarea><div class="profile-background-row"><div><strong>Chat background</strong><small>' + escapeHtml(backgroundLabel) + '</small></div><button id="chooseBackgroundBtn" class="button button-soft" type="button">Choose photo or video</button><button id="clearBackgroundBtn" class="text-button" type="button">Remove</button></div><div class="profile-security-row"><div><strong>Account password</strong><small>Change your Clines password any time.</small></div><button id="changePasswordBtn" class="button button-soft" type="button">Change password</button></div>',
    primary: 'Save profile',
    onPrimary: async () => {
      const displayName = $('displayNameInput').value.trim();
      const bio = $('bioInput').value.trim();
      if (displayName.length < 1 || displayName.length > 80) throw new Error('Display name must contain 1–80 characters.');
      const { error } = await db.from('flock_profiles').update({ display_name: displayName, bio }).eq('id', user.id);
      if (error) throw error;
      await refreshProfile();
      await refreshFriends();
      await refreshConversations();
      closeModal();
      toast('Profile updated', 'Your profile is synced.');
    }
  });
  $('changePasswordBtn').addEventListener('click', () => {
    closeModal();
    openChangePassword().catch(err => toast('Could not open password settings', err.message || 'Try again.', true));
  });
  $('chooseAvatarBtn').addEventListener('click', () => { closeModal(); $('avatarFileInput').click(); });
  $('chooseBackgroundBtn').addEventListener('click', () => { closeModal(); $('backgroundFileInput').click(); });
  $('clearBackgroundBtn').addEventListener('click', async () => {
    const old = profile.background_path;
    const { error } = await db.from('flock_profiles').update({ background_path: null, background_type: null }).eq('id', user.id);
    if (error) { feedback('modalFeedback', error.message, true); return; }
    profile.background_path = null;
    profile.background_type = null;
    if (old) removeMedia(old);
    applyChatWallpaper();
    toast('Background removed', 'Your chats are back to the default look.');
    await openProfileEditor();
  });
}
async function openChangePassword() {
  showModal({
    kicker: 'CLINES / ACCOUNT SECURITY',
    title: 'Update your password',
    description: 'Your password is hashed on the server. Clines never stores or displays the original password.',
    body: '<label for="currentPasswordInput">CURRENT PASSWORD</label><input id="currentPasswordInput" class="input-field" type="password" autocomplete="current-password" maxlength="128" placeholder="Current password"><label for="newPasswordInput">NEW PASSWORD</label><input id="newPasswordInput" class="input-field" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="At least 8 characters"><label for="confirmNewPasswordInput">CONFIRM NEW PASSWORD</label><input id="confirmNewPasswordInput" class="input-field" type="password" autocomplete="new-password" minlength="8" maxlength="128" placeholder="Type it again">',
    primary: 'Update password',
    onPrimary: async () => {
      const current = $('currentPasswordInput').value;
      const next = $('newPasswordInput').value;
      if (next.length < 8 || next.length > 128) throw new Error('New password must be 8–128 characters long.');
      if (next !== $('confirmNewPasswordInput').value) throw new Error('The new passwords do not match.');
      await flockAuth('change-password', { password: current, newPassword: next });
      closeModal();
      toast('Password updated', 'Other active sessions have been signed out.');
    }
  });
}
async function handleAvatarUpload(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const media = await uploadMedia(file, 'profile');
  const old = profile.avatar_path;
  const { error } = await db.from('flock_profiles').update({ avatar_path: media.path }).eq('id', user.id);
  if (error) { await removeMedia(media.path); throw error; }
  profile.avatar_path = media.path;
  signedUrlCache.delete(media.path);
  await getSignedUrl(media.path).catch(() => '');
  if (old) await removeMedia(old);
  renderProfile();
  await refreshFriends();
  await refreshConversations();
  toast('Profile picture updated', 'Your new picture is synced to your account.');
}
async function handleBackgroundUpload(file) {
  if (!file) return;
  const type = file.type || '';
  if (!['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm'].includes(type)) throw new Error('Use JPG, PNG, WebP, GIF, MP4 or WebM.');
  const media = await uploadMedia(file, 'background');
  const old = profile.background_path;
  const { error } = await db.from('flock_profiles').update({
    background_path: media.path, background_type: type.startsWith('video/') ? 'video' : 'image'
  }).eq('id', user.id);
  if (error) { await removeMedia(media.path); throw error; }
  profile.background_path = media.path;
  profile.background_type = type.startsWith('video/') ? 'video' : 'image';
  await getSignedUrl(media.path).catch(() => '');
  if (old) await removeMedia(old);
  applyChatWallpaper();
  toast('Chat background updated', 'Your style syncs with your profile.');
}
async function applyChatWallpaper() {
  const node = $('chatWallpaper');
  if (!node || !profile || !profile.background_path) {
    if (node) { node.style.backgroundImage = ''; node.classList.remove('has-wallpaper'); }
    return;
  }
  const url = await getSignedUrl(profile.background_path).catch(() => '');
  if (!url) return;
  if (profile.background_type === 'image') node.style.backgroundImage = 'linear-gradient(#121315a8,#121315a8),url("' + url.replace(/"/g, '%22') + '")';
  else {
    node.style.backgroundImage = 'none';
    if (!node.querySelector('video')) {
      const video = document.createElement('video');
      video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
      video.className = 'wallpaper-video'; video.src = url; node.appendChild(video);
    } else node.querySelector('video').src = url;
  }
  node.classList.add('has-wallpaper');
}
async function openConversationDetails() {
  if (!activeConversation) return;
  if (activeConversation.kind === 'direct') {
    const peer = activeConversation.peer;
    const blocked = peer ? await isUserBlocked(peer.id).catch(() => false) : false;
    showModal({
      kicker: 'CLINES / CONVERSATION',
      title: activeConversation.title,
      description: peer ? '@' + peer.username + ' · friend code ' + peer.friend_code : 'Direct conversation',
      body: '<div class="details-card"><strong>One-to-one conversation</strong><p>Voice calls are available in direct chats. You can block this account from chat options and manage blocked users in the sidebar.</p></div>' +
        (peer ? '<button id="detailsBlockUserBtn" class="modal-option" type="button">' + (blocked ? '✓ Unblock @' : '⊘ Block @') + escapeHtml(peer.username) + '</button>' : ''),
      hidePrimary: true
    });
    if (peer && $('detailsBlockUserBtn')) $('detailsBlockUserBtn').addEventListener('click', () => {
      closeModal();
      if (blocked) unblockUser(peer.id).catch(err => toast('Could not unblock user', err.message, true));
      else confirmBlockUser(peer.id, peer.username);
    });
    return;
  }
  showGroupDetails();
}
async function confirmDisbandGroup(conversationId, groupName) {
  showModal({
    kicker: 'CLINES / DANGER ZONE',
    title: 'Disband this group?',
    description: 'The group, its membership, and its chat history will be deleted for everyone. This cannot be undone.',
    body: '<div class="confirm-panel"><span class="confirm-icon">!</span><p>Everyone will lose access to "' + escapeHtml(groupName) + '".</p></div>',
    primary: 'Disband group',
    cancel: 'Keep group',
    onPrimary: async () => {
      const { error } = await db.rpc('flock_disband_group', { p_conversation_id: conversationId });
      if (error) throw error;
      closeModal();
      activeConversation = null;
      $('chatView').hidden = true;
      $('emptyChat').hidden = false;
      $('chatWorkspace').classList.remove('chat-has-conversation', 'chat-open');
      await refreshConversations();
      toast('Group disbanded', 'The group has been removed.');
    }
  });
}
function canRemoveGroupMember(actorRole, targetRole, targetId) {
  if (targetRole === 'owner') return false;
  if (targetId === user.id) return actorRole !== 'owner';
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole === 'co_admin' || targetRole === 'member';
  if (actorRole === 'co_admin') return targetRole === 'member';
  return false;
}
async function showGroupDetails() {
  if (!activeConversation || activeConversation.kind !== 'group') return;
  const convId = activeConversation.id;
  const convName = activeConversation.name || 'Group';
  const actorRole = activeConversation.myRole || 'member';
  const { data: members, error } = await db.from('flock_conversation_members')
    .select('user_id,role,joined_at').eq('conversation_id', convId).order('joined_at');
  if (error) throw error;
  const ids = (members || []).map(x => x.user_id);
  const pRes = ids.length ? await db.from('flock_profiles').select('id,username,display_name,avatar_path').in('id', ids) : { data: [], error: null };
  if (pRes.error) throw pRes.error;
  await warmProfileMedia(pRes.data || []);
  const map = new Map((pRes.data || []).map(x => [x.id,x]));
  const canAdmin = ['owner','admin'].includes(actorRole);
  const body = '<label for="editGroupName">GROUP NAME</label><div class="modal-inline-row"><input id="editGroupName" class="input-field" maxlength="80" value="' + escapeHtml(convName) + '">' +
    (canAdmin ? '<button id="saveGroupNameBtn" class="button button-soft" type="button">Rename</button>' : '') + '</div>' +
    '<label>MEMBERS · ' + members.length + '</label><div class="modal-profile-list">' + members.map(m => {
      const p = map.get(m.user_id) || { display_name: 'Clines user', username: 'user' };
      const url = p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
      const availableRoles = actorRole === 'owner' ? ['admin','co_admin','member'] : ['co_admin','member'];
      const roleOptions = availableRoles.map(role => '<option value="' + role + '" ' + (m.role === role ? 'selected' : '') + '>' + (role === 'co_admin' ? 'Co-admin' : role === 'admin' ? 'Admin' : 'Member') + '</option>').join('');
      const canChangeThisRole = actorRole === 'owner' || (actorRole === 'admin' && ['co_admin','member'].includes(m.role));
      const controls = m.role === 'owner' ? '<span class="role-pill owner">Owner</span>' :
        (canChangeThisRole ? '<select class="form-select group-role-select" data-member-role="' + m.user_id + '">' + roleOptions + '</select>' :
        '<span class="role-pill">' + escapeHtml(m.role.replace('_',' ')) + '</span>');
      const remove = canRemoveGroupMember(actorRole, m.role, m.user_id) ? '<button class="mini-action remove-group-member" data-remove-group-member="' + m.user_id + '" title="Remove member" aria-label="Remove member">×</button>' : '';
      return '<div class="modal-member-row"><span class="avatar">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span>') + '</span><span class="modal-member-copy"><strong>' + escapeHtml(p.display_name) + (m.user_id === user.id ? ' (you)' : '') + '</strong><small>@' + escapeHtml(p.username) + '</small></span>' + controls + remove + '</div>';
    }).join('') + '</div><p class="field-hint">Owners can manage every non-owner. Admins can manage members and co-admins. Co-admins can remove regular members. The server checks permissions before changing membership.</p>' +
    (actorRole === 'owner' ? '<button id="disbandGroupBtn" class="modal-option danger-option" type="button">⌫ Disband this group</button>' :
    '<button id="leaveGroupBtn" class="modal-option danger-option" type="button">↗ Leave this group</button>');
  showModal({
    kicker: 'CLINES / GROUP SETTINGS',
    title: convName,
    description: 'Manage members, roles, and the group itself.',
    body,
    primary: 'Done',
    onPrimary: async () => closeModal()
  });
  if ($('saveGroupNameBtn')) $('saveGroupNameBtn').addEventListener('click', async () => {
    const name = $('editGroupName').value.trim();
    if (!name || name.length > 80) { feedback('modalFeedback', 'Group names must be 1–80 characters.', true); return; }
    const { error: saveError } = await db.from('flock_conversations').update({ name }).eq('id', convId);
    if (saveError) { feedback('modalFeedback', saveError.message, true); return; }
    await refreshConversations();
    activeConversation = conversations.find(c => c.id === convId) || activeConversation;
    $('chatTitle').textContent = name;
    $('modalTitle').textContent = name;
    toast('Group renamed', '');
  });
  $('modalBody').querySelectorAll('[data-member-role]').forEach(select => select.addEventListener('change', async () => {
    try {
      const { error: roleError } = await db.rpc('flock_set_group_role', {
        p_conversation_id: convId, p_user_id: select.dataset.memberRole, p_role: select.value
      });
      if (roleError) throw roleError;
      await refreshConversations();
      toast('Group role updated', '');
    } catch (err) { feedback('modalFeedback', err.message || 'Could not change role.', true); }
  }));
  $('modalBody').querySelectorAll('[data-remove-group-member]').forEach(btn => btn.addEventListener('click', () => {
    const targetId = btn.dataset.removeGroupMember;
    const target = members.find(m => m.user_id === targetId);
    const targetProfile = map.get(targetId);
    const isSelf = targetId === user.id;
    showModal({
      kicker: 'CLINES / GROUP MEMBERS',
      title: isSelf ? 'Leave this group?' : 'Remove this member?',
      description: isSelf ? 'You will no longer see or receive messages from this group.' : 'This person will lose access to the group chat.',
      body: '<div class="confirm-panel"><span class="confirm-icon">!</span><p>' + escapeHtml(isSelf ? 'You can be invited back later.' : ((targetProfile && targetProfile.display_name) || 'This member') + ' will be removed from ' + convName + '.') + '</p></div>',
      primary: isSelf ? 'Leave group' : 'Remove member',
      onPrimary: async () => {
        const { error: removeError } = await db.rpc('flock_remove_group_member', { p_conversation_id: convId, p_user_id: targetId });
        if (removeError) throw removeError;
        closeModal();
        await refreshConversations();
        if (isSelf) {
          activeConversation = null;
          $('chatView').hidden = true;
          $('emptyChat').hidden = false;
          $('chatWorkspace').classList.remove('chat-has-conversation', 'chat-open');
          toast('Left group', '');
        } else {
          activeConversation = conversations.find(c => c.id === convId) || activeConversation;
          await showGroupDetails();
          toast('Member removed', 'The group membership was updated.');
        }
      }
    });
  }));
  if ($('disbandGroupBtn')) $('disbandGroupBtn').addEventListener('click', () => confirmDisbandGroup(convId, convName));
  if ($('leaveGroupBtn')) $('leaveGroupBtn').addEventListener('click', () => {
    showModal({
      kicker: 'CLINES / GROUP MEMBERS',
      title: 'Leave this group?',
      description: 'You can be invited back by a group admin.',
      body: '<div class="confirm-panel"><span class="confirm-icon">↗</span><p>You will leave "' + escapeHtml(convName) + '".</p></div>',
      primary: 'Leave group',
      onPrimary: async () => {
        const { error: leaveError } = await db.rpc('flock_remove_group_member', { p_conversation_id: convId, p_user_id: user.id });
        if (leaveError) throw leaveError;
        closeModal();
        activeConversation = null;
        $('chatView').hidden = true;
        $('emptyChat').hidden = false;
        $('chatWorkspace').classList.remove('chat-has-conversation', 'chat-open');
        await refreshConversations();
        toast('Left group', '');
      }
    });
  });
}
async function isUserBlocked(userId) {
  if (!userId || !user) return false;
  const { data, error } = await db.from('flock_user_blocks').select('blocked_id').eq('blocker_id', user.id).eq('blocked_id', userId).maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
async function confirmBlockUser(userId, username) {
  showModal({
    kicker: 'CLINES / PRIVACY',
    title: 'Block @' + String(username || 'user'),
    description: 'You and this account will no longer be able to use Clines direct chat with each other.',
    body: '<div class="confirm-panel"><span class="confirm-icon">⊘</span><p>Blocking removes the friendship if one exists and prevents direct messages and calls. You can unblock them later from Blocked users.</p></div>',
    primary: 'Block user',
    onPrimary: async () => {
      const { error } = await db.rpc('flock_block_user', { p_user_id: userId });
      if (error) throw error;
      closeModal();
      await refreshFriends().catch(() => {});
      await refreshConversations().catch(() => {});
      if (activeConversation && activeConversation.kind === 'direct' && activeConversation.peer && activeConversation.peer.id === userId) {
        activeConversation = null;
        $('chatView').hidden = true;
        $('emptyChat').hidden = false;
        $('chatWorkspace').classList.remove('chat-has-conversation', 'chat-open');
      }
      toast('User blocked', '@' + String(username || 'user') + ' is now blocked.');
    }
  });
}
async function unblockUser(userId) {
  const { error } = await db.rpc('flock_unblock_user', { p_user_id: userId });
  if (error) throw error;
  await refreshFriends().catch(() => {});
  await refreshConversations().catch(() => {});
  toast('User unblocked', 'They can interact with you again.');
  await openBlockedUsers();
}
async function openBlockedUsers() {
  assertUser();
  const { data, error } = await db.from('flock_user_blocks').select('blocked_id,created_at').eq('blocker_id', user.id).order('created_at', { ascending: false });
  if (error) throw error;
  const ids = (data || []).map(row => row.blocked_id);
  const profilesResult = ids.length ? await db.from('flock_profiles').select('id,username,display_name,avatar_path').in('id', ids) : { data: [], error: null };
  if (profilesResult.error) throw profilesResult.error;
  const pmap = new Map((profilesResult.data || []).map(p => [p.id, p]));
  const body = ids.length ? '<div class="modal-profile-list">' + ids.map(id => {
    const p = pmap.get(id) || { id, username: 'unavailable', display_name: 'Clines user' };
    return '<div class="modal-member-row"><span class="avatar"><span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span></span><span class="modal-member-copy"><strong>' + escapeHtml(p.display_name) + '</strong><small>@' + escapeHtml(p.username) + '</small></span><button class="button button-soft" type="button" data-unblock-user="' + id + '">Unblock</button></div>';
  }).join('') + '</div>' : '<div class="details-card"><strong>No blocked users</strong><p>When you block someone from a direct chat, they will appear here.</p></div>';
  showModal({
    kicker: 'CLINES / PRIVACY',
    title: 'Blocked users',
    description: 'Only you can see this list. Unblock someone to allow direct interaction again.',
    body,
    hidePrimary: true
  });
  $('modalBody').querySelectorAll('[data-unblock-user]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { error: unblockError } = await db.rpc('flock_unblock_user', { p_user_id: btn.dataset.unblockUser });
      if (unblockError) throw unblockError;
      await refreshFriends().catch(() => {});
      await refreshConversations().catch(() => {});
      toast('User unblocked', 'They can interact with you again.');
      await openBlockedUsers();
    } catch (err) { btn.disabled = false; feedback('modalFeedback', err.message || 'Could not unblock user.', true); }
  }));
}
function openAboutNew() {
  showModal({
    kicker: 'CLINES / VERSION 1.0.6',
    title: 'About New',
    description: 'What is new in the Clines 1.0.6 update.',
    body: '<div class="release-notes"><div class="release-note"><b>01</b><span><strong>Required app updates</strong><small>When a newer release is available, installed apps lock the screen until the update is installed.</small></span></div><div class="release-note"><b>02</b><span><strong>Visible download progress</strong><small>Windows shows download progress and restarts to finish installing. Supported Android builds show APK download progress and open the Android installer.</small></span></div><div class="release-note"><b>03</b><span><strong>Replay-only video moments</strong><small>Status videos play without seek, pause or stop controls; Replay starts the video from the beginning.</small></span></div><div class="release-note"><b>04</b><span><strong>Message notifications</strong><small>Clines can alert you when new messages arrive, subject to notification permission and whether the app is allowed to run.</small></span></div><div class="release-note"><b>05</b><span><strong>Update controls, clearer layout</strong><small>Use Update Clines for a release check or About New for release notes.</small></span></div></div><button id="aboutCheckUpdatesBtn" type="button" class="button button-soft button-wide">↻ Check for updates</button>',
    hidePrimary: true
  });
  $('aboutCheckUpdatesBtn').addEventListener('click', checkUpdatesManually);
}

async function addPeopleToGroup() {
  if (!activeConversation || activeConversation.kind !== 'group') return;
  await refreshFriends();
  const memberIds = new Set(activeConversation.members.map(m => m.user_id));
  const choices = friends.filter(f => !memberIds.has(f.id));
  if (!choices.length) { toast('Everyone is already here', 'Add another friend first.'); return; }
  showModal({
    kicker: 'CLINES / GROUPS',
    title: 'Bring another friend in',
    description: 'Choose accepted friends to add to this group.',
    body: '<div class="selection-list">' + choices.map(p => '<label class="selection-row"><input type="checkbox" value="' + p.id + '" data-add-group-member><span class="avatar"><span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span></span><span class="selection-copy"><strong>' + escapeHtml(p.display_name) + '</strong><small>@' + escapeHtml(p.username) + '</small></span></label>').join('') + '</div>',
    primary: 'Add selected friends',
    onPrimary: async () => {
      const ids = Array.from($('modalBody').querySelectorAll('[data-add-group-member]:checked')).map(x => x.value);
      if (!ids.length) throw new Error('Choose at least one friend.');
      for (const id of ids) {
        const { error } = await db.rpc('flock_add_group_member', { p_conversation_id: activeConversation.id, p_user_id: id });
        if (error) throw error;
      }
      closeModal();
      await refreshConversations();
      const c = conversations.find(x => x.id === activeConversation.id);
      if (c) await openConversation(c);
      toast('Friends added', ids.length + ' friend' + (ids.length === 1 ? '' : 's') + ' joined the group.');
    }
  });
}
async function loadStatuses() {
  assertUser();
  const { data, error } = await db.from('flock_statuses').select('*').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(150);
  if (error) throw error;
  statuses = data || [];
  const userIds = Array.from(new Set(statuses.map(s => s.user_id)));
  const { data: people, error: peopleError } = userIds.length
    ? await db.from('flock_profiles').select('id,username,display_name,avatar_path').in('id', userIds)
    : { data: [], error: null };
  if (peopleError) throw peopleError;
  await warmProfileMedia(people || []);
  const pmap = new Map((people || []).map(p => [p.id,p]));
  statuses = statuses.map(s => Object.assign({}, s, { author: pmap.get(s.user_id) || null }));
  lastStatusLoad = Date.now();
  return statuses;
}
async function openStatuses() {
  await loadStatuses();
  const mine = statuses.filter(s => s.user_id === user.id);
  const other = statuses.filter(s => s.user_id !== user.id);
  const makeRow = s => {
    const p = s.author || profile;
    const av = p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
    return '<button class="moment-row" data-view-status="' + s.id + '"><span class="moment-thumb">' + (av ? '<img src="' + escapeHtml(av) + '" alt="">' : escapeHtml(s.kind === 'text' ? '✦' : s.kind === 'video' ? '▷' : '◌')) + '</span><span class="moment-row-copy"><strong>' + escapeHtml(p.display_name || 'A friend') + (s.user_id === user.id ? ' · yours' : '') + '</strong><span>' + escapeHtml(s.body || (s.kind === 'video' ? 'Video moment' : s.kind === 'image' ? 'Photo moment' : 'A moment')) + ' · ' + escapeHtml(fmtTime(s.created_at)) + '</span></span></button>';
  };
  showModal({
    kicker: 'CLINES / MOMENTS',
    title: 'Little moments, shared.',
    description: 'Moments disappear 24 hours after they are posted.',
    body: '<div class="moment-toolbar"><button id="postTextStatusBtn" class="button button-soft" type="button">✦ Post a thought</button><button id="postMediaStatusBtn" class="button button-primary" type="button">＋ Add photo/video</button></div><label>YOUR MOMENTS</label><div class="moment-list">' + (mine.map(makeRow).join('') || '<p class="modal-empty-copy">You have not posted a moment yet.</p>') + '</div><label>FRIENDS’ MOMENTS</label><div class="moment-list">' + (other.map(makeRow).join('') || '<p class="modal-empty-copy">New moments from friends will appear here.</p>') + '</div>',
    hidePrimary: true
  });
  $('postTextStatusBtn').addEventListener('click', () => composeStatus('text'));
  $('postMediaStatusBtn').addEventListener('click', () => { closeModal(); $('statusFileInput').click(); });
  $('modalBody').querySelectorAll('[data-view-status]').forEach(btn => btn.addEventListener('click', () => {
    const index = statuses.findIndex(s => s.id === btn.dataset.viewStatus);
    if (index >= 0) viewStatus(index);
  }));
}
async function composeStatus(kind, file) {
  if (kind === 'text') {
    showModal({
      kicker: 'CLINES / MOMENTS',
      title: 'Share a thought',
      description: 'Your status is visible to friends for 24 hours.',
      body: '<label for="statusTextInput">WHAT’S THE MOMENT?</label><textarea id="statusTextInput" class="input-field" maxlength="500" rows="4" placeholder="A little update for your people…"></textarea>',
      primary: 'Post moment',
      onPrimary: async () => {
        const body = $('statusTextInput').value.trim();
        if (!body) throw new Error('Write something first.');
        const { error } = await db.from('flock_statuses').insert({ user_id: user.id, kind: 'text', body, expires_at: new Date(Date.now() + 24*60*60*1000).toISOString() });
        if (error) throw error;
        closeModal();
        toast('Moment posted', 'Your friends can see it for 24 hours.');
        openStatuses().catch(err => toast('Could not refresh moments', err.message, true));
      }
    });
    return;
  }
  if (!file) { $('statusFileInput').click(); return; }
  const type = file.type || '';
  const statusKind = type.startsWith('video/') ? 'video' : type.startsWith('image/') ? 'image' : '';
  if (!statusKind) throw new Error('Choose a photo, MP4 or WebM video.');
  showModal({
    kicker: 'CLINES / MOMENTS',
    title: 'Share this moment?',
    description: 'It will disappear after 24 hours.',
    body: '<div class="confirm-panel"><span class="confirm-icon">' + (statusKind === 'video' ? '▷' : '◌') + '</span><p><strong>' + escapeHtml(file.name) + '</strong><br>' + fmtBytes(file.size) + '</p></div><label for="statusCaptionInput">CAPTION (OPTIONAL)</label><input id="statusCaptionInput" class="input-field" maxlength="500" placeholder="Add a little context…">',
    primary: 'Post moment',
    onPrimary: async () => {
      const media = await uploadMedia(file, 'statuses');
      const { error } = await db.from('flock_statuses').insert({
        user_id: user.id, kind: statusKind, body: $('statusCaptionInput').value.trim(),
        media_path: media.path, media_type: media.type, expires_at: new Date(Date.now() + 24*60*60*1000).toISOString()
      });
      if (error) { await removeMedia(media.path); throw error; }
      closeModal();
      toast('Moment posted', 'Your friends can see it for 24 hours.');
      openStatuses().catch(err => toast('Could not refresh moments', err.message, true));
    }
  });
}
async function viewStatus(index) {
  if (index < 0 || index >= statuses.length) return;
  openedStatusIndex = index;
  const s = statuses[index];
  if (s.user_id !== user.id) {
    try {
      const { data: alreadyViewed, error: checkError } = await db.from('flock_status_views')
        .select('status_id').eq('status_id', s.id).eq('viewer_id', user.id).maybeSingle();
      if (checkError) throw checkError;
      if (!alreadyViewed) {
        const { error } = await db.from('flock_status_views').insert({ status_id: s.id, viewer_id: user.id });
        if (error && error.code !== '23505') throw error;
      }
    } catch (error) {
      console.warn('[Clines] Status view could not be recorded:', error.message);
    }
  }
  let media = '';
  if (s.media_path) {
    const url = await getSignedUrl(s.media_path).catch(() => '');
    if (url && s.kind === 'image') media = '<div class="status-preview"><img src="' + escapeHtml(url) + '" alt=""></div>';
    else if (url && s.kind === 'video') media = '<div class="status-preview status-video-locked"><video id="statusVideo" autoplay playsinline disablePictureInPicture controlsList="nodownload nofullscreen noplaybackrate" src="' + escapeHtml(url) + '"></video><button id="statusReplayBtn" class="status-replay-button" type="button" hidden>↻ Watch again</button></div>';
  }
  const p = s.author || profile;
  showModal({
    kicker: 'CLINES / MOMENT ' + (index + 1) + ' OF ' + statuses.length,
    title: p.display_name || 'A moment',
    description: '@' + (p.username || 'friend') + ' · ' + fmtTime(s.created_at) + ' · expires ' + fmtTime(s.expires_at),
    body: media + (s.body ? '<div class="status-caption">' + linkifyText(s.body) + '</div>' : ''),
    primary: s.user_id === user.id ? 'Delete moment' : (s.kind === 'video' ? 'Replay video' : 'Next moment →'),
    hideCancel: false,
    onPrimary: async () => {
      if (s.user_id === user.id) {
        const { error } = await db.from('flock_statuses').delete().eq('id', s.id).eq('user_id', user.id);
        if (error) throw error;
        if (s.media_path) await removeMedia(s.media_path);
        closeModal();
        toast('Moment deleted', '');
        await loadStatuses();
      } else if (s.kind === 'video') {
        const video = $('statusVideo');
        if (video) {
          video.currentTime = 0;
          video.play().catch(() => {
            const replay = $('statusReplayBtn');
            if (replay) { replay.hidden = false; replay.textContent = '▶ Play video'; }
          });
          const replay = $('statusReplayBtn');
          if (replay) replay.hidden = true;
        }
        return;
      } else {
        const { data: alreadyViewed, error: viewCheckError } = await db.from('flock_status_views').select('status_id').eq('status_id', s.id).eq('viewer_id', user.id).maybeSingle();
        if (viewCheckError) throw viewCheckError;
        if (!alreadyViewed) {
          const { error } = await db.from('flock_status_views').insert({ status_id: s.id, viewer_id: user.id });
          if (error && error.code !== '23505') throw error;
        }
        if (openedStatusIndex + 1 < statuses.length) await viewStatus(openedStatusIndex + 1);
        else { closeModal(); toast('You are all caught up', ''); }
      }
    },
    onCancel: null
  });
  if (s.user_id !== user.id && s.kind !== 'video') {
    $('modalPrimaryBtn').textContent = 'Next moment →';
    $('modalPrimaryBtn').disabled = false;
  }
  if (s.kind === 'video' && $('statusVideo')) {
    const video = $('statusVideo');
    const replay = $('statusReplayBtn');
    const playAgain = () => {
      video.currentTime = 0;
      if (replay) replay.hidden = true;
      video.play().catch(() => {
        if (replay) { replay.hidden = false; replay.textContent = '▶ Play video'; }
      });
    };
    video.addEventListener('ended', () => {
      if (replay) { replay.hidden = false; replay.textContent = '↻ Watch again'; }
    });
    video.addEventListener('pause', () => {
      if (!video.ended && video.currentTime > 0) video.play().catch(() => {});
    });
    video.addEventListener('contextmenu', event => event.preventDefault());
    if (replay) replay.addEventListener('click', playAgain);
    video.play().catch(() => {
      if (replay) { replay.hidden = false; replay.textContent = '▶ Play video'; }
    });
  }
}
async function openYouTubeShare() {
  showModal({
    kicker: 'CLINES / SHARE',
    title: 'Bring YouTube into chat',
    description: 'Paste a YouTube link and Clines will create an inline preview.',
    body: '<label for="youtubeUrlInput">YOUTUBE URL</label><input id="youtubeUrlInput" class="input-field" type="url" placeholder="https://www.youtube.com/watch?v=…"><label for="youtubeCaptionInput">MESSAGE (OPTIONAL)</label><input id="youtubeCaptionInput" class="input-field" maxlength="500" placeholder="You have to see this…">',
    primary: 'Share video',
    onPrimary: async () => {
      const raw = $('youtubeUrlInput').value.trim();
      let id = '';
      try {
        const u = new URL(raw);
        if (u.hostname === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || '';
        else if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com')) {
          id = u.searchParams.get('v') || (u.pathname.match(/\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/) || [])[1] || '';
        }
      } catch {}
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Paste a valid YouTube watch, Shorts or youtu.be link.');
      const body = $('youtubeCaptionInput').value.trim();
      await sendMessage(body, 'youtube', null, id);
      closeModal();
    }
  });
}
function insertAtCursor(text) {
  const input = $('messageInput');
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}
function openEmojiPicker() {
  const emojis = ['😀','😂','🥹','🥰','😍','😭','😎','🤔','😮','🙌','👏','👍','❤️','💚','✨','🔥','🎉','💀','👀','🙏','🥳','🤍','💜','🤝','🫶','💯','✅','🌸','🌙','⭐','🦋','🐣'];
  showModal({
    kicker: 'CLINES / EXPRESSION',
    title: 'Say it with a little feeling',
    description: 'Choose an emoji to add to your message.',
    body: '<div class="emoji-picker">' + emojis.map(e => '<button class="emoji-option" data-insert-emoji="' + e + '">' + e + '</button>').join('') + '</div>',
    hidePrimary: true
  });
  $('modalBody').querySelectorAll('[data-insert-emoji]').forEach(btn => btn.addEventListener('click', () => {
    closeModal(); insertAtCursor(btn.dataset.insertEmoji);
  }));
}
function supportedMime(kind) {
  const list = kind === 'video'
    ? ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4']
    : ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4;codecs=mp4a.40.2','audio/mp4'];
  if (typeof MediaRecorder === 'undefined') return '';
  try { return list.find(type => MediaRecorder.isTypeSupported(type)) || ''; }
  catch { return ''; }
}
async function startRecording(kind) {
  assertUser();
  if (!activeConversation) throw new Error('Open a conversation before recording.');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Recording is not supported by this device/browser. Try the installed app or a newer browser.');
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') throw new Error('Finish or cancel the current recording first.');
  const isVideo = kind === 'video_note';
  const targetConversationId = activeConversation.id;
  const stream = await navigator.mediaDevices.getUserMedia(isVideo
    ? { audio: { echoCancellation: true, noiseSuppression: true }, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 }, frameRate: { ideal: 24, max: 30 } } }
    : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  activeMediaStream = stream;
  recordingConversationId = targetConversationId;
  recordingKind = kind;
  recordingChunks = [];
  const mimeType = supportedMime(isVideo ? 'video' : 'audio');
  if (!mimeType) {
    stream.getTracks().forEach(track => track.stop());
    activeMediaStream = null;
    throw new Error('This browser does not support a compatible recording format.');
  }
  let recorder;
  try { recorder = new MediaRecorder(stream, { mimeType }); }
  catch (error) {
    stream.getTracks().forEach(track => track.stop());
    activeMediaStream = null;
    throw error;
  }
  mediaRecorder = recorder;
  recorder.ondataavailable = event => { if (event.data && event.data.size > 0) recordingChunks.push(event.data); };
  recorder.onerror = () => toast('Recording interrupted', 'Try recording again.', true);
  recorder.onstop = () => handleRecordingStopped(recorder.mimeType || mimeType, isVideo, targetConversationId, stream);
  $('recordingTitle').textContent = isVideo ? 'Recording video note' : 'Recording voice note';
  $('recordingPreview').hidden = !isVideo;
  if (isVideo) {
    $('recordingPreview').srcObject = stream;
    $('recordingPreview').muted = true;
    $('recordingPreview').playsInline = true;
    $('recordingPreview').play().catch(() => {});
  }
  $('recordingPanel').hidden = false;
  $('voiceNoteBtn').classList.toggle('recording', !isVideo);
  $('videoNoteBtn').classList.toggle('recording', isVideo);
  recordingStartedAt = Date.now();
  updateRecordingTimer();
  recordingTimer = setInterval(updateRecordingTimer, 250);
  try { recorder.start(500); }
  catch (error) {
    clearInterval(recordingTimer);
    stream.getTracks().forEach(track => track.stop());
    activeMediaStream = null;
    mediaRecorder = null;
    $('recordingPanel').hidden = true;
    $('voiceNoteBtn').classList.remove('recording');
    $('videoNoteBtn').classList.remove('recording');
    throw error;
  }
}
function updateRecordingTimer() {
  $('recordingTimer').textContent = fmtDuration((Date.now() - recordingStartedAt) / 1000);
}
async function handleRecordingStopped(mimeType, isVideo, targetConversationId, stream) {
  clearInterval(recordingTimer);
  if (stream) stream.getTracks().forEach(track => track.stop());
  if (activeMediaStream === stream) activeMediaStream = null;
  $('recordingPreview').srcObject = null;
  $('recordingPanel').hidden = true;
  $('voiceNoteBtn').classList.remove('recording');
  $('videoNoteBtn').classList.remove('recording');
  const chunks = recordingChunks;
  recordingChunks = [];
  if (!chunks.length) return;
  const baseType = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const blob = new Blob(chunks, { type: baseType });
  if (!blob.size) { toast('Empty recording', 'Please record again and speak or keep the camera running a little longer.', true); return; }
  const extByType = { 'video/webm':'webm', 'video/mp4':'mp4', 'audio/webm':'webm', 'audio/ogg':'ogg', 'audio/mp4':'m4a', 'audio/mpeg':'mp3' };
  const ext = extByType[baseType];
  if (!ext) { toast('Unsupported recording format', 'Try recording again on this device.', true); return; }
  const file = new File([blob], (isVideo ? 'video-note.' : 'voice-note.') + ext, { type: baseType });
  if (!activeConversation || activeConversation.id !== targetConversationId) {
    toast('Recording kept private', 'The chat changed before this note finished. The recording will still be sent to the original chat.', false);
  }
  const status = $('composerStatus');
  status.textContent = 'Uploading note…';
  try {
    const media = await uploadMedia(file, 'messages');
    await sendMessage('', isVideo ? 'video_note' : 'voice', media, null, { conversationId: targetConversationId });
    toast(isVideo ? 'Video note sent' : 'Voice note sent', 'Your note was sent to the conversation where you recorded it.');
  } catch (error) { toast('Could not send recording', error.message || 'Try again.', true); }
  finally { status.textContent = ''; }
}
function stopRecording(cancel) {
  clearInterval(recordingTimer);
  const recorder = mediaRecorder;
  if (!recorder || recorder.state === 'inactive') {
    if (activeMediaStream) activeMediaStream.getTracks().forEach(track => track.stop());
    activeMediaStream = null;
    recordingChunks = [];
    $('recordingPanel').hidden = true;
    $('recordingPreview').srcObject = null;
    $('voiceNoteBtn').classList.remove('recording');
    $('videoNoteBtn').classList.remove('recording');
    mediaRecorder = null;
    return;
  }
  if (cancel) {
    recorder.onstop = () => {
      if (activeMediaStream) activeMediaStream.getTracks().forEach(track => track.stop());
      activeMediaStream = null;
      recordingChunks = [];
      $('recordingPreview').srcObject = null;
      $('recordingPanel').hidden = true;
      $('voiceNoteBtn').classList.remove('recording');
      $('videoNoteBtn').classList.remove('recording');
    };
  }
  try { recorder.stop(); }
  finally { mediaRecorder = null; }
}
async function sendCallSignalTo(conversationId, recipientId, callId, signalType, payload) {
  const { error } = await db.from('flock_call_signals').insert({
    conversation_id: conversationId, sender_id: user.id, recipient_id: recipientId,
    call_id: callId, signal_type: signalType, payload: payload || {}
  });
  if (error) throw error;
}
function setCallStatus(text) {
  const node = $('callStatusText');
  if (node) node.textContent = text;
}
function showCallModal(title, status) {
  showModal({
    kicker: 'CLINES / VOICE CALL',
    title: title || 'Voice call',
    description: 'Clines direct voice call · keep this window open during the call.',
    body: '<div class="call-status-panel"><span class="call-pulse"></span><strong id="callStatusText">' + escapeHtml(status || 'Connecting…') + '</strong><small>Audio only. Your browser or device may ask for microphone permission.</small></div><button id="endVoiceCallBtn" class="button button-danger button-wide" type="button">End call</button>',
    hidePrimary: true,
    hideFooter: true,
    onCancel: () => endVoiceCall(true)
  });
  $('endVoiceCallBtn').addEventListener('click', () => endVoiceCall(true));
}
function makePeerConnection(call) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
  call.pc = pc;
  pc.onicecandidate = event => {
    if (!event.candidate || activeCall !== call) return;
    const candidate = event.candidate.toJSON();
    if (!call.signalReady) call.localCandidates.push(candidate);
    else sendCallSignalTo(call.conversationId, call.peerId, call.id, 'candidate', { candidate }).catch(err => console.warn('[Clines call] ICE candidate failed:', err.message));
  };
  pc.ontrack = event => {
    const audio = $('remoteCallAudio');
    if (audio && event.streams && event.streams[0]) {
      audio.srcObject = event.streams[0];
      audio.play().catch(() => setCallStatus('Connected. Tap the call screen if audio does not start.'));
    }
  };
  pc.onconnectionstatechange = () => {
    if (activeCall !== call) return;
    if (pc.connectionState === 'connected') setCallStatus('Connected · voice call in progress');
    else if (pc.connectionState === 'connecting') setCallStatus('Connecting audio…');
    else if (pc.connectionState === 'failed') setCallStatus('Could not connect. Check network permissions and try again.');
  };
  return pc;
}
async function flushLocalCallCandidates(call) {
  const pending = call.localCandidates.splice(0);
  for (const candidate of pending) await sendCallSignalTo(call.conversationId, call.peerId, call.id, 'candidate', { candidate });
}
async function flushRemoteCallCandidates(call) {
  if (!call.pc || !call.pc.remoteDescription) return;
  const pending = call.remoteCandidates.splice(0);
  for (const candidate of pending) {
    try { await call.pc.addIceCandidate(candidate); }
    catch (error) { console.warn('[Clines call] Skipped ICE candidate:', error.message); }
  }
}
async function startVoiceCall() {
  assertUser();
  const conversation = activeConversation;
  if (!conversation || conversation.kind !== 'direct' || !conversation.peer) throw new Error('Open a direct conversation to start a voice call.');
  if (activeCall) throw new Error('A voice call is already active or ringing.');
  const call = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2),
    conversationId: conversation.id, peerId: conversation.peer.id,
    peerName: conversation.peer.display_name || conversation.peer.username,
    direction: 'outgoing', pc: null, localStream: null, localCandidates: [], remoteCandidates: [], signalReady: false
  };
  activeCall = call;
  try {
    call.localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const pc = makePeerConnection(call);
    call.localStream.getTracks().forEach(track => pc.addTrack(track, call.localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    showCallModal('Calling ' + call.peerName, 'Calling @' + (conversation.peer.username || 'friend') + '…');
    await sendCallSignalTo(call.conversationId, call.peerId, call.id, 'offer', { offer: pc.localDescription });
    call.signalReady = true;
    await flushLocalCallCandidates(call);
  } catch (error) {
    await endVoiceCall(false);
    throw new Error(error && error.name === 'NotAllowedError' ? 'Allow microphone access to start a voice call.' : (error.message || 'Could not start this voice call.'));
  }
}
function showIncomingCallModal(call) {
  showModal({
    kicker: 'CLINES / INCOMING CALL',
    title: call.peerName + ' is calling',
    description: 'Voice call request · accept only if you want to talk now.',
    body: '<div class="call-status-panel"><span class="call-pulse"></span><strong>Incoming voice call</strong><small>Allow microphone access when asked. This call uses internet connectivity.</small></div><div class="call-action-row"><button id="declineVoiceCallBtn" class="button button-soft" type="button">Decline</button><button id="acceptVoiceCallBtn" class="button button-primary" type="button">Accept call</button></div>',
    hidePrimary: true,
    hideFooter: true,
    onCancel: () => declineVoiceCall()
  });
  $('acceptVoiceCallBtn').addEventListener('click', () => acceptVoiceCall().catch(err => {
    toast('Could not answer call', err.message || 'Try again.', true);
    endVoiceCall(true);
  }));
  $('declineVoiceCallBtn').addEventListener('click', () => declineVoiceCall().catch(err => toast('Could not decline call', err.message, true)));
}
async function acceptVoiceCall() {
  const call = activeCall;
  if (!call || call.direction !== 'incoming' || !call.offer) return;
  try {
    call.localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const pc = makePeerConnection(call);
    call.localStream.getTracks().forEach(track => pc.addTrack(track, call.localStream));
    await pc.setRemoteDescription(call.offer);
    await flushRemoteCallCandidates(call);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    showCallModal('Voice call with ' + call.peerName, 'Connecting audio…');
    await sendCallSignalTo(call.conversationId, call.peerId, call.id, 'answer', { answer: pc.localDescription });
    call.signalReady = true;
    await flushLocalCallCandidates(call);
  } catch (error) {
    await endVoiceCall(true);
    throw new Error(error && error.name === 'NotAllowedError' ? 'Allow microphone access to answer the call.' : (error.message || 'Could not answer this call.'));
  }
}
async function declineVoiceCall() {
  const call = activeCall;
  if (!call) return;
  await sendCallSignalTo(call.conversationId, call.peerId, call.id, 'reject', {}).catch(() => {});
  await endVoiceCall(false);
}
async function handleCallSignal(signal) {
  if (!signal || !signal.signal_type) return;
  if (signal.signal_type === 'offer') {
    if (activeCall) {
      await sendCallSignalTo(signal.conversation_id, signal.sender_id, signal.call_id, 'reject', { reason: 'busy' }).catch(() => {});
      return;
    }
    const conversation = conversations.find(c => c.id === signal.conversation_id && c.kind === 'direct');
    if (!conversation) {
      await sendCallSignalTo(signal.conversation_id, signal.sender_id, signal.call_id, 'reject', { reason: 'unavailable' }).catch(() => {});
      return;
    }
    const peer = conversation.peer || {};
    const call = {
      id: signal.call_id, conversationId: signal.conversation_id, peerId: signal.sender_id,
      peerName: peer.display_name || peer.username || 'Clines user', direction: 'incoming',
      pc: null, localStream: null, localCandidates: [], remoteCandidates: [], signalReady: false,
      offer: signal.payload && signal.payload.offer
    };
    if (!call.offer) return;
    activeCall = call;
    pendingIncomingCall = call;
    showIncomingCallModal(call);
    return;
  }
  const call = activeCall;
  if (!call || call.id !== signal.call_id || call.conversationId !== signal.conversation_id) return;
  if (signal.signal_type === 'candidate' && signal.payload && signal.payload.candidate) {
    if (call.pc && call.pc.remoteDescription) {
      try { await call.pc.addIceCandidate(signal.payload.candidate); }
      catch (error) { console.warn('[Clines call] Skipped remote ICE candidate:', error.message); }
    } else call.remoteCandidates.push(signal.payload.candidate);
  } else if (signal.signal_type === 'answer' && call.direction === 'outgoing' && signal.payload && signal.payload.answer) {
    try {
      await call.pc.setRemoteDescription(signal.payload.answer);
      await flushRemoteCallCandidates(call);
      setCallStatus('Connected · negotiating audio…');
    } catch (error) {
      toast('Call connection failed', error.message || 'Try again.', true);
      await endVoiceCall(true);
    }
  } else if (signal.signal_type === 'reject') {
    await endVoiceCall(false);
    toast('Call declined', call.peerName + ' did not accept the call.');
  } else if (signal.signal_type === 'end') {
    await endVoiceCall(false);
    toast('Call ended', 'The other person ended the call.');
  }
}
async function pollCallSignals() {
  if (callSignalPollBusy || !user || !db || document.hidden) return;
  callSignalPollBusy = true;
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data, error } = await db.from('flock_call_signals').select('id,conversation_id,sender_id,recipient_id,call_id,signal_type,payload,created_at')
      .eq('recipient_id', user.id).gte('created_at', since).order('created_at', { ascending: true }).limit(100);
    if (error) throw error;
    for (const signal of data || []) {
      if (processedCallSignalIds.has(signal.id)) continue;
      processedCallSignalIds.add(signal.id);
      try { await handleCallSignal(signal); }
      catch (error) { console.warn('[Clines call] Signal handler failed:', error.message); }
      await db.from('flock_call_signals').delete().eq('id', signal.id).eq('recipient_id', user.id);
    }
    if (processedCallSignalIds.size > 500) processedCallSignalIds.clear();
  } catch (error) {
    console.warn('[Clines call] Signal polling paused:', error && error.message ? error.message : 'network error');
  } finally { callSignalPollBusy = false; }
}
function startCallSignalPolling() {
  if (callSignalPoller) clearInterval(callSignalPoller);
  callSignalPoller = setInterval(() => pollCallSignals().catch(() => {}), 1000);
  pollCallSignals().catch(() => {});
}
async function endVoiceCall(notifyPeer) {
  const call = activeCall;
  activeCall = null;
  pendingIncomingCall = null;
  if (call && notifyPeer) sendCallSignalTo(call.conversationId, call.peerId, call.id, 'end', {}).catch(() => {});
  if (call && call.pc) {
    try { call.pc.onicecandidate = null; call.pc.ontrack = null; call.pc.close(); } catch {}
  }
  if (call && call.localStream) call.localStream.getTracks().forEach(track => track.stop());
  if (activeMediaStream) { activeMediaStream.getTracks().forEach(track => track.stop()); activeMediaStream = null; }
  const audio = $('remoteCallAudio');
  if (audio) { audio.pause(); audio.srcObject = null; }
  if (!$('modalBackdrop').hidden && (String($('modalKicker').textContent).startsWith('CLINES / VOICE CALL') || String($('modalKicker').textContent).startsWith('CLINES / INCOMING CALL'))) {
    modalCancelHandler = null;
    closeModal();
  }
}

function closeSidebarForMobile() {
  $('appScreen').classList.add('chat-open');
}
function goBackToChats() {
  $('appScreen').classList.remove('chat-open');
}
function updateMobileView(view) {
  document.querySelectorAll('[data-mobile-view]').forEach(btn => btn.classList.toggle('active', btn.dataset.mobileView === view));
  if (view === 'friends') {
    setSidebarTab('friends');
    goBackToChats();
  } else if (view === 'chats') {
    setSidebarTab('chats');
    goBackToChats();
  } else if (view === 'moments') openStatuses().catch(err => toast('Could not load moments', err.message, true));
  else if (view === 'profile') openProfileEditor().catch(err => toast('Could not open profile', err.message, true));
}
function setSidebarTab(tab) {
  currentSidebarTab = tab;
  document.querySelectorAll('[data-sidebar-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.sidebarTab === tab));
  $('conversationList').hidden = tab !== 'chats';
  $('friendsList').hidden = tab !== 'friends';
  if (tab === 'friends') renderFriends();
  else renderConversations();
}
async function signOut() {
  if (conversationPoller) clearInterval(conversationPoller);
  if (globalPoller) clearInterval(globalPoller);
  if (callSignalPoller) clearInterval(callSignalPoller);
  callSignalPoller = null;
  await endVoiceCall(false).catch(() => {});
  conversationPoller = null;
  globalPoller = null;
  const priorToken = flockSessionToken;
  try { await flockAuth('logout', {}, priorToken); } catch {}
  user = null;
  profile = null;
  activeConversation = null;
  conversations = [];
  friends = [];
  friendRequests = [];
  if (realtimeChannel && db) db.removeChannel(realtimeChannel);
  if (presenceChannel && db) db.removeChannel(presenceChannel);
  if (authSubscription && db) db.removeChannel(authSubscription);
  realtimeChannel = null;
  presenceChannel = null;
  authSubscription = null;
  signedUrlCache.clear();
  persistFlockSession('', false);
  showAuthScreen(false);
  toast('Signed out', 'Your messages remain saved to your Clines account.');
}
function bindEvents() {
  $('showSignInTab').addEventListener('click', () => showAuthScreen(false));
  $('showSignUpTab').addEventListener('click', () => showAuthScreen(true));
  document.querySelectorAll('[data-toggle-password]').forEach(btn => btn.addEventListener('click', () => {
    const input = $(btn.dataset.togglePassword);
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.setAttribute('aria-label', input.type === 'password' ? 'Show password' : 'Hide password');
  }));
  $('signInForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!db) { feedback('authFeedback','Clines is not configured. Check your connection and try again.',true); return; }
    const button = $('signInForm').querySelector('[type="submit"]');
    button.disabled = true;
    feedback('authFeedback','Signing you in securely…');
    try {
      const result = await flockAuth('login', {
        username: $('signInUsername').value.trim().toLowerCase(),
        password: $('signInPassword').value,
        remember: $('rememberMe').checked
      }, null);
      persistFlockSession(result.sessionToken, result.remember);
      user = result.user;
      await enterApp();
      toast('Welcome back', 'Your Clines account is ready.');
    } catch (error) {
      feedback('authFeedback', error.message || 'Could not sign in. Check your username and password.', true);
    } finally { button.disabled = false; }
  });
  $('signUpForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!db) { feedback('authFeedback','Clines is not configured. Check your connection and try again.',true); return; }
    const username = $('signUpUsername').value.trim().toLowerCase();
    const password = $('signUpPassword').value;
    const confirm = $('signUpConfirm').value;
    if (!/^[a-z0-9_.-]{3,24}$/.test(username)) { feedback('authFeedback','Use 3–24 letters, numbers, dots, underscores or hyphens for your username.',true); return; }
    if (password.length < 8 || password.length > 128) { feedback('authFeedback','Choose a password with 8–128 characters.',true); return; }
    if (password !== confirm) { feedback('authFeedback','The passwords do not match.',true); return; }
    const button = $('signUpForm').querySelector('[type="submit"]');
    button.disabled = true;
    feedback('authFeedback','Creating your private Clines account…');
    try {
      const result = await flockAuth('register', {
        username, password, displayName: username, remember: $('signUpRememberMe').checked
      }, null);
      persistFlockSession(result.sessionToken, result.remember);
      user = result.user;
      await enterApp();
      toast('Welcome to Clines', 'Your account and 10-digit friend code are ready.');
    } catch (error) {
      feedback('authFeedback', error.message || 'Could not create your Clines account. Try again.', true);
    } finally { button.disabled = false; }
  });

  $('messageForm').addEventListener('submit', handleSendMessage);
  $('messageInput').addEventListener('input', () => {
    const node = $('messageInput');
    node.style.height = 'auto';
    node.style.height = Math.min(node.scrollHeight, 140) + 'px';
    $('sendMessageBtn').disabled = !node.value.trim();
    if (presenceChannel) {
      presenceChannel.send({ type:'broadcast', event:'typing', payload:{ userId:user.id, typing:true } }).catch(() => {});
    }
  });
  $('messageInput').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('messageForm').requestSubmit();
    }
  });
  $('newChatBtn').addEventListener('click', openAddFriend);
  $('mobileNewChatBtn').addEventListener('click', openAddFriend);
  $('emptyAddFriendBtn').addEventListener('click', openAddFriend);
  $('emptyNewGroupBtn').addEventListener('click', () => createGroup().catch(err => toast('Could not create group', err.message, true)));
  $('copyFriendCodeBtn').addEventListener('click', async () => {
    if (!profile) return;
    const value = profile.friend_code;
    try {
      await navigator.clipboard.writeText(value);
      toast('Friend code copied', 'Share it with a person you trust.');
    } catch {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch {}
      area.remove();
      toast(copied ? 'Friend code copied' : 'Your friend code', copied ? 'Share it with a person you trust.' : value, !copied);
    }
  });
  $('profileOpenBtn').addEventListener('click', () => openProfileEditor().catch(err => toast('Could not open profile', err.message, true)));
  $('openSettingsBtn').addEventListener('click', () => openProfileEditor().catch(err => toast('Could not open profile', err.message, true)));
  const blockedUsersButton = $('openBlockedUsersBtn');
  if (blockedUsersButton) blockedUsersButton.addEventListener('click', () => openBlockedUsers().catch(err => toast('Could not load blocked users', err.message, true)));
  $('openAboutNewBtn').addEventListener('click', openAboutNew);
  $('checkUpdatesBtn').addEventListener('click', checkUpdatesManually);
  $('voiceCallBtn').addEventListener('click', () => startVoiceCall().catch(err => toast('Could not start call', err.message || 'Try again.', true)));
  $('myStatusBtn').addEventListener('click', () => openStatuses().catch(err => toast('Could not load moments', err.message, true)));
  $('openStatusesBtn').addEventListener('click', () => openStatuses().catch(err => toast('Could not load moments', err.message, true)));
  $('openGroupsBtn').addEventListener('click', () => createGroup().catch(err => toast('Could not create group', err.message, true)));
  $('emptyNewGroupBtn').addEventListener('click', () => createGroup().catch(err => toast('Could not create group', err.message, true)));
  $('signOutBtn').addEventListener('click', () => signOut().catch(err => toast('Could not sign out', err.message, true)));
  $('mobileBackBtn').addEventListener('click', goBackToChats);
  $('chatHeaderAvatarBtn').addEventListener('click', openConversationDetails);
  $('chatDetailsBtn').addEventListener('click', () => Promise.resolve(openConversationDetails()).catch(err => toast('Could not load details', err.message, true)));
  $('addPeopleBtn').addEventListener('click', () => addPeopleToGroup().catch(err => toast('Could not add people', err.message, true)));
  $('chatMoreBtn').addEventListener('click', () => {
    if (!activeConversation) return;
    const isGroup = activeConversation.kind === 'group';
    const peer = activeConversation.peer;
    const rows = '<button id="moreChatDetails" class="modal-option" type="button">ⓘ Conversation details</button>' +
      '<button id="moreAddFriend" class="modal-option" type="button">＋ Add a friend</button>' +
      (isGroup ? '<button id="moreGroupSettings" class="modal-option" type="button">⚙ Group settings</button>' :
       '<button id="moreVoiceCall" class="modal-option" type="button">☎ Start voice call</button>' +
       (peer ? '<button id="moreBlockUser" class="modal-option danger-option" type="button">⊘ Block @' + escapeHtml(peer.username) + '</button>' : ''));
    showModal({ kicker:'CLINES / CONVERSATION', title:'A few chat options', description:'Your conversation, your controls.', body:rows, hidePrimary:true });
    $('moreChatDetails').onclick = () => { closeModal(); openConversationDetails(); };
    $('moreAddFriend').onclick = () => { closeModal(); openAddFriend(); };
    if ($('moreGroupSettings')) $('moreGroupSettings').onclick = () => { closeModal(); showGroupDetails().catch(err => toast('Could not load group details', err.message, true)); };
    if ($('moreVoiceCall')) $('moreVoiceCall').onclick = () => { closeModal(); startVoiceCall().catch(err => toast('Could not start call', err.message || 'Try again.', true)); };
    if ($('moreBlockUser') && peer) $('moreBlockUser').onclick = () => { closeModal(); confirmBlockUser(peer.id, peer.username); };
  });

  $('attachImageBtn').addEventListener('click', () => $('mediaFileInput').click());
  $('mediaFileInput').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { await sendMediaFile(file, ''); }
    catch (error) { toast('Could not send media', error.message || 'Try another file.', true); }
  });
  $('avatarFileInput').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { await handleAvatarUpload(file); }
    catch (error) { toast('Could not update picture', error.message || 'Try another image.', true); }
  });
  $('backgroundFileInput').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { await handleBackgroundUpload(file); }
    catch (error) { toast('Could not set background', error.message || 'Try another file.', true); }
  });
  $('statusFileInput').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { await composeStatus('media', file); }
    catch (error) { toast('Could not post moment', error.message || 'Try another file.', true); }
  });
  $('voiceNoteBtn').addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive' && recordingKind === 'voice') {
      stopRecording(false); return;
    }
    startRecording('voice').catch(err => toast('Microphone not available', err.message || 'Allow microphone access and try again.', true));
  });
  $('videoNoteBtn').addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive' && recordingKind === 'video_note') {
      stopRecording(false); return;
    }
    startRecording('video_note').catch(err => toast('Camera not available', err.message || 'Allow camera and microphone access and try again.', true));
  });
  $('cancelRecordingBtn').addEventListener('click', () => stopRecording(true));
  $('finishRecordingBtn').addEventListener('click', () => stopRecording(false));
  $('youtubeBtn').addEventListener('click', openYouTubeShare);
  $('emojiBtn').addEventListener('click', openEmojiPicker);
  $('cancelReplyBtn').addEventListener('click', () => { pendingReply = null; $('replyBar').hidden = true; });
  $('sidebarSearch').addEventListener('input', () => { renderConversations(); renderFriends(); });
  document.querySelectorAll('[data-sidebar-tab]').forEach(btn => btn.addEventListener('click', () => setSidebarTab(btn.dataset.sidebarTab)));
  document.querySelectorAll('[data-mobile-view]').forEach(btn => btn.addEventListener('click', () => updateMobileView(btn.dataset.mobileView)));
  $('modalPrimaryBtn').addEventListener('click', modalPrimaryClick);
  $('modalCancelBtn').addEventListener('click', closeModal);
  $('closeModalBtn').addEventListener('click', closeModal);
  $('modalBackdrop').addEventListener('click', event => { if (event.target === $('modalBackdrop')) closeModal(); });
  $('toastCloseBtn').addEventListener('click', () => $('toast').classList.remove('visible'));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!$('modalBackdrop').hidden) closeModal();
      $('toast').classList.remove('visible');
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && user) {
      event.preventDefault(); $('sidebarSearch').focus();
    }
  });
}
async function enterApp() {
  assertUser();
  showApp();
  requestMessageNotificationPermission().catch(() => {});
  try {
    await refreshProfile();
    await Promise.all([refreshFriends(), refreshConversations()]);
    if (window.location.hash.includes('type=recovery')) openPasswordRecovery();
  } catch (error) {
    toast('Could not load your Clines data', error.message || 'Try refreshing.', true);
  }
  subscribeGlobal();
}
function subscribeGlobal() {
  if (globalPoller) clearInterval(globalPoller);
  globalPoller = null;
  const poll = async () => {
    if (globalPollBusy || !user || (document.hidden && mobileCapacitorPlatform() !== 'android')) return;
    globalPollBusy = true;
    try {
      await Promise.all([refreshFriends(), refreshConversations({ quiet: true })]);
      if (Date.now() - lastStatusLoad > 30000) $('statusCountBadge').textContent = 'NEW';
    } catch (error) {
      console.warn('[Clines] Account sync paused:', error && error.message ? error.message : 'network error');
    } finally {
      globalPollBusy = false;
    }
  };
  globalPoller = setInterval(poll, 10000);
  startCallSignalPolling();
}

async function initialize() {
  bindEvents();
  wireDesktopUpdates();
  wireMobileUpdates();
  if ('serviceWorker' in navigator && /^https?:$/.test(window.location.protocol)) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
  if (!db) {
    showAuthScreen(false);
    feedback('authFeedback','Clines cannot connect to its cloud service. Check src/flock-config.js and reload.',true);
    return;
  }
  const savedToken = getSavedFlockSession();
  if (!savedToken) {
    showAuthScreen(false);
    return;
  }
  try {
    const result = await flockAuth('session', {}, savedToken);
    flockSessionToken = savedToken;
    db = createFlockDatabase(savedToken);
    user = result.user;
    await enterApp();
  } catch (error) {
    persistFlockSession('', false);
    user = null;
    profile = null;
    showAuthScreen(false);
    feedback('authFeedback','Your saved Clines session has expired. Please sign in again.',false);
  }
}
initialize().catch(error=> {
  console.error('[Clines] Initialization error',error);
  showAuthScreen(false);
  feedback('authFeedback',error.message || 'Clines could not start.',true);
});