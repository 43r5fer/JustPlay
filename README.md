# Flock — your people, in one place

Flock is a cross-platform messenger with friend codes, real-time conversations, media sharing, group roles and 24-hour moments. The same web UI runs in the Windows Electron app, Android Capacitor wrapper and installable browser PWA.

## Current features

- Supabase Auth email/password accounts with username, password confirmation, optional email confirmation, password recovery and sign-out.
- Unique 10-digit friend codes, friend requests, accepted friends and friend lists.
- Real-time direct and group conversations.
- Grey double ticks for sent messages, changing to green when read.
- Edit/delete your own messages, replies, emoji reactions and YouTube video links.
- Photo/video/file uploads, voice notes and recorded video notes.
- Groups with owner/admin/co-admin/member roles.
- 24-hour text/photo/video statuses.
- Editable display name, profile photo, bio and synced photo/video chat wallpaper.
- Private Supabase Storage bucket and row-level data access policies.
- Windows installer, Android APK, conditional Play Store App Bundle, and installable PWA.
- Desktop auto-updates through electron-updater. Android checks Google Play in-app updates first and falls back to the public release feed when needed.

## Downloads

- **Windows setup:** https://github.com/43r5fer/JustPlay/releases/latest/download/Flock-Setup.exe
- **Android APK:** https://github.com/43r5fer/JustPlay/releases/latest/download/Flock.apk
- **Play Store App Bundle (only on signed releases):** see the Assets section of the [latest release](https://github.com/43r5fer/JustPlay/releases/latest)
- **Web app:** https://43r5fer.github.io/JustPlay/app/
- **Website:** https://43r5fer.github.io/JustPlay/
- **Source repository:** https://github.com/43r5fer/JustPlay

A debug APK is for testing. It is not a Play Store submission build and does not guarantee in-place upgrade compatibility with other debug APKs. The Play Store upload is a **signed AAB**, built only when the protected release-signing secrets are configured.

## Windows auto-updates

The packaged Windows app uses electron-updater. When a newer latest.yml is published in a GitHub Release, the app displays a prompt. Clicking **Download update** downloads the installer update; after download, Flock presents **Restart and update**. The updater does not replace user cloud data because account and messages live in Supabase.

## Android auto-updates

Android checks Google Play's official in-app update API first. When Play reports an update, the app offers a flexible or immediate update flow and lets Google Play handle the signed install. This requires the app to be installed from a Play testing/production track, and an update must be available for that account/device.

For a newer GitHub release:
- A stable release-signed APK can be downloaded by the user, followed by Android's own approval/installation confirmation.
- A debug/test build opens the release page rather than promising an in-place update with a mismatched signing certificate.
- Once Flock is published on Google Play, set playStoreUrl in src/flock-config.js to its real listing URL. The update code also detects installations whose installer is com.android.vending and routes them to the store.
- Android intentionally does not silently install an external APK without Android's user confirmation. For Play-installed apps, the official Google Play update flow is the preferred route.

## Google Play distribution: protected signing setup

Google Play requires new apps and app updates to target **Android 16 / API 36 or higher** from August 31, 2026. Flock's Android build script pins both compile/target SDK to 36. See the official [Google Play target API requirement](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en).

To build a Play Store App Bundle, provide an **upload keystore**. Do not upload the keystore or passwords to Git. The workflow reads these GitHub repository Actions secrets:

- ANDROID_KEYSTORE_BASE64 — base64 of the JKS/PKCS12 upload keystore file.
- ANDROID_KEYSTORE_PASSWORD — the keystore password.
- ANDROID_KEY_ALIAS — alias inside the keystore.
- ANDROID_KEY_PASSWORD — password for the key alias.

Create a new upload key locally if you do not already have one. On a machine with Java's keytool:

~~~bash
keytool -genkeypair -v -keystore flock-upload.jks -alias flock-upload -keyalg RSA -keysize 2048 -validity 10000
~~~

On Windows PowerShell, encode the keystore file for the ANDROID_KEYSTORE_BASE64 secret:

~~~powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("flock-upload.jks")) | Set-Content -NoNewline "flock-upload-base64.txt"
~~~

