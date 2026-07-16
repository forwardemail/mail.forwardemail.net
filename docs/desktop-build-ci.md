## How the Build Runs

The desktop release workflow builds the Tauri app across the supported desktop matrix when the top-level `release.yml` orchestrator calls it, when a `desktop-v*` tag is pushed, or when it is started manually from the Actions tab.

The build matrix now compiles for **6 desktop targets in parallel**:

| Platform        | Binary                      |
| --------------- | --------------------------- |
| macOS (arm64)   | `.dmg`                      |
| macOS (x64)     | `.dmg`                      |
| Linux (x64)     | `.AppImage`, `.deb`, `.rpm` |
| Linux (arm64)   | `.deb`, `.rpm`              |
| Windows (x64)   | `.msi`, `-setup.exe`        |
| Windows (arm64) | `-setup.exe`                |

The workflow uses native GitHub-hosted runners for each architecture, including `ubuntu-22.04-arm` for Linux arm64 and `windows-11-arm` for Windows arm64. The Linux arm64 lane is restricted to Debian and RPM bundles because the broader Linux bundle set is not reliable on that runner target. The Windows arm64 lane currently publishes the NSIS setup executable rather than MSI so the ARM release path stays aligned with the documented Tauri installer guidance.

## Build Pipeline

1. **Build** — Compiles and bundles the Tauri desktop app for each target in the matrix.
2. **Sign** — Requires the Tauri updater signing key and produces updater signatures for normal releases. The build fails closed when the key is absent unless the emergency repository variable `ALLOW_NO_UPDATER=true` is set intentionally; platform signing also runs where its required secrets are present.
3. **Windows trust** — Code signing improves Microsoft Defender and SmartScreen trust, but reputation still depends on the shipped certificate and download history; workflow changes alone cannot remove those warnings.
4. **Upload** — Pushes the generated artifacts into the draft GitHub Release associated with the desktop tag.

Dependency vulnerabilities are surfaced by GitHub's Dependabot alerts on the repository rather than as an in-workflow gate.

## Download and Test

After the workflow completes:

1. Open the draft release in GitHub Releases.
2. Download the artifact for your target architecture.
3. Install the `.dmg`, `.exe`, `.msi`, `.deb`, `.rpm`, or run the matching `.AppImage` when that artifact exists for your target architecture.
4. On Windows, use the app's **Set as default** action to open the system Default apps experience for `mailto`; Windows does not allow this app to silently take over the handler.

## Manual Runs

To trigger the workflow manually, use the **Actions** tab, choose **Release Desktop (Tauri)**, and provide a tag such as `desktop-v0.7.0`.

## ⚠️ macOS Entitlements — read before touching `src-tauri/Entitlements.plist`

`bundle.macOS.entitlements` in `tauri.conf.json` points at `src-tauri/Entitlements.plist`, and that **same file is also used for iOS** (via `scripts/inject-ios-signing.cjs`). Entitlements baked into the macOS bundle have bitten us **twice**, and both bugs share two nasty properties: they are **invisible in `tauri:dev` / local builds** (they only manifest in a **signed + notarized** bundle), and CI reports every step green (the failure is at _exec_ time in the kernel, not at build/sign/notary time).

Hard rules:

1. **App Sandbox ≠ Hardened Runtime.** Notarization needs the **Hardened Runtime** (`com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory`, + `codesign --options runtime`). It does **not** need `com.apple.security.app-sandbox`. Do **not** add `app-sandbox` to this Developer-ID app "for hardening" — a sandboxed app brokers `NSOpenPanel` through Powerbox and (without `files.user-selected.*`) returns nil → the `rfd` file dialog SIGABRTs. See [Postmortem: macOS File Picker Crash](./desktop-postmortem-macos-sandbox-filepicker-2026-06-02.md).
2. **Don't add entitlements the macOS Developer ID cert isn't authorized for.** `aps-environment` (APNs) is iOS-only and made every macOS build unlaunchable (`CODESIGNING Invalid Signature` at exec). It's injected for iOS at build time and must stay absent for macOS. See [Postmortem: macOS Releases Unopenable](./desktop-postmortem-macos-entitlements-2026-05-19.md).
3. **Always validate entitlement changes on a real signed + notarized build**, not `tauri dev`. Smoke-test anything gated by the sandbox/signature: file open/save dialogs, push, keychain, protected resources.
4. Inspect what actually shipped: `codesign -d --entitlements - "/Applications/Forward Email.app"`.
5. **Keep `Entitlements.plist` pure ASCII with no `--` (double hyphen) inside comments.** Apple's entitlements parser (`AMFIUnserializeXML`, used by `codesign`) is stricter than `plutil` and fails with `syntax error near line N` / `failed to sign app` on non-ASCII (e.g. em-dashes) or a `--` in a comment — even though `plutil -lint` reports OK. (Bit us 2026-06-02 when a comment mentioned `codesign --options`.)

Systemic fix still open: **split macOS and iOS entitlements into separate files** so an iOS-relevant or "hardening" entitlement can't silently bake into the macOS bundle.
