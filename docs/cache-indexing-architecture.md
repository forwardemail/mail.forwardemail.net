# Cache & Indexing Architecture: Detailed Reference

This is the deep-dive companion to [Building Webmail: Data Layer](building-webmail-db-schema-recovery.md).
It covers storage layers, write ownership, read patterns, eviction policies,
reconciliation strategies, and troubleshooting.

## Storage Layers at a Glance

```mermaid
flowchart TB
    subgraph L1["LAYER 1: IN-MEMORY — Read: 0ms"]
        L1A["Svelte $state stores, LRU caches"]
        L1B["Lost on page navigation. Fastest reads."]
    end

    subgraph L2["LAYER 2: INDEXEDDB (db.worker/Dexie) — Read: ~5ms"]
        L2A["13 tables, compound keys, per-account data"]
        L2B["Survives page reloads. Source of local truth."]
    end

    subgraph L3["LAYER 3: SEARCH INDEX (search.worker/FlexSearch)"]
        L3A["Full-text index persisted to IndexedDB"]
        L3B["Rebuilt if health check detects divergence."]
    end

    subgraph SW["SEPARATE: SERVICE WORKER (CacheStorage)"]
        SWA["JS, CSS, fonts, icons, images ONLY"]
        SWB["NO API responses. NO mail data."]
    end

    L1 --> L2 --> L3
    SW ~~~ L3
```

## Who Writes What

```mermaid
flowchart LR
    SW["sync.worker"] --> messages["messages"]
    SW --> messageBodies["messageBodies"]
    SW --> folders["folders"]
    SW --> syncManifests["syncManifests"]

    MT["main thread<br/>(fallback + user actions)"] --> messagesMain["messages<br/>(flags, labels, folder)"]
    MT --> messageBodiesMain["messageBodies<br/>(fallback writes)"]
    MT --> settings["settings, settingsLabels"]
    MT --> outbox["outbox, drafts"]

    SRW["search.worker"] --> searchIndex["searchIndex"]
    SRW --> indexMeta["indexMeta"]
```

## Read Patterns

### Message List

```mermaid
flowchart TD
    Start["Message List Request"] --> Step1{"1. In-memory<br/>LRU cache"}
    Step1 -- HIT --> Return1["Return (0ms)"]
    Step1 -- MISS --> Step2{"2. IndexedDB query<br/>messages.where([account+folder])<br/>.sortBy(date)"}
    Step2 -- HIT --> Render["Render list (5ms)"]
    Step2 -- MISS --> Step3["3. API delta fetch (background)<br/>sync.worker -> /v1/messages?folder=..."]
    Step3 --> Merge["Merge into IDB + update UI"]
    Merge --> Labels["Labels merging: if API response omits labels,<br/>merge from cached IndexedDB records<br/>(mergeMissingLabels)"]
```

### Message Detail

```mermaid
flowchart TD
    Start["Message Detail Request"] --> Step1{"1. messageBodies.get([account+id])<br/>HIT and fresh?"}
    Step1 -- YES --> Render["Render body (5ms)"]
    Step1 -- NO --> Step2["2. sync.worker 'messageDetail' task"]
    Step2 --> API["GET /v1/messages/:id?raw=false"]
    API --> Parse["Parse with PostalMime"]
    Parse --> PGP["PGP decrypt if needed"]
    PGP --> Cache["Cache to messageBodies"]
    Step2 -. fails .-> Fallback["3. FALLBACK:<br/>main thread direct API fetch"]
```

### Folders / Labels / Settings

```mermaid
flowchart TD
    Boot["App Boot"] --> ReadCache["Read cached folders, labels, settings<br/>for fast hydration"]
    ReadCache --> Render["Render UI immediately"]
    ReadCache --> BackgroundSync["Sync with API in background"]
    BackgroundSync --> PerAccount["Settings are per-account,<br/>keyed by account in IDB"]
    BackgroundSync --> LabelsMerge["Labels merge:<br/>settingsLabels + cached labels + msg-derived"]
```

## Search Indexing Flow

