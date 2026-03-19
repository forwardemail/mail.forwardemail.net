# Desktop App — CI & Secrets Setup Guide

## GitHub Environment Setup

1. Go to the repository **Settings → Environments**.
2. Create an environment named **`release`**.
3. (Optional) Add required reviewers or deployment protection rules.
4. Add all secrets listed below to this environment.

## Updater Keypair Setup

The Tauri updater uses Minisign to verify update signatures. You must generate a keypair before the first release.

### Step 1: Generate the keypair

```bash
pnpm tauri signer generate -w ~/.tauri/forwardemail.key
```

This outputs the **public key** to stdout and writes the **private key** to `~/.tauri/forwardemail.key`.

### Step 2: Set the public key in config

Copy the public key string and paste it into `src-tauri/tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "pubkey": "<paste your public key here>"
  }
}
```

Commit this change — the public key is safe to store in the repository.

### Step 3: Add private key secrets to GitHub

1. Read the private key file:
   ```bash
   cat ~/.tauri/forwardemail.key
   ```
2. In the `release` environment, add:
   - **`TAURI_SIGNING_PRIVATE_KEY`** — the full contents of the private key file
   - **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** — the password you set during generation

## Running a Release

### Via `release-desktop.yml` (desktop only)

1. Go to **Actions → Release Desktop (Tauri)**.
2. Click **Run workflow**.
3. Enter the version tag (e.g. `v0.3.2`).
4. Click **Run workflow**.

### Via `release.yml` (full orchestration)

1. Go to **Actions → Release**.
2. Click **Run workflow**.
3. Enter the version (e.g. `0.3.2`) — no `v` prefix needed.
4. Click **Run workflow**.

This orchestrates: GitHub Release creation → Desktop builds → Mobile builds → Checksums.

## Complete Secrets Reference

All secrets should be added to the **`release`** GitHub environment.

| Secret                               | Required    | Description                                                    | How to Obtain                                                           |
| ------------------------------------ | ----------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Yes         | Minisign private key for updater signatures                    | `pnpm tauri signer generate` (see above)                                |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Yes         | Password for the signing private key                           | Set during `signer generate`                                            |
| `APPLE_CERTIFICATE`                  | No (future) | Base64-encoded `.p12` certificate                              | Export from Keychain Access                                             |
| `APPLE_CERTIFICATE_PASSWORD`         | No (future) | Password for the `.p12` certificate                            | Set during export                                                       |
| `APPLE_SIGNING_IDENTITY`             | No (future) | Signing identity string (e.g. `Developer ID Application: ...`) | `security find-identity -v -p codesigning`                              |
| `APPLE_ID`                           | No (future) | Apple ID email for notarization                                | Apple Developer account                                                 |
| `APPLE_PASSWORD`                     | No (future) | App-specific password for notarization                         | [appleid.apple.com](https://appleid.apple.com) → App-Specific Passwords |
| `APPLE_TEAM_ID`                      | No (future) | Apple Developer Team ID                                        | [developer.apple.com](https://developer.apple.com) → Membership         |
| `WINDOWS_CERTIFICATE`                | No (future) | Base64-encoded EV code signing certificate                     | Certificate authority                                                   |
| `WINDOWS_CERTIFICATE_PASSWORD`       | No (future) | Password for the Windows certificate                           | Set during certificate export                                           |

**Note:** `GITHUB_TOKEN` is provided automatically by GitHub Actions — do not add it manually.

## macOS Code Signing (Future)

Once you have an Apple Developer Program membership:

1. Create a Developer ID Application certificate in Xcode or the Apple Developer portal.
2. Export it as a `.p12` file from Keychain Access.
3. Base64-encode it: `base64 -i certificate.p12 | pbcopy`
4. Add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` to the `release` environment.
5. Set `signingIdentity` in `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity`.

## Windows Code Signing (Future)

Once you have an EV code signing certificate:

1. Export the certificate as a `.pfx` file.
2. Base64-encode it: `base64 -i certificate.pfx | clip` (Windows) or `base64 -i certificate.pfx | pbcopy` (macOS).
3. Add `WINDOWS_CERTIFICATE` and `WINDOWS_CERTIFICATE_PASSWORD` to the `release` environment.
4. Set `certificateThumbprint` in `src-tauri/tauri.conf.json` → `bundle.windows.certificateThumbprint`.

## Verifying Artifacts

After a successful release build, check the draft GitHub Release for:

- **macOS:** `Forward Email_<version>_aarch64.dmg`, `Forward Email_<version>_x64.dmg`, `.app.tar.gz` + `.app.tar.gz.sig`
- **Windows:** `.msi`, `.nsis.zip` + `.nsis.zip.sig`
- **Linux:** `.AppImage`, `.AppImage.tar.gz` + `.AppImage.tar.gz.sig`, `.deb`

Each `.sig` file contains the Minisign signature used by the auto-updater to verify integrity. If `.sig` files are missing, check that `TAURI_SIGNING_PRIVATE_KEY` is correctly set.
