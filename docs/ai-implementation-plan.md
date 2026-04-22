# Forward Email AI Integration — Implementation Plan

Companion to the AI Integration Architecture Specification. This document translates the spec into a file-level build plan with concrete hook points in the existing webmail codebase.

**Status:** Phase 1 scoped. Phase 1.5 (Context Sources) scoped. Phases 2–4 outlined.
**Last updated:** 2026-04-19

## Core Principles

These sit above every phase and are non-negotiable without an explicit spec revision.

1. **Human-in-the-loop is the default.** AI writes; the user sends. Every mutation — sending mail, applying labels, moving folders, modifying drafts — flows through the existing UI controls the user would use manually. Auto-execute is a Phase 3+ consideration behind an explicit opt-in per feature. An AI draft is never indistinguishable from user-authored content — it lands in Compose with an "AI draft" marker and a sources panel.
2. **Streaming-first UX.** Tokens render as they arrive; tool calls surface in real time ("reading `src/api/auth.ts`…"); "Cancel" is visible at every stage. A spinner with no other signal is a bug.
3. **Sources are first-class.** Every AI output that touches external context (email threads, repositories, knowledge bases) surfaces the files/messages it pulled from, clickable to preview.
4. **Model-agnostic UX.** Claude, OpenAI-compatible, local Gemma — same surface, different price/privacy profile. Features gracefully degrade when a provider lacks a capability (tool use, long context).
5. **Privacy boundaries are declared, not inferred.** The egress preview tells the user what is about to leave the device. Local-only mode makes egress impossible.
6. **Context is always scoped, never implicit.** Every AI request declares which messages, files, or other sources the model may reference. The default is the most restrictive scope that can answer the question (single thread for drafting and summarizing). Expanding scope is a per-session, deliberate user action — never sticky across sessions, never implied. Tools enforce scope at the boundary, not on trust. See `src/ai/context/scope.ts`.

## Locked Design Decisions

Five decisions that diverge from or clarify the spec. These apply throughout the phases below.

1. **AI keys reuse `crypto-store.js` DEK** (not a session-JWT-derived key). The existing envelope encryption (DEK wrapped by PIN/passkey-derived KEK) already protects `api_key` / `alias_auth`. AI provider keys go into the same sensitive-localStorage bucket via `encryptValue` / `decryptValue`, so there is no second key hierarchy and unlock UX stays unified. Consequence: users without app-lock enabled get whatever protection `api_key` has today.
2. **CSP diverges web vs. desktop.** Web uses a static provider-host allowlist in `src/ai/providers/allowlist.ts` folded into the existing meta-tag CSP. Desktop keeps the webview CSP locked and proxies all AI HTTPS egress through Rust `reqwest`, so provider hosts never appear in `connect-src`.
3. **Phase 1 desktop keeps tool execution in JS.** The Rust AI module owns provider I/O, keyring, and egress guard only. The `ai.worker` tool registry (search, thread fetch, etc.) runs in the webview and talks to Dexie via the existing db.worker on both platforms. Rust tool execution against SQLite FTS5 lands in Phase 2.
4. **No Dexie schema bump.** `DB_NAME` embeds `SCHEMA_VERSION`, so bumping the version would orphan every user's mailbox cache and force a full re-sync. AI state instead piggybacks on the existing `meta` key-value table (the same idiom used by mutation-queue, contact-cache, and attachment-cache): `ai:provider:{id}` rows for provider metadata, `ai:audit:{YYYY-MM-DD}` rows bucketed per day for audit events, `ai:settings` for a singleton config row. API keys live in localStorage under `ai_provider_key_{providerId}`, auto-encrypted by the existing sensitive-localStorage path. `size_min_bytes` / `size_max_bytes` stay dropped from the Phase 1 DSL since no index backs them.
5. **Scoped context primitive.** Three scopes: `thread` (safest default; messages sharing a thread id), `participants` (messages with the same from/to set), `mailbox` (full access — requires explicit per-session confirmation, never sticky). `thread` scope pre-loads the full thread into the prompt so drafting sees the conversation history, not just the one selected message. Broader scopes use tool calls (landing in Sub-milestone F) that enforce the scope at the boundary — `search_messages` cannot return results outside what was authorized. Critical for shared support inboxes where one mailbox serves many unrelated customers.

## Phase 1 — Foundation (6–8 weeks)

### Dependency Graph

```
          ┌───────────────────────────────────────────────┐
          │ A. Shared packages (types, DSL, prompts)      │
          └────────┬──────────────────────────┬───────────┘
                   │                          │
          ┌────────▼─────────┐       ┌────────▼─────────────┐
          │ B. Web key vault │       │ C. Rust AI skeleton  │
          │ (extends         │       │ (mod + commands +    │
          │  crypto-store)   │       │  tauri-bridge plumb) │
          └────────┬─────────┘       └────────┬─────────────┘
                   │                          │
          ┌────────▼─────────┐       ┌────────▼─────────────┐
          │ D. ai.worker +   │       │ E. Provider adapters │
          │ aiStore/Audit/   │◄──────┤ (TS + Rust: Anthropic│
          │ Settings stores  │ share │  + OpenAI-compat)    │
          └────────┬─────────┘ DSL   └────────┬─────────────┘
                   │                          │
          ┌────────▼──────────────────────────▼─────────────┐
          │ F. Tool Registry + Egress Guard                 │
          │ (web + desktop both route through ai.worker     │
          │  in Phase 1 per decision #3)                    │
          └────────┬─────────────────────────────────────────┘
                   │
          ┌────────▼─────────┐
          │ G. Settings → AI │
          │ UI (new section  │
          │ in Settings.svelte)│
          └────────┬─────────┘
                   │
          ┌────────▼─────────────────────┐
          │ H. Feature UI: Smart Search  │
          │    + Thread Summarize        │
          └──────────────────────────────┘
```

Sub-milestones A, B, C can ship in parallel. D depends on A + B. E depends on A + C. F unifies both branches. G and H are UI-last.

### File-Level Build Order

**Sub-milestone A — Shared Contracts (week 1)**

Create:

- `src/ai/providers/types.ts` — `Provider`, `ChatMessage`, `StreamEvent`, `ToolDef`, `ChatOptions` (spec §4.1).
- `src/ai/dsl/search-query.ts` — `SearchQuery` type + strict validator. No `size_min_bytes` / `size_max_bytes` in v1.
- `src/ai/dsl/compile-flexsearch.ts` — compiles DSL → `{ dexieFilter, flexsearchText }` using existing `src/utils/search-query.js` tokens and `src/stores/searchStore.ts` plumbing.
- `src/ai/prompts/system.ts` — frozen system prompts for `smart_search` and `summarize` with `<email>` delimiter tokens (spec §12).
- `src/ai/errors.ts` — normalized `AIErrorCode` enum + `AIError` class (spec §4.4).
- `src/ai/providers/allowlist.ts` — per decision #2: static list of provider hosts CSP allows on web.

**Sub-milestone B — Web Key Vault (week 1–2)**

Modify:

- `src/utils/crypto-store.js` — extend `isSensitiveLocalKey` to treat `ai_provider_key_*` as sensitive so the existing `readSensitiveLocal` / `writeSensitiveLocal` path auto-encrypts when app-lock is on.

Create:

- `src/ai/keystore-web.ts` — provider metadata via the `meta` table under `ai:provider:{id}` keys; API keys via `readSensitiveLocal('ai_provider_key_{id}')` / `writeSensitiveLocal(...)`. `getProviderKey` is guarded so it only succeeds inside `WorkerGlobalScope` (see `db-worker-client.js:31` pattern). Plaintext never touches main thread.

