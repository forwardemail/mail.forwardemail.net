# Desktop App — Contributor Architecture Guide

## Architecture Overview

The desktop app is a **Tauri 2** shell wrapping the same Svelte 5 frontend used on the web. The frontend runs inside a WRY webview (WebKit on macOS/Linux, WebView2 on Windows).

```
┌──────────────────────────────┐
│  Tauri (Rust)                │
│  - tray icon, deep links     │
│  - IPC commands              │
│  - updater plugin            │
├──────────────────────────────┤
│  WRY Webview                 │
│  - Svelte 5 frontend         │
│  - Tauri bridges (JS)        │
│  - IndexedDB (Dexie)         │
└──────────────────────────────┘
```

**Key differences from web:**

- **No Service Worker** — WRY's custom scheme (`tauri://`) doesn't support SW registration. The `sync-shim.js` + `sync-core.js` modules replace the SW mutation queue.
- **CSP** — The web app's `<meta>` CSP tag is stripped; CSP is governed by `src-tauri/tauri.conf.json` → `app.security.csp`.
- **Isolation pattern** — Tauri's [isolation pattern](https://v2.tauri.app/concept/inter-process-communication/isolation/) is enabled (`src-tauri/isolation/`), adding a security boundary between the webview and IPC.

## Platform Detection

All platform checks go through `src/utils/platform.js`:

| Export                  | Type            | Description                                             |
| ----------------------- | --------------- | ------------------------------------------------------- |
| `isTauri`               | `boolean`       | True inside any Tauri webview                           |
| `isTauriDesktop`        | `boolean`       | True on desktop Tauri only                              |
| `isTauriMobile`         | `boolean`       | True on mobile Tauri only                               |
| `canUseServiceWorker()` | `() => boolean` | False on Tauri (WRY doesn't support SW)                 |
| `getPlatform()`         | `() => string`  | Returns `'tauri-desktop'`, `'tauri-mobile'`, or `'web'` |

## Tauri Bridges

### `src/utils/tauri-bridge.js` — IPC Command Wrapper

Provides `invokeTauri(command, args)` for calling Rust `#[tauri::command]` functions. Maintains an `ALLOWED_COMMANDS` allowlist — commands not in the list are rejected client-side before reaching Rust.

### `src/utils/updater-bridge.js` — Auto-Update Lifecycle

Wraps `@tauri-apps/plugin-updater` with rate limiting (5-min minimum between checks), version validation, and download progress tracking. Also subscribes to WebSocket `newRelease` events for server-push update notifications.

### `src/utils/sync-shim.js` + `src/utils/sync-core.js` — SW Replacement

`sync-core.js` is a dependency-injected factory (`createSyncCore({ postMessage, fetch, indexedDB })`) that contains the mutation queue processing logic ported from `public/sw-sync.js`. `sync-shim.js` wires it to the main thread with:

- `CustomEvent` dispatch as `postMessage`
- `window.fetch` for network calls
- `window.indexedDB` for storage
- Online/visibility/focus listeners to trigger processing
- 30-second heartbeat for periodic retries

### `src/utils/notification-bridge.js` — Native Notifications

Uses `@tauri-apps/plugin-notification` for native OS notification channels on desktop.

### `src/utils/sync-bridge.js` — SW vs Shim Router

Selects between the Service Worker path and the sync-shim path based on `canUseServiceWorker()`.

## Adding a New IPC Command

1. **Rust:** Add a function with `#[tauri::command]` in `src-tauri/src/lib.rs` and register it in the `generate_handler![]` macro.

2. **Capabilities:** Grant the command in the appropriate capability file under `src-tauri/capabilities/*.json`.

3. **Allowlist:** Add the command name to `ALLOWED_COMMANDS` in `src/utils/tauri-bridge.js`.

4. **Call it:** Use `invokeTauri('your_command', { arg1: 'value' })` from the frontend.

## Mobile Portability

The architecture is designed for future Android/iOS support:

- `sync-core.js` uses dependency injection — mobile platforms can inject their own `fetch` and `indexedDB` implementations.
- `platform.js` already exports `isTauriMobile` for mobile-specific branching.
- `src-tauri/Cargo.toml` uses `cfg(not(any(target_os = "android", target_os = "ios")))` for desktop-only plugins.

## Testing Locally

1. **Debug builds:** `pnpm tauri:dev` builds in debug mode with DevTools enabled.
2. **Local API:** Edit `src/config.js` to point `apiBase` at a local server.
3. **DevTools:** Automatically opens in debug builds. Use the Console tab to verify `window.__TAURI_INTERNALS__` is defined.
4. **Mutation queue:** Star/move a message while offline, go online, and watch the console for `[sync-core]` and `mutationQueueProcessed` messages.
