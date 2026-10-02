# GitHub Secrets Configuration

This document lists every secret and variable that the CI/CD workflows use to build, sign, upload, and deploy the Forward Email desktop and mobile applications. Store all signing material in the **`release`** GitHub Actions environment unless noted otherwise.

## Where each value belongs

Open **Settings → Secrets and variables → Actions** in the GitHub repository, then use the locations below.

| Location                                | Put here                                                                                  | Used by                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Environment secrets** → `release`     | Certificates, private keys, passwords, deployment tokens, and store credentials           | `release.yml`, `release-desktop.yml`, `release-mobile.yml`, `deploy.yml`   |
| **Repository secrets**                  | Optional `MATRIX_TOKEN`; notification jobs do not attach the `release` environment        | `release.yml`, `matrix-all-github-activity-notification.yml`               |
| **Repository or environment variables** | Non-secret build and deployment values such as bucket, VAPID, Play, and signing overrides | `release.yml`, `release-desktop.yml`, `release-mobile.yml`, `deploy.yml`   |
| **Repository variables**                | Break-glass `ALLOW_NO_UPDATER` override                                                   | `release-desktop.yml`                                                      |
| **Automatic GitHub secret**             | `GITHUB_TOKEN` only                                                                       | Release creation, reusable workflows, deployment, and release asset upload |

GitHub Actions provides `GITHUB_TOKEN` automatically. Do not create it manually.

> **Current state (verified 2026-09-13):** every signing and deployment secret is stored as a **repository** secret; the `release` environment holds only a duplicate `IOS_PROVISIONING_PROFILE_BASE64`. Jobs that declare `environment: release` still resolve repository secrets, so releases work, but environment protection rules (required reviewers, branch restrictions) protect nothing until the values are moved. Migrate by re-adding each value with `gh secret set NAME --env release` and then deleting the repository copy; secret values cannot be copied through the API, so this needs the original material.

## Quick reference

### Desktop signing and updater secrets

| Name                                 | Type     | Required             | Purpose                                                                                                          |
| ------------------------------------ | -------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Secret   | Yes                  | Private key used to sign Tauri updater bundles and generate `.sig` files                                         |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret   | Yes                  | Password chosen when generating the updater private key                                                          |
| `APPLE_CERTIFICATE`                  | Secret   | Yes for macOS rows   | Base64-encoded macOS `.p12` certificate for desktop code signing                                                 |
| `APPLE_CERTIFICATE_PASSWORD`         | Secret   | Yes for macOS rows   | Password used when exporting the macOS `.p12`                                                                    |
| `APPLE_SIGNING_IDENTITY`             | Secret   | Yes for macOS rows   | macOS signing identity string such as `Developer ID Application: ...`                                            |
| `APPLE_ID`                           | Secret   | Yes for macOS rows   | Apple ID email used for notarization                                                                             |
| `APPLE_PASSWORD`                     | Secret   | Yes for macOS rows   | App-specific password used for notarization                                                                      |
| `APPLE_TEAM_ID`                      | Secret   | Yes for macOS rows   | Apple Developer Team ID used by desktop notarization and shared with iOS                                         |
| `MACOS_PROVISIONING_PROFILE_BASE64`  | Secret   | For macOS push       | Base64 Developer ID provisioning profile granting Push Notifications; see docs/PUSH_NOTIFICATIONS.md             |
| `MACOS_PUSH_REQUIRED`                | Variable | No                   | Set to `true` once the profile exists so a missing profile fails the macOS rows instead of shipping without push |
| `ESIGNER_USERNAME`                   | Secret   | Yes for Windows rows | SSL.com account username (eSigner cloud signing)                                                                 |
| `ESIGNER_PASSWORD`                   | Secret   | Yes for Windows rows | SSL.com account password                                                                                         |
| `ESIGNER_CREDENTIAL_ID`              | Secret   | Yes for Windows rows | eSigner credential ID of the code-signing certificate                                                            |
| `ESIGNER_TOTP_SECRET`                | Secret   | Yes for Windows rows | eSigner secret code shown with the certificate's QR code (not a 6-digit code, not the PIN)                       |
| `WINDOWS_PUBLISHER`                  | Variable | No                   | Legal name on the certificate when it differs from `bundle.publisher` (`Forward Email LLC`)                      |
| `WINDOWS_SIGN_NSIS_PLUGINS`          | Variable | No                   | Set to `false` to skip signing the NSIS plugin DLLs (saves 10 signings per release)                              |
| `ALLOW_UNSIGNED_WINDOWS`             | Variable | No                   | Break-glass: `true` ships unsigned Windows installers when the eSigner secrets are missing                       |

