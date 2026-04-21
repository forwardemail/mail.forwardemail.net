# GitHub Secrets Configuration

This document is the canonical reference for every secret and variable used by the CI/CD workflows that build, sign, upload, and deploy the Forward Email desktop and mobile applications. All signing material should be stored in the **`release`** GitHub Actions environment unless noted otherwise.

## Where each value belongs

Open **Settings → Secrets and variables → Actions** in the GitHub repository, then use the locations below.

| Location                                | Put here                                                                       | Used by                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **Environment secrets** → `release`     | Certificates, private keys, passwords, API tokens, and signing credentials     | `release-desktop.yml`, `release-mobile.yml`, `deploy.yml` |
| **Repository or environment variables** | Non-secret values such as bucket names and optional signing-identity overrides | `deploy.yml`, `release-mobile.yml`                        |
| **Automatic GitHub secret**             | `GITHUB_TOKEN` only                                                            | Release creation and asset uploads                        |

`GITHUB_TOKEN` is provided automatically by GitHub Actions. Do not create it manually.

## Quick reference

### Desktop signing and updater secrets

| Name                                 | Type   | Required | Purpose                                                                  |
| ------------------------------------ | ------ | -------- | ------------------------------------------------------------------------ |
| `TAURI_SIGNING_PRIVATE_KEY`          | Secret | Yes      | Private key used to sign Tauri updater bundles and generate `.sig` files |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret | Yes      | Password chosen when generating the updater private key                  |
| `APPLE_CERTIFICATE`                  | Secret | Optional | Base64-encoded macOS `.p12` certificate for desktop code signing         |
| `APPLE_CERTIFICATE_PASSWORD`         | Secret | Optional | Password used when exporting the macOS `.p12`                            |
| `APPLE_SIGNING_IDENTITY`             | Secret | Optional | macOS signing identity string such as `Developer ID Application: ...`    |
| `APPLE_ID`                           | Secret | Optional | Apple ID email used for notarization                                     |
| `APPLE_PASSWORD`                     | Secret | Optional | App-specific password used for notarization                              |
| `APPLE_TEAM_ID`                      | Secret | Optional | Apple Developer Team ID used by desktop notarization and shared with iOS |
| `WINDOWS_CERTIFICATE`                | Secret | Optional | Base64-encoded exportable `.pfx` Windows code-signing certificate        |
| `WINDOWS_CERTIFICATE_PASSWORD`       | Secret | Optional | Password used when exporting the Windows `.pfx`                          |

### Mobile signing secrets

| Name                              | Type     | Required                                                         | Purpose                                                                 |
| --------------------------------- | -------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`         | Secret   | Yes for signed Android builds                                    | Base64-encoded Android signing keystore (`.jks`)                        |
| `ANDROID_KEYSTORE_PASSWORD`       | Secret   | Yes for signed Android builds                                    | Keystore password                                                       |
| `ANDROID_KEY_ALIAS`               | Secret   | Yes for signed Android builds                                    | Key alias inside the keystore                                           |
| `ANDROID_KEY_PASSWORD`            | Secret   | Yes for signed Android builds                                    | Password for the selected key alias                                     |
| `IOS_CERTIFICATE_BASE64`          | Secret   | Optional if `APPLE_CERTIFICATE` also contains Apple Distribution | Base64-encoded iOS **Apple Distribution** `.p12`                        |
| `IOS_CERTIFICATE_PASSWORD`        | Secret   | Optional if `APPLE_CERTIFICATE_PASSWORD` is reused               | Password used when exporting the iOS `.p12`                             |
| `IOS_PROVISIONING_PROFILE_BASE64` | Secret   | Yes for TestFlight                                               | Base64-encoded App Store provisioning profile (`.mobileprovision`)      |
| `APP_STORE_CONNECT_API_KEY`       | Secret   | Yes for TestFlight                                               | Full contents of the downloaded `AuthKey_XXXXXXXXXX.p8` file            |
| `APP_STORE_CONNECT_KEY_ID`        | Secret   | Yes for TestFlight                                               | Key ID shown by App Store Connect for the API key                       |
| `APP_STORE_CONNECT_ISSUER_ID`     | Secret   | Yes for TestFlight                                               | Issuer UUID shown in App Store Connect                                  |
| `IOS_SIGNING_IDENTITY`            | Variable | Optional                                                         | Override for the iOS signing identity; defaults to `Apple Distribution` |

### Deployment secrets and variables

| Name                   | Type     | Required            | Purpose                                                       |
| ---------------------- | -------- | ------------------- | ------------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | Secret   | Yes for web deploys | Cloudflare account ID                                         |
| `R2_ACCESS_KEY_ID`     | Secret   | Yes for web deploys | R2 API access key                                             |
| `R2_SECRET_ACCESS_KEY` | Secret   | Yes for web deploys | R2 API secret key                                             |
| `CLOUDFLARE_ZONE_ID`   | Secret   | Yes for cache purge | Cloudflare zone ID                                            |
| `CLOUDFLARE_API_TOKEN` | Secret   | Yes for deploys     | Cloudflare API token with Workers, R2, and cache-purge access |
| `R2_BUCKET`            | Variable | Yes for web deploys | Bucket name that stores built static assets                   |

## Generating and storing each value

### Tauri updater signing key

The desktop auto-updater requires a Tauri signing keypair. Generate it once, commit only the public key to `src-tauri/tauri.conf.json`, and store the private key in GitHub.

```bash
pnpm tauri signer generate -w ~/.tauri/forwardemail.key
cat ~/.tauri/forwardemail.key
```

Use the full contents of `~/.tauri/forwardemail.key` as `TAURI_SIGNING_PRIVATE_KEY`, and use the password you entered during generation as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### macOS desktop signing and notarization

For signed macOS desktop releases, create or download a **Developer ID Application** certificate in your Apple Developer account, install it in Keychain Access, and export it as a password-protected `.p12` file.

```bash
# macOS: encode the exported certificate for GitHub Secrets
base64 -i forwardemail-macos.p12 | pbcopy

