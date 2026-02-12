# Building Webmail: Service Worker & Offline Patterns

A service worker is essential for a PWA, but it is not a data store. Our rule:
**cache the shell, not the mail.** The real offline magic happens in IndexedDB
with optimistic updates, mutation queues, and background sync.

## The Separation

```mermaid
graph TB
    subgraph SW["SERVICE WORKER (CacheStorage)"]
        SW1["HTML, JS, CSS"]
        SW2["Fonts, icons"]
        SW3["Manifest"]
        SW4["Images (30d cache)"]
        SW5["<b>STATIC ASSETS ONLY</b>"]
        SW_WHY["WHY: Mail data changes frequently,<br/>can be large, and would create<br/>divergence and complex invalidation."]
    end
    subgraph IDB["INDEXEDDB (db.worker)"]
        IDB1["Messages, bodies"]
        IDB2["Drafts, outbox"]
        IDB3["Settings, labels"]
        IDB4["Search index"]
        IDB5["Sync manifests"]
        IDB6["<b>ALL MAIL DATA</b>"]
        IDB_WHY["WHY: Local reads are 0-latency,<br/>survive offline, and sync as<br/>a background process."]
    end
```

## Service Worker Strategy

### What Gets Cached

```mermaid
graph TB
    subgraph PRECACHED["PRECACHED (Workbox)"]
        P1["index.html"]
        P2["assets/*.js"]
        P3["assets/*.css"]
        P4["*.woff2, *.woff (fonts)"]
        P5["*.png, *.svg, *.ico"]
        P6["manifest.json"]
        P7["sw-sync.js"]
    end
    subgraph RUNTIME["RUNTIME CACHED"]
        R1["Images: 30-day CacheFirst"]
        R2["App icons: 30-day CacheFirst"]
    end
    subgraph NEVER["NEVER CACHED BY SERVICE WORKER"]
        N1["/v1/* API responses"]
        N2["/api/* endpoints"]
        N3["Message bodies"]
        N4["Attachments"]
        N5["Any mail data whatsoever"]
    end
```

### Update Model

```mermaid
flowchart TD
    A["New build deployed"] --> B["CDN receives static files"]
    B --> C["SW detects new version on fetch"]
    C --> D["Install new SW in background"]
    D --> E["UI prompts user to refresh<br/>(no mid-session forced reloads)"]
```

## Offline-First Patterns

The service worker handles the app shell. Everything below handles the data.

### Pattern 1: Optimistic Updates

Apply changes to the local store and IndexedDB immediately. Sync with the API
in the background. If the API call fails, queue for retry.

```mermaid
flowchart TD
    A["User action (e.g., mark as read)"] --> B["(1) Update Svelte store<br/>Instant UI feedback"]
    A --> C["(2) Write to IndexedDB via db.worker<br/>Survives page reload"]
    A --> D["(3) Call API (Background)"]
    D --> E{Success?}
    E -- Yes --> F["Done"]
    E -- No --> G["Queue mutation for retry"]
```

**Key:** We never revert the optimistic update. On failure, the mutation goes
into a durable queue and retries when the network returns.

### Pattern 2: Mutation Queue

Failed API calls are persisted in the `meta` table under the `mutation-queue`
key. The queue is durable across page reloads and processed in order.

```mermaid
flowchart TD
    subgraph QUEUE["MUTATION QUEUE<br/>Storage: meta table (key: mutation-queue)<br/>File: src/utils/mutation-queue.js"]
        TR["toggleRead"] --> MERGE
        TS["toggleStar"] --> MERGE
        MV["move to trash"] --> MERGE
        DEL["delete"] --> MERGE
        MERGE["..."] --> ONLINE{Online?}
        ONLINE -- Yes --> PROCESS["Process in order via API calls"]
        ONLINE -- No --> WAIT["Wait for navigator.onLine<br/>or SW background sync"]
    end

    subgraph TYPES["Mutation Types"]
        T1["toggleRead — PUT /v1/messages/:id"]
        T2["toggleStar — PUT /v1/messages/:id"]
        T3["setLabels — PUT /v1/messages/:id"]
        T4["move — PUT /v1/messages/:id"]
        T5["delete — DELETE /v1/messages/:id"]
    end
```

