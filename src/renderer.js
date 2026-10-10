'use strict';

const $ = id => document.getElementById(id);
const config = window.FLOCK_CONFIG || {};
const SUPABASE_URL = config.supabaseUrl || '';
const SUPABASE_KEY = config.supabasePublishableKey || '';
const BUCKET = config.storageBucket || 'flock-media';
const db = window.supabase && SUPABASE_URL && SUPABASE_KEY
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

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
let signedUrlCache = new Map();
let lastStatusLoad = 0;
let suppressAuthCallback = false;
let currentSidebarTab = 'chats';

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}
function safeInitial(value) {
  const text = String(value || 'F').trim();
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
  $('toastTitle').textContent = title || 'Flock';
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
  if (!db) throw new Error('Flock is not connected to Supabase. Check src/flock-config.js and reload the app.');
}
function assertUser() {
  if (!user) throw new Error('Please sign in to Flock first.');
}
function resetModalHandlers() {
  modalPrimaryHandler = null;
  modalCancelHandler = null;
}
function showModal(options) {
  const opt = options || {};
  $('modalKicker').textContent = opt.kicker || 'FLOCK / YOUR SPACE';
  $('modalTitle').textContent = opt.title || 'Make it yours.';
  $('modalDescription').textContent = opt.description || '';
  $('modalBody').innerHTML = opt.body || '';
  $('modalFeedback').textContent = '';
  $('modalFeedback').classList.remove('is-error');
  $('modalPrimaryBtn').textContent = opt.primary || 'Save';
  $('modalPrimaryBtn').hidden = opt.hidePrimary === true;
  $('modalCancelBtn').textContent = opt.cancel || 'Cancel';
  $('modalCancelBtn').hidden = opt.hideCancel === true;
  $('modalFooter').hidden = opt.hideFooter === true;
  resetModalHandlers();
  modalPrimaryHandler = opt.onPrimary || null;
  modalCancelHandler = opt.onCancel || null;
  $('modalBackdrop').hidden = false;
  document.body.classList.add('modal-open');
}
function closeModal() {
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
  if (!data) throw new Error('Your Flock profile is still being created. Please refresh in a moment.');
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
  $('connectionStatus').textContent = user ? 'Synced to Flock' : 'Not connected';
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
  if (error) console.warn('[Flock] Media cleanup did not finish.');
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
function wireDesktopUpdates() {
  const desktop = window.flockDesktop;
  if (!desktop || typeof desktop.onUpdateStatus !== 'function') return;
  const handle = state => {
    if (!state || !state.status) return;
    if (state.status === 'available') {
      const version = String(state.version || 'new version');
      if (lastUpdatePrompt === 'available:' + version) return;
      lastUpdatePrompt = 'available:' + version;
      showModal({
        kicker: 'FLOCK / UPDATE',
        title: 'A fresh Flock is ready.',
        description: 'Version ' + version + ' is available. Downloading it will not remove your account or cloud messages.',
        body: '<div class="confirm-panel"><span class="confirm-icon">↑</span><p>The update is downloaded directly from the official Flock GitHub release.</p></div>',
        primary: 'Download update',
        onPrimary: async () => {
          await desktop.downloadUpdate();
          closeModal();
          toast('Downloading Flock update', 'You can keep chatting while the update downloads.');
        }
      });
    } else if (state.status === 'downloaded') {
      if (lastUpdatePrompt === 'downloaded:' + state.version) return;
      lastUpdatePrompt = 'downloaded:' + state.version;
      showModal({
        kicker: 'FLOCK / UPDATE',
        title: 'Ready when you are.',
        description: 'Flock ' + String(state.version || '') + ' has finished downloading.',
        body: '<div class="confirm-panel"><span class="confirm-icon">✓</span><p>Flock will close and restart to finish installing the update. Your cloud chats are saved in your account.</p></div>',
        primary: 'Restart and update',
        onPrimary: async () => { await desktop.installUpdate(); }
      });
    } else if (state.status === 'error' && lastUpdatePrompt !== 'error') {
      lastUpdatePrompt = 'error';
      toast('Update check failed', state.message || 'Check your internet connection later.');
    }
  };
  desktop.onUpdateStatus(handle);
  if (typeof desktop.getUpdateStatus === 'function') desktop.getUpdateStatus().then(handle).catch(() => {});
}
let lastMobileUpdateVersion = '';
let lastMobileUpdateCheck = 0;
let playUpdateMonitor = null;
function mobileCapacitorPlatform() {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return '';
  return typeof cap.getPlatform === 'function' ? cap.getPlatform() : '';
}
function getFlockUpdatesPlugin() {
  const cap = window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.FlockUpdates) return cap.Plugins.FlockUpdates;
  if (cap && typeof cap.nativePromise === 'function') {
    return {
      getInfo: () => cap.nativePromise('FlockUpdates', 'getInfo', {}),
      startUpdate: options => cap.nativePromise('FlockUpdates', 'startUpdate', options || {}),
      completeUpdate: () => cap.nativePromise('FlockUpdates', 'completeUpdate', {})
    };
  }
  return null;
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
  for (let i = 0; i < 3; i++) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] > b.parts[i] ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre);
}
function versionFromRelease(release) {
  const candidates = [release && release.tag_name, release && release.name];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i);
    if (match) return match[1];
  }
  return '';
}
function openExternalFlockUrl(url) {
  if (!url || !/^https:\/\/|^market:\/\//i.test(url)) throw new Error('The update link is not valid.');
  const cap = window.Capacitor;
  if (cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform()) {
    window.open(url, '_system');
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
function showPlayUpdateReady(plugin, info) {
  const availableCode = Number(info && info.availableVersionCode || 0);
  const key = 'play:' + availableCode;
  if (lastMobileUpdateVersion === key) return;
  lastMobileUpdateVersion = key;
  const canUseFlexible = Boolean(info && info.flexibleAllowed);
  showModal({
    kicker: 'FLOCK / GOOGLE PLAY UPDATE',
    title: 'A new Flock is ready.',
    description: 'Google Play has an update for Flock. You can keep your cloud messages while the update installs.',
    body: '<div class="confirm-panel"><span class="confirm-icon">↑</span><p>Google Play handles the signed download and installation for this app.</p></div>',
    primary: canUseFlexible ? 'Start update' : 'Update now',
    onPrimary: async () => {
      try {
        await plugin.startUpdate({ mode: canUseFlexible ? 'flexible' : 'immediate' });
        closeModal();
        toast('Google Play update started', canUseFlexible ? 'Flock will download the update in the background.' : 'Follow the Google Play update screen.');
        if (canUseFlexible) startPlayUpdateMonitor(plugin);
      } catch (error) {
        closeModal();
        toast('Could not start Google Play update', error.message || 'Open Flock in Google Play to update.', true);
      }
    }
  });
}
function startPlayUpdateMonitor(plugin) {
  if (playUpdateMonitor) clearInterval(playUpdateMonitor);
  playUpdateMonitor = setInterval(async () => {
    try {
      const info = await plugin.getInfo();
      if (info && info.downloaded) {
        clearInterval(playUpdateMonitor);
        playUpdateMonitor = null;
        const key = 'downloaded:' + Number(info.availableVersionCode || 0);
        if (lastMobileUpdateVersion === key) return;
        lastMobileUpdateVersion = key;
        showModal({
          kicker: 'FLOCK / UPDATE READY',
          title: 'Finish installing Flock.',
          description: 'Google Play has downloaded the update. Finish the installation to start using it.',
          body: '<div class="confirm-panel"><span class="confirm-icon">✓</span><p>Google Play will finish installing the signed update and restart Flock.</p></div>',
          primary: 'Complete update',
          onPrimary: async () => {
            await plugin.completeUpdate();
            closeModal();
          }
        });
      }
    } catch {}
  }, 2500);
}
async function checkMobileUpdate(options) {
  if (mobileCapacitorPlatform() !== 'android') return;
  const now = Date.now();
  if (!(options && options.force) && now - lastMobileUpdateCheck < 5 * 60 * 1000) return;
  lastMobileUpdateCheck = now;
  const plugin = getFlockUpdatesPlugin();
  let playInfo = null;
  if (plugin && typeof plugin.getInfo === 'function') {
    try {
      playInfo = await plugin.getInfo();
      if (playInfo && playInfo.downloaded) {
        startPlayUpdateMonitor(plugin);
        const key = 'downloaded:' + Number(playInfo.availableVersionCode || 0);
        if (lastMobileUpdateVersion !== key) {
          lastMobileUpdateVersion = key;
          showModal({
            kicker: 'FLOCK / UPDATE READY',
            title: 'Finish installing Flock.',
            description: 'Google Play has already downloaded an update for you.',
            body: '<div class="confirm-panel"><span class="confirm-icon">✓</span><p>Complete the installation in Google Play to finish updating Flock.</p></div>',
            primary: 'Complete update',
            onPrimary: async () => { await plugin.completeUpdate(); closeModal(); }
          });
        }
        return;
      }
      if (playInfo && playInfo.updateAvailable) {
        showPlayUpdateReady(plugin, playInfo);
        return;
      }
    } catch {
      /* The app may have been installed outside Google Play. The release feed is the fallback. */
    }
  }
  const runtime = window.FLOCK_RUNTIME || {};
  const currentVersion = String(runtime.version || '0.0.0');
  const ownerRepo = String((window.FLOCK_CONFIG || {}).githubRepo || '43r5fer/JustPlay');
  const apiUrl = 'https://api.github.com/repos/' + ownerRepo + '/releases/latest';
  try {
    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store'
    });
    if (!response.ok) return;
    const release = await response.json();
    const latestVersion = versionFromRelease(release);
    if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) return;
    const promptKey = 'github:' + latestVersion;
    if (lastMobileUpdateVersion === promptKey) return;
    lastMobileUpdateVersion = promptKey;
    const cfg = window.FLOCK_CONFIG || {};
    const playStoreInstall = Boolean(playInfo && (playInfo.playStoreInstall || playInfo.installerPackageName === 'com.android.vending'));
    const playStoreUrl = String(cfg.playStoreUrl || '').trim() ||
      ('https://play.google.com/store/apps/details?id=' + encodeURIComponent(cfg.androidPackageId || 'com.flock.messaging'));
    const releaseSigned = Boolean(runtime.releaseSigned);
    let targetUrl;
    let buttonLabel;
    let description;
    if (playStoreInstall) {
      targetUrl = playStoreUrl;
      buttonLabel = 'Open Google Play';
      description = 'Flock ' + latestVersion + ' is newer than this installed version. Open Google Play to update when the release is available there.';
    } else if (releaseSigned) {
      targetUrl = 'https://github.com/' + ownerRepo + '/releases/latest/download/Flock.apk';
      buttonLabel = 'Download update';
      description = 'Flock ' + latestVersion + ' is available. Android will download the APK; tap the downloaded file and approve installation when Android asks.';
    } else {
      targetUrl = release.html_url || ('https://github.com/' + ownerRepo + '/releases/latest');
      buttonLabel = 'View update';
      description = 'Flock ' + latestVersion + ' is available. This testing build has no configured stable release-signing key, so direct APK installation may require uninstalling the test build first.';
    }
    showModal({
      kicker: 'FLOCK / UPDATE AVAILABLE',
      title: 'Meet the new Flock.',
      description,
      body: '<div class="confirm-panel"><span class="confirm-icon">↑</span><p>Version ' + escapeHtml(latestVersion) + ' is available. Your account and cloud conversations stay in Supabase.</p></div>',
      primary: buttonLabel,
      onPrimary: async () => {
        closeModal();
        openExternalFlockUrl(targetUrl);
        if (playStoreInstall) toast('Opening Google Play', 'Install the latest Flock version from the store.');
        else if (releaseSigned) toast('Downloading Flock update', 'After the APK finishes downloading, approve installation in Android.');
        else toast('Opening Flock release', 'Follow the release page instructions for this testing build.');
      }
    });
  } catch {
    /* Do not interrupt sign-in if the release feed is temporarily unavailable. */
  }
}
function wireMobileUpdates() {
  if (mobileCapacitorPlatform() !== 'android') return;
  checkMobileUpdate({ force: true }).catch(() => {});
  window.addEventListener('focus', () => checkMobileUpdate().catch(() => {}));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkMobileUpdate().catch(() => {});
  });
  setInterval(() => checkMobileUpdate().catch(() => {}), 6 * 60 * 60 * 1000);
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
async function refreshConversations() {
  assertUser();
  setAppLoading('Syncing your conversations…');
  const memberRes = await db.from('flock_conversation_members')
    .select('conversation_id,role,last_read_at,joined_at')
    .eq('user_id', user.id).order('joined_at', { ascending: false }).limit(300);
  if (memberRes.error) throw memberRes.error;
  const ids = (memberRes.data || []).map(x => x.conversation_id);
  if (!ids.length) {
    conversations = [];
    renderConversations();
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
    body = '<div class="message-youtube"><button class="youtube-thumb" data-youtube-open="' + escapeHtml(id) + '" title="Play YouTube video"><img loading="lazy" src="https://img.youtube.com/vi/' + escapeHtml(id) + '/hqdefault.jpg" alt=""><span class="youtube-play">▶</span></button><div class="youtube-caption">YouTube video shared in Flock<small>Opens YouTube in a new tab</small></div></div>' + (m.body ? '<div class="message-bubble">' + linkifyText(m.body) + '</div>' : '');
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
  const senderName = activeConversation && activeConversation.kind === 'group' && !myMessage ? '<span class="message-sender-name">' + escapeHtml(m.sender ? m.sender.display_name : 'Flock friend') + '</span>' : '';
  const avatarPath = !myMessage && m.sender ? m.sender.avatar_path : null;
  const avatarUrl = avatarPath ? peekSignedUrl(avatarPath) : '';
  const avatar = !myMessage && activeConversation && activeConversation.kind === 'group'
    ? '<span class="message-sender-avatar">' + (avatarUrl ? '<img src="' + escapeHtml(avatarUrl) + '" alt="">' : escapeHtml(safeInitial(m.sender && m.sender.display_name))) + '</span>' : '';
  const actions = '<div class="message-actions">' + (canEdit ? '<button data-edit-message="' + m.id + '" title="Edit message">✎</button>' : '') +
    (myMessage && !m.deleted_at ? '<button data-react-quick="' + m.id + '" title="React">☺</button>' : '') +
    '<button data-reply-message="' + m.id + '" title="Reply">↶</button>' +
    (canDelete ? '<button data-delete-message="' + m.id + '" title="Delete message">×</button>' : '') + '</div>';
  const authorLabel = myMessage ? 'You' : (m.sender ? m.sender.display_name : 'Flock friend');
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
  if (realtimeChannel) db.removeChannel(realtimeChannel);
  if (presenceChannel) db.removeChannel(presenceChannel);
  realtimeChannel = db.channel('flock-messages-' + conversationId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flock_messages', filter: 'conversation_id=eq.' + conversationId }, () => {
      if (activeConversation && activeConversation.id === conversationId) refreshMessages(conversationId, false).catch(() => {});
      refreshConversations().catch(() => {});
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flock_message_receipts' }, () => {
      if (activeConversation && activeConversation.id === conversationId) refreshMessages(conversationId, false).catch(() => {});
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flock_message_reactions' }, () => {
      if (activeConversation && activeConversation.id === conversationId) refreshMessages(conversationId, false).catch(() => {});
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'flock_conversation_members', filter: 'conversation_id=eq.' + conversationId }, () => {
      refreshConversations().catch(() => {});
    })
    .subscribe();
  presenceChannel = db.channel('flock-presence-' + conversationId, { config: { presence: { key: user.id } } })
    .on('presence', { event: 'sync' }, () => renderPresence())
    .on('broadcast', { event: 'typing' }, payload => {
      if (payload && payload.payload && payload.payload.userId !== user.id) {
        $('typingIndicator').hidden = false;
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => $('typingIndicator').hidden = true, 1800);
      }
    })
    .subscribe(async status => {
      if (status === 'SUBSCRIBED') {
        await presenceChannel.track({ user_id: user.id, display_name: profile.display_name, at: new Date().toISOString() });
      }
    });
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
async function sendMessage(body, kind, media, youtubeId) {
  assertUser();
  if (!activeConversation) throw new Error('Choose a conversation first.');
  const clean = String(body || '').trim();
  const k = kind || 'text';
  if (k === 'text' && !clean) return;
  const row = {
    conversation_id: activeConversation.id,
    sender_id: user.id,
    kind: k,
    body: clean,
    media_path: media ? media.path : null,
    media_name: media ? media.name : null,
    media_type: media ? media.type : null,
    media_size: media ? media.size : null,
    youtube_id: youtubeId || null,
    reply_to: pendingReply ? pendingReply.id : null
  };
  const { data, error } = await db.from('flock_messages').insert(row).select('id').single();
  if (error) {
    if (media && media.path) await removeMedia(media.path);
    throw error;
  }
  $('messageInput').value = '';
  $('messageInput').style.height = 'auto';
  $('sendMessageBtn').disabled = true;
  pendingReply = null;
  $('replyBar').hidden = true;
  await refreshMessages(activeConversation.id, true);
  await refreshConversations();
  if (presenceChannel) {
    presenceChannel.send({ type: 'broadcast', event: 'typing', payload: { userId: user.id, typing: false } }).catch(() => {});
  }
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
    await sendMessage(body || '', kind, media);
    toast('Message sent', 'Your media is uploaded and available in this conversation.');
  } finally { status.textContent = ''; }
}
async function editMessage(id) {
  const m = currentMessages.find(x => x.id === id);
  if (!m || m.sender_id !== user.id || m.deleted_at || m.kind !== 'text') return;
  showModal({
    kicker: 'FLOCK / MESSAGE',
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
    kicker: 'FLOCK / MESSAGE',
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
    kicker: 'FLOCK / REACTION',
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
    showModal({ kicker: 'FLOCK / GROUPS', title: 'Bring your people together', description: 'You need at least one friend before creating a group.', body: '<p class="modal-empty-copy">Add a friend with their 10-digit friend code first.</p><button id="modalAddFriendLink" class="button button-primary" type="button">Add a friend</button>', hidePrimary: true });
    $('modalAddFriendLink').addEventListener('click', () => openAddFriend());
    return;
  }
  showModal({
    kicker: 'FLOCK / GROUPS',
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
    kicker: 'FLOCK / FRIENDS',
    title: 'Find your people',
    description: 'Enter the 10-digit friend code someone shared with you.',
    body: '<label for="friendCodeInput">FRIEND CODE</label><input id="friendCodeInput" class="input-field" inputmode="numeric" maxlength="10" placeholder="0123456789"><p class="field-hint">Your code is on the left side of Flock. Share it only with people you trust.</p><div id="friendFound" class="friend-found"></div>',
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
    kicker: 'FLOCK / YOUR PROFILE',
    title: 'Your space, your style.',
    description: 'Your display name, avatar and background sync to your account across devices.',
    body: '<div class="profile-edit-row"><div class="profile-edit-avatar">' + (avatarUrl ? '<img src="' + escapeHtml(avatarUrl) + '" alt="">' : escapeHtml(safeInitial(profile.display_name))) + '</div><div><strong class="profile-edit-name">' + escapeHtml(profile.display_name) + '</strong><div class="field-hint">@' + escapeHtml(profile.username) + ' · username cannot be changed yet</div><button id="chooseAvatarBtn" class="text-button" type="button">Change profile picture ↗</button></div></div><label for="displayNameInput">DISPLAY NAME</label><input id="displayNameInput" class="input-field" maxlength="80" value="' + escapeHtml(profile.display_name) + '"><label for="bioInput">ABOUT YOU</label><textarea id="bioInput" class="input-field" maxlength="180" rows="2" placeholder="A little about you…">' + escapeHtml(profile.bio || '') + '</textarea><div class="profile-background-row"><div><strong>Chat background</strong><small>' + escapeHtml(backgroundLabel) + '</small></div><button id="chooseBackgroundBtn" class="button button-soft" type="button">Choose photo or video</button><button id="clearBackgroundBtn" class="text-button" type="button">Remove</button></div>',
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
function openConversationDetails() {
  if (!activeConversation) return;
  if (activeConversation.kind === 'direct') {
    showModal({
      kicker: 'FLOCK / CONVERSATION',
      title: activeConversation.title,
      description: activeConversation.peer ? '@' + activeConversation.peer.username + ' · friend code ' + activeConversation.peer.friend_code : 'Direct conversation',
      body: '<div class="details-card"><strong>Messages belong to you and this friend</strong><p>You can edit or delete messages you sent. Read receipts turn green when the other person has read your message.</p></div>',
      hidePrimary: true
    });
    return;
  }
  showGroupDetails();
}
async function showGroupDetails() {
  if (!activeConversation) return;
  const convId = activeConversation.id;
  const { data: members, error } = await db.from('flock_conversation_members')
    .select('user_id,role,joined_at').eq('conversation_id', convId).order('joined_at');
  if (error) throw error;
  const ids = (members || []).map(x => x.user_id);
  const pRes = ids.length ? await db.from('flock_profiles').select('id,username,display_name,avatar_path').in('id', ids) : { data: [], error: null };
  if (pRes.error) throw pRes.error;
  await warmProfileMedia(pRes.data || []);
  const map = new Map((pRes.data || []).map(x => [x.id,x]));
  const canAdmin = ['owner','admin'].includes(activeConversation.myRole);
  const body = '<label for="editGroupName">GROUP NAME</label><div class="modal-inline-row"><input id="editGroupName" class="input-field" maxlength="80" value="' + escapeHtml(activeConversation.name || '') + '"><button id="saveGroupNameBtn" class="button button-soft" type="button">Rename</button></div><label>MEMBERS · ' + members.length + '</label><div class="modal-profile-list">' + members.map(m => {
    const p = map.get(m.user_id) || { display_name: 'Flock friend', username: 'friend' };
    const url = p.avatar_path ? peekSignedUrl(p.avatar_path) : '';
    const roleOptions = ['admin','co_admin','member'].map(role => '<option value="' + role + '" ' + (m.role === role ? 'selected' : '') + '>' + (role === 'co_admin' ? 'Co-admin' : role === 'admin' ? 'Admin' : 'Member') + '</option>').join('');
    return '<div class="modal-member-row"><span class="avatar">' + (url ? '<img src="' + escapeHtml(url) + '" alt="">' : '<span class="avatar-initial">' + escapeHtml(safeInitial(p.display_name)) + '</span>') + '</span><span class="modal-member-copy"><strong>' + escapeHtml(p.display_name) + (m.user_id === user.id ? ' (you)' : '') + '</strong><small>@' + escapeHtml(p.username) + '</small></span>' + (m.role === 'owner' ? '<span class="role-pill owner">Owner</span>' : canAdmin ? '<select class="form-select group-role-select" data-member-role="' + m.user_id + '">' + roleOptions + '</select>' : '<span class="role-pill">' + escapeHtml(m.role.replace('_',' ')) + '</span>') + '</div>';
  }).join('') + '</div><p class="field-hint">Owners can manage admins and co-admins. Admins can manage co-admins and members. Co-admins can help add people to the group.</p>';
  showModal({
    kicker: 'FLOCK / GROUP SETTINGS',
    title: activeConversation.name || 'Group',
    description: 'Manage group membership and roles.',
    body: body,
    primary: 'Done',
    onPrimary: async () => closeModal()
  });
  $('saveGroupNameBtn').addEventListener('click', async () => {
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
}
async function addPeopleToGroup() {
  if (!activeConversation || activeConversation.kind !== 'group') return;
  await refreshFriends();
  const memberIds = new Set(activeConversation.members.map(m => m.user_id));
  const choices = friends.filter(f => !memberIds.has(f.id));
  if (!choices.length) { toast('Everyone is already here', 'Add another friend first.'); return; }
  showModal({
    kicker: 'FLOCK / GROUPS',
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
    kicker: 'FLOCK / MOMENTS',
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
      kicker: 'FLOCK / MOMENTS',
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
    kicker: 'FLOCK / MOMENTS',
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
      console.warn('[Flock] Status view could not be recorded:', error.message);
    }
  }
  let media = '';
  if (s.media_path) {
    const url = await getSignedUrl(s.media_path).catch(() => '');
    if (url && s.kind === 'image') media = '<div class="status-preview"><img src="' + escapeHtml(url) + '" alt=""></div>';
    else if (url && s.kind === 'video') media = '<div class="status-preview"><video controls autoplay playsinline src="' + escapeHtml(url) + '"></video></div>';
  }
  const p = s.author || profile;
  showModal({
    kicker: 'FLOCK / MOMENT ' + (index + 1) + ' OF ' + statuses.length,
    title: p.display_name || 'A moment',
    description: '@' + (p.username || 'friend') + ' · ' + fmtTime(s.created_at) + ' · expires ' + fmtTime(s.expires_at),
    body: media + (s.body ? '<div class="status-caption">' + linkifyText(s.body) + '</div>' : ''),
    primary: s.user_id === user.id ? 'Delete moment' : 'Next moment →',
    hideCancel: false,
    onPrimary: async () => {
      if (s.user_id === user.id) {
        const { error } = await db.from('flock_statuses').delete().eq('id', s.id).eq('user_id', user.id);
        if (error) throw error;
        if (s.media_path) await removeMedia(s.media_path);
        closeModal();
        toast('Moment deleted', '');
        await loadStatuses();
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
  if (s.user_id !== user.id) {
    $('modalPrimaryBtn').textContent = 'Next moment →';
    $('modalPrimaryBtn').disabled = false;
  }
}
async function openYouTubeShare() {
  showModal({
    kicker: 'FLOCK / SHARE',
    title: 'Bring YouTube into chat',
    description: 'Paste a YouTube link and Flock will create an inline preview.',
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
    kicker: 'FLOCK / EXPRESSION',
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
  const list = kind === 'video' ? ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4']
    : ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'];
  if (typeof MediaRecorder === 'undefined') return '';
  return list.find(type => MediaRecorder.isTypeSupported(type)) || '';
}
async function startRecording(kind) {
  assertUser();
  if (!activeConversation) throw new Error('Open a conversation before recording.');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Recording is not supported by this device/browser. Try a newer browser or the installed app.');
  }
  const isVideo = kind === 'video_note';
  const stream = await navigator.mediaDevices.getUserMedia(isVideo
    ? { audio: true, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 640 } } }
    : { audio: true });
  activeMediaStream = stream;
  recordingConversationId = activeConversation.id;
  recordingKind = kind;
  recordingChunks = [];
  const mimeType = supportedMime(isVideo ? 'video' : 'audio');
  if (!mimeType) {
    stream.getTracks().forEach(track => track.stop());
    activeMediaStream = null;
    throw new Error('This browser does not support the necessary recording format.');
  }
  try { mediaRecorder = new MediaRecorder(stream, { mimeType }); }
  catch (error) {
    stream.getTracks().forEach(track => track.stop());
    activeMediaStream = null;
    throw error;
  }
  mediaRecorder.ondataavailable = event => { if (event.data && event.data.size) recordingChunks.push(event.data); };
  mediaRecorder.onerror = () => toast('Recording interrupted', 'Try recording again.', true);
  mediaRecorder.onstop = () => handleRecordingStopped(mimeType, isVideo);
  $('recordingTitle').textContent = isVideo ? 'Recording video note' : 'Recording voice note';
  $('recordingPreview').hidden = !isVideo;
  if (isVideo) {
    $('recordingPreview').srcObject = stream;
    $('recordingPreview').muted = true;
    $('recordingPreview').play().catch(() => {});
  }
  $('recordingPanel').hidden = false;
  $('voiceNoteBtn').classList.toggle('recording', !isVideo);
  $('videoNoteBtn').classList.toggle('recording', isVideo);
  recordingStartedAt = Date.now();
  updateRecordingTimer();
  recordingTimer = setInterval(updateRecordingTimer, 250);
  mediaRecorder.start(250);
}
function updateRecordingTimer() {
  $('recordingTimer').textContent = fmtDuration((Date.now() - recordingStartedAt) / 1000);
}
async function handleRecordingStopped(mimeType, isVideo) {
  clearInterval(recordingTimer);
  if (activeMediaStream) activeMediaStream.getTracks().forEach(track => track.stop());
  const stream = activeMediaStream;
  activeMediaStream = null;
  if (stream) stream.getTracks().forEach(track => track.stop());
  $('recordingPreview').srcObject = null;
  $('recordingPanel').hidden = true;
  $('voiceNoteBtn').classList.remove('recording');
  $('videoNoteBtn').classList.remove('recording');
  const chunks = recordingChunks;
  recordingChunks = [];
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: mimeType.split(';')[0] });
  if (!blob.size) return;
  const ext = mimeType.indexOf('video/') === 0 ? 'webm' : mimeType.indexOf('audio/ogg') === 0 ? 'ogg' : mimeType.indexOf('audio/mp4') === 0 ? 'm4a' : 'webm';
  const file = new File([blob], (isVideo ? 'video-note.' : 'voice-note.') + ext, { type: blob.type });
  if (!activeConversation || activeConversation.id !== recordingConversationId) {
    toast('Recording kept private', 'The chat changed before this note finished. Record again in the right chat.', true);
    return;
  }
  try {
    const media = await uploadMedia(file, 'messages');
    await sendMessage('', isVideo ? 'video_note' : 'voice', media);
    toast(isVideo ? 'Video note sent' : 'Voice note sent', '');
  } catch (error) { toast('Could not send recording', error.message || 'Try again.', true); }
}
function stopRecording(cancel) {
  clearInterval(recordingTimer);
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    if (activeMediaStream) activeMediaStream.getTracks().forEach(track => track.stop());
    activeMediaStream = null;
    $('recordingPanel').hidden = true;
    return;
  }
  if (cancel) {
    mediaRecorder.onstop = () => {
      if (activeMediaStream) activeMediaStream.getTracks().forEach(track => track.stop());
      activeMediaStream = null;
      recordingChunks = [];
      $('recordingPreview').srcObject = null;
      $('recordingPanel').hidden = true;
      $('voiceNoteBtn').classList.remove('recording');
      $('videoNoteBtn').classList.remove('recording');
    };
  }
  mediaRecorder.stop();
  mediaRecorder = null;
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
  if (!db) return;
  await db.auth.signOut({ scope: 'local' });
  user = null;
  profile = null;
  activeConversation = null;
  conversations = [];
  friends = [];
  friendRequests = [];
  if (realtimeChannel) db.removeChannel(realtimeChannel);
  if (presenceChannel) db.removeChannel(presenceChannel);
  if (authSubscription) db.removeChannel(authSubscription);
  realtimeChannel = null;
  presenceChannel = null;
  authSubscription = null;
  signedUrlCache.clear();
  showAuthScreen(false);
  toast('Signed out', 'Your Flock messages remain synced to your account.');
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
    if (!db) { feedback('authFeedback','Supabase is not configured.',true); return; }
    const button = $('signInForm').querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { data, error } = await db.auth.signInWithPassword({
        email: $('signInEmail').value.trim(), password: $('signInPassword').value
      });
      if (error) throw error;
      user = data.user;
      await enterApp();
    } catch (error) {
      feedback('authFeedback', error.message || 'Could not sign in. Check your email and password.', true);
    } finally { button.disabled = false; }
  });
  $('signUpForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!db) { feedback('authFeedback','Supabase is not configured.',true); return; }
    const username = $('signUpUsername').value.trim().toLowerCase();
    const email = $('signUpEmail').value.trim().toLowerCase();
    const password = $('signUpPassword').value;
    const confirm = $('signUpConfirm').value;
    if (!/^[a-z0-9_.-]{3,24}$/.test(username)) { feedback('authFeedback','Use 3–24 letters, numbers, dots, underscores or hyphens for your username.',true); return; }
    if (password.length < 8) { feedback('authFeedback','Choose a password with at least 8 characters.',true); return; }
    if (password !== confirm) { feedback('authFeedback','The passwords do not match.',true); return; }
    const button = $('signUpForm').querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const { data, error } = await db.auth.signUp({
        email, password,
        options: { data: { username, display_name: username } }
      });
      if (error) throw error;
      if (data.session && data.user) {
        user = data.user;
        await enterApp();
        toast('Welcome to Flock', 'Your account and 10-digit friend code are ready.');
      } else {
        feedback('authFeedback','One more step: check your email to confirm the account, then sign in. Your profile and friend code are created by Flock after registration.');
        showAuthScreen(false);
        $('signInEmail').value = email;
      }
    } catch (error) {
      feedback('authFeedback', error.message || 'Could not create your account. Try a different username or email.', true);
    } finally { button.disabled = false; }
  });
  $('forgotPasswordBtn').addEventListener('click', async () => {
    if (!db) return;
    const email = $('signInEmail').value.trim();
    if (!email) { feedback('authFeedback','Enter your email address first, then choose Forgot password.',true); return; }
    try {
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: window.location.href });
      if (error) throw error;
      feedback('authFeedback','If an account exists for that email, a password reset link has been sent. Check your inbox.');
    } catch (error) { feedback('authFeedback', error.message || 'Could not request a password reset.', true); }
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
  $('myStatusBtn').addEventListener('click', () => openStatuses().catch(err => toast('Could not load moments', err.message, true)));
  $('openStatusesBtn').addEventListener('click', () => openStatuses().catch(err => toast('Could not load moments', err.message, true)));
  $('openGroupsBtn').addEventListener('click', () => createGroup().catch(err => toast('Could not create group', err.message, true)));
  $('emptyNewGroupBtn').addEventListener('click', () => createGroup().catch(err => toast('Could not create group', err.message, true)));
  $('signOutBtn').addEventListener('click', () => signOut().catch(err => toast('Could not sign out', err.message, true)));
  $('mobileBackBtn').addEventListener('click', goBackToChats);
  $('chatHeaderAvatarBtn').addEventListener('click', openConversationDetails);
  $('chatDetailsBtn').addEventListener('click', () => Promise.resolve(openConversationDetails()).catch(err => toast('Could not load details', err.message, true)));
  $('addPeopleBtn').addEventListener('click', () => addPeopleToGroup().catch(err => toast('Could not add people', err.message, true)));
  $('chatMoreBtn').addEventListener('click', () => showModal({
    kicker:'FLOCK / CONVERSATION', title:'A few chat options', description:'Your conversation, your controls.',
    body:'<button id="moreChatDetails" class="modal-option" type="button">ⓘ Conversation details</button><button id="moreAddFriend" class="modal-option" type="button">＋ Add a friend</button>' + (activeConversation && activeConversation.kind === 'group' ? '<button id="moreGroupSettings" class="modal-option" type="button">⚙ Group settings</button>' : ''),
    hidePrimary:true
  }) || setTimeout(() => {
    if ($('moreChatDetails')) $('moreChatDetails').onclick = () => { closeModal(); openConversationDetails(); };
    if ($('moreAddFriend')) $('moreAddFriend').onclick = () => { closeModal(); openAddFriend(); };
    if ($('moreGroupSettings')) $('moreGroupSettings').onclick = () => { closeModal(); showGroupDetails().catch(err => toast('Could not load group details', err.message, true)); };
  },0));
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
  try {
    await refreshProfile();
    await Promise.all([refreshFriends(), refreshConversations()]);
    if (window.location.hash.includes('type=recovery')) openPasswordRecovery();
  } catch (error) {
    toast('Could not load your Flock data', error.message || 'Try refreshing.', true);
  }
  subscribeGlobal();
}
function openPasswordRecovery() {
  showModal({
    kicker:'FLOCK / ACCOUNT SECURITY',
    title:'Choose a new password',
    description:'Use a password you do not use anywhere else.',
    body:'<label for="recoveryPassword">NEW PASSWORD</label><input id="recoveryPassword" class="input-field" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters"><label for="recoveryPasswordConfirm">CONFIRM PASSWORD</label><input id="recoveryPasswordConfirm" class="input-field" type="password" minlength="8" autocomplete="new-password" placeholder="Type it again">',
    primary:'Update password',
    onPrimary:async()=>{
      const password=$('recoveryPassword').value;
      if(password.length<8)throw new Error('Use at least 8 characters.');
      if(password!==$('recoveryPasswordConfirm').value)throw new Error('Passwords do not match.');
      const {error}=await db.auth.updateUser({password});
      if(error)throw error;
      window.history.replaceState({},document.title,window.location.pathname+window.location.search);
      closeModal();
      toast('Password updated','Your Flock account has a new password.');
    }
  });
}
function subscribeGlobal() {
  if (authSubscription) { db.removeChannel(authSubscription); authSubscription = null; }
  authSubscription = db.channel('flock-global-' + user.id)
    .on('postgres_changes',{event:'*',schema:'public',table:'flock_friendships'},payload=>{
      const row=payload.new || payload.old;
      if(row && (row.requester_id===user.id || row.addressee_id===user.id)) {
        refreshFriends().catch(()=>{});
        refreshConversations().catch(()=>{});
      }
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'flock_conversation_members',filter:'user_id=eq.'+user.id},()=>refreshConversations().catch(()=>{}))
    .on('postgres_changes',{event:'*',schema:'public',table:'flock_conversations'},payload=>{
      const row=payload.new || payload.old;
      if(row && conversations.some(c=>c.id===row.id)) refreshConversations().catch(()=>{});
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'flock_statuses'},()=> {
      if(Date.now()-lastStatusLoad>15000) $('statusCountBadge').textContent='NEW';
    })
    .subscribe();
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
    feedback('authFeedback','Flock cannot connect because Supabase configuration is missing. Check src/flock-config.js.',true);
    return;
  }
  try {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;
    user = data.session ? data.session.user : null;
    if (user) await enterApp();
    else showAuthScreen(false);
  } catch (error) {
    showAuthScreen(false);
    feedback('authFeedback',error.message || 'Could not connect to Flock. Check your internet connection.',true);
  }
  db.auth.onAuthStateChange(async (event, session) => {
    if (suppressAuthCallback) return;
    if (session && session.user && (!user || session.user.id !== user.id)) {
      user = session.user;
      await enterApp();
    } else if (!session && user) {
      user=null; profile=null; conversations=[]; friends=[]; friendRequests=[]; activeConversation=null;
      showAuthScreen(false);
    } else if (event==='PASSWORD_RECOVERY') {
      openPasswordRecovery();
    }
  });
  const params = new URLSearchParams(window.location.search);
  if (params.get('error_description')) feedback('authFeedback',params.get('error_description'),true);
}
initialize().catch(error=> {
  console.error('[Flock] Initialization error',error);
  showAuthScreen(false);
  feedback('authFeedback',error.message || 'Flock could not start.',true);
});