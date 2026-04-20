# AI Integration — Test Plan for Sub-milestones A + B

**Scope:** Shared contracts (`src/ai/providers/types.ts`, `src/ai/dsl/search-query.ts`, `src/ai/dsl/compile-flexsearch.ts`, `src/ai/prompts/system.ts`, `src/ai/errors.ts`, `src/ai/providers/allowlist.ts`) and the web keystore (`src/utils/crypto-store.js` prefix extension + `src/ai/keystore-web.ts`).

**Not in scope:** Worker integration, provider adapters, Rust AI module, Settings UI, feature UIs. Those arrive in Sub-milestones C–H with their own test plans.

## Strategy

| Layer                            | Harness                             | Location                                             |
| -------------------------------- | ----------------------------------- | ---------------------------------------------------- |
| Pure unit                        | Vitest                              | `tests/unit/ai/*.test.ts`                            |
| Dexie + localStorage integration | Vitest + `fake-indexeddb` + `jsdom` | `tests/unit/integration/ai-keystore.test.ts`         |
| Tripwire against drift           | Vitest                              | Extend `tests/unit/integration/dexie-schema.test.ts` |
| Manual smoke                     | Dev harness script                  | `scripts/ai-smoke.mjs` (new, local-only)             |

Run locally via `pnpm test`. CI runs via `pnpm test:coverage`.

## Unit Tests

### `search-query.test.ts` — DSL validator

Add `tests/unit/ai/search-query.test.ts`.

**Happy paths:**

- Empty object `{}` validates to `{}`.
- `{ text_query: "hello" }` round-trips.
- `{ filters: { from: ["a@b.com"], is_unread: true, after: "2026-01-01" } }` round-trips.
- ISO dates: `"2026-01-01"`, `"2026-01-01T12:00:00Z"` accepted.
- `sort: "date_desc" | "date_asc" | "relevance"` each accepted.
- `_confidence: 0` and `_confidence: 1` accepted.

**Rejection paths (each must throw `SearchQueryValidationError` with the correct path):**

- Top-level unknown field: `{ foo: 1 }` → path `foo`.
- Unknown filter field: `{ filters: { size_min_bytes: 1 } }` → path `filters.size_min_bytes`.
- Wrong type: `{ filters: { from: "a@b.com" } }` → path `filters.from`, "must be string[]".
- Bad date: `{ filters: { after: "not-a-date" } }` → path `filters.after`.
- Invalid sort: `{ sort: "newest" }`.
- Negative limit/offset: `{ limit: -1 }`, `{ offset: -1 }`.
- Confidence out of range: `{ _confidence: 1.5 }`, `{ _confidence: -0.1 }`.
- Non-object input: `null`, `[]`, `"string"`, `42`.

**parseSearchQueryJSON:**

- Malformed JSON → throws `SyntaxError`.
- Valid JSON with bad shape → throws `SearchQueryValidationError`.

### `compile-flexsearch.test.ts`

Add `tests/unit/ai/compile-flexsearch.test.ts`.

- `from/to/cc/subject_contains` arrays lowercased and forwarded.
- `labels_any` → payload `filters.labels`; `labels_all` emits `"filters.labels_all"` in `unsupported` and is dropped.
- `is_flagged` → `filters.isStarred`, `is_unread` → `filters.isUnread`, `has_attachment` → `filters.hasAttachment`.
- `after: "2026-01-01"` → `filters.after` is parsed to epoch ms; same for `before`.
- Missing `folder` with no `defaultFolder` → `crossFolder: true`, `filters.scope: "all"`.
- `folder: "all"` behaves the same.
- `text_query` trimmed and forwarded.
- `limit` honors positive integer; default 50 when absent.
- `semantic_query`, `sort`, `offset > 0`, `thread_id` all appear in `unsupported` and do not appear in the payload.
- `phase1UnsupportedFields()` returns a stable set (tripwire — forces an explicit update when we add support).

### `allowlist.test.ts`

Add `tests/unit/ai/allowlist.test.ts`.

