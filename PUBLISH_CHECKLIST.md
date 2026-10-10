# JustPlay public launch checklist

## Completed automatically
- [x] Public repository: https://github.com/43r5fer/JustPlay
- [x] Roblox launcher UI committed to \`main\`
- [x] Roblox game discovery/search and one-click \`roblox://placeId=\` launch support implemented
- [x] Optional Roblox OAuth profile sign-in uses PKCE and encrypted OS-backed token storage
- [x] Local favorites and game-card UI implemented
- [ ] Verify OAuth Client ID and redirect URI against the actual Roblox Creator Dashboard app configuration
- [ ] End-to-end test sign-in, search, thumbnails, favorites, and launch on a clean Windows 10/11 device
- [ ] Check installed Roblox desktop client behavior and browser fallback on a machine with Roblox installed
- [ ] Run \`npm run check\` and build the Windows installer in CI before distributing v0.3.1

## Roblox OAuth setup
1. Register an OAuth 2.0 app in https://create.roblox.com/dashboard/credentials (account verification may be required).
2. Add the identity scopes \`openid\` and \`profile\`.
3. Register redirect URL \`http://localhost:53682/callback\`.
4. Enter the app's public Client ID in JustPlay. Do not enter a client secret or Roblox password.
5. Submit/publish the OAuth app through Roblox review if it needs to be available beyond private testing limits.

Roblox OAuth identifies the profile in JustPlay; it does not log the user into the Roblox desktop app. Gameplay authentication remains the responsibility of the official Roblox client.

## Downloads
- Latest installer: https://github.com/43r5fer/JustPlay/releases/latest/download/JustPlay.exe
- Latest release: https://github.com/43r5fer/JustPlay/releases/tag/v0.3.0
- Source repository: https://github.com/43r5fer/JustPlay
