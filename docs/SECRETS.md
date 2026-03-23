# GitHub Secrets Configuration

This document lists all GitHub Secrets required for the CI/CD workflows to build, sign, and release the Forward Email desktop and mobile applications.

## Desktop Signing Secrets

### macOS

| Secret                       | Description                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `APPLE_CERTIFICATE`          | Base64-encoded `.p12` Developer ID Application certificate                                 |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` certificate                                                        |
| `APPLE_SIGNING_IDENTITY`     | Signing identity string (e.g., `Developer ID Application: Forward Email LLC (XXXXXXXXXX)`) |
| `APPLE_ID`                   | Apple ID email used for notarization                                                       |
| `APPLE_PASSWORD`             | App-specific password for notarization (generate at appleid.apple.com)                     |
| `APPLE_TEAM_ID`              | Apple Developer Team ID (10-character alphanumeric)                                        |

### Windows

| Secret                         | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| `WINDOWS_CERTIFICATE`          | Base64-encoded `.pfx` code signing certificate |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the `.pfx` certificate            |

### Tauri Updater

| Secret                               | Description                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | Private key for signing Tauri update bundles (generated via `tauri signer generate`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the Tauri signing private key                                           |

## Mobile Signing Secrets

### Android

| Secret                      | Description                         |
| --------------------------- | ----------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | Base64-encoded `.jks` keystore file |
| `ANDROID_KEYSTORE_PASSWORD` | Password for the keystore           |
| `ANDROID_KEY_ALIAS`         | Key alias within the keystore       |
| `ANDROID_KEY_PASSWORD`      | Password for the key alias          |

### iOS

| Secret                            | Description                                        |
| --------------------------------- | -------------------------------------------------- |
| `IOS_CERTIFICATE_BASE64`          | Base64-encoded `.p12` iOS Distribution certificate |
| `IOS_CERTIFICATE_PASSWORD`        | Password for the iOS `.p12` certificate            |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64-encoded `.mobileprovision` file             |

## Deployment Secrets (Cloudflare / R2)

| Secret                 | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `R2_ACCOUNT_ID`        | Cloudflare account ID (also used for Workers)   |
| `R2_ACCESS_KEY_ID`     | R2 API access key                               |
| `R2_SECRET_ACCESS_KEY` | R2 API secret key                               |
| `CLOUDFLARE_ZONE_ID`   | Zone ID for cache purge                         |
| `CLOUDFLARE_API_TOKEN` | API token with R2 + Workers + Cache permissions |

**GitHub Variables:**

| Variable    | Description                      |
| ----------- | -------------------------------- |
| `R2_BUCKET` | R2 bucket name for static assets |

## General

| Secret         | Description                                                                        |
| -------------- | ---------------------------------------------------------------------------------- |
| `GITHUB_TOKEN` | Automatically provided by GitHub Actions for release creation and artifact uploads |

## Setup Instructions

### Generating the Tauri Signing Key

```bash
# Install the Tauri CLI
cargo install tauri-cli

# Generate a new signing key pair
cargo tauri signer generate -w ~/.tauri/forwardemail.key

# The public key goes in tauri.conf.json → plugins.updater.pubkey
# The private key and password go in GitHub Secrets
```

### Encoding Certificates as Base64

```bash
# macOS
base64 -i certificate.p12 | pbcopy

# Linux
base64 -w 0 certificate.p12

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx"))
```

### Verifying Secrets Are Set

All required secrets can be verified in the repository settings at:
`Settings → Secrets and variables → Actions`

The CI workflows will fail with clear error messages if any required secret is missing.

The deployment secrets are used by [`deploy.yml`](../.github/workflows/deploy.yml), which runs when a GitHub Release is published. The signing secrets are used by [`release-desktop.yml`](../.github/workflows/release-desktop.yml) and [`release-mobile.yml`](../.github/workflows/release-mobile.yml).

## Related Documentation

- [RELEASES.md](./RELEASES.md) — Full release process documentation
- [SECURITY.md](./SECURITY.md) — Code signing verification and supply chain protections
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup instructions