### Pattern 3: Outbox (Offline Send)

Composed emails are queued in the `outbox` table when offline and sent when the
network returns.

```mermaid
flowchart TD
    A["User clicks Send"] --> B{Online?}
    B -- Yes --> C["Send via API"]
    B -- No --> D["Queue in outbox table<br/>(durable, per-account)"]
    D --> E["Show 'queued' indicator"]
    E --> F["On reconnect:<br/>Process outbox in order<br/>Update status per item"]
```

### Pattern 4: Draft Autosave

Drafts are saved to IndexedDB automatically as the user composes, protecting
against browser crashes and network loss.

```mermaid
flowchart TD
    subgraph DRAFT["DRAFT LIFECYCLE<br/>File: src/utils/draft-service.js"]
        A["Compose"] -- debounce --> B["Save to drafts table (local)"]
        B --> C{Online?}
        C -- Yes --> D["Sync to server"]
        C -- No --> E["Keep local, sync later"]
    end
```

### Pattern 5: Background Sync (Service Worker)

The service worker (`sw-sync.js`) can replay queued actions when the browser
regains connectivity — even if the tab is closed.

```mermaid
flowchart TD
    A["1. Main app queues mutation in meta table"] --> B["2. Registers a sync tag with service worker"]
    B --> C["3. Browser fires 'sync' event when online"]
    C --> D["4. sw-sync.js reads mutation queue<br/>from raw IndexedDB (no Dexie — SW can't import it)"]
    D --> E["5. Replays each mutation via fetch()"]
    E --> F["6. Removes processed items from queue"]
    F --> NOTE["IMPORTANT: sw-sync.js uses raw IndexedDB API,<br/>not Dexie. DB name must match db-constants.ts."]
    style NOTE fill:#fff3cd,stroke:#856404,color:#856404
```

### Pattern 6: Generation Counter

Prevents stale API responses from overwriting fresh data when the user
switches folders or accounts rapidly.

```mermaid
flowchart TD
    subgraph GEN["GENERATION COUNTER<br/>File: src/stores/mailboxActions.ts"]
        S0["loadGeneration: 0"]
        S0 --> S1["User clicks INBOX<br/>loadGeneration → 1<br/>API starts fetching..."]
        S1 --> S2["User clicks SENT<br/>loadGeneration → 2<br/>API starts fetching..."]
        S2 --> R1["INBOX response arrives<br/>gen=1, current=2"]
        S2 --> R2["SENT response arrives<br/>gen=2, current=2"]
        R1 --> D["DISCARD (stale)"]
        R2 --> AP["APPLY (current)"]
        style D fill:#f8d7da,stroke:#842029,color:#842029
        style AP fill:#d1e7dd,stroke:#0f5132,color:#0f5132
    end
```

### Pattern 7: Atomic Account Switch

When switching accounts, we preload the new account's cache from IndexedDB
before resetting stores — avoiding a blank flash.

```mermaid
flowchart TD
    A["switchAccount('alice@example.com')"] --> B["(1) Read IDB: folders, messages, settings<br/>for the new account (preload)"]
    B --> C["(2) Reset all stores (atomic)"]
    C --> D["(3) Apply preloaded data to stores<br/>UI shows cached data immediately"]
    D --> E["(4) Start background sync for new account<br/>Fresh deltas arrive, UI updates"]
```

## Key Source Files

| File                           | Role                                |
| ------------------------------ | ----------------------------------- |
| `src/utils/mutation-queue.js`  | Offline mutation queue (meta table) |
| `src/utils/outbox-service.js`  | Offline email send queue            |
| `src/utils/draft-service.js`   | Draft autosave and sync             |
| `src/utils/sync-controller.js` | Sync orchestration and scheduling   |
| `src/utils/cache-manager.js`   | Cache lifecycle and eviction        |
| `public/sw-sync.js`            | Service worker background sync      |
| `workbox.config.cjs`           | Workbox precaching configuration    |

---

**Next:** [Deployment](deployment-checklist.md) — ship to Cloudflare R2 + Workers.
