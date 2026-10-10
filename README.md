# Flock — your people, in one place

Flock is a cross-platform messaging app built around friend codes, real-time conversations, media sharing, group roles and 24-hour moments. The same web UI runs in the Windows Electron app, Android Capacitor wrapper and installable browser PWA.

## Current features

The current source includes the v1.0.1 profile-privacy hotfix: profile reads are scoped and friend-code search returns only the matching profile.

- Global accounts with Supabase Auth (email + password), username and password confirmation during sign-up, email confirmation when enabled, password reset, and sign-out.
- A unique 10-digit friend code per profile, friend requests, acceptance and friend lists.
- Live direct and group conversations through Supabase Realtime.
- Grey double ticks for sent messages, changing to green when a recipient has read the message.
- Edit/delete your own messages, replies, emoji reactions and YouTube link sharing.
- Upload photos, videos, voice messages, files, recorded voice notes and recorded video notes.
- Groups with owner/admin/co-admin/member roles and controlled membership management.
- 24-hour text/photo/video statuses.
- Editable display name, profile photo, bio, and synced image/video chat background.
- Private Supabase Storage media bucket with authenticated, row-level access policies.
- Windows installer, Android APK workflow, and installable PWA/web app.

## Downloads

- **Windows setup:** https://github.com/43r5fer/JustPlay/releases/latest/download/Flock-Setup.exe
- **Android APK:** https://github.com/43r5fer/JustPlay/releases/latest/download/Flock.apk
- **Web app:** https://43r5fer.github.io/JustPlay/app/
- **Landing page and release links:** https://43r5fer.github.io/JustPlay/
- **Source repository:** https://github.com/43r5fer/JustPlay

The first Android CI artifact is a debug-signed APK for direct installation/testing. For Play Store or wider public distribution, sign the app with a dedicated release keystore and protect its credentials in repository secrets.

## Supabase configuration

Flock is already connected to the configured Supabase project. The frontend config is in src/flock-config.js and contains the project URL and a **publishable key**. These values are meant for client apps; never put a service_role key or database secret in the frontend.

The deployed schema uses its own flock_* tables and a private flock-media bucket. It does not reuse or overwrite the other app tables already in the project. RLS policies scope conversations/messages to their members, profile updates to the owner, and media access to the owner/friends/chat membership. Passwords are handled by Supabase Auth; Flock does not store password hashes itself.

Important Supabase Auth settings:
1. Enable Email + Password in Authentication > Sign In / Providers.
2. Choose whether email confirmation is required. If enabled, users must confirm their email before signing in.
3. For password-reset messages, configure the production web app URL and allowed redirects in Authentication > URL Configuration.
4. Keep RLS enabled. Never ship the service-role key to an Electron, web or Android client.

## Run the Windows app from source

Install Node.js 22 or newer, then run in the repository folder:

~~~bat
npm install
npm run check
npm run dev
~~~

Create the Windows setup executable:

~~~bat
npm run dist:win
node scripts/write-update-manifest.cjs
~~~

Outputs are dist/Flock-Setup.exe and dist/latest.yml.

## Build Android from source

Install Node.js 22+, Android Studio/Android SDK (API 36), and a compatible JDK. Then:

~~~bat
npm install
npm run mobile:prepare
npx cap add android
node scripts/patch-android-manifest.mjs
npx cap sync android
node scripts/patch-android-manifest.mjs
~~~

Open the generated android folder in Android Studio or build from a shell with the Android SDK installed:

~~~bat
cd android
gradlew.bat assembleDebug
~~~

The APK output is android/app/build/outputs/apk/debug/app-debug.apk. On Linux/macOS CI use ./gradlew assembleDebug. GitHub Actions automates a Windows setup build and an Android APK build for tags beginning with v.

## Build the web/PWA app

The same files under src/ are deployed to the /app/ path on GitHub Pages. A browser can use the app directly; supported browsers may offer **Install app** / **Add to Home Screen**. Signing into the same Flock account syncs cloud data across devices. Authenticated messaging and uploads need an internet connection.

## Privacy and limitations

- Supabase Auth stores/validates account passwords; the client only manages the Auth session.
- Message and media content is stored in the configured Supabase project. A private bucket uses signed links for media downloads.
- Browser microphone/camera permissions are required for voice and video notes.
- Flock is an early-stage project. Test sign-up/email confirmation, friend requests, realtime synchronization, media upload/recording, read receipts, group permissions and recovery flows on Windows and Android before relying on it for important conversations.
- Flock has not been audited as an end-to-end encrypted messenger; data is protected by Supabase Auth, RLS and private media access, but do not describe it as E2EE.

## Main source map

- src/index.html — desktop/mobile messaging UI
- src/styles.css — responsive UI
- src/renderer.js — Supabase Auth, profile, chat, realtime, media and status behavior
- src/flock-config.js — public Supabase project config
- src/manifest.webmanifest, src/service-worker.js — installable PWA shell
- electron/main.cjs, electron/preload.cjs — Windows wrapper and update support
- capacitor.config.json, scripts/build-mobile.mjs, scripts/patch-android-manifest.mjs — Android wrapper/build
- .github/workflows/build-flock.yml — build and release workflow
- .github/workflows/deploy-pages.yml — website/PWA deployment

Flock is an independent community messenger, not affiliated with any other messaging platform.
