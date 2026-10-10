'use strict';

const api = window.justplay;
let appState = null;
let catalog = null;
let selectedEntry = null;
let activePage = 'dashboard';
let activeFilter = 'release';
let searchTerm = '';
let visibleEntries = [];
let lastProgress = 0;
let toastTimer = null;
let javaRuntimes = [];
let javaRuntimeScanInProgress = false;

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const titleCase = value => String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const readableSize = value => { const n = Number(value) || 0; if (n < 1024) return `${n} B`; if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`; return `${(n / 1024 ** 2).toFixed(1)} MB`; };

function showToast(message, kind = 'normal', duration = 4800) {
  const toast = $('messageToast');
  $('toastText').textContent = message;
  toast.classList.add('visible');
  toast.dataset.kind = kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), duration);
}

function renderUpdateStatus(state) {
  if (!state || !$('updateBanner')) return;
  const banner = $('updateBanner');
  const button = $('updatePrimaryBtn');
  const visible = ['available', 'download-started', 'error'].includes(state.status);
  banner.hidden = !visible;
  if (!visible) return;

  $('updateTitle').textContent = state.status === 'available' ? 'A new JustPlay version is available'
    : state.status === 'download-started' ? 'Installer download started'
    : 'Update check failed';
  $('updateMessage').textContent = state.message || (state.version ? `JustPlay ${state.version} is available.` : 'Check your internet connection and try again.');
  $('updateProgressTrack').hidden = true;
  $('updateProgressFill').style.width = '0%';
  button.disabled = state.status === 'download-started';
  if (state.status === 'available') {
    button.textContent = 'Download update';
    button.dataset.updateAction = 'download';
  } else if (state.status === 'download-started') {
    button.textContent = 'Download started';
    button.dataset.updateAction = 'none';
  } else {
    button.textContent = 'Try again';
    button.dataset.updateAction = 'check';
  }
}

async function handleUpdateAction() {
  const button = $('updatePrimaryBtn');
  const action = button.dataset.updateAction;
  button.disabled = true;
  try {
    if (action === 'download') {
      await api.downloadUpdate();
      renderUpdateStatus(await api.getUpdateStatus());
      showToast('The official JustPlay installer has been opened in your browser. Run it after the download finishes.');
    } else if (action === 'check') {
      renderUpdateStatus(await api.checkForUpdates());
    }
  } catch (error) {
    showToast(error.message || 'Could not update JustPlay.', 'error');
    renderUpdateStatus({ status: 'error', message: 'The update could not be completed. Check your connection and try again.' });
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

function showAccountGateFeedback(message, kind = 'error') {
  const feedback = $('accountGateFeedback');
  feedback.textContent = message || '';
  feedback.hidden = !message;
  feedback.classList.toggle('is-error', kind === 'error');
  feedback.classList.toggle('is-success', kind === 'success');
}

function enterLauncher(sessionType, username = '') {
  if (!appState) {
    showAccountGateFeedback('JustPlay could not load your local settings. Restart the app and try again.');
    return;
  }
  appState.localAccountName = sessionType === 'local' ? username : '';
  $('localLoginOverlay').hidden = true;
  renderHeader();
  renderSettings();
  if (!appState.setupComplete) {
    $('setupOverlay').hidden = false;
    previewDiskChoice();
  } else {
    $('setupOverlay').hidden = true;
  }
  if (sessionType === 'guest') {
    showToast('Continuing as guest. Microsoft sign-in may still be required to launch Minecraft.');
  } else {
    showToast(`Welcome to JustPlay, ${username}!`);
  }
}

async function submitAccountGate(action) {
  const username = $('gateUsername').value;
  const password = $('gatePassword').value;
  const signInButton = $('gateSignInBtn');
  const createButton = $('gateCreateBtn');
  signInButton.disabled = true;
  createButton.disabled = true;
  showAccountGateFeedback('', 'success');
  try {
    const result = action === 'create'
      ? await api.createLocalAccount(username, password)
      : await api.signInLocalAccount(username, password);
    appState = result.state || await api.getState();
    $('gatePassword').value = '';
    showAccountGateFeedback('', 'success');
    enterLauncher('local', result.localAccountName || username.trim());
  } catch (error) {
    showAccountGateFeedback(error.message || (action === 'create' ? 'Could not create your JustPlay account.' : 'Could not sign in.'));
  } finally {
    signInButton.disabled = false;
    createButton.disabled = false;
  }
}

function renderSkinPreview() {
  const skin = appState?.minecraftSkin;
  const image = $('skinTexturePreview');
  if (!skin || !skin.textureUrl || !skin.playerName) {
    image.hidden = true;
    image.removeAttribute('src');
    $('skinPlayerName').textContent = 'No skin synced yet';
    $('skinSyncDetails').textContent = 'Sign in with Microsoft, then sync to preview your active skin texture here.';
    return;
  }
  try {
    const url = new URL(skin.textureUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'textures.minecraft.net') throw new Error('Invalid texture host');
    image.src = url.toString();
    image.hidden = false;
  } catch {
    image.hidden = true;
    image.removeAttribute('src');
  }
  $('skinPlayerName').textContent = skin.playerName;
  const synced = skin.syncedAt ? new Date(skin.syncedAt).toLocaleString() : 'Previously synced';
  $('skinSyncDetails').textContent = `Active ${skin.variant || 'CLASSIC'} skin texture · Synced ${synced}`;
}

async function refreshJavaRuntimes(showFeedback = false) {
  if (javaRuntimeScanInProgress) return;
  javaRuntimeScanInProgress = true;
  const button = $('detectJavaBtn');
  if (button) button.disabled = true;
  if (showFeedback) $('javaRuntimeFeedback').textContent = 'Searching PATH, JAVA_HOME, and common Java/Minecraft runtime folders…';
  try {
    const result = await api.detectJavaRuntimes();
    javaRuntimes = Array.isArray(result.runtimes) ? result.runtimes : [];
    const select = $('javaRuntimeSelect');
    select.innerHTML = '<option value="">Auto-detect compatible runtime</option>' + javaRuntimes.map(item =>
      `<option value="${esc(item.path)}">Java ${esc(item.major)} · ${esc(item.path)}</option>`
    ).join('');
    const selectedPath = result.selectedPath || appState?.javaPath || '';
    if (selectedPath && javaRuntimes.some(item => item.path === selectedPath)) select.value = selectedPath;
    const selected = javaRuntimes.find(item => item.path === select.value);
    $('javaRuntimeCurrent').textContent = selected ? `Java ${selected.major} · ${selected.path}` : (javaRuntimes.length ? 'Automatic selection by Minecraft version' : 'No Java runtime detected');
    if (appState) {
      appState.javaPath = result.selectedPath || appState.javaPath || '';
    }
    $('javaRuntimeFeedback').textContent = javaRuntimes.length
      ? `Found ${javaRuntimes.length} Java runtime${javaRuntimes.length === 1 ? '' : 's'}. JustPlay chooses a compatible runtime for the selected game version.`
      : 'No Java runtime was found. Install a compatible Java runtime, then try Auto-detect again.';
    if (showFeedback) showToast(javaRuntimes.length ? `Detected ${javaRuntimes.length} Java runtime${javaRuntimes.length === 1 ? '' : 's'}.` : 'No Java runtime was detected.', javaRuntimes.length ? 'normal' : 'error');
  } catch (error) {
    $('javaRuntimeCurrent').textContent = 'Java detection unavailable';
    $('javaRuntimeFeedback').textContent = error.message || 'Could not detect Java runtimes.';
    if (showFeedback) showToast(error.message || 'Could not detect Java runtimes.', 'error');
  } finally {
    javaRuntimeScanInProgress = false;
    if (button) button.disabled = false;
  }
}

function goTo(page) {
  if (!document.getElementById(`page-${page}`)) return;
  activePage = page;
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active', el.id === `page-${page}`));
  document.querySelectorAll('[data-page]').forEach(el => el.classList.toggle('active', el.classList.contains('nav-item') && el.dataset.page === page));
  $('pageCrumb').textContent = page.toUpperCase().replace('RESOURCEPACKS', 'RESOURCE PACKS');
  if (page === 'mods') refreshAssets('mods');
  if (page === 'resourcepacks') refreshAssets('resourcepacks');
  if (page === 'settings') renderSettings();
  document.querySelector('.content-area').scrollTo({ top: 0, behavior: 'smooth' });
}

function currentMcVersion() {
  if (!selectedEntry) return catalog?.latest?.release || 'latest';
  if (selectedEntry.mcVersion) return selectedEntry.mcVersion;
  return selectedEntry.id || catalog?.latest?.release || 'latest';
}

function isEntryInstalled(entry) {
  if (!entry) return false;
  return !!entry.installed || ['installed-forge', 'installed-optifine', 'installed-fabric', 'installed-quilt', 'installed-neoforge', 'installed-custom'].includes(entry.kind);
}

function entryKindLabel(entry) {
  if (!entry) return 'Release';
  if (entry.kind === 'forge' || entry.kind === 'installed-forge') return 'Forge';
  if (entry.kind === 'fabric' || entry.kind === 'installed-fabric') return 'Fabric';
  if (entry.kind === 'optifine' || entry.kind === 'optifine-site' || entry.kind === 'installed-optifine') return 'OptiFine';
  if (entry.kind === 'installed-quilt') return 'Quilt';
  if (entry.kind === 'installed-neoforge') return 'NeoForge';
  if (entry.kind === 'installed-custom') return 'Custom';
  if (entry.type === 'snapshot') return 'Snapshot';
  if (entry.type === 'old_alpha' || entry.type === 'old_beta') return 'Legacy';
  return entry.type === 'release' ? 'Release' : titleCase(entry.type || 'Version');
}

function entryDescription(entry) {
  if (!entry) return 'Select a build from the version library.';
  if (entry.kind === 'forge') return `Official Forge installer · Minecraft ${entry.mcVersion} · Forge ${entry.loaderVersion}. JustPlay will download the installer from Forge's Maven repository and ask the launcher core to prepare this profile.`;
  if (entry.kind === 'fabric') return `Official Fabric Loader for Minecraft ${entry.mcVersion}. JustPlay downloads Fabric's official installer and prepares an isolated profile in your Game Versions folder.`;
  if (entry.kind === 'optifine' || entry.kind === 'optifine-site') return 'OptiFine is distributed through its official website. Open the source page and follow the installer instructions; JustPlay will not bypass ads, verification, or installer prompts.';
  if (entry.kind?.startsWith('installed-')) return `Installed profile in your Game Versions library. Base Minecraft: ${entry.mcVersion || 'unknown'}.`;
  if (entry.type === 'snapshot') return 'A Minecraft Java Edition snapshot from Mojang. Snapshots may be experimental and can affect compatibility with worlds.';
  if (entry.type === 'old_beta' || entry.type === 'old_alpha') return 'Legacy Minecraft Java Edition build. Old versions may require a compatible Java runtime and may not work with every current launcher library.';
  return `Official Minecraft Java Edition ${entry.id} metadata from Mojang. First launch downloads required game files.`;
}

