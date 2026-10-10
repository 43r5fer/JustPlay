# JustPlay — Minecraft Java Launcher

JustPlay is an independent Windows launcher project for Minecraft Java Edition, with a premium dark UI, local profile setup, version browsing, mods/resource packs management, and a separate public landing page.

> This repository contains source code and workflows. It does not initially contain a compiled Windows executable. A valid Minecraft Java account is required to launch the game; the local display name is only a launcher profile.

## Project layout

- `electron/` — Electron main process and restricted IPC bridge
- `src/` — desktop launcher UI
- `site/` — static landing page and documentation
- `.github/workflows/deploy-pages.yml` — deploy website to GitHub Pages
- `.github/workflows/build-windows.yml` — build a Windows installer and publish it to GitHub Releases on version tags

## Run locally on Windows

1. Install Node.js LTS from https://nodejs.org/.
2. Open Command Prompt in this directory.
3. Run:

   ```bat
   npm install
   npm run dev
   ```

## Build Windows installer

```bat
npm run check
npm run dist:win
```

The installer output is `dist/JustPlay.exe`. The NSIS configuration creates Start Menu and desktop shortcuts. Node.js is only needed to develop/build the project, not after installing the app.

## Publish the website

In the GitHub repository, open **Settings → Pages** and select **GitHub Actions** as the source. The website workflow deploys the `site/` directory on pushes to `main`.

Once deployed, the expected URL is https://43r5fer.github.io/JustPlay/.

## Publish a Windows release

Push a semantic version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The Windows workflow checks the JavaScript, builds the installer on a Windows runner, and attaches `JustPlay.exe` to a GitHub Release. The site download button points at:

https://github.com/43r5fer/JustPlay/releases/latest/download/JustPlay.exe

That download will work after the first successful tagged release.

## Authentication and limitations

- JustPlay does not ask for a Microsoft password inside its own form.
- The local display name does not unlock multiplayer or bypass Minecraft ownership checks.
- Microsoft account verification is required to launch Minecraft using that account.
- OptiFine follows its official installer workflow and is not silently installed by JustPlay.
- This is an unsigned community build; Windows may show an unknown-publisher warning.
- Install third-party mods only from sources you trust.

JustPlay is not affiliated with Mojang or Microsoft. Minecraft and Microsoft are trademarks of their respective owners.