# Linux: print a one-line base64 value instead
base64 -w 0 forwardemail-macos.p12
```

Add the base64 output to `APPLE_CERTIFICATE` and the export password to `APPLE_CERTIFICATE_PASSWORD`. Then capture the signing identity with:

```bash
security find-identity -v -p codesigning
```

Use the matching **Developer ID Application** entry as `APPLE_SIGNING_IDENTITY`. Set `APPLE_ID` to the Apple ID used for notarization, create an app-specific password at `appleid.apple.com` for `APPLE_PASSWORD`, and copy the 10-character Team ID from your Apple Developer membership page into `APPLE_TEAM_ID`.

### Windows code-signing secrets

The current desktop release workflow expects an **exportable `.pfx` file**. That means `WINDOWS_CERTIFICATE` must contain a base64-encoded `.pfx`, and `WINDOWS_CERTIFICATE_PASSWORD` must be the password used when that `.pfx` was exported.

If your certificate issuer provides a hardware token or cloud-signing workflow that cannot be exported as a `.pfx`, these two secrets are **not** sufficient by themselves. In that case you need issuer-specific signing integration or a custom signing command instead of the built-in `.pfx` flow.

If you already have an exportable `.pfx`, keep it and skip to the encoding step. Otherwise, use one of the flows below.

#### Export from the Windows certificate store

If the certificate is already installed in `Cert:\CurrentUser\My` and is exportable, export it with a password you choose:

```powershell
$PfxPassword = ConvertTo-SecureString -String 'choose-a-strong-password' -Force -AsPlainText
Export-PfxCertificate \
  -Cert Cert:\CurrentUser\My\<THUMBPRINT> \
  -FilePath .\forwardemail-windows.pfx \
  -Password $PfxPassword
```

#### Convert a `.cer` plus private key into `.pfx`

If your CA gave you a certificate file and a separate private key, you can convert them with OpenSSL:

```bash
openssl pkcs12 -export \
  -out forwardemail-windows.pfx \
  -inkey private-key.key \
  -in certificate.cer
```

OpenSSL will prompt you for an export password. That export password becomes `WINDOWS_CERTIFICATE_PASSWORD`.

#### Base64-encode the `.pfx`

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('forwardemail-windows.pfx'))
```

Store the resulting one-line base64 string as `WINDOWS_CERTIFICATE`. Store the password used to export the `.pfx` as `WINDOWS_CERTIFICATE_PASSWORD`.

If you also want to inspect or confirm the certificate thumbprint for local signing configuration, use:

```powershell
Get-PfxCertificate .\forwardemail-windows.pfx | Select-Object Thumbprint, Subject
```

### Android signing keystore

Android signing is self-managed. Generate the keystore once and back it up securely.

```bash
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

# macOS
base64 -i forwardemail.jks | pbcopy

# Linux
base64 -w 0 forwardemail.jks
```

