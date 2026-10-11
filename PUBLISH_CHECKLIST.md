# Flock release checklist

## Custom Flock login
- [x] Flock-owned username/password registration and sign-in (no Supabase Auth login).
- [x] Server-side PBKDF2-SHA256 hashes with per-user salts; raw passwords are never stored.
- [x] Revocable hashed sessions with Remember me (30 days) and temporary sessions (1 day).
- [x] Rate limiting for registration, login and password changes.
- [x] Deployed the Flock auth Edge Function and repaired friend-code generation using integer parsing.
- [x] Switched Flock database RLS identity checks to validated x-flock-session headers.
- [x] Added a change-password control in profile settings.

## Direct distribution
- [x] Windows setup and Android APK builds succeeded in CI.
- [x] Published v1.0.3 with Flock-Setup.exe and Flock.apk.
- [x] Windows latest.yml manifest and automatic update prompts included.
- [x] Android release-version check and direct-download update path included.
- [x] Android build workflow now focuses on APK distribution only; no Play Store AAB is produced.
- [ ] Add the generated stable Android signing key as protected repository Actions secrets.
- [ ] Build the first release-signed APK. The existing v1.0.3 APK is debug-signed and needs one uninstall/reinstall transition.
- [ ] Test login/remember-me and chat/media features on a real Windows PC and Android device.
- [ ] Test two accounts, message sync, groups, edit/delete and read receipts.

## Configure stable Android APK signing
Open:
https://github.com/43r5fer/JustPlay/settings/secrets/actions

Add four secrets from the private Flock signing kit:
- ANDROID_KEYSTORE_BASE64
- ANDROID_KEYSTORE_PASSWORD
- ANDROID_KEY_ALIAS (value: flock-upload)
- ANDROID_KEY_PASSWORD

Keep the JKS file and passwords private. The release workflow builds a normal release-signed APK when these values exist. If they are absent, it falls back to a functional debug-signed APK, but future updates might not install in-place.

## Downloads
- Windows: https://github.com/43r5fer/JustPlay/releases/latest/download/Flock-Setup.exe
- Android APK: https://github.com/43r5fer/JustPlay/releases/latest/download/Flock.apk
- Release page: https://github.com/43r5fer/JustPlay/releases/tag/flock-v1.0.3
- Web app: https://43r5fer.github.io/JustPlay/app/
- Website: https://43r5fer.github.io/JustPlay/
