# Release Process

This document outlines the process for creating releases for the web, desktop, and mobile applications.

## Release Flows

All platforms share a single version. Running `pnpm release` bumps `package.json`, `tauri.conf.json`, and `Cargo.toml` together via the `version` lifecycle hook.

### Desktop Release: `desktop-v*` tag

The desktop release workflow is [`release-desktop.yml`](../.github/workflows/release-desktop.yml). It creates or updates a **draft** GitHub Release and uploads the Tauri desktop artifacts for the full desktop matrix.

| Platform | Architecture | Artifacts                                                |
| -------- | ------------ | -------------------------------------------------------- |
| macOS    | arm64        | `.dmg`, updater archive + signature                      |
| macOS    | x64          | `.dmg`, updater archive + signature                      |
| Windows  | x64          | `.msi`, `-setup.exe`, updater archive + signature        |
| Windows  | arm64        | `-setup.exe`, updater archive + signature                |
| Linux    | x64          | `.AppImage`, `.deb`, `.rpm`, updater archive + signature |
| Linux    | arm64        | `.deb`, `.rpm`, updater archive + signature              |

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

| Platform | Architecture          | Files                                                                |
| -------- | --------------------- | -------------------------------------------------------------------- |
| macOS    | Apple Silicon (arm64) | `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`                             |
| macOS    | Intel (x64)           | `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig`                             |
| Windows  | x64                   | `.msi`, `.msi.sig`, `-setup.exe`, `-setup.exe.sig`                   |
| Windows  | arm64                 | `-setup.exe`, `-setup.exe.sig`                                       |
| Linux    | x64                   | `.AppImage`, `.AppImage.sig`, `.deb`, `.deb.sig`, `.rpm`, `.rpm.sig` |
| Linux    | arm64                 | `.deb`, `.deb.sig`, `.rpm`, `.rpm.sig`                               |

### Android

| File                                      | Description                                     |
| ----------------------------------------- | ----------------------------------------------- |
| `forwardemail-mail_<version>_android.apk` | Signed universal APK for sideloading            |
| `forwardemail-mail_<version>_android.aab` | Signed Android App Bundle for Play Store upload |

Built by [`release-mobile.yml`](../.github/workflows/release-mobile.yml). Requires Android signing secrets in the `release` environment (see [SECRETS.md](./SECRETS.md#generating-the-android-keystore)).

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

## Related Documentation

- [SECRETS.md](./SECRETS.md) — Required secrets for CI/CD and release signing
- [SECURITY.md](./SECURITY.md) — Code signing verification and supply chain protections
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building for production locally
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup
- [iOS Setup](./ios-setup.md) — Local iOS setup, CI signing, and TestFlight workflow
