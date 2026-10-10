# JustPlay public launch checklist

## Completed automatically
- [x] Public repository created and populated: https://github.com/43r5fer/JustPlay
- [x] Desktop launcher source committed to `main`
- [x] Static landing page added in `site/`
- [x] Windows installer built by GitHub Actions
- [x] Public release `v0.1.0` published with `JustPlay.exe`
- [x] Public hotfix release `v0.1.1` published with improved Microsoft auth diagnostics
- [x] Release `v0.2.0` published with the in-app updater and local launcher accounts
- [x] Release `v0.2.1` published with the dedicated JustPlay login screen and guest mode
- [x] Windows build and JavaScript syntax checks passed for `v0.2.1`
- [x] Release includes `JustPlay.exe` and `latest.yml` update metadata
- [x] In-app update checks are available starting with v0.2.0; v0.1.1 users must install v0.2.0 manually once; v0.2.0 can update to v0.2.1 in-app
- [x] Release download URL verified in GitHub release metadata

## One required repository setting for the website
1. Open <https://github.com/43r5fer/JustPlay/settings/pages>.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Open <https://github.com/43r5fer/JustPlay/actions/workflows/deploy-pages.yml> and choose **Run workflow**.
4. After the workflow succeeds, check <https://43r5fer.github.io/JustPlay/>.

The connected GitHub tooling cannot turn GitHub Pages on for the repository; this setting must be selected by the repo owner.

## Downloads
- Latest installer: <https://github.com/43r5fer/JustPlay/releases/latest/download/JustPlay.exe>
- Latest release: <https://github.com/43r5fer/JustPlay/releases/tag/v0.2.1>
- Changelog: <https://github.com/43r5fer/JustPlay/blob/main/CHANGELOG.md>
- Public repository: <https://github.com/43r5fer/JustPlay>

## Before broader promotion
- [ ] Test installation and uninstall on a clean Windows 10/11 PC.
- [ ] Confirm Start Menu search finds JustPlay after installation.
- [ ] Test supported Minecraft release and snapshot installs with a licensed account.
- [ ] Test mods/resource packs and loader-specific profiles with compatible versions.
- [ ] Consider code-signing the installer; this current community build is unsigned and Windows may warn about unknown publisher.
- [ ] Review third-party dependency audit output and keep dependencies updated.

JustPlay is independent and not affiliated with Mojang or Microsoft. A local display name is not Minecraft account authentication; valid Minecraft Java access is required to launch the game. A local JustPlay username/password account only signs into the local launcher profile and does not bypass game ownership checks.
