# Agent mode: discovery

Discovery pass required by §0 of the agent mode specification, written 2026-10-05
against `main` at `fd71c62` (webmail) and the current `forwardemail.net` checkout.
Where the codebase and the spec disagree, the codebase wins on mechanics and the
spec wins on invariants. Every contradiction is listed under
[Contradictions](#contradictions).

Status: the client prototype (M1 and most of M2 UI) is built against an
in-memory mock of the M0 server. No server work has started.

## Design tokens

- The token layer exists and is implemented: `src/styles/fe-tokens.css`
  (raw palette + semantic aliases), with `tokens.css` (legacy names) and
  `main.css` (shadcn/Tailwind bridge) layered on top. Migration log:
  `docs/design-system-migration-debt.md`.
- `design-system-spec.md` itself is not in this repo or anywhere under
  `~/Development/Source/empire` (searched to depth 4). The implementation in
  `fe-tokens.css` is treated as the spec of record.
- Text colour tokens are `--fg-*`, not the spec's `--text-*`, because
  `--text-*` is Tailwind v4's font-size namespace. `--text-secondary` in the
  agent spec maps to `--fg-secondary`.
- Agent mode adds `--fe-primary-deep` and the ten `--autonomy-*` tokens
  (§8.3). See contradiction 1 for `--fe-caution-deep`.
- Mono label (`--type-label`) is `.fe-type-label` / `<MonoLabel>`;
  `<StatusLog>` / `<StatusLine>` exist in `src/lib/components/ui/status-log`.

## Frontend stack

- Svelte 5 (runes) + Vite, shadcn-svelte on bits-ui under `src/lib/components/ui`,
  Tailwind v4, lucide icons.
- Routing is hand-rolled in `src/main.ts`: `detectRoute()` maps pathnames to a
  `routeStore` value, each top-level view is mounted once into its own
  `#*-root` element in `index.html`, and `updateRouteVisibility()` toggles
  `display`. `viewModel.navigate()` does `pushState` + `routeStore.set`.
  Sub-routes that keep the same top-level value (for example `/agents` to
  `/agents/:id`) do not re-fire `routeStore` subscribers, so agent mode has
  its own `agentsPath` store.
- Web, desktop (Tauri 2) and mobile (Tauri 2 Android/iOS) share the same Svelte
  bundle. Desktop compose is a separate Tauri window opened via
  `composeModal.open(prefill)`. Mobile is detected with `isTauriMobile` and
  responsive CSS; agent mode uses a 768px media query to switch to supervision
  only (§5.7).

## Sync layer

- Encrypted local store: Dexie in `db.worker`, field-level AES via
  `src/utils/db-crypto.ts`. The `meta` table is a key-value store; only key
  prefixes listed in `SENSITIVE_META_KEY_PREFIXES` are sealed. Agent mode
  caches its snapshot under `agent_cache_<account>` and that prefix was added
  to the sealed list.
- Offline mutation queue: `src/utils/mutation-queue.js`, stored in `meta` per
  account, drained by the page and by the service worker's Background Sync
  (`public/sw-sync.js`). Both processors needed changes:
  - The queue retried any thrown error up to 5 times and the SW treated any
    non-OK status as a retry. A 409 on an approval is an outcome, not a
    failure, so `agentDecision` completes on 409/422 and only transport
    errors retry.
  - The SW cannot reach the in-page mock, so mock-backed `agentDecision`
    mutations carry `mock: true` and the SW skips them.

## Rules code

- No rule IR or compiler exists in either repo. `rules-feature-spec.md` is
  not present anywhere. The only filtering engine is Sieve
  (`forwardemail.net/helpers/sieve/`, `/v1/sieve-scripts`; client
  `src/utils/sieve-rules.ts`).
- Consequence: §4.3 says agent policy compiles to the shared rule IR. That
  pipeline does not exist yet. The prototype implements `evaluate()` as a pure
  function in `src/utils/agent-policy.ts` with versioning, dry run and
  attribution, shaped so it can be lifted into whatever the rules work
  produces. Versioning and rollback live in the mock backend.

## Server surfaces (forwardemail.net)

- Alias model: `app/models/aliases.js`. No `kind`/`type` field and no agent
  concept anywhere. Tokens (`Token` subschema at :57) have description, salt
  and hash only: no scope, expiry or name.
- Alias auth: REST via `app/controllers/api/v1/alias-auth.js` →
  `helpers/setup-auth-session.js` → `helpers/on-auth.js`; SMTP uses the same
  `onAuth`. Alias tokens fall back to the domain catch-all
  (`domain.tokens`), so a catch-all password also authenticates as any
  alias. Agent credentials must not fall back to catch-all.
- Account API tokens are account-wide (`helpers/ensure-api-token-or-alias-auth.js`);
  there are no scoped tokens.
- Credential revocation: `helpers/credential-revocation.js` keeps a Redis
  revocation list (`alias:|account:|token:<id>`, 10 minute TTL) and closes
  WebSockets (close code 4001) and mail sessions. That is the natural home for
  the synchronous part of §4.4.
- Outbound: REST `POST /v1/emails` (`app/controllers/api/v1/emails.js`
  `create` :209) and SMTP `helpers/on-data-smtp.js` both converge on
  `Emails.statics.queue` (`app/models/emails.js:1463`). Per-alias
  `smtp_limit`, velocity (`helpers/check-smtp-velocity.js`) and reputation
  helpers sit before it. The agent evaluator belongs immediately before
  `Emails.queue` in both callers, which is also the integration point for
  open question 5 (abuse coupling).
- MCP: no MCP server in this repo. `forwardemail.net/AGENTS.md:26-28` points to
  an external `@forwardemail/mcp-server` that wraps the REST API with the same
  API-token or alias auth. Separating owner and agent tool surfaces (§4.7) is
  a change in that package.
- Webhooks: no user event webhooks. Inbound-to-URL recipients and
  `bounce_webhook` exist and sign with `domain.webhook_key`; the agent
  webhooks in §4.7 are new infrastructure.
- `/v1` routes: `routes/api/v1/index.js`.

## Push

- Server: `helpers/send-push-notification.js` `buildPayload` (:548) includes
  `sender`, `subject` and `snippet` in `data` for mail events. The agent
  payload must be a separate builder that emits only `{ type: 'agent_action', count }`
  (§5.6); reusing `buildPayload` would leak.
- Delivery: APNs, FCM, encrypted push, UnifiedPush, Web Push.
- Client: `src/utils/push-notifications.js`, `notification-manager.js`,
  `notification-open.ts`. Push is not wired for agent mode in the prototype
  (M3).

## Feature flags

- No flag system on either side. Server gating is by plan only
  (`users.plan`, `enforce-paid-plan.js`, `ensure-upgraded-plan.js`).
- Client "flags" are settings in `src/stores/settingsRegistry.ts`. Agent mode
  uses a new device-scope `agent_mode` setting (default off) with a derived
  `agentModeEnabled` store. This stands in for account-level enablement until
  the server owns it. `agentDnsRecord` (§6.3) has no flag yet.

## Existing related work

- Branch `feat/ai-mode` (5 commits, unmerged) adds an Ask AI panel that calls
  Claude from the client. That is a different feature and conflicts with
  invariant 7 (no user mail to third-party inference) as written. Nothing from
  it is reused here.

## Contradictions

1. **`--fe-caution-deep` already exists** as `#92400e` (amber-800), chosen
   because amber-700 (`#B45309`, the spec's value) is 4.39:1 on
   `--surface-sunken` and misses AA there. Kept the codebase value;
   `--autonomy-approve-bg` uses it. White text on it is about 7:1.
2. **Token names.** The spec's `--text-secondary` is `--fg-secondary` here
   (namespace collision with Tailwind font sizes).
3. **Declarations versus unclassified (§4.2 vs §10).** The spec says an
   undeclared new thread is unclassified, and also that a declaration never
   lowers restriction. If declaring `acknowledge` on a new thread cleared
   `unclassified`, the declared message would be less restricted than the
   undeclared one. Resolved in favour of the invariant: `initiate_known`
   always carries `unclassified`, so new threads are capped at `approve`
   whatever the agent declares. Consequence: `initiate_known` can never send
   at `notify` or `silent`. Product should confirm.
4. **Rule IR does not exist** (see Rules code). The evaluator is standalone
   for now.
5. **No scoped credentials** (open question 2). Agent credentials need either
   a scoped token type or a new alias token flag that disables catch-all
   fallback.
6. **409 body.** `Remote` copies only `code/description/param/type` from error
   bodies, so the client cannot read the current state from a 409. The client
   re-reads the action with `GET /v1/agent-actions/:id` instead. The server can
   still return it; the client does not depend on that.
7. **Approval re-evaluation response.** The spec says an approval under a
   tightened policy "fails with an explanation" but not with what status. The
   client and SW treat **422** as a final outcome (completes the queued
   mutation) and expect the explanation in `message`.
8. **Agent threads endpoint.** §4.7 has no endpoint for listing agent threads
   or reading one; the Thread screen needs them. The prototype assumes
   `GET /v1/agent-threads` and `GET /v1/agent-threads/:id`.
9. **Pause-all state.** §4.7 has `POST /pause-all` and `/resume-all` but no read.
   The prototype assumes `GET /v1/agents/pause-all` returns `{ paused }`.

## What the prototype covers

| Spec                                            | Where                                              | State                               |
| ----------------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| §3 domain model                                 | `src/types/agents.ts`                              | done                                |
| §4.2/4.3 classify + evaluate + dry run          | `src/utils/agent-policy.ts`                        | reference implementation, tested    |
| §4.4–4.6 server contract                        | `src/utils/agent-mock-backend.ts`                  | mock; real client in `agent-api.ts` |
| §5.1 Mail \| Agents switch, separate route tree | `ModeSwitch.svelte`, `main.ts`, `Agents.svelte`    | done                                |
| §5.2 screens                                    | `src/svelte/agents/*`                              | all five, plus Policies index       |
| §5.3 components                                 | `src/svelte/components/agents/*`                   | all seven                           |
| §5.4 earned autonomy                            | `AgentView.svelte`                                 | display only, raise is a local edit |
| §5.5 offline                                    | `agentStore.ts`, `mutation-queue.js`, `sw-sync.js` | done                                |
| §5.6 push                                       | none                                               | M3                                  |
| §5.7 mobile                                     | `Agents.svelte` (<=768px)                          | read-only policy, drawer nav        |
| §6.3 `_agent` record                            | none                                               | M5, behind a flag                   |
| §8.3 tokens                                     | `fe-tokens.css`                                    | done                                |
| §9 a11y + keys                                  | components + `Agents.svelte`                       | done; see note below                |

Accessibility note: the spec asks for the kill switch within two Tab stops
from anywhere in agent mode. It is the first focusable control in the shell
and has `Shift+P`; from deep inside a long page it is more than two stops
away. Meeting the letter would need a skip link or a roving focus trap.

Switch the UI to a real server build with
`localStorage.setItem('webmail_agent_mode_backend', 'server')`.
