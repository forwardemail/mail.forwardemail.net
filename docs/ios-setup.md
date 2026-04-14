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

### CI signed builds (GitHub Actions)

`release-mobile.yml` has an iOS job gated by `if: false` (line 195) awaiting signing secrets. To enable:

1. Export your Distribution certificate from Keychain as a password-protected `.p12`.
2. Download the provisioning profile (`.mobileprovision`) from developer.apple.com.
3. Store as repo secrets:
   - `IOS_CERTIFICATE_BASE64` — `base64 -i Certificate.p12`
   - `IOS_CERTIFICATE_PASSWORD` — the export password
   - `IOS_PROVISIONING_PROFILE_BASE64` — `base64 -i profile.mobileprovision`
   - `IOS_TEAM_ID` — 10-char team ID
4. Flip `if: false` → `if: true` in `.github/workflows/release-mobile.yml`.
5. See `docs/desktop-ci-secrets.md` for the equivalent macOS desktop flow — iOS follows the same pattern.

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
