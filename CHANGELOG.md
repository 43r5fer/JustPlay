# Flock release notes

## v1.0.0 — Flock cross-platform messaging rebuild

- Replaced the previous Roblox launcher application with **Flock**, a global account-based messenger.
- Added Supabase Auth with username metadata, password confirmation, friend codes, account recovery, and synchronized user profiles.
- Added private global tables for profiles, friendships, conversations, membership/roles, messages, receipts, statuses, status views and reactions.
- Added row-level security policies, private media bucket access and Supabase Realtime publication for the Flock schema.
- Added direct chats, groups, message edit/delete, replies, emoji reactions, read receipts, YouTube links, uploads, voice recording, video notes, statuses and profile backgrounds.
- Added an installable PWA and responsive layout, plus Capacitor configuration and CI for a Windows setup installer and Android APK.
- Kept Windows and Android user interfaces on the same src/ frontend.

### Notes

- The Android CI artifact is debug-signed for installation/testing. Public store release needs a dedicated release keystore.
- Flock is not audited as end-to-end encrypted; message content is stored in Supabase with RLS and media access controls.
- Verify email confirmation, realtime updates and camera/microphone behavior on real devices before broad distribution.

## v0.3.1 — Previous app

- Last release of the previous JustPlay Roblox launcher. This release is replaced by the Flock codebase.