The updater signing key is required for normal production desktop releases. The workflow fails closed when `TAURI_SIGNING_PRIVATE_KEY` is absent unless the break-glass `ALLOW_NO_UPDATER=true` repository variable is set; that override intentionally omits updater artifacts and should not be left enabled. Every macOS release row also fails closed unless all six Apple signing and notarization secrets above are present, and every Windows row fails closed unless all four eSigner secrets are present (break-glass: `ALLOW_UNSIGNED_WINDOWS=true`).

### Mobile signing secrets

| Name                              | Type     | Required                                                         | Purpose                                                                           |
| --------------------------------- | -------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`         | Secret   | Yes for signed Android builds                                    | Base64-encoded Android signing keystore (`.jks`)                                  |
| `ANDROID_KEYSTORE_PASSWORD`       | Secret   | Yes for signed Android builds                                    | Keystore password                                                                 |
| `ANDROID_KEY_ALIAS`               | Secret   | Yes for signed Android builds                                    | Key alias inside the keystore                                                     |
| `ANDROID_KEY_PASSWORD`            | Secret   | Yes for signed Android builds                                    | Password for the selected key alias                                               |
| `IOS_CERTIFICATE_BASE64`          | Secret   | Optional if `APPLE_CERTIFICATE` also contains Apple Distribution | Base64-encoded iOS **Apple Distribution** `.p12`                                  |
| `IOS_CERTIFICATE_PASSWORD`        | Secret   | Optional if `APPLE_CERTIFICATE_PASSWORD` is reused               | Password used when exporting the iOS `.p12`                                       |
| `IOS_PROVISIONING_PROFILE_BASE64` | Secret   | Yes for TestFlight                                               | Base64-encoded App Store provisioning profile (`.mobileprovision`)                |
| `APP_STORE_CONNECT_API_KEY`       | Secret   | Yes for TestFlight                                               | Full contents of the downloaded `AuthKey_XXXXXXXXXX.p8` file                      |
| `APP_STORE_CONNECT_KEY_ID`        | Secret   | Yes for TestFlight                                               | Key ID shown by App Store Connect for the API key                                 |
| `APP_STORE_CONNECT_ISSUER_ID`     | Secret   | Yes for TestFlight                                               | Issuer UUID shown in App Store Connect                                            |
| `IOS_SIGNING_IDENTITY`            | Variable | Optional                                                         | Override for the iOS signing identity; defaults to `Apple Distribution`           |
| `IOS_ENCRYPTION_COMPLIANCE_CODE`  | Variable | Only once the app is offered in France                           | Code Apple issues for the French encryption declaration (see `docs/ios-setup.md`) |

### Mobile push build inputs

| Name                          | Type                | Required                                                        | Purpose                                                                                  |
| ----------------------------- | ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`            | Repository variable | Yes for the Android release and every UnifiedPush-capable build | Public half of the backend VAPID pair embedded for UnifiedPush subscription registration |
| `GOOGLE_SERVICES_JSON_BASE64` | `release` secret    | Yes for the single dual-provider job in `release-mobile.yml`    | One-line base64 encoding of the Firebase Android app’s `google-services.json`            |

The Android application never receives the backend `VAPID_PRIVATE_KEY` or Firebase service-account JSON. Those remain backend-only production credentials.

### Google Play upload inputs

