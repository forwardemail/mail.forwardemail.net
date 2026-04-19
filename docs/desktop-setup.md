# Desktop App — Developer Setup Guide

## Prerequisites

This guide is for **building the desktop app from source**. If you only want to install a published desktop binary, use the instructions in the repository [README](../README.md#ubuntu--debian-installation). Official Linux release artifacts are now published for **x64 and arm64**.

| Tool                        | Version                                  | Notes                                                                                                                  |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Rust**                    | stable (via [rustup](https://rustup.rs)) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh`                                                      |
| **Node.js**                 | 20+                                      |                                                                                                                        |
| **pnpm**                    | 9+                                       | `corepack enable && corepack prepare pnpm@latest --activate`                                                           |
| **Xcode CLI tools** (macOS) | latest                                   | `xcode-select --install`                                                                                               |
| **WebView2** (Windows)      | latest                                   | Pre-installed on Windows 11; [download](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) for Windows 10 |
| **Linux system libs**       | see below                                | Required for WRY/WebKit                                                                                                |

### Linux Dependencies

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev
```

## First-Time Setup

```bash
# Clone and install JS dependencies
pnpm install

# Install the Rust target for your platform (if not already present)
# macOS Apple Silicon:
rustup target add aarch64-apple-darwin
# macOS Intel:
rustup target add x86_64-apple-darwin
# Linux x64:
rustup target add x86_64-unknown-linux-gnu
# Linux arm64:
rustup target add aarch64-unknown-linux-gnu
# Windows x64:
rustup target add x86_64-pc-windows-msvc
# Windows arm64:
rustup target add aarch64-pc-windows-msvc
```

If you are developing on **Linux arm64**, you can install the published release artifacts directly from GitHub Releases or build from source on your target machine for local development and custom packaging. The corresponding Rust target remains:

```bash
rustup target add aarch64-unknown-linux-gnu
```

If you are developing on **Windows arm64**, install the ARM64 MSVC toolchain support in Visual Studio Build Tools before building the Tauri app locally, then add the matching Rust target:

```bash
rustup target add aarch64-pc-windows-msvc
```

## Running in Dev Mode

```bash
pnpm tauri:dev
```

This starts the Vite dev server on `http://localhost:5174` and opens the Tauri window pointing at it. Hot-reload works for the Svelte frontend. Rust changes require a restart.

**DevTools:** Press `Cmd+Option+I` (macOS) or `Ctrl+Shift+I` (Windows/Linux) to open the WebView inspector.

## Building Unsigned Binaries

```bash
pnpm tauri:build
```

Output paths (relative to project root):

| Platform | Output                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `src-tauri/target/release/bundle/dmg/*.dmg`                                                                                                     |
| Windows  | `src-tauri/target/release/bundle/msi/*.msi`, `src-tauri/target/release/bundle/nsis/*.exe`                                                       |
| Linux    | `src-tauri/target/release/bundle/appimage/*.AppImage`, `src-tauri/target/release/bundle/deb/*.deb`, `src-tauri/target/release/bundle/rpm/*.rpm` |

## Configuration

No `.env` file is required. The API base URL is set in `src/config.js` and defaults to `https://api.forwardemail.net`. To override for local development, edit `src/config.js` directly.

## Diagnosing the Auto-Updater

Tauri's auto-updater runs from the Rust backend, so **its HTTP requests will not appear in the webview devtools Network tab**. Use one of these three paths to observe updater behavior.

### 1. JavaScript-side logs (recommended starting point)

All JS code paths in `src/utils/updater-bridge.js` log at every decision point with the `[updater]` prefix:

```
[updater] checkForUpdates() called
[updater] calling mod.check() — this issues an HTTP GET from the Rust backend
[updater] mod.check() returned { isNull: false, available: true, version: '0.9.21', currentVersion: '0.9.20', date: '2026-04-18' }
[updater] doCheck: update available → v0.9.21 (current v0.9.20)
[updater] no onUpdateAvailable callback — will auto-install silently
[updater] downloadAndInstall() starting for version 0.9.21
[updater] download started: 8421734 bytes
[updater] download progress: 10%
[updater] download progress: 20%
...
[updater] download finished — install + relaunch starting
```

These lines appear in:

- The **webview devtools Console** (⌥⌘I in dev builds — enabled by the `devtools` Tauri feature in debug builds only).
- The **rotating log files** on disk, via `tauri-plugin-log`'s `Webview` target. Up to 5 × 1 MB files. Locations:
  - macOS: `~/Library/Logs/net.forwardemail.mail/`
  - Linux: `~/.local/share/net.forwardemail.mail/logs/`
  - Windows: `%LOCALAPPDATA%\net.forwardemail.mail\logs\`
- The **app's own diagnostics UI** (Settings → Diagnostics → "View Recent Logs"), which tails those same files.

### 2. Rust-side updater plugin logs

The `tauri_plugin_updater` module is pinned to `Debug` level in `src-tauri/src/lib.rs`. Its log lines flow through the same `tauri-plugin-log` pipeline as JS logs, so they land in the same rotating files with the `tauri_plugin_updater` target:

```
2026-04-18T05:12:03Z [DEBUG][tauri_plugin_updater] checking for update from https://github.com/.../latest.json
2026-04-18T05:12:03Z [DEBUG][tauri_plugin_updater] latest version: 0.9.21, current: 0.9.20
```

In debug builds (`pnpm tauri:dev`), the overall log level is `Debug` so you'll see network retries, body parsing, and signature verification from the plugin as well.

### 3. OS-level network inspection

When you need to confirm an HTTP request actually left the machine (e.g., suspecting a firewall or DNS issue):

```bash
# macOS — watch connections from the app process while triggering a check
lsof -iTCP -sTCP:ESTABLISHED -P -c 'Forward Email' -r 1

# Cross-platform — use Little Snitch (macOS), Proxyman, or mitmproxy to
# capture the actual request. Requires configuring the OS/proxy trust
# chain since update downloads are HTTPS.
```

GitHub Releases assets use `objects.githubusercontent.com` / `release-assets.githubusercontent.com` for the actual `.tar.gz` download and `github.com` for the `latest.json` redirect.

### Common observations

| What you see                                 | What it means                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `rate-limited: last check was Xs ago`        | The 5-minute minimum between checks is holding. Triggering again immediately is a no-op.                                     |
| `mod.check() returned { isNull: true, ... }` | Tauri believes there is no newer version. You may already be on `latest`, or `latest.json` may be absent from the release.   |
| `mod.check() threw: signature mismatch`      | The pubkey in `tauri.conf.json` doesn't match the private key that signed the `.sig` file.                                   |
| `downloadAndInstall failed: Failed to move…` | macOS install-location issue. Move the app into `/Applications` and re-launch.                                               |
| No `[updater]` log lines at all              | `isTauriDesktop` returned false (wrong platform), or the module never ran. Check the Rust log for the plugin's own activity. |

## Troubleshooting

### macOS

- **"xcrun: error: invalid active developer path"** — Run `xcode-select --install` to install CLI tools.
- **Xcode license not accepted** — Run `sudo xcodebuild -license accept`.
- **Wrong Rust target** — Ensure you've added the correct target for your Mac (`aarch64-apple-darwin` for Apple Silicon, `x86_64-apple-darwin` for Intel).

### Linux

- **"Package libwebkit2gtk-4.1 was not found"** — Install the system dependencies listed above.
- **WRY build failures** — Ensure all `-dev` packages are installed. On Fedora/RHEL, use `webkit2gtk4.1-devel` and equivalents.

### Windows

- **"WebView2 runtime not found"** — Download and install from [Microsoft](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).
- **Build fails with MSVC errors** — Install Visual Studio Build Tools with the "Desktop development with C++" workload.
- **Windows arm64 build fails at link time** — Ensure the Visual Studio ARM64 C++ build tools are installed before targeting `aarch64-pc-windows-msvc`.

### General

- **`pnpm tauri:dev` hangs** — Check that port 5174 is not in use. Kill any stale Vite processes.
- **Rust compilation slow on first build** — This is expected. Subsequent builds use incremental compilation and the Rust cache.