- `checkHostAllowed('https://api.anthropic.com/v1/messages')` → `{ ok: true }`.
- `checkHostAllowed('https://api.anthropic.com', { localOnly: true })` → `{ ok: false, reason: 'egress_blocked_by_local_only' }`.
- `checkHostAllowed('http://localhost:11434')` → `{ ok: true }` (loopback).
- `checkHostAllowed('http://localhost:11434', { localOnly: true })` → `{ ok: true }`.
- `checkHostAllowed('http://127.0.0.5:8080', { localOnly: true })` → `{ ok: true }` (127.0.0.0/8).
- `checkHostAllowed('http://192.168.1.1', { localOnly: true })` → `{ ok: false }` (loopback-only, not RFC1918 in web mode; note: Rust layer is broader).
- `checkHostAllowed('https://evil.example.com')` → `{ ok: false, reason: 'not_allowlisted' }`.
- `checkHostAllowed('http://api.anthropic.com')` (no TLS, non-loopback) → `{ ok: false, reason: 'non_https' }`.
- `checkHostAllowed('not a url')` → `{ ok: false, reason: 'invalid_url' }`.
- `buildConnectSrcFragment()` returns a string containing every allowlisted host prefixed with `https://`.

### `errors.test.ts`

Add `tests/unit/ai/errors.test.ts`.

- `new AIError('rate_limited', 'msg')` has `retryable === true`.
- `new AIError('invalid_credentials', 'msg')` has `retryable === false`.
- `retryDelayMs(err, 0)` honors `details.retry_after_ms` when provided.
- Without `retry_after_ms`, exponential backoff: attempt 0 → 2000ms for rate_limited, 500ms otherwise; capped at 30000ms.
- `retryDelayMs` returns `null` for non-retryable codes.
- `userMessageFor` returns a non-empty string for every `AIErrorCode` (exhaustiveness check via TypeScript switch).

### `prompts.test.ts`

Add `tests/unit/ai/prompts.test.ts`.

- `getPrompt('smart_search').system` includes the injection preamble.
- `getPrompt('summarize').system` includes the injection preamble.
- Both prompts are frozen (`Object.isFrozen` on the template object).
- `wrapEmailContent('smart_search', 'plain text')` → `<email>\nplain text\n</email>`.
- `wrapEmailContent('smart_search', 'has </email> inside')` — the close-delimiter inside the payload is escaped so only one outer `</email>` appears.
- Delimiter tokens are the same across features (single tripwire: if we ever change one, tests catch it).

### Crypto-store extension

Extend `tests/unit/` with a small test OR inline a case in an existing crypto-store test if one exists (grep first — there may not be one yet). Add:

- `isSensitiveLocalKey('ai_provider_key_anthropic_main') === true`.
- `isSensitiveLocalKey('ai_provider_key_') === true` (prefix-only).
- `isSensitiveLocalKey('ai_provider_key')` — missing underscore — `false`.
- `isSensitiveLocalKey('api_key') === true` (regression: existing behavior preserved).
- `isSensitiveLocalKey('pgp_keys_user@example.com') === true` (regression).
- `isSensitiveLocalKey('random_key') === false`.