function updateSelectedDetail() {
  const entry = selectedEntry;
  const exists = Boolean(entry);
  const id = entry?.label || entry?.id || 'Latest Release';
  $('detailVersionName').textContent = id;
  $('detailVersionDescription').textContent = entryDescription(entry);
  $('detailVersionType').textContent = entryKindLabel(entry);
  $('detailVersionStatus').textContent = !exists ? 'Choose a version' : isEntryInstalled(entry) ? 'Installed' : ((entry.kind === 'forge' || entry.kind === 'optifine' || entry.kind === 'optifine-site') ? 'Installer available' : 'Ready to install');
  $('detailExtraNote').textContent = !appState?.accountName
    ? (appState?.cachedSessionAvailable ? `A recent saved session for ${appState.cachedMinecraftAccountName || 'your Minecraft profile'} is available for already-installed versions.` : 'Sign in with Microsoft before launching. Your Microsoft password is never entered in a JustPlay form.')
    : `Signed in as ${appState.accountName}. Game files are stored in this profile's folder.`;
  const action = $('detailActionBtn');
  action.disabled = !exists || !appState?.setupComplete;
  if (!entry) action.innerHTML = 'Choose a version <span>→</span>';
  else if (entry.kind === 'optifine' || entry.kind === 'optifine-site') action.innerHTML = 'Open official downloads <span>↗</span>';
  else if (entry.kind === 'forge') action.innerHTML = `${isEntryInstalled(entry) ? 'Play Forge' : 'Install Forge & play'} <span>→</span>`;
  else if (entry.kind === 'fabric') action.innerHTML = `${isEntryInstalled(entry) ? 'Play Fabric' : 'Install Fabric & play'} <span>→</span>`;
  else action.innerHTML = `${isEntryInstalled(entry) ? 'Play now' : 'Install & play'} <span>→</span>`;
  $('quickSelectedVersion').textContent = selectedEntry?.label || selectedEntry?.id || 'Latest Release';
  $('quickSelectedDetail').textContent = entry ? `${entryKindLabel(entry)} · ${isEntryInstalled(entry) ? 'Installed' : 'Available to install'}` : 'Choose a version to continue';
  $('quickLaunchBtn').disabled = !entry || !appState?.setupComplete;
  $('quickLaunchBtn').innerHTML = entry ? `${isEntryInstalled(entry) ? 'Play now' : (entry.kind === 'forge' ? 'Install Forge & play' : entry.kind === 'fabric' ? 'Install Fabric & play' : entry.kind?.includes('optifine') ? 'Get OptiFine' : 'Install & play')} <span>→</span>` : 'Install & play <span>→</span>';
  const canUseSavedSession = Boolean(entry && appState?.cachedSessionAvailable && appState?.setupComplete && isEntryInstalled(entry) && !['optifine', 'optifine-site'].includes(entry.kind));
  $('quickOfflineBtn').hidden = !canUseSavedSession;
  $('quickOfflineBtn').disabled = !canUseSavedSession;
  $('detailOfflineBtn').hidden = !canUseSavedSession;
  $('detailOfflineBtn').disabled = !canUseSavedSession;
  $('detailOpenFolderBtn').disabled = !appState?.setupComplete;
  $('modsInstanceLabel').textContent = appState?.rootPath ? `Selected instance: ${currentMcVersion()}` : 'Set up JustPlay first.';
  $('packsInstanceLabel').textContent = appState?.rootPath ? `Selected instance: ${currentMcVersion()}` : 'Set up JustPlay first.';
  const quickSelect = $('quickVersionSelect');
  if (entry && entry.kind === 'vanilla' && entry.type === 'release' && [...quickSelect.options].some(o => o.value === entry.id)) quickSelect.value = entry.id;
}

