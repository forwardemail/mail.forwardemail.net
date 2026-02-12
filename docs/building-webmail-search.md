# Building Webmail: The Search Engine

Search is the fastest way users navigate a mailbox. It has to be instant,
offline-capable, and reliable — even as the mailbox grows to thousands of
messages. That makes search a core system, not a feature.

## The Problem

```mermaid
flowchart TD
    A["SERVER SEARCH\n+ Complete (all messages)\n+ Always accurate\n- 200-500ms per query\n- Requires network\n- Feels sluggish"]
    B["CLIENT SEARCH\n+ Instant (no network)\n+ Works offline\n- Incomplete (only cached)\n- Needs maintenance\n- Index can drift"]

    A --> C["OUR SOLUTION"]
    B --> C

    C --> D["HYBRID SEARCH\nQuery local FlexSearch index first (instant).\nFall back to API only when local cache is insufficient.\nMerge API results back into local index for next time."]
```

## Architecture

```mermaid
flowchart TD
    MT["Main Thread\nsearchStore, Search UI,\nQuery parsing"]
    MT -- MessageChannel --> SW["search.worker\nFlexSearch\nPer-account indexes\nSubject + body (opt)"]
    SW -- "MessagePort (to db.worker)" --> DW["db.worker\nsearchIndex, indexMeta,\nmessages, messageBodies"]
```

## Indexing Pipeline

New messages flow through a pipeline from API to searchable index:

```mermaid
flowchart TD
    A["API response"] --> B["sync.worker"]
    B --> C["Normalize metadata"]
    B --> D["Write to db.worker\n(messages table)"]
    B --> E["Forward batch to search.worker"]
    E --> F["Index subject, from, snippet"]
    E --> G{"includeBody enabled?"}
    G -- Yes --> H["Load bodies from db.worker\nIndex text content"]
    E --> I["Persist index to db.worker\n(searchIndex + indexMeta)"]
```

### What Gets Indexed

```mermaid
flowchart LR
    subgraph What Gets Indexed
        A["ALWAYS INDEXED\nSubject line\nFrom address\nSnippet/preview\nDate\nMessage ID"]
        B["OPTIONAL (user toggle)\nFull message body text"]
    end
    C["Body indexing is toggled in Settings → Search.\nWhen enabled, existing messages are indexed in background."]
```

## Query Model

Three paths, fastest first:

```mermaid
flowchart TD
    A["User types query"] --> B["1. FAST PATH (~10ms)\nQuery FlexSearch index in search.worker\nResults from cached messages only\nInstant for all indexed mail"]
    B --> C{"Enough results?"}
    C -- YES --> D["Done, render results"]
    C -- NO --> E["2. FILTER PATH\nApply mailbox-level filters:\nfolder, flags (unread/starred),\nlabels, date range"]
    E --> F{"Still missing?"}
    F -- NO --> G["Done"]
    F -- YES --> H["3. FALLBACK PATH (100-500ms)\nQuery the API: GET /v1/messages?q=...\nMerge new results into db.worker + search index\nNext identical query will hit the fast path"]
```

### Advanced Query Syntax

| Filter         | Example                 |
| -------------- | ----------------------- |
| from:          | from:alice@example.com  |
| to:            | to:bob@example.com      |
| subject:       | subject:meeting notes   |
| before:        | before:2025-01-01       |
| after:         | after:2024-06-15        |
| has:attachment | has:attachment          |
| is:unread      | is:unread               |
| is:starred     | is:starred              |
| label:         | label:important         |
| free text      | quarterly report budget |

## Index Health & Rebuilds

Indexes drift. Messages get synced, evicted, or updated. We track this
explicitly and heal automatically:

```mermaid
flowchart TD
    A["On startup:\nsearch.worker loads persisted index"] --> B["Compare indexMeta.count vs\nmessages.count in db.worker"]
    B --> C{"Match or Diverged?"}
    C -- MATCH --> D["Ready"]
    C -- DIVERGED --> E["Trigger background rebuild\nDoes not block UI\nProgress reported to main thread\nIndex re-persisted when complete"]
```

## Key Source Files

| File                                | Role                                |
| ----------------------------------- | ----------------------------------- |
| `src/workers/search.worker.ts`      | FlexSearch owner, indexing, queries |
| `src/utils/search-worker-client.js` | Main thread proxy to search.worker  |
| `src/utils/search-service.js`       | Query execution and fallback        |
| `src/utils/search-query.js`         | Query parsing and filter logic      |
| `src/stores/searchStore.ts`         | Search UI state, health monitoring  |

---

**Next:** [Service Worker & Offline Patterns](building-webmail-service-worker.md)
— cache the shell, queue the mutations.
