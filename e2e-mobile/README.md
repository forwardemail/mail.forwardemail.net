# e2e-mobile

Android (and later iOS) E2E tests for the Tauri app, driven by **Vitest** + the [`webdriverio`](https://www.npmjs.com/package/webdriverio) client + [Appium 2](https://appium.io). CI runs it nightly and on `workflow_dispatch`. It does not run on PRs because cold-start emulator boots are slow and intermittently flaky.

## How it differs from `e2e-webview/`

The desktop suite uses `tauri-plugin-webdriver` (a W3C server embedded in the app). On Android we use **Appium with the UiAutomator2 driver** instead, because:

- Tauri's docs name mobile-via-Appium as the supported path.
- Appium's `webview` context switching gives standard CSS selectors against the DOM with no app-side plugin, used in full on iOS. (On Android the CI emulator cannot survive the context switch, so the Android smoke is native-only; see [Smoke spec internals](#smoke-spec-internals).)
- The Cargo `webdriver` feature is desktop-only and would not compile for Android targets anyway.

## Local prerequisites (Mac)

1. Java 17 (Temurin recommended).
2. Android SDK + NDK 27.0.12077973 (`ANDROID_HOME` set).
3. Rust target: `rustup target add x86_64-linux-android`.
4. An Android emulator booted (API 34, `google_apis`, `x86_64`).
5. Appium 2 + UiAutomator2 driver installed globally:
   ```sh
   npm install -g appium@^2
   appium driver install uiautomator2
   ```
6. Appium server running externally (`appium --port 4723 &`). Unlike the desktop harness, this suite does _not_ spawn Appium itself: most local dev setups already have Appium running, and CI starts it inside the emulator-runner action.

## Build the APK

From the repo root:

```sh
pnpm install
pnpm tauri android init
pnpm tauri android build --apk --debug --target x86_64
```

Output: `src-tauri/gen/android/app/build/outputs/apk/x86_64/debug/*.apk`.

## Run the tests

```sh
appium --port 4723 &
APK_PATH="$(realpath src-tauri/gen/android/app/build/outputs/apk/x86_64/debug/*-debug.apk)" \
  pnpm --dir e2e-mobile test
```

## Smoke spec internals

The spec splits by platform because only one of the two CI environments can survive switching into the WebView context:

- **iOS** (the simulator has a real GPU): the spec switches into the WKWebView context (`switchToTauriWebview`) and runs the full in-WebView assertions: the Tauri bridge is up (`__TAURI_INTERNALS__` is defined) and the frontend rendered a non-empty title. The switch uses **polling, not a fixed sleep**, since the WebView context can take 10–30s to appear after `NATIVE_APP`.
- **Android** (the CI emulator runs software GL): switching into the WebView context via chromedriver reliably takes the emulator offline in a WebView GPU-rasterization storm. So the Android path is **native-only**: it never attaches chromedriver and never inspects the DOM. It asserts (a) a WebView context carrying the app bundle id appeared, proving the app process launched and its WebView came up, and (b) a WebView node exists in the native view hierarchy.

**Caveat: what the Android smoke does NOT prove.** Because it never reads the DOM, it only guarantees launch and the native shell, not that the web app rendered. A blank-white WebView would still pass. This is the deliberate, emulator-safe bar chosen for 1.0 (release gating is the desktop pipeline, not this nightly job). Proving the Android web app renders needs a real-GPU device cloud (Firebase Test Lab / BrowserStack); tracked separately.

## CI

`.github/workflows/e2e-mobile-android.yml` runs nightly at 06:00 UTC plus `workflow_dispatch`. Single matrix row: API 34, `google_apis`, `x86_64`, Pixel 6 profile. Test step uses `continue-on-error: true` (informational). The desktop release pipeline handles release blocking.
