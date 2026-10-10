# JustPlay — Roblox Game Launcher

JustPlay is a Windows desktop launcher for discovering Roblox experiences and opening them directly in the official Roblox app. This major rebuild replaces the previous Minecraft-focused interface.

## Get JustPlay

- **Windows installer:** https://github.com/43r5fer/JustPlay/releases/latest/download/JustPlay.exe
- **Latest release:** https://github.com/43r5fer/JustPlay/releases/tag/v0.3.1
- **Source ZIP:** https://github.com/43r5fer/JustPlay/archive/refs/tags/v0.3.1.zip

## v0.3.1 search compatibility fix

- Updated Roblox experience search query parameters to use the current `searchQuery`, `pageToken`, `sessionId`, and `pageType=all` form. Roblox's public discover/search endpoints are undocumented and may change.

## Features

- A redesigned dark desktop interface with game cards, search, a featured experience, and a responsive layout.
- Popular experience suggestions and Roblox experience search.
- One-click launching through Roblox's documented \`roblox://placeId=<id>\` deep link; if the protocol can't be opened, JustPlay falls back to the game's web page.
- Local Favorites collection for game place IDs.
- Optional Roblox profile connection through Roblox OAuth 2.0 / OpenID Connect using authorization-code flow with PKCE.
- OAuth tokens are encrypted with Electron \`safeStorage\` before they are stored on this Windows profile.
- The app never asks for or stores a Roblox password or Roblox browser cookie.

## Important account behavior

Roblox OAuth identifies the connected profile in JustPlay. It does **not** sign the user into the Roblox desktop client or mint a gameplay session; the official Roblox app handles game authentication. Users should sign into Roblox in the official app once. If JustPlay cannot open \`roblox://\`, install or update Roblox and try again.

Game browsing and launching are available without connecting an OAuth profile. Users can connect later in Settings. The Create account action opens Roblox's own website; account creation and password reset happen on Roblox, not inside JustPlay.

## Configure Roblox profile sign-in

A Roblox OAuth Client ID is not bundled into this public source repository. To turn on **Continue with Roblox**:

1. Open the [Roblox Creator Dashboard OAuth 2.0 Apps](https://create.roblox.com/dashboard/credentials) page and register an OAuth app. Roblox currently requires an ID-verified creator account to register/publish OAuth apps.
2. Add the identity scopes \`openid\` and \`profile\`.
3. Register this exact redirect URL: \`http://localhost:53682/callback\`.
4. Copy the public Client ID (not the secret) into JustPlay's first-screen setup or Settings and save it.
5. Press **Continue with Roblox**. Roblox opens in the system browser. Sign in there and approve the requested identity information.

JustPlay uses the PKCE S256 verifier and a random state value. The local callback listens only on loopback, and the actual tokens are stored only if Electron secure storage is available. Never paste a Roblox password, session cookie, or client secret into JustPlay. Roblox OAuth is currently documented as a beta feature and app publication/review limits are controlled by Roblox.

## Build from source on Windows

Install Node.js 22 or a compatible supported release, then open Command Prompt in the project directory:

\`\`\`bat
npm install
npm run check
npm run dev
\`\`\`

Create a Windows installer:

\`\`\`bat
npm run dist:win
\`\`\`

The installer is created in \`dist\`. A GitHub Actions workflow builds the Windows installer and attaches it to tagged releases.

## Technical notes

- Electron main process: \`electron/main.cjs\`
- Roblox OAuth, game discovery, thumbnails, favorites, and deep-link handling: \`electron/roblox.cjs\`
- Sandboxed renderer bridge: \`electron/preload.cjs\`
- Desktop UI: \`src/index.html\`, \`src/styles.css\`, and \`src/renderer.js\`
- Public landing page: \`site/index.html\`

Roblox game discovery uses public Roblox web services that may change or rate-limit requests. JustPlay is not affiliated with, endorsed by, or sponsored by Roblox Corporation. Roblox and its logos are trademarks of Roblox Corporation.
