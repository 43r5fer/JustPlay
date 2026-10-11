import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';

const configText = await readFile(new URL('../src/flock-config.js', import.meta.url), 'utf8');
const supabaseUrl = configText.match(/supabaseUrl:\s*'([^']+)'/)?.[1];
const publishableKey = configText.match(/supabasePublishableKey:\s*'([^']+)'/)?.[1];
if (!supabaseUrl || !publishableKey) throw new Error('Flock public API configuration is missing.');

const username = 'qa' + Date.now().toString(36) + randomBytes(3).toString('hex');
const password = 'Test-' + randomBytes(18).toString('base64url');
let profileId = '';
let tokens = [];

async function request(action, body = {}, token = '') {
  const headers = {
    'Content-Type': 'application/json',
    apikey: publishableKey,
    Authorization: 'Bearer ' + publishableKey,
  };
  if (token) headers['x-flock-session'] = token;
  const response = await fetch(supabaseUrl + '/functions/v1/flock-auth', {
    method: 'POST',
    headers,
    cache: 'no-store',
    body: JSON.stringify({ action, ...body }),
  });
  let result = {};
  try { result = await response.json(); } catch {}
  return { status: response.status, ok: response.ok, result };
}

try {
  const registration = await request('register', { username, password, displayName: username, remember: true });
  if (!registration.ok) throw new Error('Registration failed (' + registration.status + '): ' + (registration.result.error || 'Unknown error'));
  profileId = String(registration.result.user?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(profileId)) throw new Error('Registration did not return a profile ID.');
  if (!/^\d{10}$/.test(String(registration.result.user?.friend_code || ''))) throw new Error('New friend code is not exactly ten digits.');
  if (!registration.result.sessionToken) throw new Error('Registration did not return a session token.');
  tokens.push(registration.result.sessionToken);

  const login = await request('login', { username, password, remember: true });
  if (!login.ok) throw new Error('Login failed (' + login.status + '): ' + (login.result.error || 'Unknown error'));
  if (login.result.user?.id !== profileId) throw new Error('Login returned a different account.');
  if (!login.result.sessionToken) throw new Error('Login did not return a session token.');
  tokens.push(login.result.sessionToken);

  const session = await request('session', {}, login.result.sessionToken);
  if (!session.ok || session.result.user?.id !== profileId) throw new Error('Session restore failed.');

  for (const token of tokens) {
    const logout = await request('logout', {}, token);
    if (!logout.ok) throw new Error('Logout failed (' + logout.status + ').');
  }
  const revoked = await request('session', {}, login.result.sessionToken);
  if (revoked.status !== 401) throw new Error('Signed-out session was not revoked.');
  console.log('FLOCK_AUTH_SMOKE_TEST=PASS');
  console.log('FRIEND_CODE_VALIDATION=PASS');
  console.log('CUSTOM_LOGIN=PASS');
  console.log('REMEMBERED_SESSION_RESTORE=PASS');
  console.log('SESSION_REVOCATION=PASS');
  console.log('SMOKE_PROFILE_ID=' + profileId);
} catch (error) {
  console.error('FLOCK_AUTH_SMOKE_TEST=FAIL');
  console.error(error instanceof Error ? error.message : String(error));
  if (profileId) console.log('SMOKE_PROFILE_ID=' + profileId);
  process.exitCode = 1;
}
