import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const configText = await readFile(new URL('../src/flock-config.js', import.meta.url), 'utf8');
const supabaseUrl = configText.match(/supabaseUrl:\s*'([^']+)'/)?.[1];
const publishableKey = configText.match(/supabasePublishableKey:\s*'([^']+)'/)?.[1];
const bucket = configText.match(/storageBucket:\s*'([^']+)'/)?.[1] || 'flock-media';
if (!supabaseUrl || !publishableKey) throw new Error('Flock public API configuration is missing.');

const username = 'qa' + Date.now().toString(36) + randomBytes(3).toString('hex');
const password = 'Test-' + randomBytes(18).toString('base64url');
let profileId = '';
let secondProfileId = '';
let tokens = [];
let uploadedPath = '';
const baseHeaders = { apikey: publishableKey, Authorization: 'Bearer ' + publishableKey };

async function functionRequest(action, body = {}, token = '') {
  const headers = { ...baseHeaders, 'Content-Type': 'application/json' };
  if (token) headers['x-flock-session'] = token;
  const response = await fetch(supabaseUrl + '/functions/v1/flock-auth', {
    method: 'POST', headers, cache: 'no-store', body: JSON.stringify({ action, ...body }),
  });
  let result = {};
  try { result = await response.json(); } catch {}
  return { response, result };
}
async function dataRequest(path, { method = 'GET', token = '', body, contentType = 'application/json', extraHeaders = {} } = {}) {
  const headers = { ...baseHeaders, ...extraHeaders };
  if (token) headers['x-flock-session'] = token;
  if (contentType) headers['Content-Type'] = contentType;
  const response = await fetch(supabaseUrl + path, {
    method, headers, cache: 'no-store',
    body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body)),
  });
  let result = null;
  const text = await response.text();
  try { result = text ? JSON.parse(text) : null; } catch { result = text; }
  return { response, result };
}
async function ensureOk(call, what) {
  if (!call.response.ok) throw new Error(what + ' failed (' + call.response.status + '): ' + JSON.stringify(call.result).slice(0, 500));
}
try {
  const registration = await functionRequest('register', { username, password, displayName: username, remember: true });
  await ensureOk(registration, 'Registration');
  profileId = String(registration.result.user?.id || '');
  const friendCode = String(registration.result.user?.friend_code || '');
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) throw new Error('Registration did not return a profile ID.');
  if (!/^\d{10}$/.test(friendCode)) throw new Error('Friend code is not exactly ten digits.');
  if (!registration.result.sessionToken) throw new Error('Registration did not return a session token.');
  tokens.push(registration.result.sessionToken);

  const login = await functionRequest('login', { username, password, remember: true });
  await ensureOk(login, 'Custom username/password login');
  if (login.result.user?.id !== profileId) throw new Error('Login returned another account.');
  tokens.push(login.result.sessionToken);
  const token = login.result.sessionToken;

  const secondUsername = 'qa' + Date.now().toString(36) + randomBytes(3).toString('hex');
  const secondPassword = 'Test-' + randomBytes(18).toString('base64url');
  const registration2 = await functionRequest('register', { username: secondUsername, password: secondPassword, displayName: secondUsername, remember: true });
  await ensureOk(registration2, 'Second-account registration for friend lookup');
  secondProfileId = String(registration2.result.user?.id || '');
  const secondFriendCode = String(registration2.result.user?.friend_code || '');
  if (!/^\d{10}$/.test(secondFriendCode) || !secondProfileId || secondProfileId === profileId) throw new Error('Second profile did not receive a valid friend code.');
  tokens.push(registration2.result.sessionToken);

  const profile = await dataRequest('/rest/v1/flock_profiles?id=eq.' + encodeURIComponent(profileId) + '&select=id,username,friend_code', { token });
  await ensureOk(profile, 'Profile SELECT through RLS');
  if (!Array.isArray(profile.result) || profile.result.length !== 1 || profile.result[0].id !== profileId) {
    throw new Error('Custom session did not read its own profile through RLS.');
  }

  const anonymousRead = await dataRequest('/rest/v1/flock_profiles?id=eq.' + encodeURIComponent(profileId) + '&select=id', {});
  await ensureOk(anonymousRead, 'No-session profile privacy check');
  if (!Array.isArray(anonymousRead.result) || anonymousRead.result.length !== 0) {
    throw new Error('A request without a Flock session could read a private profile.');
  }

  const friend = await dataRequest('/rest/v1/rpc/flock_find_friend_code', {
    method: 'POST', token, body: { p_friend_code: secondFriendCode },
  });
  await ensureOk(friend, 'Friend-code RPC');
  const friendRows = Array.isArray(friend.result) ? friend.result : [friend.result];
  if (!friendRows.some(row => row && row.id === secondProfileId)) throw new Error('Friend-code RPC did not return the matching friend profile: ' + JSON.stringify(friend.result).slice(0, 500));

  uploadedPath = profileId + '/profile/smoke-' + randomBytes(6).toString('hex') + '.txt';
  const objectPath = uploadedPath.split('/').map(encodeURIComponent).join('/');
  const upload = await dataRequest('/storage/v1/object/' + encodeURIComponent(bucket) + '/' + objectPath, {
    method: 'POST', token, contentType: 'text/plain',
    extraHeaders: { 'x-upsert': 'false', 'cache-control': '3600' },
    body: new TextEncoder().encode('Flock private media smoke test.'),
  });
  await ensureOk(upload, 'Private media upload with custom session');

  const signed = await dataRequest('/storage/v1/object/sign/' + encodeURIComponent(bucket) + '/' + objectPath, {
    method: 'POST', token, body: { expiresIn: 600 },
  });
  await ensureOk(signed, 'Private media signed URL with custom session');
  if (!signed.result || !(signed.result.signedURL || signed.result.signedUrl)) throw new Error('Storage did not return a signed URL.');

  const remove = await dataRequest('/storage/v1/object/' + encodeURIComponent(bucket), {
    method: 'DELETE', token, body: { prefixes: [uploadedPath] },
  });
  await ensureOk(remove, 'Private media cleanup');
  uploadedPath = '';

  for (const sessionToken of tokens) await ensureOk(await functionRequest('logout', {}, sessionToken), 'Logout');
  const revoked = await functionRequest('session', {}, token);
  if (revoked.response.status !== 401) throw new Error('Logout did not revoke the custom session.');
  console.log('FLOCK_ACCOUNT_SMOKE=PASS');
  console.log('FRIEND_CODE_AND_LOGIN=PASS');
  console.log('PROFILE_RLS_AND_FRIEND_LOOKUP=PASS');
  console.log('PRIVATE_MEDIA_UPLOAD_AND_SIGNED_URL=PASS');
  console.log('REMEMBER_ME_AND_LOGOUT=PASS');
  console.log('SMOKE_PROFILE_ID=' + profileId);
  console.log('SMOKE_SECOND_PROFILE_ID=' + secondProfileId);
} catch (error) {
  console.error('FLOCK_DATA_API_SMOKE=FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  if (profileId) console.log('SMOKE_PROFILE_ID=' + profileId);
  if (secondProfileId) console.log('SMOKE_SECOND_PROFILE_ID=' + secondProfileId);
  if (uploadedPath) console.log('SMOKE_MEDIA_PATH=' + uploadedPath);
  process.exitCode = 1;
}
