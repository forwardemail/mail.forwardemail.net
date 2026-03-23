# Development Guide (Tauri)

This guide covers development for both desktop and mobile applications, which are now unified under the Tauri v2 framework.

## Prerequisites

1.  **Install Rust**: Follow the instructions at [rustup.rs](https://rustup.rs/).
2.  **Install Tauri Prerequisites**: Follow the official guide for your operating system at [tauri.app/v2/guides/getting-started/prerequisites](https://tauri.app/v2/guides/getting-started/prerequisites). This includes dependencies for both desktop and mobile development (e.g., Android Studio, Xcode).
3.  **Install Node.js and pnpm**: We recommend using Node.js 20+ and pnpm 9+.

## Getting Started

1.  **Install project dependencies**:

    ```bash
    pnpm install
    ```

2.  **Run the development server**:

    This will start the Vite dev server for the Svelte frontend and launch the Tauri application shell.
    - **Desktop**:

      ```bash
      pnpm tauri dev
      ```

    - **Mobile (Android)**:

      Connect an Android device or start an emulator, then run:

      ```bash
      pnpm tauri android dev
      ```

    - **Mobile (iOS)**:

      Connect an iOS device or start a simulator, then run:

      ```bash
      pnpm tauri ios dev
      ```

## Project Structure

- `src/`: Svelte frontend code (components, stores, utils).
- `src-tauri/`: Rust backend code.
  - `src/main.rs`: Main entry point for the desktop application.
  - `src/lib.rs`: Shared Rust library for all platforms (desktop and mobile).
  - `tauri.conf.json`: The main Tauri configuration file.
  - `Cargo.toml`: Rust dependencies.
  - `build.rs`: Tauri build script.
- `.github/workflows/`: GitHub Actions for CI/CD and releases.

## Key Concepts

### Frontend-Backend Communication (IPC)

Tauri uses an Inter-Process Communication (IPC) bridge to allow the Svelte frontend to call Rust functions. All IPC commands are defined in `src-tauri/src/lib.rs` within the `#[tauri::command]` attribute.

The frontend interacts with these commands via the `@tauri-apps/api` JavaScript library. See `src/utils/tauri-bridge.js` for examples.

### Service Worker Alternative (Sync Shim)

Service Workers are not supported in Tauri's webview. To provide offline functionality, we use a "sync shim" architecture:

1.  **`src/utils/sync-core.js`**: A platform-agnostic module containing the core logic for handling API synchronization and mutation queues. It's a factory function that accepts an environment object (`fetch`, `indexedDB`, `postMessage`).

2.  **`public/sw-sync.js`**: The Service Worker adapter. It imports `sync-core.js` and provides the SW environment bindings. This is used for the web version.

3.  **`src/utils/sync-shim.js`**: The main-thread replacement for the Service Worker. It also imports `sync-core.js` but provides main-thread environment bindings (`window.fetch`, `window.indexedDB`, and a `CustomEvent`-based `postMessage`). This is used in Tauri builds.

4.  **`src/utils/sync-bridge.js`**: A unified module that automatically detects the platform and initializes either the Service Worker or the sync shim. The rest of the application imports from this bridge, making the code platform-agnostic.

### Native Plugins

Tauri's functionality is extended through plugins. We use several official plugins, configured in `src-tauri/Cargo.toml` and `src-tauri/src/lib.rs`:

- `tauri-plugin-updater`: For automatic background updates on desktop.
- `tauri-plugin-notification`: For native desktop and mobile push notifications.
- `tauri-plugin-deep-link`: To handle `forwardemail://` custom protocol URLs.
- `tauri-plugin-single-instance`: Ensures only one instance of the desktop app can run.
- `tauri-plugin-window-state`: Persists window size and position on desktop.

## Building for Production

To build the application for production:

```bash
# Desktop
pnpm tauri build

# Mobile (Android)
pnpm tauri android build

# Mobile (iOS)
pnpm tauri ios build
```

This will generate optimized, signed (if configured) binaries in `src-tauri/target/release/`.

## E2E Testing

We use Playwright for end-to-end testing. The tests are located in `tests/e2e/`.

- `tests/e2e/tauri/`: Tests specifically for the Tauri application.
- `tests/e2e/websocket/`: Tests for the WebSocket client.

To run the tests:

```bash
# First, build the Tauri app in debug mode
pnpm tauri build --debug

# Then, run the Playwright tests
npx playwright test tests/e2e/tauri/
```

The GitHub workflow in [`.github/workflows/e2e-apps.yml`](../.github/workflows/e2e-apps.yml) runs these tests automatically on every push.

For a comprehensive testing guide, see [TAURI_TESTING.md](./TAURI_TESTING.md).

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Full architecture document
- [RELEASES.md](./RELEASES.md) — Release process and artifact details
- [SECRETS.md](./SECRETS.md) — Required secrets for CI/CD
- [SECURITY.md](./SECURITY.md) — Security hardening and code signing
- [TAURI_TESTING.md](./TAURI_TESTING.md) — Comprehensive Tauri testing guide
- [Desktop Contributing](./desktop-contributing.md) — Desktop architecture and IPC patterns
- [Desktop Setup](./desktop-setup.md) — Desktop environment setup