function itemsForFilter() {
  if (!catalog) return [];
  if (activeFilter === 'release') return catalog.release || [];
  if (activeFilter === 'snapshot') return catalog.snapshot || [];
  if (activeFilter === 'legacy') return catalog.legacy || [];
  if (activeFilter === 'forge') return catalog.forge || [];
  if (activeFilter === 'fabric') return catalog.fabric || [];
  if (activeFilter === 'optifine') return catalog.optifine || [];
  if (activeFilter === 'installed') {
    const vanilla = [...(catalog.release || []), ...(catalog.snapshot || []), ...(catalog.legacy || [])].filter(v => v.installed);
    return [...(catalog.installed || []), ...vanilla].sort((a, b) => String(b.mcVersion || b.id).localeCompare(String(a.mcVersion || a.id), undefined, { numeric: true }));
  }
  return catalog.release || [];
}

function renderVersionList() {
  const list = $('versionList');
  let entries = itemsForFilter();
  if (searchTerm) {
    const needle = searchTerm.toLowerCase();
    entries = entries.filter(v => `${v.label || ''} ${v.id || ''} ${v.mcVersion || ''} ${v.loaderVersion || ''} ${v.kind || ''} ${v.type || ''}`.toLowerCase().includes(needle));
  }
  $('catalogResultCount').textContent = `${entries.length.toLocaleString()} builds`;
  visibleEntries = entries.slice(0, 500);
  if (!visibleEntries.length) {
    list.innerHTML = `<div class="empty-state">${activeFilter === 'installed' ? 'No installed profiles found yet. Install a vanilla version or add a loader with its official installer.' : 'No matching versions. Try a different search.'}</div>`;
    return;
  }
  list.innerHTML = visibleEntries.map((entry, index) => {
    const selected = selectedEntry && entry.id === selectedEntry.id && entry.kind === selectedEntry.kind;
    const kind = entryKindLabel(entry).toLowerCase();
    const chipClass = ['release','snapshot','forge','fabric','optifine'].includes(kind) ? kind : '';
    const date = entry.releaseTime ? new Date(entry.releaseTime).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : (entry.kind?.startsWith('installed-') ? 'Local profile' : (entry.kind === 'forge' ? `MC ${entry.mcVersion}` : 'Official catalog'));
    const itemLabel = entry.label || entry.id;
    return `<button class="version-row ${selected ? 'active' : ''}" role="listitem" data-entry-index="${index}" aria-pressed="${!!selected}">
      <span class="version-mini">${esc((entry.mcVersion || entry.id || 'JP').slice(0, 4))}</span>
      <span class="version-row-main"><strong>${esc(itemLabel)}</strong><span>${esc(date)}${entry.kind === 'forge' ? ` · Minecraft ${esc(entry.mcVersion)}` : ''}</span></span>
      <span class="version-row-side"><span class="type-chip ${chipClass}">${esc(entryKindLabel(entry))}</span>${isEntryInstalled(entry) ? '<span class="installed-check" title="Installed">✓</span>' : ''}</span>
    </button>`;
  }).join('') + (entries.length > visibleEntries.length ? `<div class="empty-state">Showing the first ${visibleEntries.length} matches. Use search to narrow the catalog.</div>` : '');
}

