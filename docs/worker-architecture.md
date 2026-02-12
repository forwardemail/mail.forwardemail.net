# Worker Architecture: Detailed Reference

This is the deep-dive companion to [Building Webmail: Workers](building-webmail-workers.md).
It covers message contracts, data flow diagrams, IndexedDB ownership, fallback
paths, and operational checklists.

## High-Level Overview

```mermaid
flowchart TB
    Main["Main Thread\nUI + Svelte Stores"]
    Main -- "MessageChannel" --> DB["db.worker\nDexie 4\nIndexedDB\n13 tables"]
    Main -- "MessageChannel" --> Sync["sync.worker\nAPI + Parse\nPostalMime\nOpenPGP"]
    Main -- "MessageChannel" --> Search["search.worker\nFlexSearch\nIndexing\nQueries"]
    Sync -- "MessagePort" --> DB
    Sync -- "MessagePort" --> Search
```

## Main Thread Responsibilities

The main thread focuses on rendering and orchestration:

```mermaid
flowchart TB
    subgraph MainThread["MAIN THREAD"]
        subgraph Rendering["Rendering"]
            R1["UI components"]
            R2["Routing"]
            R3["Event handling"]
            R4["Keyboard shortcuts"]
        end
        subgraph Orchestration["Orchestration"]
            O1["Worker startup + recovery"]
            O2["Fallback path selection"]
            O3["Optimistic UI updates"]
            O4["Settings management"]
        end
        subgraph KeyModules["Key Modules"]
            M1["src/main.ts — App bootstrap"]
            M2["src/utils/db.js — Init/recovery wrapper"]
            M3["src/utils/db-worker-client.js — Proxy to db.worker"]
            M4["src/utils/sync-worker-client.js — Proxy to sync.worker"]
            M5["src/utils/search-worker-client.js — Proxy to search"]
            M6["src/stores/mailboxStore.ts — Message list + cache"]
            M7["src/stores/mailService.ts — Body + attachments"]
            M8["src/stores/searchStore.ts — Search + health"]
            M9["src/stores/settingsStore.ts — Settings + labels"]
        end
    end
```

## Data Flow Diagrams

### Startup (Happy Path)

```mermaid
flowchart TD
    A["Main thread"] --> B["initializeDatabase()"]
    B --> C["db.worker: open Dexie"]
    A --> D["Load settings from IDB\n(settingsStore)"]
    A --> E["Load folders, labels, messages\n(mailboxStore/Actions)"]
    A --> F["startInitialSync()"]
    F --> G["sync.worker: connect db port"]
    F --> H["sync.worker: connect search port"]
    F --> I["sync.worker: begin folder + message sync"]
```

### Message List (Mailbox View)

```mermaid
flowchart TD
    A["mailboxStore.loadMessages()"] --> B["try sync.worker 'messagePage'"]
    B --> B1["Fetch GET /v1/messages?folder=..."]
    B --> B2["Normalize + write to db.worker"]
    B --> B3["Return messages to main thread"]
    A --> C["FALLBACK: main thread fetch /v1/messages"]
    A --> D["Merge labels from IDB if API payload lacks them"]
    A --> E["Update UI list"]
```

### Message Detail (Reader)

```mermaid
flowchart TD
    A["mailService.loadMessageDetail()"] --> B["Check messageBodies in db.worker"]
    A --> C["try sync.worker 'messageDetail'"]
    C --> C1["GET /v1/messages/:id?folder=...&raw=false"]
    C --> C2["Parse body with PostalMime"]
    C --> C3["Detect PGP → decrypt with OpenPGP"]
    C --> C4["Store in db.worker (messageBodies)"]
    C --> C5["Return parsed result"]
    A --> D["FALLBACK: main thread direct API fetch"]
```

### Search Indexing

```mermaid
flowchart TD
    A["sync.worker writes messages to db.worker"] --> B["Forward batch to search.worker\n(MessagePort)"]
    B --> C["Load bodies from db.worker if includeBody"]
    B --> D["Update FlexSearch index"]
    B --> E["Persist index to IndexedDB"]
```

