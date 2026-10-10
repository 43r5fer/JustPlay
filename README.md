# JustPlay — Minecraft Java Launcher

JustPlay is an unofficial Windows desktop launcher starter project with a clean UI, local profile folders, a version browser, an optional local display profile plus Microsoft sign-in when launching Minecraft, mod/resource-pack file management, and a Windows installer build configuration.

> **Important:** this package is source code, not a precompiled `.exe`. Build it using the steps below. It does not bypass Minecraft ownership. Microsoft sign-in is handled through the authentication library's window; JustPlay does not ask for your Microsoft password in its own form.

## Included

- `src/index.html`, `src/styles.css`, `src/renderer.js` — JustPlay desktop UI.
- `electron/main.cjs`, `electron/preload.cjs` — local file/folder handling and a restricted IPC bridge.
- `site/` — the separate landing page, original pixel-inspired scenery, documentation and download CTA.
- `.github/workflows/build-windows.yml` — builds a Windows installer artifact from GitHub Actions.
- Electron Builder NSIS configuration — creates `dist/JustPlay.exe`.

## Windows setup

1. Install a supported **Node.js LTS** release from <https://nodejs.org/>. During setup, keep the option to add Node.js to PATH enabled. Close and reopen Command Prompt after installation.
2. Extract this ZIP to a writable folder such as `Desktop\JustPlay`.
3. Open that folder in File Explorer. Click the address bar, type `cmd`, and press Enter.
4. Run:

   ```bat
   npm install
   npm run dev
   ```

5. To create the Windows installer, close the app and run:

   ```bat
   npm run dist:win
   ```

   The installer will be written into `dist\JustPlay.exe`. Double-click that setup file to install JustPlay and create Start Menu/Desktop shortcuts.

If `npm` is “not recognized”, Node.js is missing or its PATH update has not reached the current terminal. Install Node.js LTS, close every open Command Prompt window, and open a new one.

## Publish the public website and Windows installer with GitHub

This project expects the public repository name `43r5fer/JustPlay`, because the site’s Download buttons point to its latest Release asset. The GitHub account connected in the authoring environment did not have a `JustPlay` repository, and the available connector cannot create repositories. Create a **new public repository named `JustPlay`** on GitHub, then upload/push the contents of this folder to its `main` branch.

### Publish the website

1. In the repository, open **Settings → Pages**.
2. Set the publishing source to **GitHub Actions**.
3. Push the project to `main`, or open **Actions → Publish JustPlay website to GitHub Pages → Run workflow**.
4. The site should be published at `https://43r5fer.github.io/JustPlay/` after the workflow succeeds.

### Publish the installer

1. From a local clone, create and push a version tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. The **Build and release JustPlay for Windows** workflow builds the NSIS installer on a Windows runner and attaches `JustPlay.exe` to the GitHub Release.
3. The website’s Download button points to `https://github.com/43r5fer/JustPlay/releases/latest/download/JustPlay.exe`; this link only works after the first tagged release completes successfully.
4. The Windows installer creates a Start Menu shortcut named **JustPlay** and a desktop shortcut, so Windows Search can find the installed app.

You can also run the build workflow manually to test the build artifact before creating a version tag. Manually triggered builds upload an Actions artifact but do not publish a Release unless they run on a `v*` tag.

The app is not code-signed in this starter project. Windows SmartScreen may show an unknown-publisher warning until a publisher certificate is added.

## First run

1. Enter a display name and choose **Set up JustPlay**.
2. JustPlay checks available local drives and tries the drive with the most free space first. It creates:
   - `JustPlay\Game Versions\`
   - `JustPlay\resource packs\`
   - `JustPlay\mods\`
   - `JustPlay\config\`
3. A local display profile is enough to set up the launcher and organize files; no JustPlay password is needed.
4. To launch Minecraft through JustPlay, complete the supported Microsoft sign-in for an account with Minecraft: Java Edition access. The local display name is not game authentication.
5. Choose a Minecraft Java version. The first launch downloads the game files; later launches can use the installed profile.

The Microsoft session token is held in memory in this initial build. You may need to sign in again after closing and reopening JustPlay. No Microsoft password is written to the settings file.

## Versions, Forge and OptiFine

- Release, snapshot and legacy version metadata is read from Mojang's official version manifest: <https://piston-meta.mojang.com/mc/game/version_manifest_v2.json>.
- Forge version metadata is read from Forge's official Maven metadata. The launcher downloads the matching installer JAR from `maven.minecraftforge.net` and hands it to the launcher core. Compatibility varies by Minecraft/Forge build and Java runtime; check the logs if a selected build fails.
- OptiFine versions are listed when the official downloads page is readable, but OptiFine uses its own website/installer flow. JustPlay opens <https://optifine.net/downloads> and does not automate ad redirects, CAPTCHA, or installer prompts. Follow OptiFine's instructions and install the profile into the matching JustPlay game folder.
- Installed loader profiles are detected from local version metadata when available. A mod must match the Minecraft version and loader.

## Mods and resource packs

- Mods: add `.jar` files. JustPlay copies the selected file to the shared `mods` folder and the active profile's `mods` folder.
- Java resource packs: add `.zip` files. JustPlay copies them to the shared `resource packs` folder and the active profile's `resourcepacks` folder.
- The app copies files without replacing existing profile files during launch sync. File management stays within folders created under the configured JustPlay root.

Only install add-ons from sources you trust. This app does not verify the safety of third-party JAR files.

## Known limitations of this initial build

- A compatible Java runtime must be available on `PATH`. If Minecraft requires a different Java major version, install a compatible runtime and relaunch.
- The Microsoft authentication dependency is an external open-source library; its compatibility depends on Microsoft's current sign-in policies. Authentication failures are shown in the UI rather than bypassed.
- Forge and OptiFine support varies by release. OptiFine still requires its official installer workflow.
- This project has not been signed or independently audited, and this container cannot provide a production code-signing certificate.
- The website download link points to the latest GitHub Release asset. It returns a 404 until the first tagged Windows build has created a release containing `JustPlay.exe`.

## Legal / project status

JustPlay is an independent community project and is not affiliated with, endorsed by, or sponsored by Mojang or Microsoft. Minecraft and Microsoft are trademarks of their respective owners. You need a valid Minecraft: Java Edition account/license to play.

## Microsoft sign-in troubleshooting

A scrubbed diagnostic is written to `%APPDATA%\justplay-launcher\logs\microsoft-auth.log`. It avoids storing password or token values.


### Microsoft sign-in diagnostics update

If Microsoft sign-in opens successfully but Xbox/Minecraft verification fails, this build preserves safe structured error fields instead of displaying `[object Object]`. It redacts token-like properties and omits raw HTTP bodies, headers, request configs, and stack traces. Retry sign-in and inspect `%APPDATA%\justplay-launcher\logs\microsoft-auth.log` for the underlying error code/message. Never share passwords, access tokens, refresh tokens, or authorization codes. This improves diagnostics; it does not bypass Xbox profile, family safety, or Minecraft ownership requirements.


## Local profile vs. game authentication

JustPlay allows users to enter the app, choose a display name, install versions, and manage mods/resource packs without logging in immediately. The display name is only a local launcher profile; it is not a Minecraft identity and does not unlock multiplayer or game ownership. JustPlay will require valid Minecraft Java account authentication when starting the game. This project intentionally does not impersonate TLauncher or implement cracked/offline authentication that bypasses game access checks.