function selectEntry(entry, scroll = false) {
  if (!entry) return;
  selectedEntry = entry;
  updateSelectedDetail();
  renderVersionList();
  if (scroll) goTo('versions');
}

function populateQuickSelect() {
  if (!catalog) return;
  const select = $('quickVersionSelect');
  const releases = (catalog.release || []).slice(0, 30);
  select.innerHTML = releases.map(v => `<option value="${esc(v.id)}">${esc(v.id)}</option>`).join('');
  if (catalog.latest?.release && releases.some(v => v.id === catalog.latest.release)) select.value = catalog.latest.release;
  const chosen = releases.find(v => v.id === select.value) || releases[0];
  if (chosen) selectEntry(chosen);
}

function renderCounts() {
  if (!catalog) return;
  $('versionCount').textContent = (catalog.release?.length || 0).toLocaleString();
  $('countRelease').textContent = (catalog.release?.length || 0).toLocaleString();
  $('countSnapshot').textContent = (catalog.snapshot?.length || 0).toLocaleString();
  $('countLegacy').textContent = (catalog.legacy?.length || 0).toLocaleString();
  $('countForge').textContent = (catalog.forge?.length || 0).toLocaleString();
  $('countFabric').textContent = (catalog.fabric?.length || 0).toLocaleString();
  $('countOptifine').textContent = (catalog.optifine?.length || 0).toLocaleString();
  const vanillaInstalled = [...(catalog.release || []), ...(catalog.snapshot || []), ...(catalog.legacy || [])].filter(v => v.installed).length;
  $('countInstalled').textContent = ((catalog.installed?.length || 0) + vanillaInstalled).toLocaleString();
}

async function refreshCatalog({ silent = false } = {}) {
  if (!silent) {
    $('versionList').innerHTML = '<div class="empty-state">Refreshing from official version sources…</div>';
  }
  try {
    catalog = await api.listVersions();
    renderCounts();
    populateQuickSelect();
    renderVersionList();
    if (selectedEntry) {
      const sameCategory = itemsForFilter().find(v => v.id === selectedEntry.id && v.kind === selectedEntry.kind);
      if (sameCategory) selectedEntry = sameCategory;
    }
    updateSelectedDetail();
    if (!silent) showToast('Version catalog refreshed from official sources.');
  } catch (error) {
    $('versionList').innerHTML = `<div class="empty-state">${esc(error.message || 'Could not load versions.')}<br><br>Check your network and try Refresh list.</div>`;
    if (!silent) showToast(error.message || 'Could not refresh versions.', 'error');
  }
}