| Name                          | Type                | Required                           | Purpose                                                                                     |
| ----------------------------- | ------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `GOOGLE_PLAY_SERVICE_ACCOUNT` | `release` secret    | Optional; required for Play upload | Full Google Play Console service-account JSON authorized to publish `net.forwardemail.mail` |
| `PLAY_TRACK`                  | Repository variable | Optional; defaults to `internal`   | Google Play track that receives the release AAB                                             |

The Play upload credential is separate from both Firebase files. It authorizes publishing in
Google Play Console; it is not used for FCM delivery and must not be embedded in the application.
When `GOOGLE_PLAY_SERVICE_ACCOUNT` is absent, the workflow still publishes the signed APK and AAB
to the GitHub Release and skips only the Play upload.

### Distribution store and repository inputs

| Name                          | Type                             | Required                                                    | Purpose                                                                                               |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SNAPCRAFT_STORE_CREDENTIALS` | `release` secret                 | Required only when Snap Store publishing is enabled         | Contents exported by `snapcraft export-login`, scoped to `forwardemail-mail`                          |
| `PUBLISH_SNAP_STORE`          | Repository or `release` variable | No; set to `true` to enable                                 | Sends the release Snap to the Snap Store `stable` channel                                             |
| `FDROID_KEYSTORE_BASE64`      | `release` secret                 | Required only when F-Droid repository publishing is enabled | Base64-encoded dedicated PKCS#12 key used to sign F-Droid repository indexes                          |
| `FDROID_KEYSTORE_PASSWORD`    | `release` secret                 | Required only when F-Droid repository publishing is enabled | Password for the F-Droid keystore and `forwardemail-fdroid-repo` alias                                |
| `FDROID_REPOSITORY_URL`       | Repository or `release` variable | Optional                                                    | Public HTTPS `/fdroid/repo` URL embedded in the generated index; defaults to project GitHub Pages     |
| `PUBLISH_FDROID_REPOSITORY`   | Repository or `release` variable | No; set to `true` to enable                                 | Deploys the signed self-hosted F-Droid-compatible repository through GitHub Pages                     |
| `HOMEBREW_TAP_TOKEN`          | `release` secret                 | Required only when Homebrew tap automation is enabled       | Fine-grained token or GitHub App token with write and pull-request access only to the first-party tap |
| `HOMEBREW_TAP_REPOSITORY`     | Repository or `release` variable | Optional                                                    | Target tap; defaults to `forwardemail/homebrew-forwardemail`                                          |
| `PUBLISH_HOMEBREW_TAP`        | Repository or `release` variable | No; set to `true` to enable                                 | Opens or refreshes the versioned cask pull request in the target tap                                  |
| `NPM_TOKEN`                   | `release` secret                 | Only without trusted publishing, and for manual CLI runs    | npm granular token for `forwardemail`; see [npm publishing](#npm-publishing-for-the-terminal-client)  |

The `PUBLISH_*` controls must stay unset until each channel's account, review process, and credentials are ready. When a control is `true`, the release summary treats a failed corresponding lane as a release failure. Flathub does not use a source-repository secret: after the initial submission is accepted, its External Data Checker operates in the separate `flathub/net.forwardemail.mail` repository.

### Deployment secrets and variables

| Name                   | Type     | Required            | Purpose                                                       |
| ---------------------- | -------- | ------------------- | ------------------------------------------------------------- |
| `R2_ACCOUNT_ID`        | Secret   | Yes for web deploys | Cloudflare account ID                                         |
| `R2_ACCESS_KEY_ID`     | Secret   | Yes for web deploys | R2 API access key                                             |
| `R2_SECRET_ACCESS_KEY` | Secret   | Yes for web deploys | R2 API secret key                                             |
| `CLOUDFLARE_ZONE_ID`   | Secret   | Yes for cache purge | Cloudflare zone ID                                            |
| `CLOUDFLARE_API_TOKEN` | Secret   | Yes for deploys     | Cloudflare API token with Workers, R2, and cache-purge access |
| `R2_BUCKET`            | Variable | Yes for web deploys | Bucket name that stores built static assets                   |

### Release control and notification inputs

| Name                        | Type                             | Required | Purpose                                                                                        |
| --------------------------- | -------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `ALLOW_NO_UPDATER`          | Repository variable              | No       | Emergency override; `true` permits desktop release artifacts without Tauri updater signatures  |
| `MATRIX_TOKEN`              | Repository secret                | No       | Matrix access token used by the release summary and repository-activity notification workflows |
| `PUBLISH_SNAP_STORE`        | Repository or `release` variable | No       | Enables automated Snap Store stable-channel publication                                        |
| `PUBLISH_FDROID_REPOSITORY` | Repository or `release` variable | No       | Enables signed F-Droid repository publication to GitHub Pages                                  |
| `PUBLISH_HOMEBREW_TAP`      | Repository or `release` variable | No       | Enables first-party Homebrew tap pull-request automation                                       |
| `WEB_INSPECTOR`             | Repository variable              | No       | `true` compiles the web inspector into release builds; leave unset for store releases          |

Leave `ALLOW_NO_UPDATER` and `WEB_INSPECTOR` unset during normal operation; on iOS the web inspector uses a private WebKit key that App Review rejects. `ALLOW_NO_UPDATER` exists only to unblock an intentional non-updatable desktop release when updater signing is unavailable. Because the Matrix jobs do not attach the `release` environment, `MATRIX_TOKEN` must be a repository Actions secret rather than an environment-only secret. When it is absent, release artifacts and deployment are unaffected; only Matrix delivery is skipped.

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

Windows installers, and the terminal client's Windows executables, are Authenticode-signed with an SSL.com code-signing certificate through **eSigner**, SSL.com's cloud signing service. The private key of a publicly trusted code-signing certificate must stay in a hardware security module, so there is no `.pfx` to export: eSigner keeps the key, and CI signs through it without any manual step.

| Name                        | Type                | Purpose                                                                                  |
| --------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `ESIGNER_USERNAME`          | `release` secret    | SSL.com account username                                                                 |
| `ESIGNER_PASSWORD`          | `release` secret    | SSL.com account password                                                                 |
| `ESIGNER_CREDENTIAL_ID`     | `release` secret    | eSigner credential ID of the code-signing certificate                                    |
| `ESIGNER_TOTP_SECRET`       | `release` secret    | eSigner secret code for one-time passwords, so signing needs no phone                    |
| `WINDOWS_PUBLISHER`         | Repository variable | Optional. Certificate legal name when it is not `Forward Email LLC`                      |
| `WINDOWS_SIGN_NSIS_PLUGINS` | Repository variable | Optional. `false` skips the NSIS plugin DLLs                                             |
| `ALLOW_UNSIGNED_WINDOWS`    | Repository variable | Optional break-glass. `true` lets a release without the secrets ship unsigned installers |

#### How signing works in CI

1. `Setup Java (CodeSignTool)` installs Temurin 21. SSL.com's CodeSignTool is a Java program.
2. `Configure Windows signing (SSL.com eSigner)` runs `scripts/windows-signing.cjs setup`. It checks the secrets, downloads the pinned CodeSignTool release and checks its SHA-256, and confirms the credentials with `credential_info`, which does not use up a signing. Then it sets `bundle.windows.signCommand` in `tauri.conf.json`. If the secrets are wrong, the row fails here, before the Rust build.
3. During `tauri build`, the bundler calls `scripts/windows-signing.cjs sign <file>` for each file it signs: the app binary (once per installer type), the NSIS plugin DLLs, the NSIS uninstaller, and the finished `.msi` and `-setup.exe`. CodeSignTool hashes the file locally, eSigner signs the hash, and the signature is timestamped by `ts.ssl.com`. The script then confirms each file has a valid, timestamped signature from the expected publisher. If signing fails, the build fails. Transient errors are retried. After a refused login, or a one-time password refused in four separate 30-second windows, signing stops for the rest of the job, so retries cannot lock the account. The script also refuses to sign an NSIS installer whose uninstaller was not signed, so such an installer is never uploaded.
4. `Verify Windows signatures` runs `scripts/windows-signing.cjs verify` on the bundle directory. It checks every installer and, where the runner can unpack it (7-Zip for NSIS, `msiexec` for MSI), every executable inside it. It also reads the signing log to confirm that the uninstaller in the shipped NSIS installer was signed; NSIS ignores the exit code of the uninstaller signing command. If a Windows row fails, `Show Windows signing log` prints the reason, because the Tauri bundler hides the signing command's output.

The WiX extension DLLs that Tauri also passes to the signing command run only on the build machine, so they are skipped.

The terminal client (`release-cli.yml`) runs the same `setup` on its two Windows rows and then `scripts/windows-signing.cjs sign` on `forwardemail-win-x64.exe` and `forwardemail-win-arm64.exe` before they are compressed and uploaded, with the same checks and the same `ALLOW_UNSIGNED_WINDOWS` break-glass.

#### Signing volume

eSigner plans include a fixed number of signings per month, and unused signings carry over. A normal release uses about 20:

| Row           | Signed files                                                                    | Signings |
| ------------- | ------------------------------------------------------------------------------- | -------- |
| Windows-x64   | app binary ×2 (MSI and NSIS), 5 NSIS plugins, uninstaller, `.msi`, `-setup.exe` | 10       |
| Windows-arm64 | app binary, 5 NSIS plugins, uninstaller, `-setup.exe`                           | 8        |
| CLI win-x64   | `forwardemail-win-x64.exe`                                                      | 1        |
| CLI win-arm64 | `forwardemail-win-arm64.exe`                                                    | 1        |

`WINDOWS_SIGN_NSIS_PLUGINS=false` brings a release down to 10 signings. Re-running a failed Windows row signs everything again. The `Verify Windows signatures` step prints the number of signings each row used.

#### One-time setup

1. **Enroll the certificate in eSigner.** In the SSL.com account, open **Orders**, then the code-signing certificate's **details**. Under **eSigner Cloud Signing Enrollment**, choose **OTP APP** as the second factor, set a 4-digit PIN, and click **create OTP and issue certificate**. Skip this step if the certificate already shows **eSigner active** with the OTP app. Signing by SMS needs a person to type the code, so a certificate enrolled with **OTP SMS** must be switched to the OTP app; SSL.com support can do this if the page does not offer it.
2. **Copy the secret code.** eSigner shows a QR code together with a **secret code**. Save the secret code; it becomes `ESIGNER_TOTP_SECRET`. You can also scan the QR code into an authenticator app for manual signing, since both use the same secret. To see the code again, enter the PIN and click **Show QR Code** on the same page. **Reset QR Code** issues a new secret and invalidates the old one, so update the GitHub secret after a reset.
3. **Copy the credential ID.** The **SIGNING CREDENTIALS** section of the order lists the **eSigner credential ID**, a UUID such as `8b072e22-7685-4771-b5c6-48e46614915f`. It becomes `ESIGNER_CREDENTIAL_ID`. With CodeSignTool installed locally, `CodeSignTool get_credential_ids -username=... -password=...` prints it as well.
4. **Add the secrets.** In GitHub, open **Settings → Environments → release** and add `ESIGNER_USERNAME`, `ESIGNER_PASSWORD`, `ESIGNER_CREDENTIAL_ID` and `ESIGNER_TOTP_SECRET`. Use the username and password you sign in to SSL.com with.
5. **Check the publisher name.** The workflow requires the certificate's CN or O to equal `bundle.publisher` in `src-tauri/tauri.conf.json` (`Forward Email LLC`). If the certificate shows a different legal name, for example `Forward Email, LLC`, set the repository variable `WINDOWS_PUBLISHER` to that exact name.
6. **Pick a plan with enough signings.** At about 20 signings per release, pick the eSigner tier for the number of releases you expect each month. Change tiers in the SSL.com account.
7. **Release.** The next release signs automatically. On Windows, confirm the result:

   ```powershell
   Get-AuthenticodeSignature '.\Forward Email_<version>_x64-setup.exe' | Format-List Status, SignerCertificate, TimeStamperCertificate
   ```

   `Status` must be `Valid`, and the signer must be Forward Email.

#### Troubleshooting

- **`eSigner rejected the credentials`** in the configure step: wrong `ESIGNER_USERNAME`, `ESIGNER_PASSWORD` or `ESIGNER_CREDENTIAL_ID`.
- **`authorization grant is invalid`**: SSL.com rejected the username or password. The configure step checks these first, so seeing this while signing means the password changed during the run.
- **An OTP error while signing**: `ESIGNER_TOTP_SECRET` is wrong or was reset. Copy the current secret code again.
- **`does not look like the eSigner secret code`**: `ESIGNER_TOTP_SECRET` holds a 6-digit code or the PIN instead of the secret code.
- **`signed by "…", not "Forward Email LLC"`**: set `WINDOWS_PUBLISHER` to the name on the certificate.
- **Signing stops with a balance or quota error**: the plan is out of signings. Upgrade the tier or wait for the next month, then re-run the Windows rows.

#### SmartScreen

A valid signature is necessary but not sufficient. SmartScreen builds reputation from download history, for each file and for the signing publisher. A new certificate can still show "Windows protected your PC" on early downloads until enough people have installed signed releases. Keep signing every release with the same certificate so that reputation carries over. EV certificates no longer skip this step. Publishing to the Microsoft Store avoids the prompt entirely. See [SmartScreen reputation for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

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

### Android push build inputs

Generate one stable VAPID key pair in the `forwardemail.net` repository:

```bash
pnpm exec web-push generate-vapid-keys
```

Store the generated public value as the repository Actions variable `VAPID_PUBLIC_KEY`. It must exactly equal the backend environment value of the same name. The generated private value is the backend-only `VAPID_PRIVATE_KEY`; never add it to this repository, GitHub Actions, an APK/AAB, or a CI log.

For the dual-provider GitHub/Google Play release, open the [Firebase console](https://console.firebase.google.com/), select the same project used by backend FCM delivery, and register the Android application ID `net.forwardemail.mail`. Download `google-services.json` from **Project settings → General → Your apps**, then encode it as one line:

```bash
# macOS and Linux
base64 < /absolute/path/google-services.json | tr -d '\n'
```

Store that output as the `release` environment secret `GOOGLE_SERVICES_JSON_BASE64`. The release preflight requires this value together with all Android signing values and the repository variable `VAPID_PUBLIC_KEY` before it installs Rust, Java, Android, or Node toolchains. Local dual-provider builds use the original file rather than the encoded secret:

```bash
VAPID_PUBLIC_KEY='BN...' \
GOOGLE_SERVICES_JSON=/absolute/path/google-services.json \
  pnpm tauri:android:build:play -- --aab
