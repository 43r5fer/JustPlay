# Flock release checklist

## Current state
- [x] Flock UI and responsive layouts committed under src/
- [x] Supabase Auth/client config created
- [x] Flock-specific tables created in the connected Supabase project with RLS enabled
- [x] Private flock-media bucket configured
- [x] Supabase Realtime publication includes seven Flock tables
- [x] Windows setup metadata script uses Flock-Setup.exe
- [x] Capacitor Android config and CI pipeline created
- [x] Installable PWA manifest, icon and service worker created
- [x] Build and verify the combined Windows/Android v1.0.0 workflow (GitHub Actions success)
- [ ] Install the APK on a real Android device
- [ ] Test email confirmation and password recovery flows using configured Supabase Auth settings
- [ ] Test friend requests, direct messages, realtime sent/read ticks, message edit/delete, media uploads and status expiry
- [ ] Test voice/video recording permission prompts on Windows and Android
- [ ] Sign the Android package with a dedicated release keystore before Play Store/public production distribution

## Release assets
- Windows setup: https://github.com/43r5fer/JustPlay/releases/latest/download/Flock-Setup.exe
- Release page: https://github.com/43r5fer/JustPlay/releases/tag/flock-v1.0.0
- Source ZIP: https://github.com/43r5fer/JustPlay/archive/refs/tags/flock-v1.0.0.zip
- Android APK: https://github.com/43r5fer/JustPlay/releases/latest/download/Flock.apk
- Web app: https://43r5fer.github.io/JustPlay/app/
- Website: https://43r5fer.github.io/JustPlay/