function renderSettings() {
  if (!appState) return;
  $('settingsRootPath').textContent = appState.rootPath || 'Not set up yet';
  $('settingsAccountName').textContent = appState.accountName || 'Not signed in';
  $('localAccountCurrent').textContent = appState.localAccountName || 'Not signed in this session';
  $('signOutLocalAccountBtn').hidden = !appState.localAccountName;
  $('ramSelect').value = appState.maxRam || '4G';
  renderSkinPreview();
  $('diskSummary').innerHTML = appState.rootPath
    ? `<span class="status-dot"></span>Created on ${esc(appState.storageDrive || 'your selected drive')}. New profile data stays under this JustPlay folder.`
    : '<span class="status-dot"></span>Storage drive will be selected during setup.';
}

function renderHeader() {
  if (!appState) return;
  const name = appState.accountName || appState.localAccountName || appState.displayName || 'New player';
  $('sidebarPlayerName').textContent = name;
  $('avatarGlyph').textContent = (name.trim()[0] || 'J').toUpperCase();
  $('accountStatus').textContent = appState.accountName ? 'Minecraft connected' : appState.localAccountName ? 'JustPlay account' : 'Local display profile';
  $('signInLabel').textContent = appState.accountName ? appState.accountName : 'Sign in with Microsoft';
  $('settingsSignInBtn').textContent = appState.accountName ? 'Connected' : 'Sign in';
  $('signOutBtn').classList.toggle('hidden', !appState.accountName);
  $('rootPathButton').textContent = appState.rootPath || 'Not set up yet';
  $('settingsRootPath').textContent = appState.rootPath || 'Not set up yet';
}

function setProgress({ title = 'Preparing Minecraft…', message = 'Getting things ready.', progress = null } = {}) {
  $('progressOverlay').hidden = false;
  $('progressTitle').textContent = title;
  $('progressMessage').textContent = message;
  if (progress !== null && Number.isFinite(Number(progress))) lastProgress = Math.max(lastProgress, Math.min(100, Number(progress)));
  $('progressBar').style.width = `${lastProgress}%`;
  $('progressPercent').textContent = `${Math.round(lastProgress)}%`;
}

function hideProgress() {
  $('progressOverlay').hidden = true;
  lastProgress = 0;
  $('progressBar').style.width = '0%';
}

async function launchSelected(mode = 'online') {
  if (!selectedEntry) { showToast('Choose a version first.'); goTo('versions'); return; }
  if (!appState?.setupComplete) { $('setupOverlay').hidden = false; return; }
  if (mode === 'cached' && !appState?.cachedSessionAvailable) { showToast('Sign in with Microsoft successfully once while online to enable saved-session play.', 'error'); return; }
  if (mode !== 'cached' && !appState.accountName) {
    showToast('Sign in with Microsoft before launching Minecraft.');
    await signInFlow();
    if (!appState.accountName) return;
  }
  const entry = { ...selectedEntry, mcVersion: selectedEntry.mcVersion || selectedEntry.id };
  if (entry.kind === 'optifine' || entry.kind === 'optifine-site') {
    try { await api.openOfficial('optifine'); showToast('Follow the official OptiFine installer steps, then choose the profile under Installed.'); } catch (e) { showToast(e.message || 'Could not open OptiFine.', 'error'); }
    return;
  }
  lastProgress = 1;
  setProgress({ title: entry.kind === 'forge' ? 'Preparing Forge…' : entry.kind === 'fabric' ? (isEntryInstalled(entry) ? 'Launching Fabric…' : 'Installing Fabric…') : (isEntryInstalled(entry) ? 'Launching Minecraft…' : 'Installing Minecraft…'), message: entry.kind === 'forge' ? `Preparing Forge for ${entry.mcVersion}` : entry.kind === 'fabric' ? `Preparing Fabric for ${entry.mcVersion}` : `Preparing ${entry.id}`, progress: 1 });
  try {
    const result = await api.launch(entry, mode);
    hideProgress();
    if (result?.external) { showToast(result.message || 'Opened the official installer page.'); return; }
    if (result?.started) {
      showToast(mode === 'cached' ? 'Starting this already-installed profile with your recent saved Minecraft session. Full offline operation still depends on local game files being complete.' : 'Minecraft is starting. This profile is ready to launch again from JustPlay.');
      await refreshCatalog({ silent: true });
      if (entry.kind === 'forge' || entry.kind === 'fabric') {
        await refreshCatalog({ silent: true });
        const installed = (catalog?.installed || []).find(v => v.kind === (entry.kind === 'forge' ? 'installed-forge' : 'installed-fabric') && v.mcVersion === entry.mcVersion);
        if (installed) selectEntry(installed);
      }
    }
  } catch (error) {
    hideProgress();
    showToast(error.message || 'Minecraft could not start.', 'error', 6500);
  }
}

