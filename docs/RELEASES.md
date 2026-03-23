# Release Process (Tauri)

This document outlines the process for creating a new release for the web, desktop, and mobile applications.

> **Note:** The automatic release pipeline (`release.yml` tag triggers) is currently disabled while the desktop and mobile release workflows are being finalized. Releases can still be triggered manually via `workflow_dispatch`. See the workflow files for current status.

## Versioning

We use [`np`](https://github.com/sindresorhus/np) for version management, which handles version bumping, changelog updates, git tagging, and pushing to the repository.

## Release Steps

1. **Ensure you are on the `main` branch and your working directory is clean.**

2. **Run the release script**:

   ```bash
   pnpm release
   ```

   `np` will prompt you to select the version bump (patch, minor, major). Choose the appropriate one.

3. **Push the tag**: `np` will automatically create and push a git tag (e.g., `v1.2.3`).

4. **GitHub Actions take over**: Once the release pipeline is enabled, pushing a `v*` tag will trigger [`release.yml`](../.github/workflows/release.yml), which orchestrates the entire release pipeline:
   - Creates a draft GitHub Release with the tag name and changelog.
   - Calls [`release-desktop.yml`](../.github/workflows/release-desktop.yml) via `workflow_call` to build, sign, and notarize the desktop applications for macOS, Windows, and Linux.
   - Calls [`release-mobile.yml`](../.github/workflows/release-mobile.yml) via `workflow_call` to build and sign the mobile applications for Android and iOS.
   - Generates `SHA256SUMS.txt` for all release artifacts.

5. **Draft Release**: The workflows will automatically create a **draft** GitHub Release and attach all the compiled artifacts (`.dmg`, `.msi`, `.AppImage`, `.apk`, `.ipa`, etc.) to it.

6. **Publish the Release**: Navigate to the [Releases](https://github.com/forwardemail/mail.forwardemail.net/releases) page on GitHub, review the draft release, edit the release notes if necessary, and then publish it.

7. **Web Deployment**: The web application is deployed via two complementary mechanisms:
   - **Automatic (on release commit)**: When `np` pushes the `chore(release):` commit to `main`, [`ci.yml`](../.github/workflows/ci.yml) detects the release commit and deploys to Cloudflare R2, deploys the CDN worker, and purges the cache.
   - **On release publish**: Publishing the GitHub Release also triggers [`deploy.yml`](../.github/workflows/deploy.yml), which performs the same deployment steps as a safety net.

## Manual Release

If you need to trigger a release manually (without `np`), use the `workflow_dispatch` trigger on `release.yml`:

1. Go to **Actions** > **Release (Orchestrator)** > **Run workflow**.
2. Enter the version number (e.g., `0.3.2`).
3. The workflow will proceed as described above.

You can also trigger `release-desktop.yml` or `release-mobile.yml` individually via `workflow_dispatch` for platform-specific releases.

## Artifacts

The release process generates the following artifacts:

### Desktop

- **macOS (x64, arm64)**: `.dmg`, `.app.tar.gz`, `.app.tar.gz.sig` (for auto-updater)
- **Windows (x64)**: `.msi`, `.nsis.zip`, `.nsis.zip.sig`
- **Linux (x64)**: `.AppImage`, `.deb`

### Mobile

- **Android**: `.apk` (universal), `.aab` (for Google Play Store)
- **iOS**: `.ipa` (for App Store)

## Code Signing and Notarization

Code signing is handled automatically by the GitHub Actions workflows using secrets stored in the repository. See [SECRETS.md](./SECRETS.md) for the full list of required secrets.

- **macOS**: Signed with an Apple Developer certificate and notarized by Apple.
- **Windows**: Signed with an EV code signing certificate (optional, via `WINDOWS_CERTIFICATE` secret).
- **Android**: Signed with a JKS keystore.
- **iOS**: Signed with an Apple Distribution certificate and provisioning profile.
- **Tauri Updater**: All desktop bundles are signed with an Ed25519 private key (`TAURI_SIGNING_PRIVATE_KEY`) to generate `.sig` files, which are required for the auto-updater to securely verify new versions.

## Related Documentation

- [SECRETS.md](./SECRETS.md) — Required secrets for CI/CD and release signing
- [SECURITY.md](./SECURITY.md) — Code signing verification and supply chain protections
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building for production locally
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup
