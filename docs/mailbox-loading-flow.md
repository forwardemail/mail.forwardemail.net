# Mailbox Loading Flow

This document traces the full request lifecycle when loading messages for a
mailbox folder — from user click through every cache layer, worker, and
network path, all the way back to the rendered list.

## High-level overview

```mermaid
flowchart TD
    A[User clicks folder] --> B["In-Memory LRU<br/>(~0ms, sync)"]
    B -->|if miss| C["IndexedDB<br/>(~5ms, async)"]
    C -->|always| D["Network Fetch<br/>(~100-500ms)"]

    B -->|"hit: render immediately"| E
    C -->|"hit: render immediately,<br/>set loading=false"| E
    D -->|"response: merge,<br/>write IDB + LRU,<br/>update UI silently"| E

    E["Svelte Store (messages)<br/>UI renders from this store"]
```

**Key principle**: cache is always read first. Network always runs in the
background. The skeleton loader only appears when both the in-memory and
IndexedDB caches are empty (e.g. first visit to a folder on a new device).

---

## Detailed request flow

### Phase 1 — Folder selection (synchronous)

**Entry point**: `mailboxStore.ts:selectFolder()`

```mermaid
flowchart TD
    A["selectFolder(path)"] --> B["selectedFolder.set(path)<br/>update store (sync)"]
    B --> C["page.set(1)<br/>reset pagination (sync)"]
    C --> D["selectedConversationIds.set([])"]
    D --> E["selectedMessage.set(null)"]
    E --> F["loadMessages()<br/>starts the cache + fetch pipeline"]
```

`selectFolder` and the first part of `loadMessages` run in the **same
microtask**, which means Svelte batches the folder change and any synchronous
cache hit into a single render frame.

---

### Phase 2 — In-memory cache check (synchronous, ~0ms)

**Location**: `mailboxStore.ts:loadMessages()` — in-memory LRU section

```
folderMessageCache : Map<string, { messages[], hasNextPage }>

Key format: "account:folder:page"
Example:   "user@example.com:INBOX:1"
```

```mermaid
flowchart TD
    A["loadMessages()"] --> B["memKey = account:folder:page"]
    B --> C["memCached = folderMessageCache.get(memKey)"]
    C --> D{"memCached?.messages?.length?"}
    D -->|Yes| E["messages.set(memCached.messages)<br/>populate store (sync)"]
    E --> F["hasNextPage.set(memCached.hasNextPage)"]
    F --> G["loading.set(false) — no skeleton"]
    G --> H["Auto-select first message<br/>(desktop classic layout)"]
    D -->|No| I["Continue to IDB + network layers"]
```

This runs synchronously. If the folder was visited earlier in this session,
the list renders instantly with no flicker.

**Regardless of a hit or miss, execution continues to the next layers.**

---

### Phase 3 — IndexedDB cache read (async, ~5ms)

**Location**: `mailboxStore.ts:loadMessages()` — IDB cache section

```mermaid
flowchart TD
    A["Dexie Query"] --> B{"Sort type?"}
    B -->|"newest / oldest sort"| C["db.messages<br/>.where('[account+folder+date]')<br/>.between(...)<br/>.reverse() (if newest)<br/>.offset(startIdx)<br/>.limit(limit)<br/>.toArray()"]
    B -->|"other sorts"| D["db.messages<br/>.where('[account+folder]')<br/>.equals([account, folder])<br/>.toArray()"]
    D --> E["sortMessages(cached, sort)<br/>.slice(startIdx, startIdx + limit)"]
    C --> F["cachedPage = pageSlice.map(normalize)"]
    E --> F
```

If `cachedPage` has results:

```mermaid
flowchart TD
    A["messages.set(cachedPage)<br/>render cached data"] --> B["loading.set(false)<br/>no skeleton"]
    B --> C["folderMessageCache.set(...)<br/>warm in-memory LRU for next time"]
    C --> D["Auto-select first message"]
    D --> E["Count total for hasNextPage<br/>(if basic query)"]
```

**The IDB read populates the list within ~5ms** — well under the 150ms
skeleton delay threshold. Users see cached data almost instantly.

---

### Phase 4 — Skeleton decision

**Location**: `mailboxStore.ts:loadMessages()` — skeleton gate

```mermaid
flowchart TD
    A{"cachedPage.length == 0?"} -->|Yes| B["loading.set(true)<br/>only triggers skeleton if BOTH caches missed"]
    A -->|No| C["Skip — skeleton not needed"]
```

