# Flock release checklist

## v1.0.3 — custom Flock login and remembered sessions
- [x] Replaced Supabase Auth UI/API login with Flock-owned username/password sign-in and registration.
- [x] Added per-account salted PBKDF2-SHA256 hashes; raw passwords are never stored.
- [x] Added revocable, hashed session tokens with Remember me (30 days) and temporary sessions (1 day).
- [x] Added registration/sign-in/password-change rate limiting.
- [x] Deployed the flock-auth Edge Function and verified it is active.
- [x] Switched Flock database RLS identity checks to validate the x-flock-session header.
- [x] Added password-change controls to profile settings.
- [x] Removed Supabase Auth calls from the renderer.
- [x] Windows setup and Android APK builds passed in GitHub Actions.
- [x] Flock v1.0.3 release published with Flock-Setup.exe and Flock.apk.
- [x] Windows update manifest generated; desktop update prompts are enabled.
- [x] Android Google Play in-app update bridge is included.
- [x] Android compile/target SDK set to API 36.
- [ ] Configure the four Android upload-signing secrets to produce Flock-Play-Store.aab.
- [ ] Upload the signed AAB to Play Console internal testing, complete listing/Data safety/privacy forms, and submit for review.
- [ ] Install v1.0.3 APK on a real Android device and test camera/microphone, custom login, remember-me, media and update flows.
- [ ] Test two separate user accounts and verify cross-device message sync, friend requests, groups, edit/delete and read receipts.
- [ ] Add a self-service password recovery workflow (forgotten-password recovery is not implemented yet).

## Android Play Store signing secrets
Add these as repository Actions secrets at:
https://github.com/43r5fer/JustPlay/settings/secrets/actions

- ANDROID_KEYSTORE_BASE64
- ANDROID_KEYSTORE_PASSWORD
- ANDROID_KEY_ALIAS
- ANDROID_KEY_PASSWORD

The current v1.0.3 Android artifact is a debug-signed testing APK because these secrets were not configured. The GitHub release does not include a Play Store AAB yet. Do not submit the debug APK to Play Console.

## Release assets
- Windows setup: https://github.com/43r5fer/JustPlay/releases/download/flock-v1.0.3/Flock-Setup.exe
- Android testing APK: https://github.com/43r5fer/JustPlay/releases/download/flock-v1.0.3/Flock.apk
- Release page: https://github.com/43r5fer/JustPlay/releases/tag/flock-v1.0.3
- Source ZIP: https://github.com/43r5fer/JustPlay/archive/refs/tags/flock-v1.0.3.zip
- Web app: https://43r5fer.github.io/JustPlay/app/
- Website: https://43r5fer.github.io/JustPlay/
- Workflow run: https://github.com/43r5fer/JustPlay/actions/runs/38076318017
