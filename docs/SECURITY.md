# Security Architecture

This document describes what the Forward Email webmail and apps do to protect users, as the code does it today. It covers the web app (PWA), the Tauri desktop and mobile apps, and the release pipeline. Where a protection is partial or missing, it says so. If you find a claim here that the code does not back up, that is a bug in this document: please report it.

## Contents

1. [Threat model in brief](#threat-model-in-brief)
2. [What leaves the device](#what-leaves-the-device)
3. [Rendering email](#rendering-email)
4. [Content Security Policy](#content-security-policy)
5. [IPC boundary and capabilities](#ipc-boundary-and-capabilities)
6. [Credentials and local storage](#credentials-and-local-storage)
7. [App Lock](#app-lock)
8. [OpenPGP](#openpgp)
9. [Realtime (WebSocket)](#realtime-websocket)
10. [Service worker and offline queue](#service-worker-and-offline-queue)
11. [Notifications](#notifications)
12. [Deep links](#deep-links)
13. [Auto-update](#auto-update)
14. [Release pipeline and signing](#release-pipeline-and-signing)
15. [Known gaps](#known-gaps)
16. [Reporting vulnerabilities](#reporting-vulnerabilities)

## Threat model in brief

Treated as hostile:

- **Email content.** Any HTML, headers, attachments or links in a message.
- **Realtime and push payloads.** Their fields can carry sender-controlled text.
- **Deep links.** `mailto:` and `forwardemail://` URLs.

Treated as trusted:

- the Forward Email API (`api.forwardemail.net`)
- the app's own bundled code

Protection against other software running as the same OS user is limited. Without App Lock, such software can read whatever the app can.

## What leaves the device

There is no analytics, telemetry or crash reporting SDK. The app contacts:

| Host                                   | When                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| `api.forwardemail.net` (HTTPS and WSS) | All mail, calendar and contacts traffic, and realtime updates                    |
| `api.github.com`, `github.com`         | Release checks (`web-updater.js`, `desktop-download.js`) and the desktop updater |
| Hosts named in an email                | Only if remote images are loaded for that message or sender (see below)          |
| `api.forwardemail.net/v1/lookup`       | Only from the hidden Diagnostics page, without credentials                       |

**Feedback.** The feedback form sends an email from the user's own address to support@forwardemail.net. It shows a preview first, redacts paths, and includes only the categories the user ticked (`FeedbackModal.svelte`, `feedback-payload.ts`).

## Rendering email

**Sanitizing.** Message HTML goes through a dedicated DOMPurify instance (`src/utils/sanitize.js`). Links get `target="_blank" rel="noopener noreferrer"` and are opened by the app, never by navigating the frame.

**Remote content.**

- Remote images are blocked by default (`remoteImagesBlockedByDefault`, the `block_remote_images` setting).
- Tracking pixels are stripped by default (`block_tracking_pixels`). Pixels stay blocked when the user loads images, unless they choose "Load All".
- The user can load images for one message, or for every message from one sender. The trusted-sender list is kept per account in `remote-image-trust.ts`.
- When images are blocked, the frame's own CSP narrows `img-src` to `data: blob:`. That stops remote loads the HTML rewrite cannot see (`srcset`, CSS `url()`, `background=`).
- A body cached while images were allowed is sanitized again when blocking is on (`cachedBodyNeedsResanitize`), so the cache never serves images past the setting.

**The email frame.**

- Each body renders in a sandboxed `srcdoc` iframe (`EmailIframe.svelte`).
- Its CSP (`iframe-srcdoc.ts`) is `default-src 'none'`. The only script it allows is `/email-iframe.js`, the app's own runtime, so inline script in an email does not run. It also sets `form-action 'none'` and `base-uri 'none'`.
- The sandbox is `allow-scripts` without `allow-same-origin` on the web and the desktop apps. The email document gets an opaque origin, so even script that got past both the sanitizer and the CSP could not reach the app's storage or the Tauri bridge. It talks to the app only by `postMessage`, and the app checks `event.source` and a per-document token.
- **Exception:** the iOS and Android apps still add `allow-same-origin`. The parent attaches touch listeners to the frame's document because Android WebView can swallow touches inside it. That path has not yet been checked on devices without it, so on mobile the sanitizer and the frame CSP are the boundary.

**Link preview (desktop).** Hovering a link shows its real destination (`link-preview.ts`):

- It warns when the link text names a different host than the link goes to.
- It flags punycode/IDN hosts.
- It strips credentials from the URL.

**Sender authentication.** SPF, DKIM and DMARC results are parsed from `Authentication-Results` and shown in the message details (`security-helpers.js`). There is no look-alike-domain or display-name-spoofing banner yet.

## Content Security Policy

There are three policies:

| Runtime                    | Source                                            |
| -------------------------- | ------------------------------------------------- |
| Web app                    | `<meta http-equiv>` in `index.html`               |
| Web compose window         | `<meta http-equiv>` in `compose.html`             |
| Tauri (desktop and mobile) | `app.security.csp` in `src-tauri/tauri.conf.json` |

For Tauri builds, the `strip-csp-meta-for-tauri` plugin in `vite.config.js` removes the meta tags, so only the Tauri policy applies.

| Directive                 | Web (`index.html`)                                                                      | Tauri                                           |
| ------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `default-src`             | `'self'`                                                                                | `'self' tauri: asset:`                          |
| `script-src`              | `'self' 'unsafe-inline' 'wasm-unsafe-eval'`                                             | `'self' 'unsafe-inline' 'wasm-unsafe-eval'`     |
| `style-src`               | `'self' 'unsafe-inline'`                                                                | `'self' 'unsafe-inline'`                        |
| `img-src`                 | `'self' data: blob: https:`                                                             | `'self' data: blob: https: http: tauri: asset:` |
| `connect-src`             | `'self' https://api.forwardemail.net wss://api.forwardemail.net https://api.github.com` | the same three hosts, plus Tauri's IPC origins  |
| `frame-src`               | `'self'`                                                                                | `'self' blob: data: tauri:`                     |
| `worker-src`              | `'self' blob:`                                                                          | `'self' blob:`                                  |
| `object-src`              | `'none'`                                                                                | `'none'`                                        |
| `base-uri`, `form-action` | `'self'`                                                                                | not set                                         |

Notes on these policies:

- `'unsafe-inline'` in `script-src` is there for the small boot scripts in `index.html`. In Tauri, the runtime injects a nonce for its IPC bootstrap, and a nonce disables `'unsafe-inline'` for every script without one. That is why the email runtime is an external file rather than inline.
- `'wasm-unsafe-eval'` is for libsodium and Argon2.
- There is no `frame-ancestors`. A meta CSP cannot set it, and it is not set in the Tauri policy.
- When adding a new origin, update `index.html`, `compose.html` and `tauri.conf.json` together. The web build will work while Tauri rejects the origin, or the other way round.
- Sandboxed `srcdoc` frames inherit the parent's policy and add their own. The stricter rule wins.

## IPC boundary and capabilities

The app runs Tauri's default ("brownfield") pattern. The isolation pattern is not enabled. A script running in the main webview is limited by:

1. **The capabilities in `src-tauri/capabilities/`, enforced in Rust.**
   - `default.json` covers the main window and compose windows. `desktop.json`, `mobile.json` and the per-platform push files add more.
   - Grants:
     - Notifications: permission, notify, channels, action types.
     - `core:webview:allow-create-webview-window`, for compose windows.
     - Updater check and install (desktop).
     - Deep links.
     - Dialog open and save.
     - Process exit and restart, log, OS info, window state, and the push plugins.
   - The opener may open any `http://` or `https://` URL in the system browser, and only `$TEMP/forwardemail-original-*` files as paths.
   - `fs` write access is scoped to the same temporary files. Read and remove get their paths at runtime from the file dialog. There is no static `**` scope.
   - There is no shell plugin.
2. **Input checks in each app command** (`src-tauri/src/*.rs`). There is no blanket validator.
   - `set_badge_count` rejects values over 99999.
   - `is_valid_deep_link` rejects control characters and links over 8 KB.
   - `open_url_in_browser` (the Windows external-browser override) accepts only `http(s)` URLs with a host. It rejects shell metacharacters, UNC paths and `..` in the browser path.
3. **`ALLOWED_COMMANDS` in `src/utils/tauri-bridge.js`.** This only filters calls made through that module. Code that reaches `window.__TAURI_INTERNALS__` directly is not filtered by it.

No capability sets `remote`, so pages from other origins cannot call IPC.

## Credentials and local storage

**Where data lives.**

- Credentials are either an alias password (`alias_auth`, sent as HTTP Basic) or an API key.
- A sign-in validates by calling `GET /v1/folders`. There are no tokens to refresh. Three consecutive 401s sign the tab out.
- Credentials are tab-scoped: each tab keeps its own copy in `sessionStorage`. The `localStorage` copy is what survives a restart, unless the user turned off "Stay signed in".
- Several accounts can be signed in. Requests carry the auth of the account they were made for, not whichever account is active when they complete.
- Mail is cached in one IndexedDB database, `webmail-cache-v1`, with an `account` column on each record. Accounts share the database. They are not separate databases.

**Sensitive values.** These `localStorage` keys are treated as sensitive (`isSensitiveLocalKey` in `crypto-store.js`):

- credentials and the multi-account list
- catch-all passwords
- PGP private keys and their passphrases

How they are stored depends on the platform and on App Lock:

| Situation                       | How sensitive values are stored                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Lock on, unlocked           | Encrypted with the vault key (see App Lock)                                                                                                                     |
| App Lock off, desktop app       | Sealed with a random key kept in the OS credential store (Keychain, Credential Manager, Secret Service). See `device-seal.ts` and `src-tauri/src/device_key.rs` |
| App Lock off, web or mobile app | Plaintext                                                                                                                                                       |

**The desktop device key.**

- A copy of the profile directory alone no longer gives away credentials or private keys: a backup, a synced home folder, or a lost disk.
- It does not stop code running as the same user, which can ask the credential store for the key too.
- The key is loaded by `src/boot.ts` before the app reads any credential, so reads stay synchronous.
- If the credential store is unavailable (for example, a Linux session without a Secret Service), values stay as they were and the app works as before.
- If the key is lost, sealed values cannot be read, and the user signs in again.
- If the store does not answer within 4 seconds (for example, a keyring unlock prompt), the app starts without the key. Sealed lists such as PGP keys are then protected from being overwritten. If the key arrives later, the app picks it up.
- The Diagnostics page has a "Credential sealing" line. It shows whether sealing is on, why it is unavailable, and how many saved values cannot be opened.

## App Lock

App Lock is opt-in. It locks the UI and encrypts local data at rest. See [app-lock-architecture.md](./app-lock-architecture.md) for the full design.

**Keys.**

- A random data key (DEK) encrypts the data.
- The DEK is wrapped with libsodium `secretbox` under a key-encryption key (KEK).
- The KEK is derived from the PIN with Argon2id (3 iterations, 256 MiB), or from a passkey through the WebAuthn PRF extension and keyed BLAKE2b.
- The settings UI adds passkeys only after a PIN is set. The API itself can create a passkey-only vault.

**What is encrypted.**

- **IndexedDB.** `db-crypto.ts` seals records in `messages`, `messageBodies`, `drafts`, `outbox`, `searchIndex` and the sensitive `meta` families (mutation queue, contacts, attachment blobs, saved searches, calendars) with AES-256-GCM. The subkey is derived from the DEK.
  - Fields the database indexes stay in plaintext so queries work: account, id, folder, dates, flags, labels, unread state, and attachment and modseq markers.
  - So do label names, folder paths and unread counts.
  - Writes to sealed tables fail closed while locked.
- **localStorage.** The sensitive keys listed above are encrypted with the DEK. Each unlock sweeps any value written while locked.
- **Not covered.** While a tab is unlocked, `sessionStorage` holds plaintext credentials and the DEK, so a reload does not prompt again. Both are cleared on lock and when the tab closes.

**Locking.**

- Inactivity timeouts: 30 s, 1, 2, 5, 10, 15 or 30 min, 1 h, or never. Lock on minimize is optional.
- On lock, the DEK buffer is zeroed and dropped.
- Wrong PINs back off: 30 s after the 3rd attempt, then 60 s, 120 s, 300 s, 600 s, 1800 s, and 3600 s from the 9th. The state survives reloads. Nothing is wiped after repeated failures.
- The service worker has no access to the key, so background content sync is skipped while App Lock is on.

## OpenPGP

All OpenPGP work runs in the sync worker with openpgp.js v6.

**Keys.**

- Users can create a key pair (v4, Curve25519) or import a private key. Both are stored per account.
- The creation flow requires a passphrase of at least 8 characters, offers the public key and a revocation certificate for download, and pins the public key for the user's own address.
- Passphrases can be remembered. They are stored like the other sensitive values above.

**Contacts' keys.** Users pin public keys per correspondent (`pgp-recipients.ts`). The client does no WKD, keyserver or Autocrypt lookup. The server encrypts opportunistically when it finds a WKD key, but the client cannot see or force that.

**Decryption.**

- Handles PGP/MIME and inline messages, and protected-headers subjects.
- Signatures inside encrypted messages are checked against pinned contact keys and the user's own keys. The reader shows one of:
  - **verified**: the signing key is held and belongs to the From address
  - **signed by someone else**: valid, but the key belongs to another address
  - **invalid**: a held key's signature does not match
  - **signing key revoked**: the key is held but its owner revoked it
  - **signed, not verified**: no key for it is held
- Signed-only messages (`multipart/signed`) that arrive are not verified yet.

**Sending.**

- Encrypting builds RFC 3156 PGP/MIME on the device and posts it as `raw`, so the server never sees the plaintext. Encrypted messages are signed when a key is unlocked.
- Users can also sign without encrypting (RFC 3156 `multipart/signed`).
- Both refuse Bcc: for a raw message, the API builds the delivery envelope from the headers, so a Bcc recipient would be visible.
- Scheduled send is not available for either, because a raw message carries its own Date.
- The Subject is not encrypted.

## Realtime (WebSocket)

`src/utils/websocket-client.js` keeps one socket per signed-in account to `wss://api.forwardemail.net/v1/ws`.

- **Auth.** It connects with `?auth=message` and sends the credentials in the first message (`{event: 'auth', ...}`), so they never appear in the URL.
- **Limits.** Messages over 64 KB are dropped. More than 200 messages in 60 s triggers a single `rate-limit` event, and listeners respond with a full refresh rather than processing the flood.
- **Liveness.** The server pings every 30 s. The client closes the socket if no ping arrives within 45 s.
- **Reconnects.** Backoff starts at 1 s and doubles up to 60 s, with up to 2 s of jitter. The client gives up after 50 attempts. The counter resets when the server confirms the connection, when the device comes back online, or on a manual reconnect.
- **Event checks.** Events must have a string name. Per-event payload checks happen in the handlers.
- **Account gating.** Multi-account handlers act only on events stamped with the account they belong to.

## Service worker and offline queue

- `public/sw-sync.js` runs background sync of folders, messages and the mutation queue.
- It handles a fixed set of message types: `startSync`, `cancelSync`, `syncStatus`, `push-accounts`, `close-idb`, `reopen-idb`. It ignores anything else. It does not check the sender's origin; same-origin clients are the only ones that can reach it.
- Offline changes (read, star, move, delete, label) queue in IndexedDB. They retry with exponential backoff (3 s base, 2 min cap, up to 20% jitter) for at most 5 attempts.
- A mutation that still fails is reported to the UI and removed. There is no dead-letter store, and the queue has no size cap.

## Notifications

`notification-manager.js` and `notification-bridge.js` handle notifications.

- **Sanitizing.** Titles and bodies have control characters stripped and are truncated: 256 characters for titles, 1024 for bodies in the manager, and 4096 in the bridge. On Linux, markup is escaped before display.
- **Click targets.** Only app paths under `/calendar`, `/contacts` and `/mailbox/settings` are followed. Release links must be `https` on github.com or forwardemail.net.
- **Deduplication.** Tags already notified are remembered for 3 days, up to 500 entries.
- **Permission.** It is requested only from a user action.

## Deep links

- The desktop app registers `mailto:` and `forwardemail://`.
- In Rust, `is_valid_deep_link` rejects control characters and links over 8 KB, and buffers at most 32 links that arrive before the frontend is ready.
- `mailto:` links are parsed by `parseMailto` and only pre-fill the composer. They never send.
- `forwardemail://` links are mapped to an in-app target. Otherwise a path that starts with `/` and a letter is navigated as an in-app route. Nothing outside the app is opened.

## Auto-update

- **Desktop updates are signed.** The Tauri updater verifies each package against the public key in `tauri.conf.json`. The signing key lives in the `release` CI environment, and a release build fails without it.
- **Source.** The manifest is `latest.json` on the GitHub release (`github.com/forwardemail/mail.forwardemail.net/releases/latest/download/latest.json`).
- **Updates install automatically.** The app checks hourly, and when a realtime `newRelease` event arrives. When a newer version exists it shows a toast ("Installing update vX, the app will restart"), installs, and relaunches. It does not ask first. A failed install leaves the current version in place and is retried at the next check.
- **Web app.** The web app updates through its service worker.

## Release pipeline and signing

- **Workflow permissions.** Workflows declare explicit permissions. CI uses `{}` at the top with per-job grants. Release workflows grant `contents: write` plus `id-token` and `attestations` for provenance.
- **Secrets.** Signing secrets are scoped to the `release` environment.
- **Tags and builds.** Release tags must be semver. Release workflows do not cancel in progress.
- **Android keystore.** The main Android job overwrites the decoded keystore with random data before deleting it.
- **Checksums and provenance.** Releases attach `SHA256SUMS.txt` when there are artifacts, and SLSA build provenance attestations.
- **Dependencies.** Dependency advisories come from Dependabot. There is no in-workflow audit gate.

| Platform | Signing                                   |
| -------- | ----------------------------------------- |
| macOS    | Apple Developer ID, notarized             |
| Windows  | SSL.com eSigner (HSM-backed) Authenticode |
| Linux    | Updater signature (`.sig`)                |
| Android  | Release keystore                          |
| iOS      | Apple distribution certificate            |

## Known gaps

These are tracked and not yet addressed:

- **Plaintext storage without App Lock.** Without App Lock, the web and mobile apps keep credentials and PGP keys in plaintext `localStorage`. The desktop seal does not apply there yet.
- **Mobile email frame.** It still uses `allow-same-origin` (see [Rendering email](#rendering-email)).
- **PGP verification and key discovery.**
  - Incoming `multipart/signed` messages are not verified.
  - There is no client-side WKD or Autocrypt.
  - S/MIME is not supported.
- **Sender warnings.** There is no warning for look-alike domains or display-name spoofing.
- **Image proxy.** There is no server-side image proxy, so loading remote images reveals the reader's IP address to the sender.
- **`'unsafe-inline'`.** It remains in `script-src`.

## Reporting vulnerabilities

Follow the organization security policy:

- <https://forwardemail.net/security>
- <https://forwardemail.net/security.txt>
- <https://github.com/forwardemail/.github/blob/main/SECURITY.md>

Please do not open a public issue for a vulnerability.

## Related documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [App Lock Architecture](./app-lock-architecture.md)
- [SECRETS.md](./SECRETS.md) and [Desktop CI Secrets](./desktop-ci-secrets.md)
- [RELEASES.md](./RELEASES.md)
- [WEBSOCKET.md](./WEBSOCKET.md)
