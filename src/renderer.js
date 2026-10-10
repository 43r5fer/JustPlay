'use strict';

const api = window.justplay;
const $ = function (id) { return document.getElementById(id); };
let robloxState = { configured: false, clientId: '', profile: null, connected: false, redirectUri: 'http://127.0.0.1:53682/callback' };
let favorites = new Set();
let games = [];
let favoriteGames = [];
let gameById = new Map();
let visibleCount = 12;
let searchQuery = '';
let searchTimer = null;
let toastTimer = null;
let isSearching = false;
let activeView = 'discover';

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
  });
}
function safeImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    if (!url.hostname.toLowerCase().endsWith('.rbxcdn.com')) return '';
    return url.href;
  } catch { return ''; }
}
function formatNumber(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num < 1) return '';
  try { return new Intl.NumberFormat(undefined, { notation: num >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(num); }
  catch { return String(num); }
}
function toast(title, message, isError) {
  $('toastTitle').textContent = title || 'JustPlay';
  $('toastMessage').textContent = message || '';
  $('launchToast').classList.toggle('toast-error', Boolean(isError));
  $('launchToast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { $('launchToast').classList.remove('visible'); }, 5200);
}
function setFeedback(id, message, isError) {
  const node = $(id);
  if (!node) return;
  node.textContent = message || '';
  node.classList.toggle('is-error', Boolean(isError));
}
function setBusy(button, isBusy, busyText) {
  if (!button) return;
  if (isBusy) {
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent.trim();
    button.disabled = true;
    if (busyText) button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}
function showAuthSetup(expand) {
  $('authScreen').hidden = false;
  $('appScreen').hidden = true;
  if (expand) $('oauthSetupBody').hidden = false;
  $('oauthSetupSummary').classList.toggle('expanded', !$('oauthSetupBody').hidden);
}
function switchToApp() {
  $('authScreen').hidden = true;
  $('appScreen').hidden = false;
  renderProfile();
}
function showSettings() {
  $('settingsOverlay').hidden = false;
  $('settingsClientIdInput').value = robloxState.clientId || '';
  $('settingsRedirectUri').textContent = robloxState.redirectUri || 'http://127.0.0.1:53682/callback';
  renderSettingsProfile();
}
function closeSettings() {
  $('settingsOverlay').hidden = true;
}
function renderSettingsProfile() {
  const profile = robloxState.profile;
  $('settingsProfileStatus').textContent = profile
    ? 'This Roblox profile was verified using Roblox OAuth. The official Roblox app manages game sessions.'
    : 'No Roblox profile is connected. You can still browse and launch public experiences.';
  $('settingsDisplayName').textContent = profile ? (profile.displayName || profile.username) : 'Not connected';
  $('settingsUsername').textContent = profile ? '@' + (profile.username || 'Roblox player') : '@not_connected';
  $('settingsSignInBtn').textContent = profile ? 'Connected' : 'Connect';
  $('settingsSignInBtn').disabled = Boolean(profile);
  $('settingsSignOutBtn').hidden = !profile;
  const avatar = $('settingsAvatar');
  const fallback = $('settingsAvatarFallback');
  const source = safeImageUrl(profile && profile.avatarUrl);
  avatar.hidden = !source;
  avatar.src = source || '';
  fallback.hidden = Boolean(source);
  fallback.textContent = (profile && (profile.displayName || profile.username) || 'J').slice(0, 1).toUpperCase();
}
function renderProfile() {
  const profile = robloxState.profile;
  const username = profile ? profile.username : 'Guest player';
  const displayName = profile ? (profile.displayName || profile.username) : 'Browse mode';
  $('sidebarDisplayName').textContent = displayName;
  $('sidebarUsername').textContent = profile ? '@' + username : 'Roblox profile optional';
  $('sidebarAvatarFallback').textContent = displayName.slice(0, 1).toUpperCase();
  $('topAvatarFallback').textContent = displayName.slice(0, 1).toUpperCase();
  const source = safeImageUrl(profile && profile.avatarUrl);
  for (const item of [['sidebarAvatar', 'sidebarAvatarFallback'], ['topAvatar', 'topAvatarFallback']]) {
    const image = $(item[0]);
    const fallback = $(item[1]);
    image.src = source || '';
    image.hidden = !source;
    fallback.hidden = Boolean(source);
  }
  $('connectionBadge').classList.toggle('connected', Boolean(profile));
  $('connectionBadgeText').textContent = profile ? 'Roblox profile connected' : 'Browsing as guest';
  $('topConnectBtn').hidden = Boolean(profile);
  $('robloxSignInLabel').textContent = profile ? 'Roblox connected' : 'Continue with Roblox';
  $('robloxSignInBtn').disabled = Boolean(profile);
  if (profile) {
    $('robloxSignInBtn').classList.add('is-connected');
    $('robloxSignInBtn').innerHTML = '<span class="roblox-button-icon">✓</span><span>Connected as ' + escapeHtml(profile.username) + '</span>';

    $('browseWithoutSignInBtn').textContent = 'Continue to games →';
  } else {
    $('robloxSignInBtn').classList.remove('is-connected');
    $('robloxSignInBtn').innerHTML = '<span class="roblox-button-icon">◩</span><span>Continue with Roblox</span><span class="button-arrow">↗</span>';

    $('browseWithoutSignInBtn').textContent = 'Browse games first →';
  }
  $('oauthClientIdInput').value = robloxState.clientId || '';
  $('redirectUriText').textContent = robloxState.redirectUri || 'http://127.0.0.1:53682/callback';
  $('oauthSetupBody').hidden = Boolean(robloxState.configured);
  $('oauthSetupSummary').classList.toggle('expanded', !robloxState.configured);
  $('favoritesCount').textContent = String(favorites.size);
  renderSettingsProfile();
}
async function loadRobloxState() {
  try {
    robloxState = await api.robloxState();
    robloxState.redirectUri = robloxState.redirectUri || 'http://127.0.0.1:53682/callback';
    $('redirectUriText').textContent = robloxState.redirectUri;
    $('settingsRedirectUri').textContent = robloxState.redirectUri;
    renderProfile();
    if (robloxState.profile) switchToApp();
  } catch (error) {
    setFeedback('authFeedback', error.message || 'Could not read Roblox sign-in settings.', true);
  }
}
async function beginRobloxSignIn() {
  if (!robloxState.configured) {
    showAuthSetup(true);
    setFeedback('authFeedback', 'Add your public Roblox OAuth Client ID below to enable secure profile sign-in. You can still browse and launch games without connecting.');
    $('oauthClientIdInput').focus();
    return;
  }
  const button = $('robloxSignInBtn');
  button.disabled = true;
  $('robloxSignInLabel').textContent = 'Waiting for Roblox…';
  setFeedback('authFeedback', 'Roblox will open in your browser. Sign in there and approve the requested profile access.');
  try {
    const result = await api.signInRoblox();
    robloxState = result.state || await api.robloxState();
    renderProfile();
    switchToApp();
    await loadGames('');
    toast('Roblox connected', 'Signed in as @' + (robloxState.profile && robloxState.profile.username || 'Roblox player') + '. Choose a game to start playing.');
  } catch (error) {
    setFeedback('authFeedback', error.message || 'Roblox sign-in failed. Check the OAuth app settings and redirect URI.', true);
    toast('Could not connect Roblox', error.message || 'Check your Roblox OAuth configuration.', true);
  } finally {
    button.disabled = Boolean(robloxState.profile);
    if (!robloxState.profile) $('robloxSignInLabel').textContent = 'Continue with Roblox';
  }
}
async function saveClientId(inputId, feedbackId) {
  const value = $(inputId).value.trim();
  try {
    const result = await api.configureRoblox(value);
    robloxState = result.state || await api.robloxState();
    renderProfile();
    setFeedback(feedbackId, 'Roblox OAuth Client ID saved on this PC. Make sure this exact redirect URI is registered with your OAuth app.');
    toast('Roblox sign-in configured', 'You can now connect your Roblox profile.');
    return true;
  } catch (error) {
    setFeedback(feedbackId, error.message || 'Could not save the Roblox Client ID.', true);
    return false;
  }
}
async function copyRedirectUri(id, feedbackId) {
  const text = robloxState.redirectUri || 'http://127.0.0.1:53682/callback';
  try {
    await navigator.clipboard.writeText(text);
    if (feedbackId) setFeedback(feedbackId, 'Redirect URI copied. Paste it into the Roblox OAuth app settings.');
    else toast('Redirect URI copied', 'Paste it into your Roblox OAuth app redirect URI field.');
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    input.remove();
    if (copied) toast('Redirect URI copied', 'Paste it into your Roblox OAuth app settings.');
    else toast('Redirect URI', text);
  }
}
function navigate(view) {
  activeView = view === 'favorites' ? 'favorites' : 'discover';
  document.querySelectorAll('.view').forEach(function (node) {
    node.classList.toggle('active', node.id === (activeView === 'favorites' ? 'viewFavorites' : 'viewDiscover'));
  });
  $('navDiscover').classList.toggle('active', activeView === 'discover');
  $('navFavorites').classList.toggle('active', activeView === 'favorites');
  $('breadcrumbTitle').textContent = activeView === 'favorites' ? 'Favorites' : 'Discover';
  if (activeView === 'favorites') loadFavoriteGames();
}
function rememberGames(list) {
  (list || []).forEach(function (game) {
    if (game && game.placeId) gameById.set(String(game.placeId), game);
  });
}
function cardMarkup(game) {
  const id = String(game.placeId || game.id || '');
  const favorite = favorites.has(id);
  const iconUrl = safeImageUrl(game.iconUrl);
  const badge = game.featured ? '<span class="game-badge">POPULAR</span>' : '';
  const players = formatNumber(game.players);
  const playerMarkup = players ? '<span class="game-players"><i></i>' + escapeHtml(players) + ' playing</span>' : '<span class="game-players">↗ Experience</span>';
  const name = escapeHtml(game.name || 'Roblox experience');
  const creator = escapeHtml(game.creator || 'Roblox creator');
  const description = escapeHtml(game.description || 'Jump in and explore this Roblox experience with your friends.');
  const genre = escapeHtml(game.genre || 'Experience');
  const icon = iconUrl
    ? '<img src="' + escapeHtml(iconUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
    : '';
  const initial = escapeHtml((game.name || 'R').slice(0, 1).toUpperCase());
  return '<article class="game-card" data-game-id="' + escapeHtml(id) + '">' +
    '<div class="game-card-art"><div class="game-placeholder"><span>' + initial + '</span></div>' + icon + badge +
    '<button class="favorite-button ' + (favorite ? 'is-favorite' : '') + '" data-favorite-id="' + escapeHtml(id) + '" aria-label="' + (favorite ? 'Remove from favorites' : 'Add to favorites') + '" title="' + (favorite ? 'Remove from favorites' : 'Add to favorites') + '">' + (favorite ? '♥' : '♡') + '</button></div>' +
    '<div class="game-card-body"><div class="game-card-title-row"><div class="game-card-title" title="' + name + '">' + name + '</div></div>' +
    '<div class="game-card-creator">By ' + creator + '</div><p class="game-card-description">' + description + '</p>' +
    '<div class="game-card-meta"><span class="genre-chip">' + genre + '</span>' + playerMarkup + '</div>' +
    '<button class="game-play-button" data-play-id="' + escapeHtml(id) + '">Play experience <span>↗</span></button></div></article>';
}
function renderGrid(nodeId, list, totalLabel) {
  const node = $(nodeId);
  if (!list || !list.length) {
    node.innerHTML = '<div class="loading-grid empty-grid-state"><strong>No experiences to show yet.</strong><p>Try another search or refresh the list.</p></div>';
    return;
  }
  const shown = list.slice(0, visibleCount);
  node.innerHTML = shown.map(cardMarkup).join('');
  node.querySelectorAll('img').forEach(function (image) {
    image.addEventListener('error', function () { image.hidden = true; });
  });
  if (nodeId === 'gamesGrid') {
    $('loadMoreBtn').hidden = list.length <= shown.length;
    $('gamesResultCount').textContent = totalLabel || (list.length + ' experiences');
    $('loadMoreBtn').textContent = 'Load more experiences (' + Math.min(12, list.length - shown.length) + ') ↓';
  }
}
function setSpotlight(game) {
  if (!game) {
    $('spotlightTitle').textContent = 'Discover something new.';
    $('spotlightDescription').textContent = 'Explore Roblox experiences and jump right in.';
    $('spotlightPlayBtn').disabled = true;
    $('spotlightImage').hidden = true;
    document.querySelector('.spotlight-art-placeholder').hidden = false;
    return;
  }
  $('spotlightTitle').textContent = game.name || 'Featured experience';
  $('spotlightDescription').textContent = game.description || ('By ' + (game.creator || 'the Roblox community') + '. Open this experience in the official Roblox app.');
  $('spotlightPlayBtn').disabled = false;
  $('spotlightPlayBtn').dataset.playId = String(game.placeId || game.id || '');
  const src = safeImageUrl(game.iconUrl);
  $('spotlightImage').src = src;
  $('spotlightImage').hidden = !src;
  const placeholder = document.querySelector('.spotlight-art-placeholder');
  placeholder.hidden = Boolean(src);
  $('spotlightBackdrop').style.backgroundImage = src
    ? 'linear-gradient(90deg,#20191f 0%,#20191fe8 35%,#17171cc7 100%),url("' + src + '")'
    : 'radial-gradient(ellipse at 70% 25%,#ff4f5924,transparent 55%),linear-gradient(110deg,#271a21,#16161b 80%)';
  $('spotlightImage').onerror = function () {
    this.hidden = true;
    placeholder.hidden = false;
  };
}
function renderGames() {
  $('gamesSectionTitle').textContent = searchQuery ? 'Search results' : 'Popular right now';
  setSpotlight(games.find(function (game) { return game.featured; }) || games[0]);
  renderGrid('gamesGrid', games, isSearching ? 'Searching Roblox…' : String(games.length) + ' experiences');
  if (!games.length) {
    $('gamesGrid').innerHTML = '<div class="loading-grid"><strong>No matching experiences found.</strong><p>Try a different name, or clear your search to explore popular games.</p></div>';
    $('loadMoreBtn').hidden = true;
    $('gamesResultCount').textContent = '0 experiences';
  }
  $('clearSearchBtn').hidden = !searchQuery;
  $('catalogSourceNote').textContent = searchQuery
    ? 'Search results are fetched from Roblox discovery services.'
    : 'Popular suggestions · Experience metadata and icons from Roblox services.';
  rememberGames(games);
}
async function loadGames(query, options) {
  const opts = options || {};
  const clean = String(query || '').trim();
  if (!opts.keepQuery) searchQuery = clean;
  isSearching = true;
  if (!opts.append) {
    $('gamesGrid').innerHTML = '<div class="loading-grid"><span class="loading-spinner"></span><strong>' + (clean ? 'Searching Roblox…' : 'Finding popular experiences…') + '</strong><p>Getting game cards ready.</p></div>';
    $('loadMoreBtn').hidden = true;
  }
  $('gamesResultCount').textContent = 'Loading…';
  try {
    const result = await api.listRobloxGames(clean);
    const returned = Array.isArray(result && result.games) ? result.games : [];
    if (opts.append) {
      const existing = new Set(games.map(function (game) { return String(game.placeId); }));
      games = games.concat(returned.filter(function (game) { return !existing.has(String(game.placeId)); }));
    } else {
      games = returned;
      visibleCount = 12;
    }
    isSearching = false;
    rememberGames(games);
    renderGames();
    if (result && result.source) $('catalogSourceNote').textContent = result.source + ' · Use Play to open the experience in Roblox.';
  } catch (error) {
    isSearching = false;
    if (!opts.append) {
      $('gamesGrid').innerHTML = '<div class="loading-grid"><strong>Could not load experiences.</strong><p>' + escapeHtml(error.message || 'Check your connection and try again.') + '</p><button class="button button-outline" id="retryGamesBtn">Try again</button></div>';
      $('retryGamesBtn').addEventListener('click', function () { loadGames(searchQuery); });
      $('gamesResultCount').textContent = 'Unavailable';
    }
    toast('Could not load games', error.message || 'Try again later.', true);
  }
}
async function loadFavoriteGames() {
  $('favoritesGrid').innerHTML = '<div class="loading-grid"><span class="loading-spinner"></span><strong>Loading favorites…</strong></div>';
  $('favoritesEmpty').hidden = true;
  try {
    const result = await api.getRobloxFavoriteGames();
    favoriteGames = (Array.isArray(result) ? result : []).map(function (game) {
      const known = gameById.get(String(game.placeId));
      return known ? Object.assign({}, game, { iconUrl: game.iconUrl || known.iconUrl, name: game.name || known.name }) : game;
    });
    rememberGames(favoriteGames);
    if (!favoriteGames.length) {
      $('favoritesGrid').innerHTML = '';
      $('favoritesEmpty').hidden = false;
    } else {
      visibleCount = Math.max(12, favoriteGames.length);
      renderGrid('favoritesGrid', favoriteGames);
      $('favoritesEmpty').hidden = true;
    }
    $('favoritesCount').textContent = String(favorites.size);
  } catch (error) {
    $('favoritesGrid').innerHTML = '<div class="loading-grid"><strong>Could not load favorites.</strong><p>' + escapeHtml(error.message || 'Try again.') + '</p></div>';
  }
}
async function toggleFavorite(placeId) {
  const id = String(placeId || '');
  if (!/^\d{1,24}$/.test(id)) return;
  try {
    const result = await api.toggleRobloxFavorite(id);
    favorites = new Set((result.favorites || []).map(String));
    $('favoritesCount').textContent = String(favorites.size);
    renderGames();
    if (activeView === 'favorites') await loadFavoriteGames();
    toast(result.favorite ? 'Added to favorites' : 'Removed from favorites', (gameById.get(id) || {}).name || 'Your collection is saved on this PC.');
  } catch (error) {
    toast('Could not update favorites', error.message || 'Try again.', true);
  }
}
async function launchGame(placeId) {
  const id = String(placeId || '');
  const game = gameById.get(id) || games.find(function (item) { return String(item.placeId) === id; });
  if (!/^\d{1,24}$/.test(id)) {
    toast('Cannot launch this experience', 'The selected game does not have a valid place ID.', true);
    return;
  }
  try {
    const result = await api.launchRobloxGame(id);
    toast('Opening ' + ((game && game.name) || 'Roblox experience'), result.message || 'Handing this experience to the Roblox app.');
  } catch (error) {
    toast('Roblox did not open', (error.message || 'Could not launch the experience.') + ' Install or update the official Roblox app, then try again.', true);
  }
}
function bindCardActions(nodeId) {
  $(nodeId).addEventListener('click', function (event) {
    const favoriteButton = event.target.closest('[data-favorite-id]');
    if (favoriteButton) {
      event.preventDefault();
      toggleFavorite(favoriteButton.dataset.favoriteId);
      return;
    }
    const playButton = event.target.closest('[data-play-id]');
    if (playButton) {
      event.preventDefault();
      launchGame(playButton.dataset.playId);
    }
  });
}
function bindEvents() {
  $('robloxSignInBtn').addEventListener('click', beginRobloxSignIn);
  $('browseWithoutSignInBtn').addEventListener('click', function () {
    switchToApp();
    if (!games.length) loadGames('');
  });
  $('createRobloxAccountBtn').addEventListener('click', function () {
    api.openRobloxSignup().catch(function (error) { toast('Could not open Roblox', error.message, true); });
  });
  $('toggleOauthSetupBtn').addEventListener('click', function () {
    $('oauthSetupBody').hidden = !$('oauthSetupBody').hidden;
    $('oauthSetupSummary').classList.toggle('expanded', !$('oauthSetupBody').hidden);
  });
  $('saveClientIdBtn').addEventListener('click', function () { saveClientId('oauthClientIdInput', 'authFeedback'); });
  $('openOAuthDashboardBtn').addEventListener('click', function () {
    api.openRobloxOAuthDashboard().catch(function (error) { setFeedback('authFeedback', error.message, true); });
  });
  $('copyRedirectBtn').addEventListener('click', function () { copyRedirectUri('redirectUriText', 'authFeedback'); });
  $('topConnectBtn').addEventListener('click', function () {
    if (!robloxState.configured) {
      showSettings();
      setFeedback('settingsFeedback', 'Add your public OAuth Client ID to connect your Roblox profile.');
      return;
    }
    beginRobloxSignIn();
  });
  $('topAvatarBtn').addEventListener('click', showSettings);
  $('sidebarAccountBtn').addEventListener('click', showSettings);
  $('settingsBtn').addEventListener('click', showSettings);
  $('settingsSignInBtn').addEventListener('click', beginRobloxSignIn);
  $('settingsSignOutBtn').addEventListener('click', async function () {
    try {
      const result = await api.signOutRoblox();
      robloxState = result.state || await api.robloxState();
      renderProfile();
      setFeedback('settingsFeedback', 'Roblox profile disconnected from JustPlay. The encrypted sign-in session was removed.');
      toast('Roblox disconnected', 'You can keep browsing and launching games.');
    } catch (error) { setFeedback('settingsFeedback', error.message || 'Could not disconnect Roblox.', true); }
  });
  $('saveSettingsClientIdBtn').addEventListener('click', function () { saveClientId('settingsClientIdInput', 'settingsFeedback'); });
  $('settingsOAuthDashboardBtn').addEventListener('click', function () {
    api.openRobloxOAuthDashboard().catch(function (error) { setFeedback('settingsFeedback', error.message, true); });
  });
  $('settingsCopyRedirectBtn').addEventListener('click', function () { copyRedirectUri('settingsRedirectUri', 'settingsFeedback'); });
  $('closeSettingsBtn').addEventListener('click', closeSettings);
  $('settingsDoneBtn').addEventListener('click', closeSettings);
  $('settingsOpenRobloxBtn').addEventListener('click', function () {
    api.openRobloxApp().then(function (result) { toast('Opening Roblox', result.message || 'Opening the official app.'); })
      .catch(function (error) { toast('Could not open Roblox', error.message || 'Install the official Roblox app.', true); });
  });
  $('settingsRobloxWebsiteBtn').addEventListener('click', function () { api.openRobloxSignup(); });
  $('openRobloxAppBtn').addEventListener('click', function () {
    api.openRobloxApp().then(function (result) { toast('Opening Roblox', result.message || 'Opening the official app.'); })
      .catch(function (error) { toast('Could not open Roblox', error.message || 'Install the official Roblox app.', true); });
  });
  $('openRobloxWebsiteBtn').addEventListener('click', function () { api.openRobloxSignup(); });
  $('navDiscover').addEventListener('click', function () { navigate('discover'); });
  $('navFavorites').addEventListener('click', function () { navigate('favorites'); });
  $('backToDiscoverBtn').addEventListener('click', function () { navigate('discover'); });
  $('favoritesDiscoverBtn').addEventListener('click', function () { navigate('discover'); });
  $('spotlightExploreBtn').addEventListener('click', function () { $('gameSearchInput').focus(); document.querySelector('.games-toolbar').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('spotlightPlayBtn').addEventListener('click', function () { launchGame($('spotlightPlayBtn').dataset.playId); });
  $('refreshGamesBtn').addEventListener('click', function () { loadGames(searchQuery); });
  $('loadMoreBtn').addEventListener('click', function () { visibleCount += 12; renderGrid('gamesGrid', games, String(games.length) + ' experiences'); });
  $('gameSearchInput').addEventListener('input', function (event) {
    clearTimeout(searchTimer);
    const value = event.target.value.trim();
    $('clearSearchBtn').hidden = !value;
    searchTimer = setTimeout(function () { loadGames(value); }, 450);
  });
  $('gameSearchInput').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      clearTimeout(searchTimer);
      loadGames(event.target.value.trim());
    }
    if (event.key === 'Escape') {
      event.target.value = '';
      loadGames('');
    }
  });
  $('clearSearchBtn').addEventListener('click', function () {
    $('gameSearchInput').value = '';
    loadGames('');
    $('gameSearchInput').focus();
  });
  $('toastCloseBtn').addEventListener('click', function () { $('launchToast').classList.remove('visible'); });
  $('settingsOverlay').addEventListener('click', function (event) { if (event.target === $('settingsOverlay')) closeSettings(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeSettings();
      $('launchToast').classList.remove('visible');
    }
    if ((event.ctrlKey || event.metaKey) && event.key === '1' && !$('appScreen').hidden) navigate('discover');
  });
  bindCardActions('gamesGrid');
  bindCardActions('favoritesGrid');
}
async function initialize() {
  bindEvents();
  try {
    robloxState = await api.robloxState();
    robloxState.redirectUri = robloxState.redirectUri || 'http://127.0.0.1:53682/callback';
    const result = await api.getRobloxFavorites();
    favorites = new Set((Array.isArray(result) ? result : []).map(String));
    $('redirectUriText').textContent = robloxState.redirectUri;
    $('settingsRedirectUri').textContent = robloxState.redirectUri;
    renderProfile();
    if (robloxState.profile) switchToApp();
  } catch (error) {
    setFeedback('authFeedback', error.message || 'Could not initialize JustPlay.', true);
    showAuthSetup(false);
  }
  await loadGames('');
  if (!$('appScreen').hidden) await loadFavoriteGames();
}
initialize().catch(function (error) {
  setFeedback('authFeedback', error.message || 'JustPlay could not start.', true);
});