`isSensitiveLocalKey` is not exported today; add the test via an adjacent module-internal test harness or export it conditionally (prefer the export — it's already referenced by multiple internal paths).

## Integration Tests

### `ai-keystore.test.ts`

Add `tests/unit/integration/ai-keystore.test.ts`. Uses `fake-indexeddb/auto` and `jsdom` `localStorage`.

**Setup per test:**

- Fresh fake IDB; set up `dbClient` pointing at a temp DB name.
- `localStorage.clear()`.
- Seed crypto-store in unlocked state for encryption-on tests; leave locked/disabled for plaintext tests.

**Test matrix:**

| Scenario                                    | App-lock state | Expected                                                   |
| ------------------------------------------- | -------------- | ---------------------------------------------------------- |
| `saveProvider` + `getProvider`              | disabled       | metadata round-trips via `meta` table                      |
| `saveProvider` then `getProviderKey`        | disabled       | returns the plaintext key                                  |
| `saveProvider` with lock enabled+unlocked   | unlocked       | localStorage value is `ENCRYPTED_PREFIX`-prefixed          |
| `getProviderKey` when lock enabled+unlocked | unlocked       | returns plaintext key                                      |
| `getProviderKey` when lock enabled+locked   | locked         | returns `null` (can't decrypt)                             |
| `listProviders` with 3 saved + 1 deleted    | any            | returns 2 in undefined order                               |
| `deleteProvider`                            | any            | meta row gone, localStorage entry gone                     |
| `saveProvider` twice with same id           | any            | `createdAt` preserved, `updatedAt` updated                 |
| Unrelated `meta` keys not affected          | any            | `meta.get('saved_search_x')` unchanged after AI operations |

**Worker context guard:**

- Mock `localStorage` to `undefined`; confirm `saveProvider` / `deleteProvider` / `getProviderKey` throw with the "must be called from the main thread" message. `getProvider` and `listProviders` still work (they use `dbClient.meta` only).

**Key-prefix collision safety:**

- Save a provider with id `"foo"`; save a raw meta row with key `"ai:provider:foobar"`. `listProviders` must include the `foo` entry and treat the raw row correctly when its `value` has the `ProviderConfig` shape.

### Extend `dexie-schema.test.ts`

Add a case to the existing file:

- Write 5 rows with `ai:audit:2026-04-19`-style keys and 100 unrelated `meta` keys.
- `meta.where('key').startsWith('ai:audit:').toArray()` returns exactly 5.
- `meta.get('saved_search_test')` still works after the AI writes (no index invalidation).

This is the "meta-table cardinality" tripwire called out in the updated plan's Phase 1 risk #1.

## Manual QA Checklist

Before committing A + B:

- [ ] `pnpm check` (svelte-check + tsc) passes. Existing errors in `sync.worker.ts` are OK — no new errors in `src/ai/`.
- [ ] `pnpm lint` passes.
- [ ] `pnpm test` passes locally.
- [ ] `pnpm test:coverage` — coverage for new files ≥ 85%.
- [ ] `node scripts/validate-schema-version.js` still passes (unchanged since decision #4 skipped the schema bump).
- [ ] `rg -n 'ai_provider_key_' src/` returns only references from `src/ai/` and `src/utils/crypto-store.js` — no stray uses elsewhere.
- [ ] Start `pnpm dev`, open DevTools, run in console:
  - `await import('/src/ai/dsl/search-query.ts').then(m => m.validateSearchQuery({ filters: { from: ['alice'] } }))` — returns the normalized object.
  - `import('/src/ai/providers/allowlist.ts').then(m => console.log(m.buildConnectSrcFragment()))` — returns the expected CSP fragment.
- [ ] With app-lock enabled, use DevTools → Application → Local Storage to confirm `webmail_ai_provider_key_*` values are `ENCRYPTED:`-prefixed after `saveProvider` is exercised (via the smoke script below).

## Smoke Script

Add `scripts/ai-smoke.mjs` (dev-only, not shipped):

```js
// Usage: paste into DevTools console, or run via vite-node for the main-thread paths.
import {
  saveProvider,
  getProviderKey,
  listProviders,
  deleteProvider,
} from '/src/ai/keystore-web.ts';

await saveProvider(
  { id: 'test', kind: 'anthropic', label: 'Test', endpoint: 'https://api.anthropic.com' },
  'sk-ant-demo-1234',
);
console.log('providers:', await listProviders());
console.log('key:', getProviderKey('test'));
await deleteProvider('test');
console.log('after delete:', await listProviders());
```

Run once with app-lock off, once with app-lock on + unlocked, once locked (should return `null`).

## Definition of Done (A + B)

1. All unit + integration tests added and green.
2. Manual QA checklist complete.
3. `docs/ai-implementation-plan.md` reflects the final decision #4 language (already updated).
4. No regressions in `pnpm test` for existing suites.
5. `tests/unit/integration/dexie-schema.test.ts` tripwire extended.
6. No bump of `SCHEMA_VERSION`; no change to `public/sw-sync.js`; no change to `scripts/validate-schema-version.js` expectations.

## Risks Tests Specifically Cover

- **Risk #1 (meta-table cardinality):** extended dexie-schema integration test asserts prefix-scan is isolated and hot paths unaffected.
- **Risk #4 (DSL → Dexie compound-index coverage):** `compile-flexsearch` unit tests lock down which DSL fields survive Phase 1 and which are dropped, so there are no surprise runtime behaviors.
- **Injection resistance (spec §12):** prompts test locks the `<email>` delimiter contract; `wrapEmailContent` escape test catches regressions that would let a hostile message close the delimiter early.
- **CSP backstop (decision #2):** allowlist unit tests assert every pathological input (non-HTTPS, non-allowlisted, invalid URL, RFC1918 in non-local-only mode) is rejected.

Risks #2 (Stronghold binary weight), #3 (Linux Secret Service), #5 (`compose.html` CSP) are not on the A+B surface and remain open for Sub-milestone C.
