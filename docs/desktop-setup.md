# Desktop App — Developer Setup Guide

## Prerequisites

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
# Linux:
rustup target add x86_64-unknown-linux-gnu
# Windows:
rustup target add x86_64-pc-windows-msvc
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

| Platform | Output                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------- |
| macOS    | `src-tauri/target/release/bundle/dmg/*.dmg`                                                        |
| Windows  | `src-tauri/target/release/bundle/msi/*.msi`, `src-tauri/target/release/bundle/nsis/*.exe`          |
| Linux    | `src-tauri/target/release/bundle/appimage/*.AppImage`, `src-tauri/target/release/bundle/deb/*.deb` |

## Configuration

No `.env` file is required. The API base URL is set in `src/config.js` and defaults to `https://api.forwardemail.net`. To override for local development, edit `src/config.js` directly.

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

### General

- **`pnpm tauri:dev` hangs** — Check that port 5174 is not in use. Kill any stale Vite processes.
- **Rust compilation slow on first build** — This is expected. Subsequent builds use incremental compilation and the Rust cache.