```

Google-free downstream and F-Droid builds still require `VAPID_PUBLIC_KEY`, but they do not use Firebase and are not emitted as a second GitHub release APK:

```bash
VAPID_PUBLIC_KEY='BN...' pnpm tauri:android:build:fdroid -- --apk
```

> `google-services.json` is Firebase client configuration. The backend’s `firebase-service-account.json` is a private server credential and must never be substituted here or embedded in a client artifact.

See [`PUSH_NOTIFICATIONS.md`](./PUSH_NOTIFICATIONS.md) for provider architecture, profile behavior, backend handoff, and device validation.

### Google Play publishing

Create a service account in Google Play Console, grant it permission to publish the
`net.forwardemail.mail` application, and store the complete JSON key as the `release` environment
secret `GOOGLE_PLAY_SERVICE_ACCOUNT`. Set the optional repository or environment variable
`PLAY_TRACK` to the target track; when omitted, `release-mobile.yml` uploads to `internal`.

This is not the backend `firebase-service-account.json` and not the client
`google-services.json`. Keep all three files separate because they authorize different systems.

### iOS TestFlight signing secrets

The iOS release job builds a signed IPA and uploads it to TestFlight. It runs on `macos-26` and explicitly selects the latest stable Xcode toolchain so the active iPhoneOS SDK satisfies Apple’s current submission requirement.

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

### Snap Store credentials

Reserve `forwardemail-mail` under the approved publisher account before enabling automation. On a trusted workstation with [Snapcraft](https://github.com/canonical/snapcraft) installed and authenticated, export a restricted, expiring macaroon:

```bash
snapcraft export-login \
  --snaps=forwardemail-mail \
  --channels=stable \
  --acls=package_access,package_push,package_update,package_release \
  --expires=2027-08-12 \
  forwardemail-snapcraft-login.txt
