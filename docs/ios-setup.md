# iOS App — Developer Setup Guide

Target for iOS is Tauri v2 mobile. This guide covers simulator-first development with a free Apple ID; paid Developer Program work (TestFlight, ad-hoc sideload) is at the end.

## Prerequisites

| Tool         | Version | Notes                                                                                                                        |
| ------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **macOS**    | 13+     | iOS development is Mac-only                                                                                                  |
| **Xcode**    | 15+     | Install from App Store or [developer.apple.com](https://developer.apple.com/xcode/) — **not** just Command Line Tools        |
| **Rust**     | stable  | `rustup target add aarch64-apple-ios-sim x86_64-apple-ios` (device target `aarch64-apple-ios` only needed for signed builds) |
| **Node.js**  | 20+     |                                                                                                                              |
| **pnpm**     | 9+      | `corepack enable && corepack prepare pnpm@latest --activate`                                                                 |
| **Apple ID** | any     | Free account is sufficient for simulator + 7-day personal-device sideload                                                    |

## First-Time Setup

### 1. Install Xcode and a simulator runtime

```bash
# Install Xcode from the App Store, then point the toolchain at it:
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer

# Accept the license agreement once:
sudo xcodebuild -license accept

# Verify a simulator runtime is installed:
xcrun simctl list runtimes
```

If no iOS runtime is listed, open **Xcode → Settings → Platforms** and download one.

### 2. Install Rust iOS targets

```bash
rustup target add aarch64-apple-ios-sim x86_64-apple-ios
```

Add `aarch64-apple-ios` as well only when you intend to produce signed device builds.

### 3. Initialize the Tauri iOS project

`src-tauri/gen/` is git-ignored, so the iOS Xcode project is generated on demand:

```bash
pnpm tauri ios init
```

This creates `src-tauri/gen/apple/` containing the Xcode workspace, `Info.plist`, and Swift sources. Re-run this after pulling changes that alter `tauri.conf.json`'s `bundle.iOS` section or icon set.

The first run prompts for a **Development Team ID**. For simulator-only work any value works (or leave `developmentTeam: null` in `tauri.conf.json`). For device/TestFlight work, use your team's 10-character ID from [appleid.apple.com](https://appleid.apple.com) → Membership.

## Day-to-Day Development

### Run in simulator

```bash
pnpm tauri:ios:dev
```

The wrapper script (`scripts/ios-dev.sh`) verifies Xcode is selected, boots an iPhone simulator if none is running, then hands off to `tauri ios dev`. The Vite dev server on `localhost:5174` is reachable from the simulator without any tunnelling (unlike Android's `adb reverse`).

### Build an unsigned simulator `.app`

```bash
pnpm tauri:ios:build
```

Defaults to your host arch's simulator target (`aarch64-sim` on Apple Silicon, `x86_64-sim` on Intel). The resulting `.app` bundle lives under `src-tauri/gen/apple/build/<target>/` — drag it onto a running simulator window to install.

Pass through extra flags when you need a different target:

```bash
pnpm tauri:ios:build -- --target x86_64-sim
```

### Run on a physical device with a free Apple ID

1. Open the generated workspace: `open src-tauri/gen/apple/forwardemail_mail.xcworkspace`
2. Select the top-level project → **Signing & Capabilities** → sign in with your Apple ID and pick your **Personal Team**.
3. Plug in the device, select it as the run target, press ⌘R.

Apps signed with a free team expire after **7 days** and allow at most 3 apps per device. For longer-lived builds you need a paid Developer Program account — see the signed-build section below.

## Safe Areas / Notch / Dynamic Island

iOS WKWebView supports `env(safe-area-inset-*)` natively; `src/styles/base.css:12-21` already consumes them. **No Swift injection is needed** (unlike `MainActivity.kt` on Android, which had to bridge `WindowInsets` manually). Verify in simulator with **Hardware → Device → iPhone 15 Pro** (has Dynamic Island) and rotating to landscape.

## Share Extension (deferred)

The Android build receives `ACTION_SEND` intents in `MainActivity.kt:79-115` and dispatches `app:share-received` to the webview. The iOS equivalent is a **Share Extension** — a separate embedded target in the Xcode project that Tauri does not scaffold. Track this as follow-up work; the app functions without it.

## Signed Device / Sideload / TestFlight Builds

Only required for:

- Distributing to others' devices (ad-hoc via Diawi/AltStore, or TestFlight internal/external testing)
- CI-produced signed `.ipa` artifacts
- Builds that survive past 7 days on your own device

Requires a paid [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/yr).

### Manual signed build (local)

1. In [developer.apple.com](https://developer.apple.com) → Certificates, Identifiers & Profiles:
   - Create an **App ID** matching `net.forwardemail.mail`.
   - Generate an **iOS Distribution certificate** and download the `.cer`; double-click to add to Keychain.
   - Create an **Ad Hoc provisioning profile** (for sideload) or **App Store profile** (for TestFlight) referencing that App ID and cert.
2. Set `developmentTeam` in `src-tauri/tauri.conf.json` to your 10-char team ID.
3. Build:
   ```bash
   pnpm tauri ios build --target aarch64
   ```
4. The resulting `.ipa` is at `src-tauri/gen/apple/build/arm64/<scheme>.ipa`.

### CI signed builds → TestFlight (GitHub Actions)

The iOS job in [`release-mobile.yml`](../.github/workflows/release-mobile.yml) produces a signed IPA, uploads it to App Store Connect for TestFlight distribution, and also attaches the IPA to the GitHub Release for archival. It runs on every `v*` tag as part of the [unified release](./RELEASES.md#unified-release-v-tag). When required secrets are missing the job logs a warning and exits 0 — it never blocks the desktop/Android release.

#### One-time setup

On [developer.apple.com](https://developer.apple.com):

1. **Certificates → +** → **Apple Distribution** (the unified modern cert — works for both iOS App Store and macOS App Store). Upload a CSR you generate in Keychain Access (**Certificate Assistant → Request a Certificate from a Certificate Authority → Saved to disk**). Download `.cer`, double-click to install, then export from Keychain as a password-protected `.p12`.
2. **Identifiers** → verify App ID `net.forwardemail.mail` exists.
3. **Profiles → + → Distribution → App Store** → pick the App ID and the Apple Distribution cert → download the `.mobileprovision`.

On [appstoreconnect.apple.com](https://appstoreconnect.apple.com):

4. **My Apps → + → New App** → iOS, bundle ID `net.forwardemail.mail`, pick a SKU like `forwardemail-mail-ios`. Minimum metadata is fine to start — full screenshots/description only required before public App Store submission.
5. **Users and Access → Integrations → App Store Connect API → Generate API Key** with **App Manager** role. Download the `.p8` (downloadable only once). Note the **Key ID** (10 chars) and **Issuer ID** (UUID at the top of the page).

Store the six secrets in the `release` environment — see [SECRETS.md → iOS](./SECRETS.md#ios) for the full list and encoding commands.

#### What happens on a tagged release

Triggered by `pnpm release` (or manual `v*` tag push):

1. `create-release` cuts a draft GitHub Release.
2. `build-mobile` calls [`release-mobile.yml`](../.github/workflows/release-mobile.yml) which runs `android` and `ios` as sibling jobs.
3. The iOS job:
   - Imports the Apple Distribution cert into a temporary keychain.
   - Installs the `.mobileprovision` into `~/Library/MobileDevice/Provisioning Profiles/` by its embedded UUID.
   - Runs `tauri ios init --ci` to regenerate `src-tauri/gen/apple/`.
   - Runs [`scripts/sync-version.cjs`](../scripts/sync-version.cjs) + [`scripts/inject-ios-signing.cjs`](../scripts/inject-ios-signing.cjs), which inject `CODE_SIGN_STYLE=Manual` + team + identity + profile specifier into `project.yml`, regenerate the xcodeproj via `xcodegen`, write `ExportOptions.plist`, and set `CFBundleVersion` to a monotonically-increasing integer derived from semver (`major*10000 + minor*100 + patch`).
   - Runs `tauri ios build --ci --target aarch64 --export-method app-store-connect` which archives and exports the signed IPA.
   - Uploads the IPA to App Store Connect via `xcrun altool --upload-app` using the API key.
   - Uploads the IPA to the draft GitHub Release as archival.
4. `publish` flips the Release from draft to published.

#### TestFlight lifecycle (post-release)

Find the build at [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **My Apps** → **Forward Email** → **TestFlight** tab.

| Stage               | Location                                   | Typical duration     | What to do                                                                                       |
| ------------------- | ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------ |
| Upload received     | Activity → iOS Builds → "Processing"       | 5–15 min             | Wait. You'll get an email when processing finishes (or fails).                                   |
| Processing complete | TestFlight → iOS tab, listed under version | —                    | Build is ready for internal testers immediately.                                                 |
| Missing Compliance  | Yellow banner on the build row             | one-time per version | Click the build → answer the encryption question (see below).                                    |
| Internal testing    | TestFlight → Internal Testing → Groups     | instant after adding | Add up to 25 testers (must be users on your team). They get an email + TF push.                  |
| External testing    | TestFlight → External Testing → Groups     | <24h beta review     | Add testers by email (no Apple Developer seat needed). First build per version is beta-reviewed. |
| Build expiry        | —                                          | 90 days from upload  | Upload a new build before expiry to keep testing continuous.                                     |

**Testers install the [TestFlight app](https://apps.apple.com/app/testflight/id899247664) from the App Store once**, tap the invite link or redeem the code you send them, then install. Updates are automatic.

#### Export compliance (one-time, per app)

Forward Email uses TLS for network transport and user-held PGP keys for email content — both typically qualify as **exempt** encryption under US EAR (§740.17(b)(1) / 5D992.c).

Two ways to handle the compliance question:

- **Answer once in ASC**: when the first build hits "Missing Compliance", click it → "Yes, my app uses encryption" → "Yes, the app qualifies for the exemptions" → submit. ASC remembers for future builds in the same major version.
- **Set once in Info.plist** to skip the prompt permanently: add `<key>ITSAppUsesNonExemptEncryption</key><false/>` to `src-tauri/gen/apple/forwardemail-desktop_iOS/Info.plist`. (Not currently injected by our CI — would need to add to [`inject-ios-signing.cjs`](../scripts/inject-ios-signing.cjs).)

Consult a lawyer if the app later ships non-standard crypto (custom ciphers, ECC on-device key gen without TLS context, etc).

#### Inviting testers

From **TestFlight → Internal Testing → +** or **External Testing → +**:

- **Internal Testing** — up to 25 team members who have an App Store Connect role. Builds appear instantly after processing, no beta review. Best for developers + QA.
- **External Testing** — up to 10,000 testers by email (no Apple Developer Program seat needed on their end). First build per version number goes through a same-day beta review. Subsequent builds with the same major version auto-skip review.

Each tester receives an email invite with a public TestFlight link. They can also be added to a Public Link that you share anywhere — useful for "apply to beta" pages.

#### Manual signed build (local)

For rare cases where you want to produce a signed IPA outside CI (e.g., debugging a signing issue):

1. Follow the one-time setup above so the Apple Distribution cert is in your login Keychain and the `.mobileprovision` is installed in `~/Library/MobileDevice/Provisioning Profiles/`.
2. Set `developmentTeam` in `src-tauri/tauri.conf.json` to your 10-char team ID (already set).
3. Build:
   ```bash
   APPLE_TEAM_ID=FH83QMJS7P \
   IOS_EXPORT_METHOD=app-store-connect \
   IOS_PROFILE_NAME="Forward Email Mail App Store" \
     node scripts/inject-ios-signing.cjs
   pnpm tauri ios build --target aarch64 --export-method app-store-connect
   ```
4. Find the IPA at `src-tauri/gen/apple/build/arm64/*.ipa`.
5. Upload to TestFlight via Transporter.app (Mac App Store) or `xcrun altool --upload-app`.

## Troubleshooting

| Symptom                                                | Fix                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xcrun: error: unable to find utility`                 | `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`                                                                                      |
| `No iOS Simulator runtime available`                   | Xcode → Settings → Platforms → install iOS SDK                                                                                                         |
| `developmentTeam is required` during `ios init`        | Set `app.iOS.developmentTeam` in `src-tauri/tauri.conf.json`, even a dummy value for simulator builds                                                  |
| Build succeeds but app doesn't launch in simulator     | `xcrun simctl shutdown all && xcrun simctl erase all` then retry                                                                                       |
| Rust link errors about `aarch64-apple-ios` missing     | `rustup target add aarch64-apple-ios-sim` (sim target for simulator builds)                                                                            |
| `pnpm tauri ios dev` hangs on "Waiting for connection" | Ensure simulator is booted first (`open -a Simulator`) before running the command                                                                      |
| White-screen in simulator                              | `localhost:5174` not yet ready; wait for Vite to finish booting, then reload with ⌘R in Safari Web Inspector (Develop → Simulator → forwardemail_mail) |

## Related Docs

- `docs/DEVELOPMENT.md` — overall dev workflow
- `docs/desktop-setup.md` — macOS desktop (Tauri) setup, some steps overlap
- `docs/desktop-ci-secrets.md` — CI secret-management pattern to mirror for iOS signing
- `docs/RELEASES.md` — release pipeline overview
