# Flock — your people, in one place

Flock is a cross-platform messenger for Windows, Android and the web. Accounts use Flock's own username/password login; chat profiles, friend codes, messages, groups and media sync through the connected cloud database.

## What's included

- Custom Flock username/password registration and sign-in. No Supabase-hosted login page or Supabase Auth account is needed.
- Passwords are hashed on the server using PBKDF2-SHA256 with a random per-account salt. Raw passwords are never stored.
- A Remember me option stores a random revocable session token on the device. Remembered sessions last up to 30 days; temporary sessions last up to one day. Signing out revokes the current token.
- Account rate limiting, session revocation, change-password flow and server-validated Flock sessions.
- Unique 10-digit friend codes and friend requests.
- Cloud-synced direct and group messages, message editing/deletion, replies, reactions and read ticks.
- Photos, videos, voice messages, recorded video notes, files, YouTube sharing and 24-hour status posts.
- Profile image, display name, bio and photo/video chat wallpapers.
- Private storage, scoped row-level policies and a Flock-session identity check at the database boundary.
- Windows installer with automatic update prompts and a responsive browser PWA.
- Direct Android APK builds with update notices from the Flock GitHub release feed.

## Downloads and release

- Windows setup: https://github.com/43r5fer/JustPlay/releases/latest/download/Flock-Setup.exe
- Android APK: https://github.com/43r5fer/JustPlay/releases/latest/download/Flock.apk
- Direct-download Android APK: https://github.com/43r5fer/JustPlay/releases/latest/download/Flock.apk
- Web app: https://43r5fer.github.io/JustPlay/app/
- Landing page: https://43r5fer.github.io/JustPlay/
- Source code: https://github.com/43r5fer/JustPlay

## How custom Flock login works

1. The client sends a username/password only to the flock-auth Edge Function over HTTPS.
2. The function hashes/verifies passwords using PBKDF2-SHA256 and creates a 256-bit random session token.
3. Only the SHA-256 token hash is stored in flock_auth_sessions; the raw session token stays on the user's device.
4. Database calls include the token in x-flock-session. A private PostgreSQL helper validates it before RLS policies permit access to that user's rows.
5. Login attempts are throttled. Changing the password revokes the account's other active sessions. Signing out revokes the current session.

The Supabase publishable key in src/flock-config.js is intentionally client-visible. The service-role key remains inside Supabase Edge Function environment variables and is never embedded in the app.

## Configure the cloud database

For a fresh project, run these scripts in order in the Supabase SQL Editor:

1. supabase/setup.sql — Flock tables, groups, messages, RLS and storage.
2. supabase/custom_auth.sql — detach Flock profiles from auth.users, create custom credentials/sessions, and update RLS to validate Flock session headers.

For the connected production project, the schema and custom-auth migration have already been applied. The flock-auth Edge Function is deployed. Its service-role key is managed by Supabase, not included in the repository.

## Windows build

Requires Node.js 22+:

~~~bat
npm install
npm run check
npm run dev
npm run dist:win
node scripts/write-update-manifest.cjs
~~~

Output: dist/Flock-Setup.exe plus dist/latest.yml.

When a newer Windows release is published, the installed app detects it, prompts Download update, then prompts Restart and update when ready.

## Direct Android APK builds

Requires Node.js 22+, JDK 21, and Android SDK API 36:

~~~bat
npm install
npm run mobile:prepare
npx cap add android
node scripts/patch-android-manifest.mjs
npx cap sync android
node scripts/patch-android-manifest.mjs
node scripts/patch-android-release.mjs
~~~

The release script sets package version/versionCode and target API 36. Flock is distributed directly as an APK; no app-store account is required.

### Direct APK signing and updates

For reliable in-place APK updates, sign every APK with the same private release key. I generated a one-time signing kit for this project; keep it private and do not commit it. Open the repository [Actions secrets settings](https://github.com/43r5fer/JustPlay/settings/secrets/actions) and add these values:

- ANDROID_KEYSTORE_BASE64 — the contents of the kit's base64 text file.
- ANDROID_KEYSTORE_PASSWORD — the value in the matching password text file.
- ANDROID_KEY_ALIAS — flock-upload.
- ANDROID_KEY_PASSWORD — the value in the matching key-password text file.

The release workflow builds only Flock.apk for direct distribution; no app-store bundle is produced. If those secrets are missing, the workflow still creates a debug-signed APK that runs, but future in-place updates may require uninstalling the old APK first. The current v1.0.3 APK was built before a persistent release key was configured; migrating from it to the first release-signed APK requires a one-time uninstall/reinstall. Your cloud account and messages are stored remotely, so sign back in after reinstalling.

The GitHub project cannot use your keystore until you put these values into Actions secrets. Never share the keystore/passwords publicly.
 
## PWA, privacy and production notes

- The web app is served from /app/. Supported browsers can offer Install app / Add to Home Screen.
- Message and media sync require an internet connection.
- Microphone and camera permissions are needed for voice and video notes.
- Flock has not undergone a formal security audit and is not an end-to-end encrypted messenger. Cloud row access is restricted by custom sessions, RLS and private media controls.
- The username/password system does not yet provide self-service recovery for a forgotten password. Users should keep passwords safe; do not share them with anyone.

## Code map

- src/index.html, src/styles.css — responsive UI and Flock login screens
- src/renderer.js — custom Flock sessions, chat, media, polling sync and update prompts
- src/flock-config.js, src/flock-runtime.js — public project config and version
- supabase/functions/flock-auth/index.ts — password hashing, login, registration and sessions
- supabase/setup.sql, supabase/custom_auth.sql — schema and session-based RLS
- electron/main.cjs, electron/preload.cjs — desktop wrapper and updater
- scripts/patch-android-release.mjs — Play update bridge, API level and signing configuration
- .github/workflows/build-flock.yml — Windows/Android CI and release artifacts

Flock is an independent community messenger.