```

Paste the entire resulting file into the `release` environment secret `SNAPCRAFT_STORE_CREDENTIALS`, securely delete the local file, and then set `PUBLISH_SNAP_STORE=true`. Rotate the secret before its expiry with a newly exported, restricted credential. The public build job still uploads a `.snap` asset even while the store-publish variable is not enabled.

### F-Droid repository signing inputs

Create a dedicated repository-index key; it must not be the Android application signing key. The workflow has a fixed alias, so use this command exactly and keep an encrypted offline backup of the resulting `.p12` file:

```bash
keytool -genkeypair \
  -keystore forwardemail-fdroid-repo.p12 \
  -storetype PKCS12 \
  -alias forwardemail-fdroid-repo \
  -keyalg RSA -keysize 4096 -validity 3650 \
  -dname "CN=Forward Email F-Droid Repository, O=Forward Email LLC, C=US"

keytool -list -v -keystore forwardemail-fdroid-repo.p12 \
  -alias forwardemail-fdroid-repo
base64 -w 0 forwardemail-fdroid-repo.p12
```

Store the last command's one-line output as `FDROID_KEYSTORE_BASE64` and the chosen password as `FDROID_KEYSTORE_PASSWORD`, both in the `release` environment. Record the SHA-256 certificate fingerprint from the `keytool -list` output separately for public user verification. Enable **Settings → Pages → GitHub Actions** and then set `PUBLISH_FDROID_REPOSITORY=true`. `FDROID_REPOSITORY_URL` may be omitted for the default project Pages URL, or set to the final HTTPS `/fdroid/repo` URL before the first publication.

### Homebrew tap automation credentials

Create `forwardemail/homebrew-forwardemail` with `Casks/forward-email.rb` from the source repository's `homebrew/` directory. Then create a fine-grained personal access token or GitHub App installation token limited to the tap repository, with **Contents: read/write** and **Pull requests: read/write**. Store it as `HOMEBREW_TAP_TOKEN` in the `release` environment, set `HOMEBREW_TAP_REPOSITORY` if the non-default repository is used, and finally set `PUBLISH_HOMEBREW_TAP=true`.

The token must be able to create a pull request, not merely push commits. This is why `GITHUB_TOKEN` is not used: it cannot independently authorize cross-repository writes to the tap. The updater downloads the release's two macOS DMGs and calculates their SHA-256 hashes itself before it opens the PR.

### npm publishing for the terminal client

The `npm` job of `release-cli.yml` publishes the `forwardemail` package. It needs one of two ways to sign in to npm. Trusted publishing is preferred: there is no token to leak, rotate or renew.

**Trusted publishing (recommended).** The `forwardemail` package already exists on npm, so this can be set up before the first release:

1. Sign in to [npmjs.com](https://www.npmjs.com) with an account that maintains `forwardemail`, and open the package's **Settings** tab.
2. Under **Trusted Publisher**, choose **GitHub Actions** and enter organization `forwardemail`, repository `mail.forwardemail.net`, workflow filename `release.yml` and environment `release`. npm checks the workflow that started the run, and `release.yml` calls `release-cli.yml`, so the filename is `release.yml`.
3. Save. Under **Publishing access**, you can then choose to require two-factor authentication and disallow tokens.

A manual **Release CLI** run (from the Actions tab) starts from `release-cli.yml` instead, so npm does not trust it. It needs `NPM_TOKEN`, or publish that version by hand (`pnpm build:cli && cd cli && npm publish --access public`).

**A token.** Use one for manual runs, or instead of trusted publishing:

1. On npmjs.com, open your avatar › **Access Tokens** › **Generate New Token** › **Granular Access Token**.
2. Name it `mail.forwardemail.net release-cli`. Under **Packages and scopes**, choose **Read and write** for the `forwardemail` package only. Check **Bypass two-factor authentication**, since CI cannot answer a 2FA prompt. Set an expiration: npm allows at most 90 days for write tokens.
3. Copy the token (it is shown once). In GitHub, open **Settings › Environments › release › Environment secrets › Add environment secret**, name it `NPM_TOKEN` and paste the value. With the GitHub CLI: `gh secret set NPM_TOKEN --env release --repo forwardemail/mail.forwardemail.net`.
4. Put a reminder in your calendar before the expiration date. An expired token fails the `npm` job, and the rest of the release is unaffected. Re-run **Release CLI** for that version after replacing it.

The job reads the token as `NODE_AUTH_TOKEN` and passes `--provenance` either way. A version already on npm is skipped, so re-running is safe.

### Cloudflare and R2 deployment secrets

The web deployment pipeline uses Cloudflare R2 for static assets and Cloudflare Workers for serving and cache management.

| Name                                        | How to obtain it                                                                                    |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `R2_BUCKET`                                 | Create a bucket in Cloudflare R2 and use the bucket name as an Actions variable                     |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare Dashboard → R2 → Manage R2 API Tokens → Create API token                                 |
| `R2_ACCOUNT_ID`                             | Cloudflare Dashboard → right sidebar on any account or R2 page                                      |
| `CLOUDFLARE_ZONE_ID`                        | Cloudflare Dashboard → domain overview                                                              |
| `CLOUDFLARE_API_TOKEN`                      | My Profile → API Tokens → Create Token → Custom token with Workers, R2, and cache-purge permissions |

[deployment-checklist.md](./deployment-checklist.md) has a step-by-step walkthrough for the Cloudflare values.

## Verification checklist

After populating the values above, verify the setup in the following order.

| Check                                                                 | Expected result                                                                                                                   |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Settings → Secrets and variables → Actions → Environments → release` | All required signing, store, and deployment secrets are present in the `release` environment                                      |
| `Settings → Secrets and variables → Actions → Secrets`                | Optional `MATRIX_TOKEN` is a repository secret if Matrix delivery is enabled                                                      |
| `Settings → Secrets and variables → Actions → Variables`              | `VAPID_PUBLIC_KEY`, `R2_BUCKET`, and any needed `PLAY_TRACK`, `IOS_SIGNING_IDENTITY`, or enabled `PUBLISH_*` controls are present |
| Updater override                                                      | `ALLOW_NO_UPDATER` is absent or not `true` during normal production releases                                                      |
| Desktop release workflow                                              | `.sig` updater files are created; a missing updater key fails unless the break-glass override is explicit                         |
| iOS release workflow                                                  | The job does not skip, logs the active Xcode and iPhoneOS SDK, and uploads an IPA to TestFlight                                   |
| Android release workflow                                              | Exactly one dual-provider APK and one matching AAB are produced; missing release inputs fail at preflight                         |
| Android push configuration                                            | `VAPID_PUBLIC_KEY` equals the backend public key; the release decodes a valid `google-services.json`                              |
| Enabled Snap Store lane                                               | The scoped credential is present and `snap info forwardemail-mail` reports the release version                                    |
| Enabled F-Droid lane                                                  | GitHub Pages serves signed indexes at `/fdroid/repo` and the client fingerprint matches the recorded key                          |
| Enabled Homebrew lane                                                 | The tap PR contains the release version and both newly calculated DMG SHA-256 values                                              |

## Related documentation

- [PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md): Push provider setup, profile behavior, and cross-repository values
- [RELEASES.md](./RELEASES.md): End-to-end release orchestration and artifact outputs
- [ios-setup.md](./ios-setup.md): Local and CI iOS signing workflow details
- [desktop-ci-secrets.md](./desktop-ci-secrets.md): Desktop-focused signing notes
- [deployment-checklist.md](./deployment-checklist.md): Full Cloudflare and R2 deployment setup
- [SECURITY.md](./SECURITY.md): Code-signing trust and supply-chain notes
- [distribution-publishing.md](./distribution-publishing.md): Step-by-step Snap, Flathub, F-Droid, Homebrew, and Obtainium setup
