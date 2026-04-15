# Cross-Platform WebView Gotchas

Field guide for shipping the webmail app (Svelte 5 + Dexie + Workbox + sync Web Worker + optimistic offline mutations + ~50MB attachment cache) via Tauri 2 to macOS, Linux, Windows, iOS, and Android. As of 2025–2026.

## 1. WebView engines per platform

Tauri/WRY dispatches to whatever the OS ships:

| Platform    | Engine                            |
| ----------- | --------------------------------- |
| macOS / iOS | WKWebView (WebKit)                |
| Windows     | WebView2 (Chromium, Evergreen)    |
| Linux       | WebKitGTK 4.1                     |
| Android     | Android System WebView (Chromium) |

That means two engines (Chromium + WebKit) but **four stability profiles**. Behavior diverges on: service workers, IDB quotas/eviction, range requests, Blob/File URLs, module workers, codec support, cookie persistence.

**Mitigation:** test by engine, not OS. Pair WebView2 + Android; pair macOS + iOS + Linux on the WebKit side. Tauri docs specify minimums: webkit2gtk 4.1, WebView2 Evergreen, iOS 13+, Android 7+/API 24+.

Refs: [Tauri webview versions](https://v2.tauri.app/reference/webview-versions/), [Exploring system webviews](https://dev.to/shrsv/exploring-system-webviews-in-tauri-native-rendering-for-efficient-cross-platform-apps-9hl)

## 2. Service workers — biggest single issue for this app

- **WKWebView blocks SWs** unless you opt into **App-Bound Domains** (`limitsNavigationsToAppBoundDomains=true`), which conflicts with `addUserScript` — i.e. with Tauri's IPC injection. Effectively: **no service workers on iOS/macOS Tauri webviews.**
- **Tauri custom protocol (`tauri://`) disallows SW registration on every platform** because WebKit/Chromium require a secure origin.
- **No Background Sync on WebKit at all** — Chromium-only.
- **Windows v2 changed default scheme** from `https://tauri.localhost` to `http://tauri.localhost`; this wipes IDB/LocalStorage/Cookies for upgraders and blocks SW-requiring features unless you set `app.windows.useHttpsScheme=true`.

**Mitigation:** don't rely on the Workbox SW on mobile/macOS Tauri builds. Options:

- (a) Use `tauri-plugin-localhost` so the app is served from `http://localhost:<port>` where Chromium will register SWs (still risky on iOS — WKWebView entitlement required).
- (b) Treat the SW as a **desktop-Windows/Linux-only** enhancement and move offline/precache/sync logic into `sync.worker.ts` + Rust commands.

Given the existing `sw-sync.js` + sync Web Worker + mutation queue, lean on the Web Worker + Rust commands for mobile and keep the SW as progressive enhancement.

Refs: [WebKit#206741](https://bugs.webkit.org/show_bug.cgi?id=206741), [Apple forum](https://developer.apple.com/forums/thread/745615), [tauri#13031](https://github.com/tauri-apps/tauri/issues/13031), [tauri#12214](https://github.com/tauri-apps/tauri/issues/12214), [tauri#11500 (Android)](https://github.com/tauri-apps/tauri/issues/11500), [wry#389](https://github.com/tauri-apps/wry/issues/389), [Workbox#2516](https://github.com/GoogleChrome/workbox/issues/2516), [Tauri v2 migration](https://v2.tauri.app/start/migrate/from-tauri-1/), [localhost plugin](https://v2.tauri.app/plugin/localhost/)

## 3. IndexedDB / Dexie quirks

- **WebKit 7-day ITP eviction** wipes IDB, LocalStorage, SessionStorage, and SW registrations after 7 days of use without interaction. Inside a native Tauri app the policy still applies in current WebKitGTK/WKWebView builds — an app that sits unused for a week can return to an empty cache.
- **iOS 17+ quota**: 15% of disk for non-browser apps (WKWebView), 60% for browser apps. Plenty for a 50MB attachment cache, but `navigator.storage.estimate()` is the only reliable figure — plan for `QuotaExceededError`.
- **Dexie on Safari**: historically compound-index/multiEntry issues, and iOS 14.5 had a hard bug storing Blobs in IDB. Dexie 4 has workarounds baked in — pin to Dexie ≥4.
- **Tauri v2 migration reset**: the IDB directory path changed (`https_tauri.localhost_0.indexeddb.leveldb` → `http_…`) causing silent data loss for upgraders.

**Mitigation:** wrap every write in explicit quota-error handling; persist a server-sourced watermark so the cache can rebuild when eviction happens; for upgraders from v1, detect the old path and migrate or prompt re-login. The existing `SCHEMA_VERSION` discipline between `sw-sync.js` and `db-constants.ts` is already correct.

Refs: [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/), [PWA iOS limits](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide), [Dexie on Safari](https://dexie.org/docs/IndexedDB-on-Safari), [Dexie#1227](https://github.com/dfahlander/Dexie.js/issues/1227), [tauri#11252](https://github.com/tauri-apps/tauri/issues/11252)

## 4. Web Workers / module workers

Classic + module Workers generally work on all four engines, but Tauri has traps:

- **Tauri APIs (`invoke`, HTTP plugin, etc.) are NOT exposed in Workers** — only the main thread. Route through main or call Rust via a main-thread proxy.
- **macOS prod build bug**: importing worker scripts via the custom protocol returns `text/html` MIME → `SyntaxError: Unexpected token`.
- **Dev postMessage race** requires a hot-reload on first load.

**Mitigation:** bundle worker code (Vite `?worker` / inline) to avoid runtime protocol MIME issues; keep the main thread as the sole Tauri-API broker.

Refs: [tauri#3308](https://github.com/tauri-apps/tauri/issues/3308), [tauri#12277](https://github.com/tauri-apps/tauri/issues/12277), [tauri#9975](https://github.com/tauri-apps/tauri/issues/9975), [tauri#8158](https://github.com/tauri-apps/tauri/issues/8158)

## 5. Blob / File / attachments (direct hit on the 50MB cache)

- **Android WebView cannot download `blob:` URLs** natively — DownloadManager only gets the URL, not the bytes, so `<a download>` silently fails. Intercept via `setDownloadListener` or route through Rust. Tauri has no built-in "download file" on mobile.
- **WKWebView Blob memory pressure**: iOS aggressively kills webviews approaching ~1GB; a 50MB attachment fetched as one Blob and then decoded into DataURLs can push you there fast. Stream to disk via the Tauri `fs`/`upload` plugins instead of holding in Blob + dataURL.
- **No HTTP range on custom protocol yet** — large attachment streaming from Rust requires range support Tauri doesn't natively emit; workaround is the localhost plugin.
- **Asset protocol broken on Android** in some builds (500s).

**Mitigation:** for mobile, use a Rust command that writes the decoded attachment to `app_data_dir` and returns a path the viewer loads via `convertFileSrc`. Cap in-memory Blob retention; avoid `FileReader.readAsDataURL` on big files.

Refs: [Android blob download guide](https://medium.com/@SrimanthChowdary/resolving-blob-download-issues-in-android-webview-a-comprehensive-guide-for-developers-ad103e0833bd), [tauri#10280](https://github.com/tauri-apps/tauri/issues/10280), [tauri discussion#12243](https://github.com/tauri-apps/tauri/discussions/12243), [tauri#12364](https://github.com/tauri-apps/tauri/issues/12364)

## 6. CSP, custom protocols, cookies

`tauri://localhost` (and `http://tauri.localhost` on Windows/Android) is **not a secure/valid origin** from WebKit's POV, so: no SW, no `Set-Cookie` persistence, and CORS preflights appear with `null`/opaque origins that many APIs reject. `api.forwardemail.net` needs either CORS with credentials configured for the Tauri origin or — more robustly — you proxy via Rust (`tauri-plugin-http`).

**Mitigation:** use `@tauri-apps/plugin-http` fetch (or `tauri-plugin-cors-fetch` which shims `window.fetch`) for anything that needs cookies, SSE, or custom headers; keep token auth (`alias_auth`/`api_key`) since cookies are fragile.

Refs: [tauri discussion#5337](https://github.com/tauri-apps/tauri/discussions/5337), [tauri#11518](https://github.com/tauri-apps/tauri/issues/11518), [tauri-plugin-cors-fetch](https://github.com/idootop/tauri-plugin-cors-fetch)

## 7. IME / keyboard / compose on Android

`contenteditable` on Android WebView is notoriously broken: composition-mid delete/enter sequences drop characters, autocapitalize flags are ignored, cursor placement in long content is wrong, and M139 resizes the visual viewport directly which races your own `resize` handlers.

**Mitigation:** for the mobile compose view, prefer a `<textarea>`-backed editor (with a plain-text→markdown step) over a rich `contenteditable`; if you need rich text, use a library that handles Android IME (ProseMirror/Lexical latest), never hand-roll. Adopt `tauri-plugin-safe-area-insets` so the keyboard + gesture bar don't cover the send button.

Refs: [ProseMirror thread](https://discuss.prosemirror.net/t/contenteditable-on-android-is-the-absolute-worst/3810), [flutter#62205](https://github.com/flutter/flutter/issues/62205), [Android window insets](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets), [safe-area-insets plugin](https://github.com/saurL/tauri-plugin-safe-area-insets-css)

## 8. Fetch / CORS / cookies

Two fetch paths coexist: **browser fetch** (through the webview, subject to CORS + opaque-origin cookies) and **Tauri HTTP plugin** (through `reqwest` in Rust, no CORS, full cookie jar). They _behave differently_, especially for `credentials: 'include'`, `Set-Cookie`, and SSE. The HTTP plugin has had gaps around HttpOnly cookie persistence.

**Mitigation:** pick one path per request type and document it; if you route a subset through Rust, pass through `User-Agent`, `Accept-Language`, and any API-required custom headers manually (these aren't automatic).

Refs: [plugins-workspace#1167](https://github.com/tauri-apps/plugins-workspace/issues/1167), [tauri#11518](https://github.com/tauri-apps/tauri/issues/11518)

## 9. Background behavior

- **iOS 17+** the webview fully suspends when hidden; timers/workers pause. Tauri v2 lets you pick suspend vs throttle via `backgroundThrottlingPolicy`.
- **Android** throttles JS timers after ~5 minutes minimized, and may kill the process under memory pressure.
- **Rust-side background work** is possible on Android via a foreground service but non-trivial on iOS (only BGTaskScheduler windows).

**Mitigation:** don't expect the sync worker to keep running; on resume, diff a server watermark and rehydrate. For push-style new-mail, ship native push via an APNs/FCM plugin rather than SW Push API (which isn't there on iOS WKWebView anyway).

Refs: [Tauri commit a2d36b8](https://github.com/tauri-apps/tauri/commit/a2d36b8c34a8dcfc6736797ca5cd4665faf75e7e), [tauri#5147](https://github.com/tauri-apps/tauri/issues/5147), [tauri discussion#11688](https://github.com/tauri-apps/tauri/discussions/11688)

## 10. Known Tauri 2 mobile bugs worth tracking

- Back button exits app instead of routing in SPA ([#14406](https://github.com/tauri-apps/tauri/issues/14406), [#8142](https://github.com/tauri-apps/tauri/issues/8142), [wry#1564](https://github.com/tauri-apps/wry/issues/1564)) — intercept via a plugin and wire to your router.
- Asset protocol 500s on Android ([#12364](https://github.com/tauri-apps/tauri/issues/12364)).
- Back navigation on Android hiccups ([#14939](https://github.com/tauri-apps/tauri/issues/14939)).
- Tauri globals occasionally not injected in emulator ([#6053](https://github.com/tauri-apps/tauri/issues/6053)).
- Webview unresponsive reports on some Android devices ([#14741](https://github.com/tauri-apps/tauri/issues/14741)).

## 11. Linux WebKitGTK — the weakest link

The community is openly frustrated ("webkitgtk is unusable", "more unstable each release"). Common breakages: WebRTC absent unless you rebuild, MediaSource/video codecs partial, SW registration spotty, occasional IDB corruption on `webkit2gtk-4.1` < 2.44, PDF viewer missing, DRM content disabled.

**Mitigation:** set minimum `webkit2gtk-4.1 ≥ 2.44` in packaging metadata; ship `.deb`, `.rpm`, and Flatpak (Flatpak bundles its own runtime so you control the WebKit version); be explicit to users that AppImage depends on system WebKit and may break on older distros. For Chromium-only features (push, background sync), feature-detect and hide the UI.

Refs: [tauri discussion#8524](https://github.com/tauri-apps/tauri/discussions/8524)

## 12. Distribution, signing, store review

- **Windows**: OV cert still shows SmartScreen warnings; EV cert gets instant rep. Plan ~$300–$600/yr.
- **macOS**: notarization mandatory for outside-App-Store distribution; App Store adds sandbox + entitlements review.
- **Linux**: AppImage GPG signatures aren't auto-verified; prefer Flatpak/Snap for trust + sandboxing, or rely on the distro's `.deb/.rpm` signed repo flow.
- **App Store (iOS)** — email apps face extra scrutiny around:
  1. Account creation → **in-app account deletion** required (5.1.1(v))
  2. Privacy nutrition labels for message content
  3. If any purchase path exists, new 2025 "external purchase email" rules apply
  4. Sign in with Apple required if offering any third-party sign-in
- **Play Store**: email clients don't need `QUERY_ALL_PACKAGES` or Accessibility, dodging the worst declarations; you _do_ need a Data Safety form (message bodies/attachments = user content) and a privacy policy URL. If SMS/call parsing is ever added, plan months of review.

Refs: [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/), [Tauri distribute](https://v2.tauri.app/distribute/), [App Store guidelines](https://developer.apple.com/app-store/review/guidelines/), [NextNative review checklist](https://nextnative.dev/blog/app-store-review-guidelines), [Play permissions policy](https://support.google.com/googleplay/android-developer/answer/16558241)

---

## Priority cheat-sheet

1. **Assume no service worker on iOS/macOS/any custom-protocol build.** Push offline/sync logic into the sync Web Worker + Rust. _(high)_
2. **Dexie 4, Blob-in-IDB tests on iOS, quota-error handlers everywhere** — the 50MB attachment cache is guaranteed to hit eviction on WebKit. _(high)_
3. **Route attachment download/streaming through Rust** (`fs`/`upload` + `convertFileSrc`), never `a[download]` with Blob URLs on Android. _(high)_
4. **Use the HTTP plugin** (or `tauri-plugin-cors-fetch`) for authenticated API calls — custom protocol cookies/CORS will bite you. _(high)_
5. **Swap rich `contenteditable` compose on mobile** for a robust editor (Lexical/ProseMirror latest) or textarea. _(medium-high)_
6. **Intercept Android back button** via plugin and route to your history stack. _(medium)_
7. **Set `backgroundThrottlingPolicy` explicitly**; don't rely on workers staying alive when hidden. _(medium)_
8. **Pin `webkit2gtk-4.1 ≥ 2.44`** and prefer Flatpak on Linux. _(medium)_
9. **Budget for EV Windows cert + macOS Developer Program + Play + Apple review cycles** (email clients get extra scrutiny on privacy labels and account deletion). _(upfront)_
