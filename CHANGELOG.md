# JustPlay release notes

## v0.3.1 — Roblox search compatibility

- Updated experience search to use Roblox's current documented-by-example query parameter casing and `pageType=all` pattern for more reliable game results.
- Retained curated popular-game fallbacks when Roblox search is unavailable or rate-limited.


## v0.3.0 — Roblox launcher rebuild

- **New Roblox-focused desktop UI:** replaced the Minecraft launcher workflow with a discover page, search, featured experience, responsive game cards, and favorites.
- **One-click play:** selected experiences are opened with Roblox's documented \`roblox://placeId=<id>\` deep link, with a browser fallback if the desktop protocol cannot be opened.
- **Game discovery:** uses Roblox web search and experience metadata/thumbnail endpoints, with popular-game suggestions when search is unavailable.
- **Optional verified profile connection:** implemented Roblox OAuth 2.0 / OpenID Connect profile sign-in using PKCE, state validation, and a loopback callback.
- **Local favorites:** saved place IDs are kept on the current Windows profile.
- **No Roblox password collection:** profile sign-in happens on Roblox's website. OAuth tokens are written only through Electron secure storage when available.
- **Account-session distinction:** Roblox OAuth confirms the JustPlay profile but does not replace the sign-in session of the official Roblox desktop client.

## v0.2.3 — Minecraft launcher predecessor

- Official Fabric Loader installation and launch support.
- JavaScript syntax check passed and Windows installer build succeeded.

## v0.2.2 — Minecraft launcher predecessor

- Java runtime auto-detection, authenticated skin sync, and encrypted saved-session launching for previously installed profiles.