No `db.worker.ts` or `db-constants.ts` changes (per decision #4).

**Sub-milestone C — Rust AI Skeleton (week 1–2, parallel)**

Create (new tree `src-tauri/src/ai/`):

- `mod.rs` — pub submodules, shared `AIConfig` state, `AIError` enum.
- `commands.rs` — `ai_chat`, `ai_cancel`, `ai_configure_provider`, `ai_validate_provider`, `ai_get_audit_log`, `ai_get_keystore_status`. Streams events via `app.emit("ai:stream:{id}", event)`.
- `providers/{mod.rs, anthropic.rs, openai_compat.rs}` — `Provider` trait mirroring the TS interface; `reqwest` SSE streaming.
- `egress_guard.rs` — URL allowlist check; rejects non-loopback when local-only is set (spec §9.1).
- `audit.rs` — append-only log at `${APP_DATA}/ai-audit.jsonl`, 30-day rotation.
- `keyring.rs` (at `src-tauri/src/`) — `keyring-rs` wrapper with Linux Secret Service fallback (risk #3 resolution): primary path stores a 32-byte seed; fallback derives Stronghold password from the `crypto-store` DEK via HKDF when `keyring-rs` init fails. `AI_TEST_EPHEMERAL_KEYSTORE=1` switches to in-memory-only for CI.

Modify:

- `src-tauri/Cargo.toml` — add (desktop-only target gating): `tokio-stream`, `eventsource-stream`, `keyring = "3"`, `tauri-plugin-stronghold = "2"`. `reqwest`, `rustls`, `tokio`, `hyper`, `futures-util`, and `url` are already pulled in transitively by `tauri-plugin-updater` (confirmed in `Cargo.lock`) and do not need to be declared again. Net binary add: ~1.5–2.5 MB (Stronghold is the bulk; everything else is under 150 KB combined).
- `src-tauri/src/lib.rs` — `mod ai;` at line 6, register 6 commands in `generate_handler!` (~line 576), register stronghold plugin in the builder.
- `src-tauri/capabilities/default.json` — add `stronghold:default` permission.
- `src-tauri/tauri.conf.json` — leave webview CSP locked (decision #2). AI HTTPS goes through Rust.
- `src/utils/tauri-bridge.js:69` (`ALLOWED_COMMANDS`) — add the 6 AI commands.

**Sub-milestone D — ai.worker + Stores (week 2–3)**

Create:

- `src/workers/ai.worker.ts` — mirrors the structure of `src/workers/search.worker.ts`. Holds decrypted keys in memory only, builds prompts, calls provider adapter, streams events back, dispatches tool calls to db.worker via `MessageChannel` (and eventually to search.worker the same way).
- `src/utils/ai-worker-client.js` — main-thread shim. Copy shape of `src/utils/search-worker-client.js`. Exposes `chat(feature, messages, { onToken, onToolCall, onDone, onError })` with `AbortController`. Sets up the MessageChannel to db.worker at bootstrap.
- `src/ai/providers/anthropic-web.ts`, `src/ai/providers/openai-compat-web.ts` — `fetch` + `ReadableStream` + `TextDecoderStream` SSE readers. Implement the shared `Provider` interface.
- `src/ai/egress-guard-web.ts` — pre-flight URL allowlist check called from each web adapter.
- `src/stores/aiStore.ts` — `writable()` stores matching the `searchStore.ts` style: `currentStream`, `isStreaming`, `lastError`, `currentFeature`.
- `src/stores/aiSettingsStore.ts` — providers list, feature→provider binding, `local-only` flag, redaction prefs. Persists via `settingsRegistry` with `DEVICE` scope.
- `src/stores/aiAuditStore.ts` — reads `aiAuditLog` Dexie table; 30-day retention job hooked into `src/utils/background-service.js`.

Modify:

- `src/main.ts` (~line 383) — initialize `aiWorkerClient` after db + search workers are ready.

**Sub-milestone E — Provider Adapters (weeks 2–4, parallel with D)**

Two implementations (web TS + Rust) share prompts and DSL. A single fixture suite must pass both.

Create:

- `src/ai/providers/__fixtures__/` — canned SSE streams for Anthropic (`message_start`, `content_block_delta`, `message_delta`) and OpenAI-compat (`data: {...}\n\n`).
- `tests/ai/provider-contract.test.ts` — contract suite both web adapters run against.
- `src-tauri/src/ai/providers/tests.rs` — Rust equivalent.

**Sub-milestone F — Tool Registry + Egress Guard (weeks 3–4)**

Create:

- `src/ai/tools/registry.ts` — allowlist dispatcher. Phase 1 exposes read-only tools: `search_messages`, `get_thread`, `list_folders`, `list_labels`.
- `src/ai/tools/search-messages.ts` — takes a `SearchQuery`, compiles via `src/ai/dsl/compile-flexsearch.ts`, posts through ai.worker → search.worker + db.worker, returns normalized hits.
- `src/ai/tools/get-thread.ts` — uses the existing `dbClient.messages.where('[account+folder]')` path; matches `indexMessages` structure in `search.worker.ts:149–173`.
- `src-tauri/src/ai/tools/` — minimal for Phase 1 per decision #3. Rust tool registry is a stub; all execution happens in the webview.

**Sub-milestone G — Settings → AI UI (weeks 4–5)**

Modify:

- `src/svelte/Settings.svelte` — add `'ai'` to the sections array (lines 489 and 1291), add a `{#if section === 'ai'}` mount block (~line 2067). Because the file is ~89KB, extract the pane as a child component.

Create:

- `src/svelte/components/ai/AISettings.svelte` — top-level pane.
- `src/svelte/components/ai/AIProviderList.svelte`, `AIProviderForm.svelte` — manage configured providers.
- `src/svelte/components/ai/AIFeatureBindings.svelte` — bind feature → provider.
- `src/svelte/components/ai/AIPrivacyPanel.svelte` — local-only toggle, egress-preview toggle (PII redaction is Phase 3).
- `src/svelte/components/ai/AIAuditLog.svelte` — table view + JSON export.
- `src/svelte/components/ai/EgressPreviewModal.svelte` — reused by every feature UI.
- `src/svelte/components/ai/AIRepositoriesPlaceholder.svelte` — disabled section with a "Coming in Phase 1.5" label so the information architecture is right from first ship. Replaced by the real UI in Sub-milestone L.

**Sub-milestone H — Feature UI (weeks 5–7)**

Modify:

- `src/svelte/Mailbox.svelte` — add an "Ask AI" affordance next to the search bar. Active NL query goes to `aiWorkerClient.chat('smart_search', …)`; resulting `SearchQuery` is handed to `searchStore.searchByDSL()`.
- `src/svelte/mailbox/` (thread view) — add a "Summarize thread" button. Mounts `ThreadSummary.svelte` streaming from ai.worker.
- `src/stores/searchStore.ts` — add `searchByDSL(query: SearchQuery)` that bypasses `parseSearchQuery` and applies filters via Dexie compound indexes + FlexSearch directly.

Create:

- `src/svelte/components/ai/SmartSearchHint.svelte` — renders the parsed-query affordance (e.g., `from:alice after:2026-01-01`).
- `src/svelte/components/ai/ThreadSummary.svelte` — streaming panel with cancel.

Note: smart-compose / smart-reply arrive in Phase 2 and must use the compose proxy (risk #5 resolution) — emit `ai:compose:request` from compose window → main listens and calls `ai.worker` → `emitTo(label, 'ai:compose:response', ...)`. `compose.html` CSP stays locked.

**Sub-milestone I — Buffer / QA (weeks 7–8)**

Provider contract tests, egress-guard fuzz tests, `meta`-table tripwire extension, smoke on desktop with Anthropic + Ollama-on-loopback, Settings → AI accessibility pass.

### Integration Touchpoints

| Existing code                                                      | New code hooks here                                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/main.ts` ~line 383                                            | `initAIWorkerClient()` after db + search are ready                                                 |
| `src/workers/db.worker.ts` meta table (unchanged)                  | `ai:provider:*`, `ai:audit:*`, `ai:settings` keys (decision #4)                                    |
| `src/workers/search.worker.ts:149` (`indexMessages`)               | Unchanged. Tool registry posts into the existing search path.                                      |
| `src/stores/searchStore.ts`                                        | New `searchByDSL()` method                                                                         |
| `src/utils/crypto-store.js` (DEK, `encryptValue` / `decryptValue`) | `encryptAIKey` / `decryptAIKey` reuse DEK (decision #1)                                            |
| `src/utils/auth.ts`                                                | Read-only. AI does not mint its own auth.                                                          |
| `src/svelte/Settings.svelte:489, 1291, ~2067`                      | New `'ai'` section id + component mount                                                            |
| `src/svelte/Mailbox.svelte` search bar                             | Smart-search "Ask AI" toggle                                                                       |
| `src-tauri/src/lib.rs:6, 576-591`                                  | `mod ai;` + 5 commands + stronghold plugin                                                         |
| `src-tauri/Cargo.toml` ~line 38                                    | reqwest / tokio / keyring / stronghold                                                             |
| `src-tauri/capabilities/default.json`                              | stronghold permission                                                                              |
| `src/utils/tauri-bridge.js:69` (`ALLOWED_COMMANDS`)                | Add 6 AI commands                                                                                  |
| `index.html` / `compose.html` CSP meta                             | Web: expand `connect-src` with allowlist from `src/ai/providers/allowlist.ts`. Desktop: no change. |

### Critical Risks & Unknowns

1. ~~**`meta`-table cardinality.**~~ **Mitigated.** `tests/unit/integration/dexie-schema.test.ts` now locks down: `ai:audit:*` and `ai:provider:*` prefix scans return exactly their rows; 30 days × 50 events of AI writes do not disturb mutation-queue / contact-cache / attachment-cache hot paths; `ai:*` umbrella prefix supports wipe-on-logout. 12 tests passing.
2. ~~**Stronghold + keyring dependency weight.**~~ **Resolved.** `reqwest`, `rustls`, `tokio`, `hyper` are already in the dep tree via `tauri-plugin-updater`. Only Stronghold (~1.5–2 MB) + keyring-rs (~50–100 KB) + two small streaming crates (~30 KB) are truly new. Net add ~1.5–2.5 MB, ~10–15 % of the existing release binary — accepted for the Stronghold security layer on top of keyring-rs.
3. ~~**Linux Secret Service fallback.**~~ **Resolved.** Primary path: a 32-byte seed in `keyring-rs` unlocks a Stronghold snapshot at `${APP_DATA}/ai-stronghold.snapshot`. Fallback when `keyring-rs` init fails: require app-lock to be enabled, derive the Stronghold password from the existing `crypto-store` DEK via HKDF — reuses the existing unlock flow, no new prompt. Detection is eager at AI subsystem init; Settings → AI surfaces the keystore status (✓ secure / ⚠ app-lock backup / ✗ needs app-lock). CI / headless: `AI_TEST_EPHEMERAL_KEYSTORE=1` switches to in-memory-only.
4. ~~**Smart-search DSL → Dexie compound-index coverage.**~~ **Resolved** — spike results in appendix. Every Phase 1 DSL filter maps to either an existing compound/single index (candidate fetch), FlexSearch (`text_query`, `subject_contains`), or post-filter via the existing `applySearchFilters` pipeline. No schema change needed. `compile-flexsearch.ts` targets this pipeline directly.
5. ~~**`compose.html` CSP in Phase 2.**~~ **Resolved.** On desktop, compose is a separate Tauri `WebviewWindow` that already uses a `compose:ready` / `compose:init` event handshake. AI calls from compose proxy through the main window: compose emits `ai:compose:request`, main window calls `ai.worker`, response streams back via `emitTo(label, 'ai:compose:response', ...)`. `compose.html` CSP stays locked (no `connect-src` for provider hosts); API keys never loaded in the compose process. On web (PWA), compose is in-page and calls `ai.worker` directly — no proxy needed.

## Phase 1.5 — Context Sources (2–3 weeks, desktop-only)

Support-team workflow: incoming email is a question about a product backed by one or more git repositories. The assistant reads the thread, greps the repo(s), drafts a reply with file citations, user reviews in Compose, user sends.

This is the first feature category beyond mailbox-local AI — it introduces **Context Sources** as a concept the product can extend (repositories now; knowledge bases, docs, and internal wikis later). Desktop-only for v1 because it requires filesystem access; mobile/web defer to BYO cloud with no repo context.

### Scope

- **Repository registration** — Settings → AI → Repositories. Path, label, optional sender/domain associations. Stored under `ai:repo:{id}` in the `meta` table (same pattern as providers).
- **Code retrieval tools** (desktop Rust): `grep_repo`, `read_file`, `list_files`. Read-only, auto-execute (no user confirmation — they're information-gathering, not mutating), `.gitignore`-respecting.
- **Draft-reply flow** — new feature: `draft_support_reply`. Input: a selected thread + one or more registered repos. Model uses `get_thread` + repo tools, streams a draft, user opens it in Compose.
- **Sources panel** — every AI draft surfaces the files + messages it read. Clickable to preview (read-only code panel, thread scroll-to).
- **Compose integration** — new hook: `openComposeWithDraft({ threadId, draft, sources, aiFeature })`. Sets an "AI draft" marker and attaches the sources panel. Does NOT auto-populate recipients or auto-send — user confirms everything.

### Build order (on top of Phase 1)

**Sub-milestone J — Repository subsystem (desktop)**

Create:

- `src/ai/repositories/types.ts` — `Repository` config (id, label, path, associations).
- `src/ai/repositories/store.ts` — CRUD via `meta` table under `ai:repo:{id}`. Mirrors `keystore-web.ts` shape.
- `src-tauri/src/ai/tools/repo/{mod.rs, grep.rs, read.rs, list.rs}` — Rust implementations. Each respects `.gitignore` via the `ignore` crate; reads are size-capped (default 256 KB per file) with a clear truncation marker.
- Commands: `ai_repo_grep`, `ai_repo_read`, `ai_repo_list`. Always scoped to a registered repo path — absolute paths outside registered repos are rejected at the command layer.

Modify:

- `src-tauri/Cargo.toml` — add `ignore = "0.4"`, `grep-regex = "0.1"` (or `grep = "0.2"` wrapper).
- `src/utils/tauri-bridge.js` `ALLOWED_COMMANDS` — add the 3 repo commands.

**Sub-milestone K — Draft-reply feature**

Create:

- `src/ai/prompts/draft-support.ts` — system prompt with injection preamble, explicit "always cite the files you read" instruction, tone guidance.
- `src/ai/tools/registry.ts` — extend with the repo tools; compose tool set per feature (smart-search gets mailbox tools only; draft-support gets mailbox + repo tools).
- `src/svelte/components/ai/DraftReplyPanel.svelte` — streaming review panel with cancel, regenerate (with optional user hint), sources panel, "Open in Compose" button.
- `src/utils/compose-hooks.ts` — `openComposeWithDraft()` that extends the existing `compose-window.ts` flow on desktop and the inline compose path on web (web path is a no-op for Phase 1.5).

Modify:

- `src/svelte/mailbox/` thread view — add "Draft support reply" action when the current thread has a matched repository.

**Sub-milestone L — Settings → AI → Repositories UI**

Create:

- `src/svelte/components/ai/AIRepositoryList.svelte` — list, add, remove, verify path exists.
- `src/svelte/components/ai/AIRepositoryForm.svelte` — path picker (uses `tauri-plugin-dialog`), label, sender/domain associations.

Modify:

- `src/svelte/components/ai/AISettings.svelte` (created in Phase 1 Sub-milestone G) — enable the Repositories section.

### Risks

1. **Egress of source code.** Repos can contain secrets, proprietary logic, license-restricted code. The draft-support feature must respect local-only mode and MUST show repo file names in the egress preview before sending to a remote provider. Ideal long-term: this feature pairs with Phase 2 local inference so code never leaves the box.
2. **Context budget.** `read_file` on a 50 KB file × 5 files is already ~5 KB of tokens. Add a per-request budget (default 50 KB of repo context) enforced in `ai.worker`. When exceeded, the worker truncates and tells the model "more files available — grep to find them."
3. **`.gitignore` edge cases.** Repos with submodules, nested `.gitignore` files, or symlinks to outside the repo root. Use the `ignore` crate's `WalkBuilder` which handles the first two; reject symlinks that resolve outside the repo root.
4. **Binary files / non-UTF-8.** Reject at the read tool; return a clear "binary file, skipped" message the model can cite.
5. **Cross-platform path normalization.** Windows vs. macOS path separators for citations. Store paths as POSIX in the `Repository` config; convert at the Rust boundary.

### Open UX questions

- Should the model be able to re-read files during a regenerate with hint, or only synthesize from the already-collected context? First answer: re-read (cheaper than re-prompting from scratch).
- Should "Sources" be deep-linked (`file:line-line`) or file-only? First answer: file-only for v1; ranges in Phase 3.
- Repository associations (sender → repo) — manual-only in v1, suggested by the AI in Phase 3.

## Phase 2 — Local Inference (8–10 weeks)

- New Rust module `src-tauri/src/ai/providers/local_gguf.rs` via `llama-cpp-2` crate, feature-gated per platform (Metal / CUDA / Vulkan).
- Model manager UI: new Settings → AI → Models pane; `ai_list_models`, `ai_download_model`, `ai_verify_model` commands.
- Bundled embedding model (`bge-small-en-v1.5-q8.onnx`) via `ort` crate.
- `src-tauri/src/search_index.rs` — SQLite + FTS5 + `sqlite-vec`; sync pipeline from the existing Dexie snapshot.
- `src/ai/dsl/compile-sqlite.ts` → Rust `src-tauri/src/ai/dsl/compiler_sqlite.rs` parameterized SQL builder.
- Ollama / LM Studio auto-discovery (`localhost:11434`, `localhost:1234`).
- Features added: smart reply in Compose, triage assistant sidebar.
- Revisit decision #3: desktop tool execution moves into Rust once SQLite FTS5 lands.

**Key risks:** GGUF memory footprint vs. Tauri WebKit renderer; model-disk-space UX on small laptops; Tahoe WebKit token-batching regressions (spec §7.5); platform GPU matrix across macOS / Windows / Linux.

## Phase 3 — Fine-Tune (10–14 weeks)

- Training pipeline lives outside this repo; `scripts/ai-eval/` holds the execution-equivalence harness usable from CI.
- `src/ai/routing/hybrid.ts` — confidence-threshold router (fine-tune first, chat-provider fallback below threshold).
- `src-tauri/src/ai/model_manifest.rs` — signed manifest verification (SHA-256 + release public key).
- Shipped GGUF (`gemma-4-e2b-fe-search-v1.gguf`) downloaded on first run (~1.8 GB, too big to bundle).
- Opt-in PII redaction: extends existing `src/utils/redaction.ts` + local ONNX classifier.
- Feature: NL → DSL runs locally (no egress) for search.

**Key risks:** training-data leakage into shipped weights; eval-fixture drift across model versions; legal review of opt-in real-query capture; release signing-key rotation story.

## Phase 4 — Hosted Inference (opportunistic)

- New Rust adapter `hosted_fe.rs` — OpenAI-compat wire, authenticated via existing `alias_auth` / `api_key`.
- Forward Email server-side work (outside this repo): confidential-compute deployment (Nitro Enclaves / Confidential Space), no-retention guarantees, per-user encrypted inference keys.
- Client change surface is small: one more provider kind in `aiSettingsStore`, one more entry in the CSP / Rust allowlist.

**Key risks:** compliance posture (SOC 2 / HIPAA) for the hosted endpoint; abuse / rate-limiting; cost model; confidential-compute attestation surfaced in-client so users can verify.

## Open Architectural Questions

Carried forward from spec §14 plus items discovered during planning:

1. **License on fine-tuned weights.** Apache 2.0 is inherited from Gemma 4; confirm Gemma's prohibited-use addenda are acceptable.
2. **Mobile AI.** Tauri mobile builds have separate capability files and no desktop-only plugins; `llama-cpp-2` won't run on iOS / Android. Decision: BYO cloud only on mobile for v1?
3. **Team / shared accounts.** Per-account key model in `crypto-store.js` means shared AI provider keys need new plumbing. Out of scope for v1.
4. **Enterprise compliance.** Do org-policy files ship as JSON in `src/ai/policy/` enforced by ai.worker + Rust?
5. **Telemetry.** AI aggregate counters should stay purely local (opt-in export only, no telemetry to Forward Email servers).
6. **`SCHEMA_VERSION` bump cost.** Confirm incremental-add migrations don't force full search-index rebuild (`db-constants.ts:19–22` forces full reload on schema change).
7. **MCP schema sharing.** `@forwardemail/ai-tools` does not exist in the repo yet. Decide: new workspace package, git submodule, or npm dep from the MCP server repo?
8. **`compose.html` CSP.** See Phase 1 risk #5.

## Appendix A — Spike: DSL → Dexie Index Coverage (risk #4)

Dexie `messages` store indexes (from `db.worker.ts:149-150`):

- **Primary:** `[account+id]`
- **Compound:** `[account+folder]`, `[account+folder+date]`, `[account+folder+is_unread_index]`
- **Single:** `id`, `folder`, `account`, `from`, `subject`, `snippet`, `date`, `flags`, `is_unread`, `is_unread_index`, `has_attachment`, `modseq`, `updatedAt`, `bodyIndexed`, `labels`

Note: `flags` and `labels` are declared as single-field indexes on array values, **not** Dexie multi-entry indexes (no `*` prefix). `.where('labels').equals('Work')` compares the whole array against the string — it does not match "has label Work". Label and flag filtering must go through post-filter, or the schema must add `*labels`/`*flags` (future schema bump).

Mapping of Phase 1 DSL filters to execution strategy:

| DSL filter                         | Index support                      | Strategy                                         |
| ---------------------------------- | ---------------------------------- | ------------------------------------------------ |
| `filters.folder`                   | `[account+folder]`                 | Candidate fetch (primary path)                   |
| `filters.after` / `filters.before` | `[account+folder+date]`            | Range query combined with folder                 |
| `filters.is_unread`                | `[account+folder+is_unread_index]` | Compound query when folder set, else post-filter |
| `filters.from`                     | single `from`                      | `.anyOf()` / prefix on index                     |
| `filters.has_attachment`           | single `has_attachment`            | Candidate or post-filter                         |
| `filters.is_flagged`               | `flags` (array, not multi-entry)   | **Post-filter**                                  |
| `filters.labels_any`               | `labels` (array, not multi-entry)  | **Post-filter**                                  |
| `filters.to`, `filters.cc`         | none                               | **Post-filter**                                  |
| `filters.subject_contains`         | `subject` is exact/prefix only     | **FlexSearch**                                   |
| `text_query`                       | —                                  | **FlexSearch**, intersect with candidate IDs     |
| `filters.thread_id`                | none, dropped from Phase 1 DSL     | (unsupported)                                    |
| `filters.labels_all`               | dropped from Phase 1 DSL           | (unsupported)                                    |
| `sort`, `offset`, `semantic_query` | dropped from Phase 1 DSL           | (unsupported)                                    |

Execution pipeline (already implemented in `search.worker.ts`, `compile-flexsearch.ts` targets it):

1. **Candidate fetch:** pick the most selective indexed filter. Priority: `[account+folder+date]` (folder + date range) → `[account+folder+is_unread_index]` → `[account+folder]` → `account`.
2. **Text filter:** if `text_query` or `subject_contains` is present, run FlexSearch and intersect with candidate IDs.
3. **Post-filter:** `applySearchFilters` applies everything else (`is_flagged`, `labels_any`, `to`, `cc`, remaining fields).

**Verdict:** No schema change needed for Phase 1. Sub-milestone F can build on the existing pipeline. Future indexes that would unlock faster execution (log as future work, not blocking):

- `*labels` multi-entry — cheaper `labels_any` queries at scale
- `*flags` multi-entry — cheaper `is_flagged` when a user stars a lot
- `[account+thread_id]` — enables per-thread operations without full scan
- `[account+from]` + `[account+date]` — cheaper from-only or date-only queries across folders

## References

- [AI Integration Architecture Specification](./ai-architecture.md) — if/when saved.
- [Worker Architecture](./worker-architecture.md)
- [App Lock Architecture](./app-lock-architecture.md) — the DEK / KEK vault we're reusing.
- [Cache Indexing Architecture](./cache-indexing-architecture.md)