Use the encoded keystore as `ANDROID_KEYSTORE_BASE64`, the keystore password as `ANDROID_KEYSTORE_PASSWORD`, the alias as `ANDROID_KEY_ALIAS`, and the key password as `ANDROID_KEY_PASSWORD`.

### iOS TestFlight signing secrets

The iOS release job builds a signed IPA and uploads it to TestFlight. It now runs on `macos-26` and explicitly selects the latest stable Xcode toolchain so the active iPhoneOS SDK satisfies Apple’s current submission requirement.

Start in the Apple Developer portal and App Store Connect:

| Value                             | Where to create it                                                             | What to store in GitHub                    |
| --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `IOS_CERTIFICATE_BASE64`          | Apple Developer → Certificates → **Apple Distribution** certificate            | Base64-encoded exported `.p12`             |
| `IOS_CERTIFICATE_PASSWORD`        | During `.p12` export from Keychain Access                                      | The `.p12` export password                 |
| `IOS_PROVISIONING_PROFILE_BASE64` | Apple Developer → Profiles → **App Store** profile for `net.forwardemail.mail` | Base64-encoded `.mobileprovision`          |
| `APP_STORE_CONNECT_API_KEY`       | App Store Connect → Users and Access → Integrations → App Store Connect API    | Full contents of the downloaded `.p8` file |
| `APP_STORE_CONNECT_KEY_ID`        | Same page as the API key                                                       | The displayed Key ID                       |
| `APP_STORE_CONNECT_ISSUER_ID`     | Same page as the API key list                                                  | The displayed Issuer ID                    |
| `APPLE_TEAM_ID`                   | Apple Developer membership details                                             | 10-character team ID                       |

Encode the iOS certificate and provisioning profile with the same base64 approach used above:

```bash
# macOS
base64 -i forwardemail-ios.p12 | pbcopy
base64 -i ForwardEmailAppStore.mobileprovision | pbcopy

# Linux
base64 -w 0 forwardemail-ios.p12
base64 -w 0 ForwardEmailAppStore.mobileprovision
```

For the App Store Connect API key, do **not** base64-encode it. Paste the full multi-line contents of the downloaded `AuthKey_XXXXXXXXXX.p8` file directly into `APP_STORE_CONNECT_API_KEY`.

If your existing `APPLE_CERTIFICATE` export already contains both the macOS Developer ID certificate and an Apple Distribution certificate, the workflow can reuse `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` and you may omit `IOS_CERTIFICATE_BASE64` and `IOS_CERTIFICATE_PASSWORD`.

### Cloudflare and R2 deployment secrets

The web deployment pipeline uses Cloudflare R2 for static assets and Cloudflare Workers for serving and cache management.

| Name                                        | How to obtain it                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `R2_BUCKET`                                 | Create a bucket in Cloudflare R2 and use the bucket name as an Actions variable                     |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare Dashboard → R2 → Manage R2 API Tokens → Create API token                                 |
| `R2_ACCOUNT_ID`                             | Cloudflare Dashboard → right sidebar on any account or R2 page                                      |
| `CLOUDFLARE_ZONE_ID`                        | Cloudflare Dashboard → domain overview                                                              |
| `CLOUDFLARE_API_TOKEN`                      | My Profile → API Tokens → Create Token → Custom token with Workers, R2, and cache-purge permissions |

A full step-by-step walkthrough for the Cloudflare values is in [deployment-checklist.md](./deployment-checklist.md).

## Verification checklist

After populating the values above, verify the setup in the following order.

| Check                                                                 | Expected result                                                                                 |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Settings → Secrets and variables → Actions → Environments → release` | All signing secrets are present in the `release` environment                                    |
| `Settings → Secrets and variables → Actions → Variables`              | `R2_BUCKET` and optional `IOS_SIGNING_IDENTITY` are present if needed                           |
| Desktop release workflow                                              | `.sig` updater files are created when the Tauri signing key is present                          |
| iOS release workflow                                                  | The job does not skip, logs the active Xcode and iPhoneOS SDK, and uploads an IPA to TestFlight |
| Android release workflow                                              | Signed `.apk` and `.aab` artifacts are produced                                                 |

## Related documentation

- [RELEASES.md](./RELEASES.md) — End-to-end release orchestration and artifact outputs
- [ios-setup.md](./ios-setup.md) — Local and CI iOS signing workflow details
- [desktop-ci-secrets.md](./desktop-ci-secrets.md) — Desktop-focused signing notes
- [deployment-checklist.md](./deployment-checklist.md) — Full Cloudflare and R2 deployment setup
- [SECURITY.md](./SECURITY.md) — Code-signing trust and supply-chain notes
