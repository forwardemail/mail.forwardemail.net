# Desktop App: CI & Secrets Setup Guide

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

Commit this change. The public key is safe to store in the repository.

### Step 3: Add private key secrets to GitHub

1. Read the private key file:
   ```bash
   cat ~/.tauri/forwardemail.key
   ```
2. In the `release` environment, add:
   - **`TAURI_SIGNING_PRIVATE_KEY`**: the full contents of the private key file
   - **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`**: the password you set during generation

## Running a Release

### Via `release-desktop.yml` (desktop only)

1. Go to **Actions → Release Desktop (Tauri)**.
2. Click **Run workflow**.
3. Enter the version tag (e.g. `v0.3.2`).
4. Click **Run workflow**.

### Via `release.yml` (full orchestration)

1. Go to **Actions → Release**.
2. Click **Run workflow**.
3. Enter the version (e.g. `0.3.2`) with no `v` prefix.
4. Click **Run workflow**.

This orchestrates the WebView E2E gate, draft GitHub Release creation, desktop and mobile builds, web deployment, release publication, checksums, and the optional Matrix notification.

## Complete Secrets Reference

Add all secrets to the **`release`** GitHub environment.

| Secret                               | Required | Description                                                    | How to Obtain                                                           |
| ------------------------------------ | -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Yes      | Minisign private key for updater signatures                    | `pnpm tauri signer generate` (see above)                                |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Yes      | Password for the signing private key                           | Set during `signer generate`                                            |
| `APPLE_CERTIFICATE`                  | Yes      | Base64-encoded macOS `.p12` certificate                        | Export from Keychain Access                                             |
| `APPLE_CERTIFICATE_PASSWORD`         | Yes      | Password for the `.p12` certificate                            | Set during export                                                       |
| `APPLE_SIGNING_IDENTITY`             | Yes      | Signing identity string (e.g. `Developer ID Application: ...`) | `security find-identity -v -p codesigning`                              |
| `APPLE_ID`                           | Yes      | Apple ID email for notarization                                | Apple Developer account                                                 |
| `APPLE_PASSWORD`                     | Yes      | App-specific password for notarization                         | [appleid.apple.com](https://appleid.apple.com) → App-Specific Passwords |
| `APPLE_TEAM_ID`                      | Yes      | Apple Developer Team ID                                        | [developer.apple.com](https://developer.apple.com) → Membership         |
| `ESIGNER_USERNAME`                   | Yes      | SSL.com account username (eSigner)                             | SSL.com sign-in                                                         |
| `ESIGNER_PASSWORD`                   | Yes      | SSL.com account password                                       | SSL.com sign-in                                                         |
| `ESIGNER_CREDENTIAL_ID`              | Yes      | eSigner credential ID of the code-signing certificate          | SSL.com → Orders → certificate details → SIGNING CREDENTIALS            |
| `ESIGNER_TOTP_SECRET`                | Yes      | eSigner secret code for one-time passwords                     | Shown with the eSigner QR code (PIN → Show QR Code)                     |

The desktop workflow also reads the repository variables `ALLOW_UNSIGNED_WINDOWS`, `WINDOWS_PUBLISHER` and `WINDOWS_SIGN_NSIS_PLUGINS` (see [SECRETS.md](./SECRETS.md#windows-code-signing-secrets)) and `ALLOW_NO_UPDATER`. Leave it unset during normal releases: the workflow fails closed when `TAURI_SIGNING_PRIVATE_KEY` is missing. Setting `ALLOW_NO_UPDATER=true` is an emergency override that deliberately produces release artifacts without updater signatures.

GitHub Actions provides `GITHUB_TOKEN` automatically. Do not add it manually.

## macOS Code Signing and Notarization

The macOS matrix rows fail closed unless all six Apple signing and notarization secrets in the table above are present. With an Apple Developer Program membership:

1. Create a Developer ID Application certificate in Xcode or the Apple Developer portal.
2. Export it as a `.p12` file from Keychain Access.
3. Base64-encode it: `base64 -i certificate.p12 | pbcopy`
4. Add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` to the `release` environment. The workflow passes `APPLE_SIGNING_IDENTITY` to Tauri at build time; keep `bundle.macOS.signingIdentity` unset in the committed configuration.

## Windows Code Signing

Windows installers are signed with an SSL.com certificate through eSigner cloud signing; the key stays at SSL.com and CI needs no manual step. `release-desktop.yml` runs `scripts/windows-signing.cjs setup`, which sets `bundle.windows.signCommand` so the Tauri bundler signs the app binary, NSIS plugins and uninstaller, and the `.msi` and `-setup.exe`. A later step verifies every installer and the executables inside it. The Windows rows fail closed without the four `ESIGNER_*` secrets. Setup, signing volume and troubleshooting: [SECRETS.md](./SECRETS.md#windows-code-signing-secrets).

## Verifying Artifacts

After a successful release build, check the draft GitHub Release for:

- **macOS arm64:** `Forward.Email_<version>_aarch64.dmg`, `Forward.Email_aarch64.app.tar.gz`, and `Forward.Email_aarch64.app.tar.gz.sig`
- **macOS x64:** `Forward.Email_<version>_x64.dmg`, `Forward.Email_x64.app.tar.gz`, and `Forward.Email_x64.app.tar.gz.sig`
- **Windows x64:** `Forward.Email_<version>_x64_en-US.msi`, `Forward.Email_<version>_x64_en-US.msi.sig`, `Forward.Email_<version>_x64-setup.exe`, and `Forward.Email_<version>_x64-setup.exe.sig`
- **Windows arm64:** `Forward.Email_<version>_arm64-setup.exe` and `Forward.Email_<version>_arm64-setup.exe.sig`
- **Linux x64:** `Forward.Email_<version>_amd64.AppImage`, `Forward.Email_<version>_amd64.deb`, `Forward.Email-<version>-1.x86_64.rpm`, and each file's matching `.sig` sidecar
- **Linux arm64:** `Forward.Email_<version>_arm64.deb`, `Forward.Email-<version>-1.aarch64.rpm`, and each file's matching `.sig` sidecar

`latest.json` is the Tauri updater manifest. The unified release workflow also publishes `SHA256SUMS.txt` over every release asset present before checksum generation. Each `.sig` file contains the Minisign signature used by the auto-updater to verify integrity. A normal release fails before building when `TAURI_SIGNING_PRIVATE_KEY` is missing; if updater artifacts are absent, confirm that the signing key was available and that the break-glass `ALLOW_NO_UPDATER` variable was not enabled.