Open the [repository Actions secrets settings](https://github.com/43r5fer/JustPlay/settings/secrets/actions) and add those four secret values. Keep the .jks file and its passwords somewhere secure; never commit them to the repository. Then run the release workflow again with the signing secrets in place. The job will upload:
- Flock-Play-Store.aab — signed App Bundle for Play Console.
- Flock.apk — APK signed with the same upload key for direct, user-approved installs.
- Flock-debug.apk — debug build for testing.

The workflow will still build a test APK if signing secrets are missing, but it will skip the Play Store AAB. An AAB cannot be made Play-Store-ready without a signing key. Google Play App Signing is recommended; the upload key signs the AAB you submit, while Google Play manages the key used for APKs delivered to users. Follow [Google Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en).

Before publishing, create the app in Play Console, upload the signed AAB to internal testing first, complete the store listing, privacy policy, Data safety, content rating, app access and other required declarations, then submit for review. The repository workflow builds artifacts; it does not submit the app to your personal Play Console account automatically.

## Configure Supabase

The client config is in src/flock-config.js and contains the project URL plus a **publishable key**. These are intended for clients; never put a Supabase service_role key or database secret in the frontend.

The Flock schema is documented in supabase/setup.sql; the live project uses Flock-specific flock_* tables and a private flock-media bucket. RLS policies scope access to the signed-in user, friends and conversation memberships. Passwords are handled by Supabase Auth; Flock does not store password hashes itself.

In Supabase Auth settings:
1. Enable Email + Password in Authentication > Sign In / Providers.
2. Choose whether email confirmation is required.
3. Configure the production app URL and allowed password-reset redirects under Authentication > URL Configuration.
4. Keep RLS enabled. Never ship a service-role key to an Electron, web or Android client.

## Run Windows from source

Install Node.js 22+:

~~~bat
npm install
npm run check
npm run dev
~~~

Build Windows setup:

~~~bat
npm run dist:win
node scripts/write-update-manifest.cjs
~~~

Outputs: dist/Flock-Setup.exe and dist/latest.yml.

## Build Android from source

Install Node.js 22+, Android Studio/SDK API 36, and JDK 21. Then:

~~~bat
npm install
npm run mobile:prepare
npx cap add android
node scripts/patch-android-manifest.mjs
npx cap sync android
node scripts/patch-android-manifest.mjs
node scripts/patch-android-release.mjs
~~~

Open the generated android folder in Android Studio, or build a debug APK with cd android then gradlew.bat assembleDebug. For a signed Play Store bundle, set the same signing environment variables the GitHub workflow uses before running node scripts/patch-android-release.mjs, then run gradlew.bat bundleRelease assembleRelease.

## PWA and privacy notes

- The PWA is served from /app/. Supported browsers can offer **Install app / Add to Home Screen**. Messaging/uploads require internet.
- Microphone/camera access is required for voice and video notes.
- Flock has not been audited as an end-to-end encrypted messenger. Data access is scoped using Supabase Auth, RLS and private storage; do not market it as E2EE.
- Test email confirmation, recovery, group permissions, receipts and media recording on real devices before relying on it for important communication.

## Source map

- src/index.html, src/styles.css — responsive UI
- src/renderer.js — Auth, messaging, realtime, media, statuses and update prompts
- src/flock-config.js, src/flock-runtime.js — public config and runtime version
- electron/main.cjs, electron/preload.cjs — Windows shell and auto-updater
- scripts/patch-android-release.mjs — Android package version, API 36, signing and Google Play in-app update bridge
- supabase/setup.sql — reproducible schema/RLS/storage policies
- .github/workflows/build-flock.yml — Windows, Android and Play Store build pipeline
- .github/workflows/deploy-pages.yml — landing page and PWA deployment

Flock is an independent community messenger.