On the Svelte side (`Mailbox.svelte`), the skeleton has a **150ms delay**
before it actually renders:

```mermaid
flowchart TD
    A["wantListSkeleton =<br/>listIsEmpty && ($loading || syncingSelectedFolder || !showEmptyState)"]
    A --> B{"wantListSkeleton?"}
    B -->|Yes| C["setTimeout 150ms<br/>(LIST_SKELETON_DELAY_MS)"]
    C --> D["showListSkeleton = true"]
    B -->|No| E["showListSkeleton = false<br/>cancel immediately"]
```

This means: if the IDB read or a preview fetch resolves within 150ms, the
skeleton never appears at all.

---

### Phase 5 — Preview fetch (empty-cache optimization)

**Location**: `mailboxStore.ts:loadMessages()` — preview section

When cache is completely empty AND the page limit is large (>20), a **parallel
small fetch** fires to get initial results on screen faster:

```mermaid
flowchart TD
    A{"cache empty AND limit > 20?"} -->|Yes| B["fetchWithFallback limit: 20<br/>small preview, fire-and-forget"]
    A -->|Yes| C["fetchWithFallback limit: full<br/>full request, awaited"]
    B --> D["messages.set(previewMessages)"]
    D --> E["loading.set(false) — cancel skeleton"]
    A -->|No| F["Skip preview, proceed with full fetch only"]
```

Both requests run concurrently. The preview typically resolves first and
clears the skeleton while the full page loads.

---

### Phase 6 — Network fetch via `fetchWithFallback()`

**Location**: `mailboxStore.ts:fetchWithFallback()`

```mermaid
flowchart TD
    A["fetchWithFallback(params)"] --> B["TRY: sendSyncRequest('messagePage', params)"]
    B -->|success| C["return { source: 'worker', res }"]
    B -->|catch| D["CATCH: Remote.request('MessageList', params)"]
    D --> E["return { source: 'main', res }"]
```

Two paths, worker preferred with main-thread fallback:

```mermaid
flowchart LR
    subgraph PRIMARY["PRIMARY PATH"]
        direction TB
        MT1["Main Thread<br/>(mailboxStore)"] -->|"postMessage<br/>{ type: 'request',<br/>action: 'messagePage',<br/>payload }"| SW["Sync Worker<br/>(sync.worker.ts)"]
        SW --> F1["fetch(apiBase + '/v1/messages?...')<br/>(raw fetch, bypasses Service Worker)"]
        F1 --> N1["Normalize messages"]
        N1 --> M1["Merge missing labels"]
        M1 --> W1["db.messages.bulkPut()"]
        W1 --> S1["Post to search worker"]
        S1 -->|"postMessage<br/>{ type: 'requestComplete',<br/>result: { messages, hasNextPage } }"| MT1R["Main Thread receives result"]
    end

    subgraph FALLBACK["FALLBACK PATH"]
        direction TB
        MT2["Main Thread<br/>(Remote.request)"] -->|"Ky HTTP GET /v1/messages<br/>Authorization: alias_auth / api_key<br/>Timeout: 10s<br/>Retry: 3x exponential backoff<br/>(1s → 2s → 4s, cap 5s)"| API["API<br/>(forwardemail.net)"]
        API -->|"JSON response"| MT2R["Main Thread receives JSON"]
    end
```

---

### Phase 7 — Response processing (main thread)

**Location**: `mailboxStore.ts:loadMessages()` — response handler

```mermaid
flowchart TD
    A["Network response arrives"] --> B{"Stale check:<br/>account/folder changed?"}
    B -->|"Yes (stale)"| C["Write to IDB for next visit,<br/>skip UI update"]
    B -->|No| D["Parse response"]

    D --> D1{"Source?"}
    D1 -->|worker path| D2["res.messages, res.hasNextPage"]
    D1 -->|fallback path| D3["res.Result.List,<br/>list.length >= limit"]

    D2 --> E["Normalize each message<br/>normalizeMessageForCache(raw, folder, account)<br/>attach: normalizedSubject, threadId,<br/>in_reply_to, references"]
    D3 --> E

    E --> F["mergeMissingLabels(account, mapped, labelPresence)<br/>Preserve labels the list endpoint doesn't return"]
    F --> G["mergeMissingFrom(account, merged)<br/>Preserve full 'from' when API returns abbreviated"]

    G --> H{"Page 1?"}
    H -->|Yes| I["Cache prune: find IDB entries<br/>NOT in server response<br/>db.messages.bulkDelete(staleKeys)"]
    H -->|No| J["Skip prune"]

    I --> K["Write to IDB<br/>db.messages.bulkPut(merged)"]
    J --> K

    K --> L["Write to in-memory LRU<br/>folderMessageCache.set(account:folder:page, ...)"]
    L --> M{"Main-thread fallback?"}
    M -->|Yes| N["searchStore.actions.indexMessages(merged)<br/>Update search index"]
    M -->|"No (worker already indexed)"| O["Skip indexing"]

    N --> P["Update UI (if not stale)<br/>messages.set(merged)<br/>loading.set(false)<br/>updateFolderUnreadCounts()"]
    O --> P
```