async function signInFlow() {
  if (appState?.accountName) { showToast(`Signed in as ${appState.accountName}.`); return; }
  $('signInBtn').disabled = true;
  $('signInLabel').textContent = 'Opening Microsoft sign-in…';
  showToast('Continue in the Microsoft sign-in window. JustPlay does not collect your password.', 'normal', 6000);
  try {
    const result = await api.signIn();
    appState = await api.getState();
    renderHeader(); renderSettings(); updateSelectedDetail();
    showToast(`Welcome${result.accountName ? `, ${result.accountName}` : ''}!`);
  } catch (error) {
    showToast(error.message || 'Microsoft sign-in did not complete.', 'error', 7000);
  } finally {
    $('signInBtn').disabled = false;
    $('signInLabel').textContent = appState?.accountName || 'Sign in with Microsoft';
  }
}

async function refreshAssets(kind) {
  const target = kind === 'mods' ? 'modsFileList' : 'packsFileList';
  const node = $(target);
  if (!appState?.setupComplete) { node.innerHTML = '<div class="empty-state">Set up JustPlay before managing files.</div>'; return; }
  node.innerHTML = '<div class="empty-state">Looking for files…</div>';
  try {
    const files = await api.listFiles(kind, currentMcVersion());
    if (!files.length) { node.innerHTML = `<div class="empty-state">No ${kind === 'mods' ? 'mods' : 'resource packs'} listed for this profile yet.<br>Add a file above to get started.</div>`; return; }
    node.innerHTML = files.map(file => `<div class="asset-row"><div class="asset-name"><span class="asset-icon">${kind === 'mods' ? '✣' : '▧'}</span><span><strong title="${esc(file.name)}">${esc(file.name)}</strong><small>${esc(file.modified?.slice(0, 10) || '')}</small></span></div><span class="asset-meta">${readableSize(file.size)}</span><span class="asset-meta">${file.folderType === 'shared' ? 'Shared folder' : 'This profile'}</span><button class="asset-delete" data-remove-kind="${kind}" data-remove-name="${esc(file.name)}" data-remove-folder="${file.folderType}">Remove</button></div>`).join('');
  } catch (error) {
    node.innerHTML = `<div class="empty-state">${esc(error.message || 'Could not list files.')}</div>`;
  }
}

async function addFiles(kind) {
  if (!appState?.setupComplete) { showToast('Set up JustPlay first.'); return; }
  try {
    const result = await api.addFiles(kind, currentMcVersion());
    if (result.cancelled) return;
    showToast(result.count ? `Added ${result.count} file${result.count === 1 ? '' : 's'} to your library.` : 'No supported files were added. Check the file types.', result.count ? 'normal' : 'error');
    await refreshAssets(kind);
  } catch (error) { showToast(error.message || 'Could not add files.', 'error'); }
}

async function openFolder(target) {
  if (!appState?.setupComplete) { showToast('Set up JustPlay first.'); return; }
  try { await api.openFolder(target, currentMcVersion()); } catch (error) { showToast(error.message || 'Could not open folder.', 'error'); }
}

async function setupSubmit(event) {
  event.preventDefault();
  $('setupError').hidden = true;
  $('setupSubmitBtn').disabled = true;
  $('setupSubmitBtn').innerHTML = 'Creating your folders…';
  try {
    const result = await api.setup($('setupName').value);
    appState = result.state;
    renderHeader(); renderSettings();
    $('setupOverlay').hidden = true;
    showToast(`JustPlay folders created on ${result.selectedDrive}.`);
    await refreshCatalog({ silent: true });
    updateSelectedDetail();
  } catch (error) {
    $('setupError').textContent = error.message || 'Setup failed. Check disk permissions and try again.';
    $('setupError').hidden = false;
  } finally {
    $('setupSubmitBtn').disabled = false;
    $('setupSubmitBtn').innerHTML = 'Set up JustPlay <span>→</span>';
  }
}

async function previewDiskChoice() {
  try {
    const disks = await api.getDisks();
    const best = disks[0];
    $('setupDiskPreview').textContent = best ? `${best.id} has the most free space (${best.free}) and will be tried first.` : 'A writable folder in your user profile will be used if drive scanning is unavailable.';
  } catch {
    $('setupDiskPreview').textContent = 'The app will choose the best writable location automatically.';
  }
}

function bindEvents() {
  document.querySelectorAll('[data-page]').forEach(el => el.addEventListener('click', () => goTo(el.dataset.page)));
  document.querySelectorAll('[data-open-folder]').forEach(el => el.addEventListener('click', () => openFolder(el.dataset.openFolder)));
  $('accountGateForm').addEventListener('submit', event => {
    event.preventDefault();
    submitAccountGate('sign-in');
  });
  $('gateCreateBtn').addEventListener('click', () => submitAccountGate('create'));
  $('gateGuestBtn').addEventListener('click', () => enterLauncher('guest'));

  $('signInBtn').addEventListener('click', signInFlow);
  $('quickOfflineBtn').addEventListener('click', () => launchSelected('cached'));
  $('detailOfflineBtn').addEventListener('click', () => launchSelected('cached'));
  $('detectJavaBtn').addEventListener('click', () => refreshJavaRuntimes(true));
  $('javaRuntimeSelect').addEventListener('change', async event => {
    try {
      const result = await api.setJavaRuntime(event.target.value);
      appState = result.state || await api.getState();
      const selected = javaRuntimes.find(item => item.path === appState.javaPath);
      $('javaRuntimeCurrent').textContent = selected ? `Java ${selected.major} · ${selected.path}` : 'Automatic selection by Minecraft version';
      $('javaRuntimeFeedback').textContent = selected ? `Saved Java ${selected.major} for runtime selection. Compatibility is checked again for every selected Minecraft version.` : 'Java will be automatically selected for the game version when you launch it.';
      showToast('Java runtime preference saved.');
      updateSelectedDetail();
    } catch (error) {
      showToast(error.message || 'Could not save Java runtime.', 'error');
      await refreshJavaRuntimes(false);
    }
  });
  $('syncSkinBtn').addEventListener('click', async () => {
    const button = $('syncSkinBtn');
    button.disabled = true;
    $('skinSyncFeedback').textContent = 'Connecting to the official Minecraft profile service…';
    try {
      const result = await api.syncSkin();
      appState = result.state || await api.getState();
      renderSkinPreview();
      renderHeader();
      $('skinSyncFeedback').textContent = `Synced ${result.skin.playerName}’s active skin texture from Minecraft.`;
      showToast('Minecraft skin synced.');
    } catch (error) {
      $('skinSyncFeedback').textContent = error.message || 'Could not sync your skin.';
      showToast(error.message || 'Could not sync your skin.', 'error');
    } finally {
      button.disabled = false;
    }
  });
  $('settingsSignInBtn').addEventListener('click', signInFlow);
  $('checkUpdatesBtn').addEventListener('click', async () => {
    const button = $('checkUpdatesBtn');
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const state = await api.checkForUpdates();
      renderUpdateStatus(state);
      if (state.status === 'available') {
        showToast(`JustPlay ${state.version} is available. Use the update banner to download it.`);
      } else if (state.status === 'not-available') {
        showToast(`You're up to date. Current version: ${state.currentVersion || 'installed'}.`);
      } else {
        showToast(state.message || 'Could not check for updates.', 'error');
      }
    } catch (error) {
      showToast(error.message || 'Could not check for updates.', 'error');
    } finally {
      button.disabled = false;
      button.innerHTML = '<span aria-hidden="true">↻</span> Updates';
    }
  });
  $('updatePrimaryBtn').addEventListener('click', handleUpdateAction);
  $('updateDismissBtn').addEventListener('click', () => { $('updateBanner').hidden = true; });
  api.onUpdateStatus(renderUpdateStatus);

  $('createLocalAccountBtn').addEventListener('click', async () => {
    const username = $('justplayUsername').value;
    const password = $('justplayPassword').value;
    try {
      const result = await api.createLocalAccount(username, password);
      appState = result.state || await api.getState();
      $('justplayPassword').value = '';
      $('localAccountFeedback').textContent = `Local JustPlay account created and signed in as ${result.localAccountName}.`;
      renderHeader(); renderSettings();
      showToast('JustPlay local account created.');
    } catch (error) {
      $('localAccountFeedback').textContent = error.message || 'Could not create this account.';
      showToast(error.message || 'Could not create this account.', 'error');
    }
  });
  $('justplayAccountForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const result = await api.signInLocalAccount($('justplayUsername').value, $('justplayPassword').value);
      appState = result.state || await api.getState();
      $('justplayPassword').value = '';
      $('localAccountFeedback').textContent = `Signed in as ${result.localAccountName} on this PC.`;
      renderHeader(); renderSettings();
      showToast(`Signed in to JustPlay as ${result.localAccountName}.`);
    } catch (error) {
      $('localAccountFeedback').textContent = error.message || 'Could not sign in.';
      showToast(error.message || 'Could not sign in.', 'error');
    }
  });
  $('signOutLocalAccountBtn').addEventListener('click', async () => {
    try {
      const result = await api.signOutLocalAccount();
      appState = result.state || await api.getState();
      $('localAccountFeedback').textContent = 'Signed out of the local JustPlay account.';
      renderHeader(); renderSettings();
      showToast('Signed out of the local JustPlay account.');
    } catch (error) {
      showToast(error.message || 'Could not sign out.', 'error');
    }
  });
  $('docsSignInBtn').addEventListener('click', signInFlow);
  $('signOutBtn').addEventListener('click', async () => {
    try { await api.signOut(); appState = await api.getState(); renderHeader(); renderSettings(); updateSelectedDetail(); showToast('Signed out of this JustPlay session.'); }
    catch (e) { showToast(e.message || 'Could not sign out.', 'error'); }
  });
  $('openRootBtn').addEventListener('click', () => openFolder('root'));
  $('rootPathButton').addEventListener('click', () => openFolder('root'));
  $('settingsOpenRoot').addEventListener('click', () => openFolder('root'));
  $('settingsOpenGame').addEventListener('click', () => openFolder('game'));
  $('detailOpenFolderBtn').addEventListener('click', () => openFolder('instance'));
  $('quickLaunchBtn').addEventListener('click', launchSelected);
  $('detailActionBtn').addEventListener('click', launchSelected);
  $('quickVersionSelect').addEventListener('change', event => {
    const entry = (catalog?.release || []).find(v => v.id === event.target.value);
    if (entry) selectEntry(entry);
  });
  document.querySelectorAll('.catalog-tab').forEach(button => button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll('.catalog-tab').forEach(tab => tab.classList.toggle('active', tab === button));
    renderVersionList();
  }));
  $('versionSearch').addEventListener('input', event => { searchTerm = event.target.value.trim(); renderVersionList(); });
  $('versionList').addEventListener('click', event => {
    const row = event.target.closest('[data-entry-index]');
    if (!row) return;
    const entry = visibleEntries[Number(row.dataset.entryIndex)];
    if (entry) selectEntry(entry);
  });
  $('refreshVersionsBtn').addEventListener('click', async () => { catalog = null; await refreshCatalog(); });
  $('addModBtn').addEventListener('click', () => addFiles('mods'));
  $('addPackBtn').addEventListener('click', () => addFiles('resourcepacks'));
  $('openInstanceModsBtn').addEventListener('click', () => openFolder('instance'));
  $('modsFileList').addEventListener('click', handleRemoveFile);
  $('packsFileList').addEventListener('click', handleRemoveFile);
  $('ramSelect').addEventListener('change', async event => {
    try { await api.setRam(event.target.value); appState = await api.getState(); renderSettings(); $('ramSaveState').textContent = `Saved: ${event.target.value} maximum memory for future launches.`; showToast('Memory preference saved.'); }
    catch (error) { showToast(error.message || 'Could not save memory preference.', 'error'); }
  });
  $('setupForm').addEventListener('submit', setupSubmit);
  $('openForgeSource').addEventListener('click', () => api.openOfficial('forge').catch(e => showToast(e.message, 'error')));
  $('openFabricSource').addEventListener('click', () => api.openOfficial('fabric').catch(e => showToast(e.message, 'error')));
  $('openOptifineSource').addEventListener('click', () => api.openOfficial('optifine').catch(e => showToast(e.message, 'error')));
  $('docsForgeBtn').addEventListener('click', () => api.openOfficial('forge').catch(e => showToast(e.message, 'error')));
  $('docsOptifineBtn').addEventListener('click', () => api.openOfficial('optifine').catch(e => showToast(e.message, 'error')));
  $('docsJavaBtn').addEventListener('click', () => api.openOfficial('java').catch(e => showToast(e.message, 'error')));
  $('toastClose').addEventListener('click', () => $('messageToast').classList.remove('visible'));
  api.onMinecraftStatus(status => {
    if (!status) return;
    if (['progress', 'installing', 'downloading-forge', 'installing-fabric'].includes(status.state)) {
      const title = status.state === 'downloading-forge' ? 'Downloading Forge installer…' : status.state === 'installing-fabric' ? 'Installing Fabric Loader…' : status.state === 'installing' ? 'Installing game files…' : 'Preparing Minecraft…';
      setProgress({ title, message: status.message || 'Preparing files…', progress: status.progress ?? null });
    } else if (status.state === 'ready') {
      $('progressMessage').textContent = status.message || 'Minecraft started.';
      hideProgress();
    } else if (status.state === 'closed') {
      hideProgress();
      showToast(status.message || 'Minecraft closed.', status.code === 0 ? 'normal' : 'error');
    } else if (status.state === 'error') {
      hideProgress();
      showToast(status.message || 'Minecraft encountered an error.', 'error', 7000);
    }
  });
}

