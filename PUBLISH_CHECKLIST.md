# First public JustPlay release checklist

- [ ] Create a new **public** GitHub repository named `JustPlay` under the intended owner account.
- [ ] Push the contents of this folder to the repository's `main` branch.
- [ ] In Settings → Pages, select **GitHub Actions** as the publishing source.
- [ ] Wait for **Publish JustPlay website to GitHub Pages** to complete.
- [ ] Push tag `v0.1.0` to trigger the Windows release build.
- [ ] Confirm the Release has a `JustPlay.exe` asset and test downloading it from Windows.
- [ ] Test installer launch, Start Menu search for `JustPlay`, uninstall, first-run folder selection, version install, and account sign-in.

Expected website: `https://43r5fer.github.io/JustPlay/`
Expected installer: `https://github.com/43r5fer/JustPlay/releases/latest/download/JustPlay.exe`

The URL is configured for the expected repository name, but neither URL is live until the repository is created, Pages is enabled, and a Release build succeeds.