---

## Complete timeline visualization

```mermaid
sequenceDiagram
    participant U as User
    participant MT as Main Thread
    participant IDB as IndexedDB
    participant Net as Network
    participant UI as Svelte Store / UI

    U->>MT: Click folder (t=0ms)
    MT->>MT: selectFolder.set(path)
    MT->>MT: loadMessages() begins (same microtask)

    MT->>MT: [SYNC] Check in-memory LRU
    alt LRU hit
        MT->>UI: list renders at t=0ms. No skeleton.
    end

    MT->>IDB: [ASYNC] Start IDB query (t=1ms)
    IDB-->>MT: IDB results arrive (t=5ms)
    alt IDB hit
        MT->>UI: list renders at t=5ms. loading=false. No skeleton.
    end

    MT->>Net: [ASYNC] Preview fetch (if cache empty)
    MT->>Net: [ASYNC] Full network fetch (always)

    Net-->>MT: Preview response arrives (t=100ms)
    MT->>UI: list renders preview. loading=false. Skeleton cancelled.

    Note over UI: t=150ms — Skeleton delay threshold<br/>(skeleton only appears if nothing rendered by now)

    Net-->>MT: Full network response arrives (t=200ms)
    MT->>MT: normalize, merge, write IDB + LRU
    MT->>UI: messages.set(merged) — list updates silently

    MT->>MT: Background: search indexing,<br/>folder count update, quota check (t=200ms+)
```

### When do you see a skeleton?

| Scenario                             | Memory     | IDB        | Network    | Skeleton?                       |
| ------------------------------------ | ---------- | ---------- | ---------- | ------------------------------- |
| Revisit folder (same session)        | hit        | --         | background | Never                           |
| Revisit folder (new session, cached) | miss       | hit (~5ms) | background | Never                           |
| First visit, fast network (<150ms)   | miss       | miss       | fast       | Never (preview beats delay)     |
| First visit, slow network (>150ms)   | miss       | miss       | slow       | Yes, until preview/full arrives |
| Offline, previously cached           | hit or hit | hit        | fails      | Never                           |
| Offline, never visited               | miss       | miss       | fails      | Yes, then error state           |

---

## Component responsibilities

### Sync Worker (`src/workers/sync.worker.ts`)

The sync worker is the **preferred network path**. It:

1. Makes raw `fetch()` calls to the API (bypasses Service Worker)
2. Normalizes raw API responses into cache-ready format
3. Writes results to IndexedDB via Dexie
4. Posts to the search worker for full-text indexing
5. Returns normalized messages to the main thread

**Why raw fetch?** The sync worker runs in a Web Worker context. Service
Workers intercept main-thread fetches but worker-originated fetches go
directly to the network. This is intentional — API responses are cached in
IndexedDB, not in CacheStorage.

### Service Worker (`public/sw-sync.js`)

The Service Worker does **not** cache API responses. Its roles:

```mermaid
flowchart TD
    SW["Service Worker Roles"]
    SW --> A["1. Precache app shell (Workbox)<br/>JS, CSS, icons, images in CacheStorage"]
    SW --> B["2. Background sync<br/>Process offline mutation queue<br/>Replay failed writes when online"]
    SW --> C["3. Bulk body prefetch<br/>Fetch message bodies for offline reading<br/>Triggered after initial metadata sync"]
```

### Main Thread (`src/stores/mailboxStore.ts`)

Orchestrates everything:

- Reads from in-memory and IDB caches
- Delegates network to sync worker (with main-thread fallback)
- Manages loading/skeleton state
- Merges network responses into stores
- Prunes stale cache entries

