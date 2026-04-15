# Security Hardening Guide

This document describes the security architecture, hardening measures, and best practices implemented across the Forward Email application. It covers the Tauri v2 backend, the PWA/webmail frontend, the service-worker replacement (sync-shim), WebSocket communication, notifications, auto-updater, and CI/CD pipelines.

## Table of Contents

1. [Tauri Backend (Rust)](#tauri-backend-rust)
2. [Content Security Policy](#content-security-policy)
3. [IPC Isolation Pattern](#ipc-isolation-pattern)
4. [Capability Least-Privilege](#capability-least-privilege)
5. [Frontend Bridges](#frontend-bridges)
6. [Service Worker and Sync-Shim](#service-worker-and-sync-shim)
7. [WebSocket Client](#websocket-client)
8. [Notifications](#notifications)
9. [Auto-Updater](#auto-updater)
10. [Deep-Links](#deep-links)
11. [IndexedDB and Local Storage](#indexeddb-and-local-storage)
12. [CI/CD Pipeline](#cicd-pipeline)
13. [Code Signing](#code-signing)
14. [Reporting Vulnerabilities](#reporting-vulnerabilities)

---

## Tauri Backend (Rust)

The Tauri backend in `src-tauri/src/lib.rs` implements the following hardening measures.

All IPC commands validate their inputs before processing. String parameters are checked for length limits and forbidden characters. Numeric parameters are bounds-checked. The `set_badge_count` command, for example, clamps its input to the range `[0, 99999]` and rejects non-finite values. The `open_external_url` command validates that URLs use the `https` scheme and belong to an allowlist of trusted domains (`forwardemail.net`, `github.com`, `github.com/forwardemail`). Any URL that does not match is rejected with an error.

The `show_notification` command sanitises title and body strings by stripping control characters and enforcing maximum lengths (256 for titles, 1024 for bodies). This prevents injection of invisible characters or excessively long strings that could cause UI issues.

Error handling uses Rust's `Result` type throughout, with descriptive error messages that do not leak internal paths or stack traces to the frontend.

## Content Security Policy

The CSP is defined in `src-tauri/tauri.conf.json` and enforces the following restrictions:

| Directive         | Value                                                        | Purpose                                                   |
| ----------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| `default-src`     | `'self'`                                                     | Block all resources not explicitly allowed                |
| `script-src`      | `'self'`                                                     | No inline scripts, no `eval()`                            |
| `style-src`       | `'self' 'unsafe-inline'`                                     | Allow inline styles (required by Svelte)                  |
| `img-src`         | `'self' https: data:`                                        | Allow images from HTTPS and data URIs                     |
| `connect-src`     | `'self' https://*.forwardemail.net wss://*.forwardemail.net` | Restrict API and WebSocket connections to trusted origins |
| `font-src`        | `'self' data:`                                               | Allow fonts from self and data URIs                       |
| `object-src`      | `'none'`                                                     | Block all plugins (Flash, Java, etc.)                     |
| `base-uri`        | `'self'`                                                     | Prevent base tag hijacking                                |
| `form-action`     | `'self'`                                                     | Restrict form submissions to same origin                  |
| `frame-ancestors` | `'none'`                                                     | Prevent clickjacking via framing                          |

The `dangerousRemoteDomainIpcAccess` array is empty, meaning no remote domains can invoke Tauri IPC commands.

### Cross-Platform Gotchas

CSP enforcement is not uniform across the three runtimes. Changes to `script-src`, `frame-src`, or anything the email iframe touches must be validated on each one.

**1. Three distinct policies are active.**

| Runtime    | Policy source                       | Parent origin           |
| ---------- | ----------------------------------- | ----------------------- |
| Web (PWA)  | `<meta http-equiv>` in `index.html` | `https://webmail.…`     |
| Tauri dev  | `src-tauri/tauri.conf.json` → `csp` | `http://localhost:5174` |
| Tauri prod | `src-tauri/tauri.conf.json` → `csp` | `tauri://localhost`     |

`vite.config.js` strips the `<meta>` CSP for Tauri builds (the `strip-csp-meta-for-tauri` plugin) so the two policies don't collide into a more-restrictive union.

**2. Tauri injects a nonce at runtime for its IPC bootstrap.** Per CSP spec, _once any nonce or hash is present in `script-src`, `'unsafe-inline'` is ignored_ for scripts that don't match. This silently breaks inline scripts that "worked" on web or in release builds. Symptom: `Refused to execute a script because its hash, its nonce, or 'unsafe-inline' does not appear in the script-src directive` even though `'unsafe-inline'` is clearly in the declared CSP.

**3. Sandboxed srcdoc iframes inherit the parent's CSP.** They add their own meta CSP on top — the effective policy is the intersection (most restrictive wins). So point 2 propagates into every email iframe. An inline script that works on web will fail inside the same iframe under Tauri dev.

**4. The email iframe uses an external script, not inline.** `public/email-iframe.js` is loaded via `<script src="${parent-origin}/email-iframe.js">` (see `src/utils/iframe-srcdoc.ts`). The srcdoc CSP is `script-src ${parent-origin}`. This side-steps the nonce-kills-unsafe-inline interaction because origin matches are unaffected by nonce presence. The previous hash-based approach had a race (the async SHA-256 computation wasn't always ready by first render) and would have been defeated by any future change to the script text. Do not revert to inline without also removing Tauri's nonce injection (which is not optional — it's part of the IPC bootstrap).

**5. When a link inside the email iframe appears to silently fail,** check the _iframe's_ devtools frame, not the top-level page. Two errors typically appear together: the srcdoc script is blocked (script-src), then the iframe's `<a>` navigates to the link target, which is blocked by the parent's `frame-src` because it's an external origin. Fix the first and the second goes away — the external script registers the capture-phase click interceptor that postMessages the URL up to `handleIframeLinkClick` in `Mailbox.svelte`, which calls `openUrl()` instead of navigating.

**6. When adding a new external origin (script, frame, connect),** update _both_ `index.html` and `src-tauri/tauri.conf.json`. It's easy to miss one; the web build will silently work while Tauri rejects, or vice versa.

## IPC Isolation Pattern

The application uses Tauri's **isolation pattern** (`src-tauri/isolation/index.html`), which interposes a sandboxed iframe between the main webview and the Tauri IPC bridge. The isolation script performs the following checks on every IPC message:

1. Validates that the message has a `cmd` field of type string.
2. Validates that the command name matches a known allowlist of commands.
3. Rejects messages with `__TAURI_INTERNALS__` or `__TAURI_INVOKE_KEY__` fields that could be used for privilege escalation.
4. Passes validated messages through to the Tauri core.

This prevents malicious or compromised frontend code from invoking arbitrary Tauri commands.

## Capability Least-Privilege

The capabilities file (`src-tauri/capabilities/default.json`) grants only the minimum permissions required for each plugin:

| Plugin       | Permissions Granted                                                                                                                   | Permissions Denied                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Notification | `allow-is-permission-granted`, `allow-request-permission`, `allow-notify`                                                             | `allow-register-action-types`, `allow-cancel`                     |
| Updater      | `allow-check`, `allow-download-and-install`                                                                                           | —                                                                 |
| Deep Link    | `allow-get-current`                                                                                                                   | —                                                                 |
| Window       | `allow-close`, `allow-set-title`, `allow-show`, `allow-hide`, `allow-minimize`, `allow-maximize`, `allow-set-size`, `allow-set-focus` | `allow-create`, `allow-destroy`, `allow-set-always-on-top`        |
| Shell        | `allow-open`                                                                                                                          | `allow-execute`, `allow-spawn`, `allow-stdin-write`, `allow-kill` |

The `shell:allow-execute`, `shell:allow-spawn`, and `shell:allow-kill` permissions are explicitly **denied** to prevent command injection attacks.

## Frontend Bridges

All frontend bridge modules (`tauri-bridge.js`, `notification-bridge.js`, `updater-bridge.js`, `sync-bridge.js`) implement the following patterns.

**Input validation.** Every function that accepts user-provided or event-provided data validates types and lengths before passing to Tauri IPC. String inputs are truncated to safe maximums and stripped of control characters.

**Credential handling.** Credentials (email/password) are never stored in module-level variables. They are read from `Local` storage only at the moment they are needed (e.g., WebSocket connection) and are not cached in closures or global state.

**Safe postMessage.** The `sync-bridge.js` module validates the `origin` of incoming `message` events against the expected origin before processing. Messages with unexpected origins are silently dropped.

**Error boundaries.** All async operations are wrapped in try/catch blocks. Errors are logged with contextual information but never expose stack traces or internal paths to the user.

## Service Worker and Sync-Shim

The service worker (`public/sw-sync.js`) and its main-thread replacement (`src/utils/sync-shim.js`) implement these hardening measures.

**Message validation.** The SW adapter validates every incoming `message` event, checking that `event.data` has a `type` field from a known allowlist (`SYNC_NOW`, `PROCESS_MUTATIONS`, `FETCH`, `GET_PENDING_COUNT`). Unknown message types are rejected.

**Origin checks.** In the web context, the SW only processes messages from clients with the same origin. In the Tauri context, the sync-shim validates that `postMessage` events come from the expected origin.

**Retry limits.** The sync-core module enforces a maximum retry count (default: 5) for failed mutations. After the limit is reached, the mutation is moved to a dead-letter queue in IndexedDB rather than retried indefinitely, preventing infinite retry loops.

**Exponential backoff.** Retry delays use exponential backoff with jitter to prevent thundering herd problems when the server recovers from an outage.

**Queue size limits.** The mutation queue enforces a maximum size (default: 10,000 entries). New mutations are rejected when the queue is full, preventing memory exhaustion.

## WebSocket Client

The WebSocket client (`src/utils/websocket-client.js`) implements comprehensive hardening.

**Authentication.** Credentials are sent as a base64-encoded `Authorization` header during the WebSocket handshake, not as URL parameters. This prevents credentials from appearing in server logs or browser history.

**Reconnection abuse prevention.** The client uses exponential backoff (1s, 2s, 4s, 8s, ... up to 60s) with random jitter for reconnection attempts. A maximum reconnection attempt limit (default: 100) prevents infinite reconnection loops. The attempt counter resets after a successful connection that lasts longer than 30 seconds.

**Message rate limiting.** Inbound messages are rate-limited to 100 messages per second. Messages exceeding this rate are dropped with a warning. This prevents a compromised or misbehaving server from flooding the client.

**Message size limits.** Messages larger than 1 MB are rejected before parsing. This prevents memory exhaustion from oversized payloads.

**Heartbeat/ping.** The client sends periodic ping frames (every 30s) and expects pong responses within 10s. If no pong is received, the connection is considered dead and is closed and reconnected.

**Payload validation.** All parsed message payloads are type-checked before being dispatched to event handlers. Payloads that do not match the expected structure for their event type are dropped.

## Notifications

The notification system (`src/utils/notification-manager.js`, `src/utils/notification-bridge.js`) implements the following.

**Input sanitisation.** All notification content (titles, bodies, tags) from WebSocket event payloads is sanitised before display. HTML entities are escaped, control characters are stripped, and strings are truncated to safe maximums (256 chars for titles, 1024 for bodies).

**Path validation.** Notification click paths are validated against an allowlist of prefixes (`#inbox`, `#folders`, `#calendar`, `#contacts`, `#settings`). Unknown paths default to `#inbox`.

**URL validation.** URLs in notification data (e.g., release URLs) are validated to ensure they use `https` and belong to trusted domains (`github.com`, `forwardemail.net`).

**Deduplication.** A time-windowed deduplication map (2-second window) prevents notification spam. The map is size-limited to 200 entries to prevent memory exhaustion.

**Permission checks.** Notification permission is requested lazily (on first notification) and cached. The system gracefully degrades when permission is denied.

## Auto-Updater

The auto-updater (`src/utils/updater-bridge.js`) implements these protections.

**Signature verification.** All update packages are cryptographically signed using the Tauri updater signing key. The Tauri runtime verifies signatures before applying updates. The signing private key is stored as a GitHub Actions secret and is never exposed to the frontend.

**HTTPS-only.** The update endpoint URL is validated to use `https` only. The endpoint is hardcoded to `https://releases.forwardemail.net` and cannot be overridden by the frontend.

**User consent.** Updates are never applied silently. The user is prompted with the version number and changelog before installation begins.

**Rollback.** If an update fails to install, the application remains on the current version. The updater does not retry failed installations automatically.

## Deep-Links

The deep-link handler (`src-tauri/src/lib.rs`) validates all incoming deep-link URLs.

**Scheme validation.** Only the registered `forwardemail://` scheme is accepted.

**Path validation.** The path component is validated against a known set of routes. Unknown paths are redirected to the inbox.

**Parameter sanitisation.** Query parameters are URL-decoded and sanitised before being passed to the frontend router.

## App Lock and Client-Side Encryption

The application provides an optional App Lock feature that encrypts all locally stored data (IndexedDB records, sensitive localStorage values) using libsodium. This protects user data at rest on the device.

**Envelope encryption architecture.** A random 256-bit Data Encryption Key (DEK) is generated per device. The DEK encrypts all data. The DEK itself is encrypted by a Key Encryption Key (KEK) derived from the user's PIN or passkey. The encrypted DEK and its salt are stored in localStorage as the "vault". This two-layer design means changing the PIN only requires re-encrypting the DEK, not re-encrypting all data.

**Key derivation.** The KEK is derived from the user's PIN using Argon2id (`crypto_pwhash`) with interactive-level parameters (3 iterations, 64 MB memory). This makes brute-force attacks on the PIN computationally expensive. For passkey-based authentication, the WebAuthn PRF extension is used to derive the KEK directly from the authenticator, with HKDF applied for domain separation.

**Passkey (WebAuthn) authentication.** Users can register a passkey (biometric, security key, or platform authenticator) using the `@passwordless-id/webauthn` library. The passkey can be used to unlock the app instead of a PIN. A backup PIN is always required as a fallback. The WebAuthn ceremony is performed entirely client-side with no server round-trips.

**Full IndexedDB encryption.** When App Lock is enabled, the `crypto-store` module provides `encryptRecord()` and `decryptRecord()` functions that are called by the database layer. All non-indexed fields in every IndexedDB record are encrypted using `crypto_secretbox_easy` (XSalsa20-Poly1305). Each record gets a unique random nonce. Indexed fields (e.g., `id`, `mailbox`, `date`) remain unencrypted to preserve query performance, but their values are non-sensitive identifiers.

**localStorage encryption.** Sensitive localStorage keys (credentials, PGP passphrases, auth tokens) are encrypted with the same DEK when App Lock is enabled. The `SENSITIVE_LOCAL_KEYS` set defines which keys are encrypted. Non-sensitive keys (UI preferences, lock configuration) remain unencrypted since they are needed before unlock.

**Memory safety.** The DEK is held in a module-scoped closure variable, never exposed on `window` or any global scope. On lock, `sodium.memzero()` is called to wipe the DEK from memory. The KEK is never stored; it is derived on-demand during unlock and immediately discarded after decrypting the DEK.

**Brute-force protection.** Failed PIN attempts trigger exponential backoff: 30 seconds after 3 failures, 60 seconds after 4, 300 seconds after 5+. The attempt counter and lockout timestamp are stored in localStorage and persist across page reloads. After 10 consecutive failures, the user is warned that continued failures may result in data wipe.

**Inactivity auto-lock.** A configurable inactivity timer monitors mouse, keyboard, touch, and scroll events. When the timeout expires, the app locks automatically, wiping the DEK from memory. The timer resets on any user interaction. Supported timeouts: 1 minute, 5 minutes, 15 minutes, 30 minutes, 1 hour, or never.

## IndexedDB and Local Storage

**IndexedDB isolation.** Each account's data is stored in a separate IndexedDB database, namespaced by account identifier. This prevents cross-account data leakage.

**Transaction safety.** All IndexedDB operations use explicit transactions with appropriate modes (`readonly` for reads, `readwrite` for writes). Transactions are kept as short as possible to prevent lock contention.

## CI/CD Pipeline

The CI/CD workflows implement the following supply chain protections.

**Minimal permissions.** Every workflow declares explicit `permissions` at the top level. CI build workflows use `contents: read` only. Release workflows use `contents: write` only. No workflow has `write-all` or `admin` permissions.

**Environment scoping.** Release workflows use GitHub's `environment` feature to scope secrets to the `release` environment. This prevents CI builds from accessing signing keys or credentials.

**Supply chain audits.** Dependency vulnerability scanning is handled by GitHub's native Dependabot alerts rather than in-workflow gates. In-workflow scanners (`cargo audit`, OSV-Scanner against `pnpm-lock.yaml`) were removed because npm's legacy audit endpoint was retired (410 Gone) and the remaining scans produced noisy advisories on dev-only dep paths that did not ship in the user bundle. Dependabot + GitHub's security advisories are the system of record; critical findings are triaged via PRs rather than blocking CI.

**Concurrency controls.** Release workflows use `cancel-in-progress: false` to prevent partial releases. CI workflows use `cancel-in-progress: true` to save resources.

**Artifact retention.** CI artifacts are retained for 7 days. Release artifacts are attached to GitHub Releases for permanent storage.

**Keystore cleanup.** The Android release workflow securely deletes the decoded keystore file after use, overwriting it with random data before deletion to prevent recovery.

**Version validation.** The release orchestrator validates that the tag matches semver format before creating a release, preventing malformed releases.

## Code Signing

All release binaries are code-signed.

| Platform | Signing Method                       | Verification                              |
| -------- | ------------------------------------ | ----------------------------------------- |
| macOS    | Apple Developer ID + Notarization    | Gatekeeper verifies on first launch       |
| Windows  | EV Code Signing Certificate          | SmartScreen trusts signed binaries        |
| Linux    | Tauri updater signature (.sig files) | Verified by the built-in updater          |
| Android  | Android Keystore (release key)       | Play Store and APK signature verification |
| iOS      | Apple Distribution Certificate       | App Store and device-level verification   |

SHA-256 checksums for all release artifacts are generated and attached to each GitHub Release as `SHA256SUMS.txt`.

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly by emailing **security@forwardemail.net**. Do not open a public GitHub issue for security vulnerabilities. We will acknowledge receipt within 48 hours and provide a timeline for a fix.

## Related Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Full architecture document including encryption details
- [SECRETS.md](./SECRETS.md) — Required secrets for CI/CD and code signing
- [Desktop CI Secrets](./desktop-ci-secrets.md) — Detailed desktop signing setup
- [RELEASES.md](./RELEASES.md) — Release process and artifact signing
- [App Lock Architecture](./app-lock-architecture.md) — Detailed App Lock encryption design
