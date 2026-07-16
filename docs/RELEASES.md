# Release Process

This document outlines the process for creating releases for the web, desktop, and mobile applications.

## Release Flows

All platforms share a single version. Running `pnpm release` bumps `package.json`, `tauri.conf.json`, and `Cargo.toml` together via the `version` lifecycle hook.

### Desktop Release: `desktop-v*` tag

The desktop release workflow is [`release-desktop.yml`](../.github/workflows/release-desktop.yml). It creates or updates a **draft** GitHub Release and uploads the Tauri desktop artifacts for the full desktop matrix.

| Platform | Architecture | Installer bundles                                                                                                     | Updater/signature assets                      |
| -------- | ------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| macOS    | arm64        | `Forward.Email_<version>_aarch64.dmg`                                                                                 | `Forward.Email_aarch64.app.tar.gz` and `.sig` |
| macOS    | x64          | `Forward.Email_<version>_x64.dmg`                                                                                     | `Forward.Email_x64.app.tar.gz` and `.sig`     |
| Windows  | x64          | `Forward.Email_<version>_x64_en-US.msi`, `Forward.Email_<version>_x64-setup.exe`                                      | matching `.sig` sidecars                      |
| Windows  | arm64        | `Forward.Email_<version>_arm64-setup.exe`                                                                             | matching `.sig` sidecar                       |
| Linux    | x64          | `Forward.Email_<version>_amd64.AppImage`, `Forward.Email_<version>_amd64.deb`, `Forward.Email-<version>-1.x86_64.rpm` | matching `.sig` sidecars                      |
| Linux    | arm64        | `Forward.Email_<version>_arm64.deb`, `Forward.Email-<version>-1.aarch64.rpm`                                          | matching `.sig` sidecars                      |

The workflow uses native GitHub-hosted runners for `macos-15`, `macos-15-intel`, `ubuntu-22.04`, `ubuntu-22.04-arm`, `windows-latest`, and `windows-11-arm`. Linux arm64 intentionally publishes Debian and RPM bundles only, because the broader Linux bundle set is not reliable on that ARM runner. Windows arm64 currently publishes the NSIS setup executable rather than MSI so the arm64 path stays aligned with the documented Windows installer support in Tauri.

```bash
pnpm release:desktop patch
```

## CI Pipeline

Every push to `main` and every PR triggers [`ci.yml`](../.github/workflows/ci.yml):

- Lint + format checks
- Unit tests (Vitest)
- Build
- E2E tests (Playwright — desktop Chromium, mobile Android, mobile iOS viewports)

## Versioning