### Labels & Settings

```mermaid
flowchart TD
    A["Settings UI"] --> B["settingsStore.updateSetting()"]
    B --> B1["PUT /v1/account"]
    B --> B2["Cache to db.worker\n(settings/settingsLabels)"]

    C["Mailbox labels dropdown"] --> D["mailboxActions.loadLabels()"]
    D --> D1["Merge: settings labels +\ncached labels + message-derived labels"]
```

## Message Passing Contracts

### db.worker

```
REQUEST:   { id: string, action: string, table: string, payload: any }
RESPONSE:  { id: string, ok: true, result: any }
        or { id: string, ok: false, error: string }
```

Common actions:

| Action  | Description                            |
| ------- | -------------------------------------- |
| get     | Read single record by key              |
| getAll  | Read all records (optionally filtered) |
| put     | Upsert single record                   |
| bulkPut | Upsert multiple records                |
| delete  | Remove by key                          |
| where   | Query with index + filters             |
| count   | Count records matching criteria        |
| clear   | Clear all records in a table           |

### sync.worker

```
TASK REQUEST:
  { type: 'task', taskId: string, task: { action: string, ...params } }

REQUEST/RESPONSE:
  { type: 'request', requestId: string, action: string, payload: any }
  { type: 'requestComplete', requestId: string, result: any }
  { type: 'requestError', requestId: string, error: string }
```

Common tasks:

| Task           | Description                          |
| -------------- | ------------------------------------ |
| messagePage    | Fetch page of messages for a folder  |
| messageDetail  | Fetch + parse single message body    |
| folderSync     | Sync folder list from API            |
| bodiesPass     | Background fetch bodies for a folder |
| decryptMessage | PGP decrypt a message body           |

### search.worker

```
REQUEST:   { id: string, action: string, payload: any }
RESPONSE:  { id: string, ok: true, result: any }
        or { id: string, ok: false, error: string }
```

Common actions:

| Action     | Description                  |
| ---------- | ---------------------------- |
| search     | Execute FlexSearch query     |
| index      | Add/update messages in index |
| remove     | Remove messages from index   |
| rebuild    | Full index rebuild from IDB  |
| stats      | Return index health info     |
| setAccount | Switch active account index  |

## IndexedDB Ownership

```mermaid
flowchart TD
    subgraph DBWorker["db.worker (SOLE OWNER)"]
        subgraph Tables["Tables"]
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
    Note1["Other workers NEVER open IndexedDB directly.\nThey always send requests to db.worker."] -.-> DBWorker
    Note2["Exception: sw-sync.js uses raw IndexedDB API\n(service workers cannot import Dexie)"] -.-> DBWorker
```

## Fallback & Resilience

| Component      | Fallback                              |
| -------------- | ------------------------------------- |
| sync.worker    | Main thread direct API calls          |
| search.worker  | Main thread SearchService (in-memory) |
| db.worker      | Delete DB, re-init, resync from API   |
| Message list   | Direct /v1/messages fetch             |
| Message detail | Direct /v1/messages/:id fetch         |

Workers restart independently. The main thread always has a degraded path
that keeps the app functional.

## Known Constraints

- db.worker MUST initialize before sync/search workers connect
- `SCHEMA_VERSION` in `db-constants.ts` must match `sw-sync.js`
- Labels are keyed by keyword/id; rename changes display name only
- Service worker does NOT cache API responses
- Workers use TypeScript (`.ts`) but are bundled by Vite

## Update Checklist

When modifying worker code:

- [ ] Update schema in src/workers/db.worker.ts
- [ ] Increment SCHEMA_VERSION in src/utils/db-constants.ts
- [ ] Ensure db.worker clients handle new tables/fields
- [ ] Update sw-sync.js if meta table structure changes
- [ ] Update this doc if responsibilities or flows change