async function handleRemoveFile(event) {
  const button = event.target.closest('[data-remove-name]');
  if (!button) return;
  const kind = button.dataset.removeKind;
  const name = button.dataset.removeName;
  const folderType = button.dataset.removeFolder;
  if (!window.confirm(`Remove “${name}” from ${folderType === 'shared' ? 'the shared folder' : 'this profile'}?`)) return;
  try {
    await api.removeFile(kind, currentMcVersion(), name, folderType);
    showToast(`Removed ${name}.`);
    await refreshAssets(kind);
  } catch (error) { showToast(error.message || 'Could not remove file.', 'error'); }
}

async function init() {
  bindEvents();
  try {
    renderUpdateStatus(await api.getUpdateStatus());
  } catch { /* Update checks are not available in a development launch. */ }
  try {
    appState = await api.getState();
    renderHeader(); renderSettings();
    refreshJavaRuntimes(false);
    // Every app launch starts at the JustPlay account gate. A guest may continue without
    // creating a local account; gameplay authentication remains separate.
    $('setupOverlay').hidden = true;
    $('localLoginOverlay').hidden = false;
    if (!appState.setupComplete) previewDiskChoice();
  } catch (error) { showToast(error.message || 'Could not read JustPlay settings.', 'error'); }
  await refreshCatalog({ silent: true });
}

init();
