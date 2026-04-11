# Release Process

This document outlines the process for creating releases for the web, desktop, and mobile applications.

## Release Flows

All platforms share a single version. Running `pnpm release` bumps `package.json`, `tauri.conf.json`, and `Cargo.toml` together via the `version` lifecycle hook.

### Unified Release: `v*` tag

Triggers [`release.yml`](../.github/workflows/release.yml), which orchestrates:

1. Creates a **draft** GitHub Release
2. Builds desktop binaries for macOS (arm64 + x64), Windows (x64), Linux (x64)
3. Builds Android APK + AAB (signed, runs in parallel with desktop)
4. Generates `SHA256SUMS.txt` for all artifacts (desktop + mobile)
5. **Publishing** the draft triggers [`deploy.yml`](../.github/workflows/deploy.yml) → deploys webmail to Cloudflare R2

Android build failures do not block the desktop release or publishing.

```bash
pnpm release          # np bumps version across all files, creates v* tag, pushes
```

### Desktop-Only Hotfix: `desktop-v*` tag (optional)

For hotfixes that only affect the desktop app without a webmail deploy:

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

Trigger any workflow manually via GitHub Actions:

1. **Full release**: Actions → Release → Run workflow → enter version (e.g., `0.7.0`)
2. **Desktop only**: Actions → Release Desktop → Run workflow → enter tag (e.g., `desktop-v0.7.0`)

## Artifacts

### Desktop

| Platform | Architecture          | Files                                    |
| -------- | --------------------- | ---------------------------------------- |
| macOS    | Apple Silicon (arm64) | `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig` |
| macOS    | Intel (x64)           | `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig` |
| Windows  | x64                   | `.msi`, `.nsis.zip`, `.nsis.zip.sig`     |
| Linux    | x64                   | `.AppImage`, `.deb`                      |

### Android

| File                                      | Description                                     |
| ----------------------------------------- | ----------------------------------------------- |
| `forwardemail-mail_<version>_android.apk` | Signed universal APK for sideloading            |
| `forwardemail-mail_<version>_android.aab` | Signed Android App Bundle for Play Store upload |

Built by [`release-mobile.yml`](../.github/workflows/release-mobile.yml). Requires Android signing secrets in the `release` environment (see [SECRETS.md](./SECRETS.md#generating-the-android-keystore)).

### iOS (Future)

| File   | Description      |
| ------ | ---------------- |
| `.ipa` | App Store upload |

## Code Signing

Signing is automatic when secrets are configured. Without secrets, builds are unsigned but still functional.

| Platform     | Signing                           | Notes                                     |
| ------------ | --------------------------------- | ----------------------------------------- |
| macOS        | Apple Developer ID + notarization | Users won't see Gatekeeper warnings       |
| Windows      | EV certificate (optional)         | Avoids SmartScreen warnings               |
| Linux        | None needed                       | AppImage/deb work unsigned                |
| Android      | Self-managed keystore (`.jks`)    | Required for Play Store; optional for APK |
| Auto-updater | Ed25519 key                       | Required for `.sig` files                 |

See [SECRETS.md](./SECRETS.md) for the full list of required secrets and [desktop-ci-secrets.md](./desktop-ci-secrets.md) for detailed setup.

## Related Documentation

- [SECRETS.md](./SECRETS.md) — Required secrets for CI/CD and release signing
- [SECURITY.md](./SECURITY.md) — Code signing verification and supply chain protections
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building for production locally
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup
