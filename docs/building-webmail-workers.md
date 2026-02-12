# Building Webmail: The Worker Mesh

Offline-first webmail is a concurrency problem. Message parsing, API sync, and
full-text indexing are too heavy for the main thread. The solution: a worker
mesh with clear ownership boundaries and zero shared state.

## The Golden Rule

```mermaid
flowchart LR
    rule["<b>db.worker is the SOLE OWNER of IndexedDB.</b><br/><br/>Every other component talks to it over MessageChannel.<br/>No exceptions. No &quot;quick direct reads.&quot;"]
    style rule fill:#ff6,stroke:#d40,stroke-width:3px,color:#000
```

This avoids lock contention, prevents version conflicts, and gives us a single
place to version and migrate the schema.

## The Architecture

```mermaid
flowchart TB
    subgraph main["Main Thread"]
        M1["Svelte 5 UI + Stores"]
        M2["Routing + Shortcuts"]
        M3["Worker orchestration"]
    end

    subgraph db["db.worker"]
        DB1["Dexie 4"]
        DB2["13 tables"]
    end

    subgraph sync["sync.worker"]
        S1["API fetch"]
        S2["PostalMime"]
        S3["OpenPGP"]
        S4["Normalize"]
    end

    subgraph search["search.worker"]
        SE1["FlexSearch 0.7"]
        SE2["Full-text index"]
        SE3["Health checks"]
        SE4["Persistence"]
    end

    main -- "MessageChannel" --> db
    main -- "MessageChannel" --> sync
    main -- "MessageChannel" --> search
    sync -- "db ops via MessagePort" --> db
    sync -- "index batches via MessagePort" --> search
```

## Worker Responsibilities

```mermaid
flowchart TB
    subgraph dbworker["db.worker — src/workers/db.worker.ts"]
        direction TB
        DB_OWNS["<b>OWNS:</b> Dexie/IndexedDB connection (sole owner)"]
        DB_DOES["<b>DOES:</b> All CRUD, schema versioning, migrations"]
        DB_SERVES["<b>SERVES:</b> Main thread, sync.worker, search.worker"]
        DB_NOT["<b>DOES NOT:</b> Make network requests, touch UI state, build indexes"]

        subgraph tables["Tables (13)"]
            direction LR
            T1["accounts"]
            T2["folders"]
            T3["drafts"]
            T4["outbox"]
            T5["messages"]
            T6["messageBodies"]
            T7["syncManifests"]
            T8["searchIndex"]
            T9["indexMeta"]
            T10["meta"]
            T11["labels"]
            T12["settings"]
            T13["settingsLabels"]
        end
    end

    style DB_NOT fill:#fdd,stroke:#c00,color:#000
```

```mermaid
flowchart TB
    subgraph syncworker["sync.worker — src/workers/sync.worker.ts"]
        direction TB
        SW_OWNS["<b>OWNS:</b> API synchronization, message parsing pipeline"]
        subgraph SW_DOES["DOES"]
            direction TB
            SW1["Fetch folders + message lists from REST API"]
            SW2["Normalize and enrich message metadata"]
            SW3["Parse message bodies with PostalMime"]
            SW4["PGP decryption via OpenPGP"]
            SW5["Write results to db.worker via MessagePort"]
            SW6["Forward new messages to search.worker for indexing"]
            SW7["Maintain per-folder sync manifests"]
            SW8["Emit progress events to main thread"]
        end
        SW_NOT["<b>DOES NOT:</b> Open IndexedDB, render UI, own search state"]
    end

    style SW_NOT fill:#fdd,stroke:#c00,color:#000
```

```mermaid
flowchart TB
    subgraph searchworker["search.worker — src/workers/search.worker.ts"]
        direction TB
        SE_OWNS["<b>OWNS:</b> FlexSearch index (per account, per includeBody mode)"]
        subgraph SE_DOES["DOES"]
            direction TB
            SE1["Index new messages from sync.worker or main thread"]
            SE2["Execute search queries with filters"]
            SE3["Persist index state to IndexedDB via db.worker"]
            SE4["Health checks: compare index count vs DB count"]
            SE5["Background rebuilds when divergence detected"]
        end
        SE_NOT["<b>DOES NOT:</b> Fetch from API, open IndexedDB directly"]
    end

    style SE_NOT fill:#fdd,stroke:#c00,color:#000
```

```mermaid
flowchart TB
    subgraph serviceworker["Service Worker — public/sw-sync.js + Workbox SW"]
        direction TB
        SV_OWNS["<b>OWNS:</b> CacheStorage for static assets"]
        subgraph SV_DOES["DOES"]
            direction TB
            SV1["Precache app shell (HTML, JS, CSS, fonts, icons)"]
            SV2["SPA fallback routing (serve index.html for nav requests)"]
            SV3["Runtime cache for images (30-day CacheFirst)"]
            SV4["Background sync replay via sw-sync.js"]
        end
        SV_NOT["<b>DOES NOT:</b> Cache API responses, own Dexie, store mail data"]
    end

    style SV_NOT fill:#fdd,stroke:#c00,color:#000
```

## Startup Sequence

```mermaid
flowchart TD
    T0["t=0ms: Main thread boots"]
    S1["(1) Initialize db.worker<br/>Open Dexie, verify schema"]
    S1OK(["DB ready"])
    S2["(2) Load cached state from IDB<br/>Settings, folders, labels, messages"]
    S2OK(["UI renders with cached data"])
    S3["(3) Connect sync.worker<br/>Pass db.worker MessagePort"]
    S3OK(["sync ready"])
    S4["(4) Connect search.worker<br/>Pass db.worker MessagePort<br/>Load persisted index<br/>Run health check"]
    S4OK(["search ready"])
    S5["(5) Start initial sync<br/>sync.worker fetches deltas<br/>Writes to db.worker<br/>Forwards batches to search.worker<br/>Main thread updates UI"]

    T0 --> S1 --> S1OK --> S2 --> S2OK --> S3 --> S3OK --> S4 --> S4OK --> S5

    style S1OK fill:#cfc,stroke:#090,color:#000
    style S2OK fill:#cfc,stroke:#090,color:#000
    style S3OK fill:#cfc,stroke:#090,color:#000
    style S4OK fill:#cfc,stroke:#090,color:#000
```

## Data Flow: Loading the Inbox

```mermaid
flowchart TD
    A["User clicks INBOX"] --> B["mailboxStore.loadMessages()"]
    B --> C{"Check in-memory<br/>LRU cache"}
    C -- "HIT" --> C1(["Return immediately (0ms)"])
    C -- "MISS" --> D{"Check IndexedDB<br/>via db.worker"}
    D -- "HIT" --> D1(["Render cached list"])
    D -- "MISS" --> E["sync.worker 'messagePage' task"]
    E --> F["GET /v1/messages?folder=INBOX"]
    F --> G["Normalize metadata<br/>Enrich flags, labels, snippets<br/>Compute is_unread_index"]
    G --> H["Write to db.worker<br/>Upsert messages table<br/>Update syncManifests"]
    H --> I["Forward batch to search.worker<br/>Incremental index update"]
    I --> J["Return to main thread<br/>Merge with existing state<br/>Update UI list"]
```

## Data Flow: Reading a Message

```mermaid
flowchart TD
    A["User clicks message"] --> B["mailService.loadMessageDetail()"]
    B --> C{"Check messageBodies<br/>in db.worker"}
    C -- "HIT and fresh" --> C1(["Render cached body (5ms)"])
    C -- "MISS or stale" --> D["sync.worker 'messageDetail' task"]
    D --> E["GET /v1/messages/:id?folder=...&raw=false"]
    E --> F["Parse with PostalMime"]
    F --> G{"Detect PGP?"}
    G -- "Yes" --> G1["Decrypt with OpenPGP"] --> H
    G -- "No" --> H["Sanitize HTML (DOMPurify)"]
    H --> I["Cache to db.worker (messageBodies)"]
    I --> J(["Return parsed result"])

    B -- "sync.worker unavailable" --> K["Fallback: main thread direct API call"]
```

## Message Passing Protocol

All workers use a request/response protocol over `MessageChannel`:

```mermaid
flowchart LR
    subgraph dbproto["db.worker protocol"]
        direction TB
        DB_REQ["REQUEST: { id, action, table, payload }"]
        DB_RES_OK["RESPONSE: { id, ok: true, result }"]
        DB_RES_ERR["RESPONSE: { id, ok: false, error }"]
        DB_REQ --> DB_RES_OK
        DB_REQ --> DB_RES_ERR
    end

    subgraph syncproto["sync.worker protocol"]
        direction TB
        SY_TASK["TASK: { type: 'task', taskId, task }"]
        SY_REQ["REQUEST: { type: 'request', requestId, action, payload }"]
        SY_RES_OK["RESPONSE: { type: 'requestComplete', requestId, result }"]
        SY_RES_ERR["RESPONSE: { type: 'requestError', requestId, error }"]
        SY_TASK --> SY_RES_OK
        SY_REQ --> SY_RES_OK
        SY_REQ --> SY_RES_ERR
    end

    subgraph searchproto["search.worker protocol"]
        direction TB
        SE_REQ["REQUEST: { id, action, payload }"]
        SE_RES_OK["RESPONSE: { id, ok: true, result }"]
        SE_RES_ERR["RESPONSE: { id, ok: false, error }"]
        SE_REQ --> SE_RES_OK
        SE_REQ --> SE_RES_ERR
    end
```

## Fallback & Resilience

```mermaid
flowchart LR
    A1["sync.worker fetch<br/>(primary path)"] -- "FAIL" --> B1["Main thread direct API<br/>(graceful degradation)"]
    A2["search.worker<br/>FlexSearch query"] -- "FAIL" --> B2["Main thread SearchService<br/>(in-memory fallback)"]
    A3["db.worker<br/>Dexie open/query"] -- "FAIL" --> B3["Delete DB + re-init<br/>Resync from API"]

    style A1 fill:#fdd,stroke:#c00,color:#000
    style A2 fill:#fdd,stroke:#c00,color:#000
    style A3 fill:#fdd,stroke:#c00,color:#000
    style B1 fill:#cfc,stroke:#090,color:#000
    style B2 fill:#cfc,stroke:#090,color:#000
    style B3 fill:#cfc,stroke:#090,color:#000
```

Workers can restart independently without UI resets. The main thread always has
a fallback path to direct API calls.

## Key Source Files

| File                                | Role                               |
| ----------------------------------- | ---------------------------------- |
| `src/workers/db.worker.ts`          | IndexedDB owner, schema, CRUD      |
| `src/workers/sync.worker.ts`        | API sync, parsing, PGP             |
| `src/workers/search.worker.ts`      | FlexSearch indexing and queries    |
| `src/utils/db-worker-client.js`     | Main thread proxy to db.worker     |
| `src/utils/sync-worker-client.js`   | Main thread proxy to sync.worker   |
| `src/utils/search-worker-client.js` | Main thread proxy to search.worker |
| `src/utils/sync-controller.js`      | Sync orchestration and scheduling  |
| `public/sw-sync.js`                 | Service worker background sync     |

---

**Next:** [Data Layer](building-webmail-db-schema-recovery.md) — how IndexedDB
becomes product memory.