### Remote (`src/utils/remote.js`)

Fallback HTTP client used when the sync worker is unavailable:

- Uses **Ky** (a `fetch` wrapper)
- 3 retries with exponential backoff
- Per-action timeouts (MessageList: 10s, default: 30s)
- Auth header from sessionStorage (tab-scoped)

---

## Data flow between components

```mermaid
flowchart TD
    subgraph MainThread["Main Thread"]
        SF["selectFolder()"] --> LM["loadMessages()"]

        LM -->|"[1] sync, ~0ms"| LRU["folderMessageCache (Map)"]
        LRU --> SS1["Svelte store<br/>messages.set()"]

        LM -->|"[2] async, ~5ms"| IDB["db.messages (Dexie/IDB)"]
        IDB --> SS2["Svelte store<br/>messages.set()"]

        LM -->|"[3]"| SSR["sendSyncRequest()"]
    end

    subgraph SyncWorker["Sync Worker"]
        SW_FETCH["fetch(API)"] --> FEN["forwardemail.net"]
        FEN --> SW_NORM["normalize()"]
        SW_NORM --> SW_WRITE["db.messages.bulkPut()"]
        SW_WRITE --> SW_SEARCH["postToSearch()"]
        SW_SEARCH --> SW_POST["postMessage(result)"]
    end

    SSR --> SW_FETCH
    SW_POST --> MERGE

    subgraph MainThread2["Main Thread — Response Processing"]
        MERGE["normalize + merge"] --> WRITE_IDB["db.messages.bulkPut()<br/>(write-through to IDB)"]
        WRITE_IDB --> WRITE_LRU["folderMessageCache.set()<br/>(write-through to LRU)"]
        WRITE_LRU --> SS3["messages.set(merged) → Svelte store"]
        SS3 --> DONE["loading.set(false)"]
    end
```

---

## Cache layers summary

| Layer                 | Type               | Speed        | Scope                             | Populated by                        | Cleared on                                                      |
| --------------------- | ------------------ | ------------ | --------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `folderMessageCache`  | In-memory `Map`    | ~0ms (sync)  | Per page, per folder, per account | IDB read + network response         | Account switch (`resetMailboxState`)                            |
| `db.messages` (Dexie) | IndexedDB          | ~5ms (async) | All messages, all accounts        | Sync worker + main thread writes    | Cache prune (page 1 server diff), `emptyFolder`, quota eviction |
| Svelte stores         | In-memory reactive | ~0ms         | Current view only                 | Any cache layer or network response | Folder switch, account switch                                   |

### IndexedDB indexes used for message queries

```mermaid
flowchart LR
    subgraph Primary["Primary Index (date-sorted)"]
        P1["[account+folder+date]"]
        P2["Used for newest/oldest sort"]
        P3["Supports efficient offset+limit pagination"]
        P1 --- P2 --- P3
    end

    subgraph Fallback["Fallback Index (unsorted)"]
        F1["[account+folder]"]
        F2["Used for subject/sender sort"]
        F3["Full scan + in-memory sort + slice"]
        F1 --- F2 --- F3
    end
```

---

## Key constants

| Constant                 | Value              | Location                         | Purpose                                    |
| ------------------------ | ------------------ | -------------------------------- | ------------------------------------------ |
| `LIST_SKELETON_DELAY_MS` | 150ms              | `Mailbox.svelte`                 | Delay before showing list skeleton         |
| `SKELETON_DELAY_MS`      | 200ms              | `Mailbox.svelte`                 | Delay before showing message body skeleton |
| `EMPTY_STATE_DELAY_MS`   | 150ms              | `Mailbox.svelte`                 | Delay before showing "no messages"         |
| Preview limit            | 20                 | `mailboxStore.ts`                | Quick-fetch page size when cache is empty  |
| MessageList timeout      | 10s                | `remote.js`                      | Ky request timeout for message list        |
| HTTP retry count         | 3                  | `remote.js`                      | Exponential backoff retries                |
| DB name                  | `webmail-cache-v1` | `db-constants.ts` / `sw-sync.js` | Must match between app and SW              |

---

## Related documents

- [Worker Architecture](worker-architecture.md) — worker responsibilities and communication
- [Cache and Indexing Architecture](cache-indexing-architecture.md) — storage layers and search indexing
- [Service Worker](building-webmail-service-worker.md) — SW setup and background sync
