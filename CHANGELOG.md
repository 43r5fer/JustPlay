# JustPlay release notes

## v0.2.0 — October 2026

- **In-app updates:** installed builds check GitHub Releases for a newer version and show a banner with download progress and a restart-to-install action.
- **What's New in the launcher:** the Docs page includes version notes and migration instructions.
- **Local JustPlay accounts:** users can create a local launcher account with a username and password. Passwords are saved as salted password hashes on this Windows user profile; the credentials are not sent to a server.
- **Clear account separation:** a local JustPlay account is for the launcher profile only. Official Minecraft Java Edition gameplay still requires Microsoft authentication and valid game access.
- **Release metadata:** Windows releases include an update manifest so the updater can verify the installer payload.

### Upgrade note for v0.1.1 users

Version v0.1.1 did not contain an update checker, so it cannot display an in-app prompt for v0.2.0. Install v0.2.0 once from the official release page; future updates can then be offered inside JustPlay.

## v0.1.1 — Microsoft sign-in diagnostics

- Preserved safe structured details from nested authentication errors instead of only showing `[object Object]`.
- Redacted token fields and omitted raw request/configuration data from logs.
- Kept Microsoft tokens in memory and the local display profile separate from Minecraft authentication.

## v0.1.0 — Initial Windows preview

- Minecraft Java version browsing and launcher UI.
- Local version folders, mod and resource-pack management.
- Microsoft sign-in flow for official Minecraft Java access.
