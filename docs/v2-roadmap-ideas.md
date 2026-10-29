# v2 Roadmap Ideas

Ideas for after the current release line, with enough context to pick one up. These are proposals, not commitments. The facts about today's code were checked on 2026-10-28; check them again before starting, because the code moves.

## 1. Backend interface: open protocols (IMAP, SMTP, CalDAV, CardDAV, JMAP)

**Goal.** Let a user connect any standards-based mail server, not only the Forward Email API. The app is open source, and supporting the open protocols is what makes it a client people can use with their own servers. It is also the foundation for agent mode (section 2).

**Where the code is today.**

- There is no backend abstraction. Most calls go through `Remote.request(action, params)` in `src/utils/remote.js`. The parameters are shaped like the REST API, and some callers bypass the action vocabulary with `pathOverride` (`src/stores/mailService.ts`, `src/stores/filtersStore.ts`).
- Raw `fetch` calls go around it entirely:
  - `src/workers/sync.worker.ts` (seven calls)
  - `public/sw-sync.js`
  - the injected fetch in `src/utils/sync-core.js`
  - a hard-coded push-token URL in `src/utils/background-service.js`
- The API base (`src/config.ts`) is one global value, fixed at build time, so it can't differ per account.
- Realtime is Forward Email's own WebSocket protocol (`docs/WEBSOCKET.md`).
- There are no IMAP, SMTP, JMAP or DAV libraries, in JavaScript or in Rust.
- **What helps:**
  - The message model already speaks IMAP: `flags`, `uid`, `modseq`, folder paths, labels as keywords, Message-ID, In-Reply-To and References (`src/types/message.ts`, `normalizeMessageForCache` in `src/utils/sync-helpers.ts`).
  - Threading happens on the client.
  - Demo mode (`interceptDemoRequest` in `remote.js`) already shows that a whole backend can be swapped in at the action level.

**Phases.**

1. **Phase A, an interface only (refactor, no behaviour change).**
   - Define `MailBackend`:
     - folders and messages (list, get, flags, move, delete)
     - send, search and drafts
     - contacts and calendars
     - a realtime subscription
     - `capabilities()`
   - `ForwardEmailBackend` wraps today's REST and WebSocket code. Demo mode becomes a second implementation.
   - Every raw `fetch` moves behind the interface.
   - Each account gets its own backend and base URL.
   - The UI checks capabilities instead of assuming them. `src/utils/api-capabilities.ts` already does this for one flag.
   - This phase is about one to two weeks, and every existing test must still pass unchanged.
2. **Phase B, IMAP and SMTP in Rust (desktop and mobile).**
   - Browsers can't open raw sockets, so this lives in Tauri:
     - `async-imap` with CONDSTORE/QRESYNC for change tracking and IDLE for live updates
     - `lettre` for SMTP
     - `mail-parser` for parsing
   - A stable message id is folder + UIDVALIDITY + UID.
   - The network traffic happens in Rust, so the webview CSP stays as it is.
   - Test it first against Forward Email's own IMAP and SMTP servers.
3. **Phase C, CalDAV, CardDAV and ManageSieve.** ManageSieve (RFC 5804) lets the filters builder and Block sender work on other servers.
4. **Phase D, JMAP.** It runs over HTTP, so it is the only route that also works in the web app (Fastmail, Stalwart). After that, OAuth2 sign-in for Gmail and Outlook. Start with app passwords.

**What changes on a generic server.** The capability check turns each of these into an honest UI state rather than a bug:

| Feature        | Forward Email API        | Generic IMAP/SMTP                                    |
| -------------- | ------------------------ | ---------------------------------------------------- |
| Scheduled send | Held on the server       | Held in the client outbox; the app has to be running |
| Live updates   | WebSocket and push       | IDLE while the app is running                        |
| Labels         | Keywords                 | Keywords, or Gmail's own labels on Gmail             |
| Search         | Server search plus local | IMAP SEARCH plus local                               |
| Filters        | Sieve via the API        | ManageSieve, where the server offers it              |
| PGP send       | `raw` via `/v1/emails`   | Straight to SMTP                                     |

## 2. Agent mode on open protocols

The client prototype is on branch `feat/agent-mode` and runs against a mock. It includes:

- a policy evaluator
- an approval queue
- a hash-chained audit log
- pause, revoke and pause-all

See `docs/agent-mode-discovery.md` on that branch. No server work has started.

**Proposal: make the inbox the sandbox, using standard mail objects.**

- **Each agent is an alias.** It gets its own scoped credential, which never falls back to the domain catch-all. This is the same server work as scoped app passwords for people.
- **Approvals are drafts.** Pending agent sends sit in an `Agents/Pending` folder. Approving submits the draft; rejecting deletes it. This works from any IMAP client and over a backend from section 1.
- **The audit trail is mail.** The server records each agent action as an RFC 822 message in `Agents/Audit`, with `X-Agent-*` headers: agent, action class, policy version, the rule that decided, and the previous and current hash. The log is then portable, searchable and checkable by anyone, so `/audit/verify` becomes a convenience.
- **Policy is a versioned document.** The server evaluates it right before queueing, on both the REST and SMTP send paths, using the prototype's `evaluate()` as the reference.

**Open decisions:**

- Branch `feat/ai-mode` sends mail content to Anthropic from the client, with the user's key. The agent-mode spec rules that out ("no user mail to third-party inference"). Decide whether it becomes a device opt-in with its egress preview, or stays out.
- New threads to known contacts are capped at "approve". Product has not confirmed this.

## 3. Smaller items parked for v2

- **Server-side image proxy.** Remote images are blocked by default now, but loading them still reveals the reader's IP address.
- **One-click unsubscribe POST (RFC 8058) from the server.** The app opens the page in a browser today, because its CSP allows connections to the Forward Email API only.
- **Client-side WKD lookup.** On desktop through a Rust command; on web through a server endpoint.
- **Autocrypt headers.** Check first that `/v1/emails` accepts custom headers.
- **Credential sealing on mobile.** iOS Keychain through keyring; Android Keystore through a plugin.
- **Mobile email frame without `allow-same-origin`.** Move the Android touch handling to the frame's swipe messages, then test on devices.
- **Alias per sender from inside the app.** This needs alias creation to work with alias-password sign-in, not only API keys.