```mermaid
flowchart TD
    subgraph Primary["PRIMARY PATH"]
        API1["API"] --> SyncW["sync.worker"]
        SyncW --> DBW1["db.worker (messages)"]
        SyncW --> SRW1["search.worker (index batch)"]
    end

    subgraph Fallback["FALLBACK PATH"]
        API2["API"] --> Main["main thread"]
        Main --> DBW2["db.worker (messages)"]
        Main --> SRW2["search.worker (index batch)"]
    end

    subgraph Startup["ON STARTUP"]
        Load["search.worker loads persisted index<br/>from searchIndex table"]
        Load --> Compare["Compares indexMeta counts<br/>vs messages count"]
        Compare -- Diverged? --> Rebuild["Background rebuild<br/>(non-blocking)"]
    end
```

## Data Freshness & Reconciliation

| DATA TYPE         | RECONCILIATION STRATEGY                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| Labels            | Merge cached labels when API omits them (mergeMissingLabels)              |
| Flags (read/star) | Update in-place in messages table                                         |
| Moves / deletes   | Optimistic UI update, then update specific record in IDB on success       |
| Search index      | Health check on startup; rebuild if count diverges from messages table    |
| Sync progress     | syncManifests track per-folder cursor (lastUID, lastSyncAt, pagesFetched) |

## Caching Policies & Eviction

```mermaid
flowchart TD
    Title["EVICTION PRIORITY<br/>Managed by: src/utils/cache-manager.js"]

    subgraph KeepLongest["KEEP LONGEST"]
        M["metadata"]
        S["settings"]
        F["folders"]
    end

    subgraph EvictFirst["EVICT FIRST"]
        B["bodies"]
        SI["search index"]
        AB["attachment blobs"]
    end

    M --> S --> F --> B --> SI --> AB

    Notes["Attachment cache: 50MB quota (meta table, key: attachment:*)<br/>Contact cache: meta table (key: contacts:*)<br/>Storage tracked: navigator.storage.estimate()"]

    Title ~~~ KeepLongest
    EvictFirst ~~~ Notes
```

## Failure & Fallback Modes

| FAILURE                               | FALLBACK                                                              |
| ------------------------------------- | --------------------------------------------------------------------- |
| sync.worker fails                     | Main thread fetches /v1/messages and writes to db.worker              |
| search.worker fails                   | Main thread SearchService + DB query                                  |
| IndexedDB corrupt or version mismatch | Recovery: delete DB, re-init, resync from API. Credentials preserved. |
| Quota exceeded                        | Evict bodies and attachments first                                    |

## Troubleshooting Checklist

```mermaid
flowchart TD
    Step1["1. Is db.worker initialized?<br/>Check: DevTools -> Application -> IndexedDB<br/>Should see webmail-cache-v1 with 13 tables"]
    Step2["2. Does messages table have records after API fetch?<br/>Open messages table, filter by account + folder"]
    Step3["3. Are searchIndex/indexMeta populated after indexing?<br/>If empty, search will return no results"]
    Step4["4. Is UI reading from cache before network?<br/>First render should show cached data<br/>Network data should update, not replace"]
    Step5["5. Are syncManifests progressing?<br/>lastSyncAt should update after each sync<br/>pagesFetched should increment"]

    Step1 --> Step2 --> Step3 --> Step4 --> Step5
```

## Reference Files

| File                                | Role                             |
| ----------------------------------- | -------------------------------- |
| `src/workers/db.worker.ts`          | IndexedDB owner, schema, CRUD    |
| `src/workers/sync.worker.ts`        | API sync, writing to IDB         |
| `src/workers/search.worker.ts`      | FlexSearch indexing              |
| `src/utils/db-worker-client.js`     | Main thread proxy to db.worker   |
| `src/utils/sync-worker-client.js`   | Main thread proxy to sync.worker |
| `src/utils/search-worker-client.js` | Main thread proxy to search      |
| `src/utils/cache-manager.js`        | Eviction and lifecycle           |
| `src/utils/attachment-cache.js`     | Attachment blob cache (50MB)     |
| `src/utils/contact-cache.js`        | Contact autocomplete cache       |
| `src/stores/mailboxStore.ts`        | Message list orchestration       |
| `src/stores/mailService.ts`         | Message body + attachments       |
| `src/stores/settingsStore.ts`       | Settings + labels sync           |
