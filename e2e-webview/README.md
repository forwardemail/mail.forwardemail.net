# e2e-webview

Cross-platform native-WebView E2E tests for the Tauri desktop app, driven by **Vitest** + the [`webdriverio`](https://www.npmjs.com/package/webdriverio) client + [`tauri-plugin-webdriver`](https://github.com/Choochmeque/tauri-plugin-webdriver).

Unlike the Playwright suites under `tests/e2e/`, these tests drive the **actual platform WebView** (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux), so they catch rendering, JS, and IPC bugs that only manifest in production-equivalent runtimes.

## Why Vitest, not Mocha

WebdriverIO's framework adapters list (Mocha/Jasmine/Cucumber) is a recommendation. The project standardizes on Vitest for every test runner: unit, component, and these E2E harnesses. We use the raw `webdriverio` package as a client library (no `@wdio/cli`) and let Vitest drive.

## Prerequisites

1. Rust toolchain (matches `src-tauri/Cargo.toml`).
2. `pnpm` 9+ in the repo root.
3. The intermediary CLI:
   ```sh
   cargo install tauri-webdriver --locked
   ```
4. **Linux only:** `webkit2gtk-driver`, plus `xvfb` for headless runs.

## Build the Tauri binary with the `webdriver` feature

From the repo root:

```sh
pnpm install
pnpm tauri build --debug --no-bundle --features webdriver
```

**Why `tauri build`, not plain `cargo build`?** Tauri 2 embeds `frontendDist` (the assets the WebView loads) only when the `tauri` CLI drives the build. `cargo build` alone produces a binary with an empty asset registry, and the WebView fails with `AssetNotFound("index.html")` at runtime. `--no-bundle` skips the DMG/MSI/etc. bundling step, which tests don't need.

The `webdriver` Cargo feature embeds a W3C WebDriver server inside the app on `127.0.0.1:4445`. It is **off by default**; release builds never include it.

## Run the tests

From this directory:

```sh
pnpm install                                    # first time only
pnpm test                                       # macOS / Windows
xvfb-run --auto-servernum -- pnpm test          # Linux
```

Vitest's `globalSetup` spawns `tauri-webdriver` (intermediary on `:4444`, forwarding to the in-app server on `:4445`); the per-spec `beforeAll` hook calls `remote()` to open the WebDriver session and load the binary resolved by `support/platform.ts`. `afterAll` closes each spec file's session.

`fileParallelism` is disabled because `tauri-plugin-webdriver` allows one session per app instance; running spec files sequentially keeps them from racing on the port.

## Pointing at a specific binary

Two overrides:

- `TAURI_TARGET=<rust-target-triple>`: resolves under `target/<triple>/debug/` instead of `target/debug/`. Used by the CI matrix.
- `TAURI_E2E_BINARY=/abs/path/to/binary`: explicit absolute path. Wins over both auto-resolution and `TAURI_TARGET`.

## Reports

- JUnit XML → `reports/junit.xml` (uploaded as a CI artifact).
- Failure screenshots → `screenshots/*.png` via the `setup/per-test.ts` `afterEach` hook.
- Both directories are gitignored.

## Two non-obvious gotchas (also encoded in the code)

1. **`cargo build` produces an empty asset registry.** Use `pnpm tauri build --debug --no-bundle --features webdriver` (see above).
2. **The plugin's WebDriver session attaches to a blank context, not the existing main window.** Every spec must call `openApp(browser)` (or `browser.url('tauri://localhost')` directly) before assertions. Encoded in `support/app.ts:appUrl()`/`openApp()`.
