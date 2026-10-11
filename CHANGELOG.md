# Flock release notes

## Live backend hotfix — October 11, 2026

- Fixed friend-code generation in the Flock registration service. The previous implementation used `Number(hex, 16)`, which JavaScript does not support, producing `NaN` instead of a valid 10-digit code.
- Deployed the corrected `Number.parseInt(hex, 16)` implementation to the live `flock-auth` Edge Function.
- Passed a live smoke test for registration, 10-digit friend code validation, username/password login, remembered-session restore, logout and session revocation. The temporary test account was deleted after verification.


## v1.0.3 — Custom Flock account system

- Replaced Supabase Auth UI/API sign-in calls with Flock-owned username/password registration, login, logout and session validation.
- Added per-user salted PBKDF2-SHA256 password hashes in a private credential table and 256-bit random, revocable device session tokens.
- Added a default-on Remember me control (30-day remembered sessions; one-day temporary sessions) so users can reopen the app without entering their password on each launch.
- Added server rate limiting for registration/sign-in and password change with revocation of other sessions.
- Updated PostgreSQL RLS identity checks to validate the x-flock-session hash; ordinary message/storage calls no longer rely on auth.uid().
- Replaced database Realtime subscriptions with short-interval polling because anonymous Data API connections do not carry a Flock session through Supabase Realtime.
- Kept the Windows automatic updater and switched Android update prompts to direct APK release downloads.

### Release notes

- A persistent Android signing key is needed for in-place updates between APK releases; configure the protected signing secrets before the first release-signed update.
- Flock isn't formally audited and doesn't claim end-to-end encryption.
- Self-service forgotten-password recovery is not enabled yet; signed-in users can change their password from profile settings.

## v1.0.2 — Android update and signing groundwork

- Added desktop update prompts, conditional Android APK signing and target API 36.

## v1.0.1 — Friend-code privacy hotfix

- Restricted profile reads and friend-code lookup to the exact friend-code query.

## v1.0.0 — Flock cross-platform messaging rebuild

- Added global profiles, direct/group chat, media, statuses, read receipts, profile backgrounds, responsive UI and release pipelines.