We use [`np`](https://github.com/sindresorhus/np) for version management. It handles version bumping, git tagging, and pushing.

```bash
pnpm release
```

`np` prompts for patch/minor/major, creates the `v*` tag, and pushes to trigger the full release flow.

### Version Sync

The `version` lifecycle hook in `package.json` runs [`scripts/sync-version.cjs`](../scripts/sync-version.cjs), which updates:

| File                                         | Field                         | Example         |
| -------------------------------------------- | ----------------------------- | --------------- |
| `src-tauri/tauri.conf.json`                  | `version`                     | `0.8.2`         |
| `src-tauri/Cargo.toml`                       | `version`                     | `0.8.2`         |
| `src-tauri/gen/android/app/tauri.properties` | `versionName` + `versionCode` | `0.8.2` / `802` |

The Android `versionCode` is derived as `major * 10000 + minor * 100 + patch` (e.g., `0.8.2` = `802`, `1.0.0` = `10000`). This ensures it always increments with each semver bump, as required by the Play Store.

## Manual Release

Trigger the desktop workflow manually via GitHub Actions:

1. Open **Actions** → **Release Desktop (Tauri)**
2. Choose **Run workflow**
3. Enter a tag such as `desktop-v0.7.0`

## Artifacts

### Desktop

The exact desktop asset basenames are listed in the matrix above. Tauri also uploads `latest.json`, and the unified release workflow adds `SHA256SUMS.txt`. Linux arm64 intentionally has no AppImage; Windows arm64 intentionally has no MSI.

### Android

| File                                      | Description                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `forwardemail-mail_<version>_android.apk` | Signed sideloadable APK containing both FCM and UnifiedPush; users may select a UnifiedPush distributor |
| `forwardemail-mail_<version>_android.aab` | The same dual-provider application as an Android App Bundle for Google Play                             |

Built by [`release-mobile.yml`](../.github/workflows/release-mobile.yml). The release job requires Android signing secrets, Firebase client configuration, and the matching VAPID public key before toolchain setup (see [SECRETS.md](./SECRETS.md#generating-the-android-keystore)). Google-free downstream and F-Droid builds remain available through the UnifiedPush-only build command, but the GitHub release intentionally publishes one APK rather than parallel provider-specific APKs.

### iOS

| File                                  | Description                                                      |
| ------------------------------------- | ---------------------------------------------------------------- |
| `forwardemail-mail_<version>_ios.ipa` | Signed IPA (archival — primary distribution is TestFlight below) |

The same IPA is uploaded to **App Store Connect → TestFlight** via `xcrun altool` using the App Store Connect API key. Testers install through the TestFlight app rather than downloading from the GitHub Release. See [ios-setup.md](./ios-setup.md#testflight-lifecycle-post-release) for the post-release flow (processing wait, inviting testers, beta review).

## Code Signing

Signing is automatic when secrets are configured. Without secrets, builds are unsigned but still functional.

| Platform     | Signing                           | Notes                                                                                    |
| ------------ | --------------------------------- | ---------------------------------------------------------------------------------------- |
| macOS        | Apple Developer ID + notarization | Users won't see Gatekeeper warnings                                                      |
| Windows      | Authenticode certificate          | Improves Microsoft Defender and SmartScreen trust, but reputation still builds over time |
| Linux        | None needed                       | `.deb` and `.rpm` work unsigned; trust is handled by the host package flow               |
| Android      | Self-managed keystore (`.jks`)    | Required for Play Store; optional for APK                                                |
| iOS          | Apple Distribution + ASC API key  | Required for TestFlight — job skips gracefully when secrets aren't set                   |
| Auto-updater | Ed25519 key                       | Required for `.sig` files                                                                |

See [SECRETS.md](./SECRETS.md) for the full list of required secrets, [desktop-ci-secrets.md](./desktop-ci-secrets.md) for desktop signing setup, and [ios-setup.md](./ios-setup.md) for the iOS signing and TestFlight flow.

## Tauri Pre-Release Checks

Tauri v2 has a handful of platform-specific bugs that are easy to ship past in
`tauri dev` and only show up in signed/notarized production builds. Run through
this list before promoting a draft GitHub release.

### macOS — App Sandbox + updater smoke test

The macOS bundle has `com.apple.security.app-sandbox = true` with
`com.apple.security.network.client = true` granted (`src-tauri/Entitlements.plist`).
Without that network entitlement, the App Sandbox blocks every outbound
request in production builds — including the updater check — even though
everything works in `tauri dev` (tauri-apps/tauri#13878).

Smoke test, on a notarized signed build (not `tauri dev`):

1. Install the signed `.dmg` from the draft release.
2. Open Console.app → filter for "Forward Email".
3. Launch the app. Confirm:
   - The updater check fires and either reports "up to date" or surfaces a new
     version prompt — not a network error.
   - The login flow reaches `api.forwardemail.net` (sign in with a test
     account).
4. If outbound traffic is silently failing, re-check `Entitlements.plist`
   ships in the bundle (`codesign -d --entitlements - /Applications/Forward\ Email.app`).

### Windows — `mailto:` handler smoke test

Windows ships both NSIS (`-setup.exe`) and MSI installers. The deep-link
plugin's compile-time scheme registration only works with MSI on Windows
(tauri-apps/plugins-workspace#10095) — so we register `mailto:` at runtime via
direct registry mutation in `set_default_mailto_handler` (`src-tauri/src/lib.rs`).

Smoke test, on a fresh Windows 11 VM (don't reuse a dev machine — stale
registry entries from prior installs hide the bug):

1. Install via `-setup.exe` (NSIS).
2. Launch the app, sign in.
3. Settings → make Forward Email the default mail handler. Accept the
   Windows Settings prompt that pops.
4. Open `cmd` and run `start mailto:test@example.com`. Confirm:
   - Forward Email comes to the foreground.
   - The compose window opens pre-populated with `test@example.com` in the
     To field.
5. Repeat with a single-instance test: with the app already open, run the
   `start mailto:` command again. Confirm a new compose window opens in the
   existing instance, not a second app process.

If step 4 silently does nothing, the runtime registry write isn't taking — fall
back to MSI (`.msi`) and reproduce there before shipping.

### Updater endpoint resilience

The updater pulls its manifest from a single GitHub URL
(`tauri.conf.json` → `plugins.updater.endpoints`):

```
https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/latest.json
```

GitHub's redirect chain has historically returned 401s/403s for some
clients (tauri-apps/tauri#2579 lineage). To add resilience, host a mirror of
`latest.json` at a stable URL on `forwardemail.net` infra (e.g. a Cloudflare
Worker or static R2/S3 object) and add it as a second entry in `endpoints`:

```json
"endpoints": [
  "https://releases.forwardemail.net/latest.json",
  "https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/latest.json"
]
```

Tauri tries each endpoint in order and falls through on network or non-200
errors — so the self-hosted mirror becomes primary, the GitHub URL is the
backstop.

The mirror needs to publish the same manifest JSON the desktop release
workflow already produces; the simplest path is a CI job that re-uploads
`latest.json` to the mirror after the GitHub release is published.

### Antivirus reputation (Windows)

Authenticode signing alone doesn't suppress every Windows Defender / third-party
AV false-positive against WebView2 binaries (tauri-apps/wry#2486). On each
release, proactively submit the new `-setup.exe` and `.msi` to:

- Microsoft Defender — https://www.microsoft.com/wdsi/filesubmission (mark as
  "incorrectly detected as malware").
- Major third-party AV vendors that have one-shot false-positive forms
  (Avast/AVG, Bitdefender, Kaspersky, ESET).

Reputation builds over weeks, so submitting on each release is more useful
than batching after user reports.

### Linux — webkit2gtk version

`tauri.conf.json` declares `libwebkit2gtk-4.1-0` as the deb dependency. Don't
drop back to `4.0` — it's no longer in Ubuntu 24 / Debian 13 repos
(tauri-apps/wry#9662). When testing the AppImage, use a fresh Ubuntu 24 VM
(not Ubuntu 22) so we catch any 4.1 incompatibilities before users do.

### Known limitations (document, don't fix)

- **ChromeOS Android intent filter** (tauri-apps/plugins-workspace#3207): deep
  links don't fire for ChromeOS users running our Android build. Niche; no
  upstream fix yet.
- **Notification plugin on Android** (tauri-apps/plugins-workspace#2341): the
  `cancelAll`, `pending`, `active`, and `channels` APIs are broken. Don't add
  call sites for any of them — `notification-bridge.js` already avoids them
  and logs explicitly when channel creation fails on Android.
- **macOS WKWebView pinned to OS version**: users on old macOS get old WebKit.
  We currently set `bundle.macOS.minimumSystemVersion = "10.15"`. Bumping to
  `11.0` would drop Catalina users in exchange for fewer JS-feature edge
  cases — defer until telemetry shows Catalina usage is negligible.

## Related Documentation

- [SECRETS.md](./SECRETS.md) — Required secrets for CI/CD and release signing
- [SECURITY.md](./SECURITY.md) — Code signing verification and supply chain protections
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building for production locally
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup
- [iOS Setup](./ios-setup.md) — Local iOS setup, CI signing, and TestFlight workflow
