# Release Process

This document outlines the process for creating releases for the web, desktop, and mobile applications.

## Release Flows

All platforms share a single version. Running `pnpm release` bumps `package.json`, `tauri.conf.json`, and `Cargo.toml` together via the `version` lifecycle hook.

### Unified Release: `v*` tag

Triggers [`release.yml`](../.github/workflows/release.yml), which orchestrates:

1. Creates a **draft** GitHub Release
2. Builds desktop binaries for macOS (arm64 + x64), Windows (x64), Linux (x64)
3. Generates `SHA256SUMS.txt` for all artifacts
4. **Publishing** the draft triggers [`deploy.yml`](../.github/workflows/deploy.yml) → deploys webmail to Cloudflare R2

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

### Mobile (Future)

| Platform | Files                                   |
| -------- | --------------------------------------- |
| Android  | `.apk` (universal), `.aab` (Play Store) |
| iOS      | `.ipa` (App Store)                      |

## Code Signing

Signing is automatic when secrets are configured. Without secrets, builds are unsigned but still functional.

| Platform     | Signing                           | Notes                               |
| ------------ | --------------------------------- | ----------------------------------- |
| macOS        | Apple Developer ID + notarization | Users won't see Gatekeeper warnings |
| Windows      | EV certificate (optional)         | Avoids SmartScreen warnings         |
| Linux        | None needed                       | AppImage/deb work unsigned          |
| Auto-updater | Ed25519 key                       | Required for `.sig` files           |

See [SECRETS.md](./SECRETS.md) for the full list of required secrets and [desktop-ci-secrets.md](./desktop-ci-secrets.md) for detailed setup.

## Related Documentation

- [SECRETS.md](./SECRETS.md) — Required secrets for CI/CD and release signing
- [SECURITY.md](./SECURITY.md) — Code signing verification and supply chain protections
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building for production locally
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup
