# Flock release notes

## v1.0.2 — Play Store preparation and update prompts

- Added desktop update prompts that offer download and restart/install when electron-updater finds a new release.
- Added Android update detection using the release feed, plus a native Google Play in-app update bridge using flexible/immediate Play update flows.
- Routed Play Store-installed builds through Google Play when that source is detected; sideload updates use a stable release-signed APK when signing is configured.
- Added conditional protected signing for Android upload key secrets, signed release APK and signed Play Store App Bundle (Flock-Play-Store.aab).
- Pinned Android compile/target SDK to API 36.
- Kept a debug APK for testing when release-signing secrets are unavailable; Play Store App Bundle is skipped until an upload key is configured.
- Added release build notes for Play Console, upload-key protection and Android's user-confirmed APK install flow.

## v1.0.1 — Friend-code privacy hotfix

- Restricted profile rows to the signed-in user, accepted/pending friends, and members who share a conversation.
- Added a server-checked flock_find_friend_code RPC so a friend code returns only the exact requested profile instead of exposing every profile row.
- Restricted the profile lookup function to authenticated users and added server-side checks preventing duplicate or blocked friend requests.
- Updated the renderer to use the scoped RPC.

## v1.0.0 — Flock cross-platform messaging rebuild

- Replaced the previous Roblox launcher application with **Flock**, a global account-based messenger.
- Added Supabase Auth with username metadata, password confirmation, friend codes, account recovery, and synchronized user profiles.
- Added private global tables for profiles, friendships, conversations, membership/roles, messages, receipts, statuses, status views and reactions.
- Added row-level security policies, private media bucket access and Supabase Realtime publication for the Flock schema.
- Added direct chats, groups, message edit/delete, replies, emoji reactions, read receipts, YouTube links, uploads, voice recording, video notes, statuses and profile backgrounds.
- Added an installable PWA and responsive layout, plus Capacitor configuration and CI for a Windows setup installer and Android APK.

### Notes

- The Android artifact is debug-signed for testing if release signing secrets are absent.
- Flock is not audited as end-to-end encrypted; message content is stored in Supabase with RLS and media access controls.

## v0.3.1 — Previous app

- Last release of the previous JustPlay Roblox launcher. This release is replaced by the Flock codebase.
