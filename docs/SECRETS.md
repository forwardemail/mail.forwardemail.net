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

Distribution target is **TestFlight** (App Store Connect). `APPLE_TEAM_ID` is shared with the macOS desktop flow. The iOS job in [`release-mobile.yml`](../.github/workflows/release-mobile.yml) is secret-gated — when any of these are missing the job skips with a warning and does not block the desktop/Android release.

| Secret                            | Description                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `IOS_CERTIFICATE_BASE64`          | Base64-encoded `.p12` **Apple Distribution** certificate (not Developer ID — that's macOS-only) |
| `IOS_CERTIFICATE_PASSWORD`        | Password for the iOS `.p12` certificate                                                         |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64-encoded `.mobileprovision` (type: **App Store** distribution)                            |
| `APP_STORE_CONNECT_API_KEY`       | Full contents of the `AuthKey_XXXXXXXXXX.p8` file including BEGIN/END lines                     |
| `APP_STORE_CONNECT_KEY_ID`        | 10-character Key ID from App Store Connect → Users and Access → Integrations                    |
| `APP_STORE_CONNECT_ISSUER_ID`     | Issuer UUID shown above the API keys table (same for every key in your account)                 |

**Optional variables** (repo-level under Settings → Variables, not Secrets):

| Variable               | Default              | Description                                                                                           |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `IOS_SIGNING_IDENTITY` | `Apple Distribution` | Override the `CODE_SIGN_IDENTITY` / `signingCertificate` — rarely needed unless you use a legacy cert |

If your existing `APPLE_CERTIFICATE` p12 already contains an Apple Distribution cert alongside Developer ID, you can omit `IOS_CERTIFICATE_*` — the iOS job falls back to `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD`.

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

### Generating the Android Keystore

No Google/Android developer account is required for signing APKs. The keystore is self-managed. A [Google Play Developer account](https://play.google.com/console/) ($25 one-time) is only needed for Play Store distribution.

```bash
# Generate a new keystore with a signing key
keytool -genkeypair \
  -v \
  -keystore forwardemail.jks \
  -alias forwardemail \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass <choose-a-strong-password> \
  -keypass <choose-a-strong-password> \
  -dname "CN=Forward Email, O=Forward Email LLC, L=Austin, ST=Texas, C=US"

# Encode for GitHub Secrets
base64 -i forwardemail.jks | pbcopy   # macOS — copies to clipboard
base64 -w 0 forwardemail.jks          # Linux — prints to stdout
```

Then add the following secrets to the `release` environment in GitHub:

| Secret                      | Value                                   |
| --------------------------- | --------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | Output of the `base64` command above    |
| `ANDROID_KEYSTORE_PASSWORD` | The password you chose for `-storepass` |
| `ANDROID_KEY_ALIAS`         | `forwardemail`                          |
| `ANDROID_KEY_PASSWORD`      | The password you chose for `-keypass`   |

> **Important**: Back up the `.jks` file securely (e.g., 1Password vault). If lost, you cannot update apps signed with it on the Play Store. For GitHub Releases / sideloading, a new key can be generated, but users will see an "untrusted update" warning.

The signing config in `build.gradle.kts` reads these values from environment variables at build time. When the env vars are absent (local development), the build produces an unsigned APK.

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
`Settings → Secrets and variables → Actions → Environments → release`

The CI workflows will fail with clear error messages if any required secret is missing.

The deployment secrets are used by [`deploy.yml`](../.github/workflows/deploy.yml), which runs when a GitHub Release is published. The signing secrets are used by [`release-desktop.yml`](../.github/workflows/release-desktop.yml) and [`release-mobile.yml`](../.github/workflows/release-mobile.yml).

## Related Documentation

- [RELEASES.md](./RELEASES.md) — Full release process documentation
- [SECURITY.md](./SECURITY.md) — Code signing verification and supply chain protections
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup instructions
