# Building Webmail: Vision & Architecture

> A privacy-first, offline-capable webmail client that runs entirely in the
> browser and stores mailbox state locally.

## Why This Exists

Most webmail is server-driven: HTML rendered remotely, thin browser caches, and
features that disappear when the network stalls. We took the opposite bet.

```mermaid
flowchart LR
    subgraph Traditional["Traditional Webmail"]
        direction LR
        B1[Browser] -->|request| S1[Server] -->|renders| H1[HTML] -->|back| U1[UI]
    end
    subgraph ForwardEmail["Forward Email Webmail"]
        direction LR
        B2[Browser IS the app] ---|data pipe| A2[API]
    end

    Traditional -.- VS((vs.)) -.- ForwardEmail

    style Traditional fill:#f9f9f9,stroke:#999
    style ForwardEmail fill:#e6f3ff,stroke:#369

    T1["Every click = network round-trip\nOffline = blank page\nServer holds all state"]
    T2["App shell cached at edge + locally\nMail state lives in IndexedDB\nOffline = fully functional\nServer only provides deltas"]

    Traditional --- T1
    ForwardEmail --- T2

    style T1 fill:#fff,stroke:#999
    style T2 fill:#fff,stroke:#369
```

## Architectural North Stars

These are the constraints we refuse to break:

```mermaid
flowchart TD
    NS["Architectural North Stars"]
    P1["1. PWA Shell from CDN\nHTML/JS/CSS are static, versioned,\ncached at the edge"]
    P2["2. IndexedDB as Product Memory\nMailbox state, drafts, settings, and\nsearch indexes live locally.\nIndexedDB is not a cache — it IS the product"]
    P3["3. Workers over Main Thread\nParsing, sync, and indexing never block the UI.\nThree dedicated workers handle all heavy lifting"]
    P4["4. API as Data Pipe\nThe server provides deltas and validation,\nnever UI state. The client decides what to show"]

    NS --> P1
    NS --> P2
    NS --> P3
    NS --> P4

    style NS fill:#2a5599,color:#fff,stroke:#1a3366
    style P1 fill:#e6f3ff,stroke:#369
    style P2 fill:#e6f3ff,stroke:#369
    style P3 fill:#e6f3ff,stroke:#369
    style P4 fill:#e6f3ff,stroke:#369
```

## How a Request Flows

From cold start to rendered inbox in under 200ms (cached):

```mermaid
flowchart TD
    CDN["CDN / Edge (Cloudflare R2)\nindex.html | assets/*.js | assets/*.css"]
    SW["Service Worker\nWorkbox precache"]
    CACHE_NOTE["(2) Cache shell for next visit"]
    UI["Main UI Thread\nSvelte 5 components + stores\nKeyboard shortcuts + routing\nOrchestrates workers"]
    IDB["IndexedDB (Dexie 4)\n13 tables, per-account"]
    API["Forward Email API\napi.forwardemail.net\nREST + JSON, Data only"]
    MERGE["Merge + update cache"]
    RENDER["Render inbox"]

    CDN -->|"(1) Load app shell"| SW
    CACHE_NOTE -.-> SW
    SW -->|"(3) Boot application"| UI
    UI -->|"(4) Read cache first"| IDB
    UI -->|"(5) Fetch deltas"| API
    IDB -->|"(6) Merge + update cache"| MERGE
    API --> MERGE
    MERGE --> RENDER

    style CDN fill:#f0f4ff,stroke:#369
    style SW fill:#f0f4ff,stroke:#369
    style UI fill:#e6f3ff,stroke:#269
    style IDB fill:#fff3e0,stroke:#e65100
    style API fill:#fff3e0,stroke:#e65100
    style RENDER fill:#e8f5e9,stroke:#2e7d32
    style CACHE_NOTE fill:#fff,stroke:#999,stroke-dasharray: 5 5
```

## Layered Architecture

```mermaid
flowchart TD
    subgraph Presentation["PRESENTATION LAYER"]
        P1["Svelte 5 Components"]
        P2["Routing"]
        P3["Keyboard Shortcuts"]
        P4["Virtual Scrolling"]
        P5["Themes"]
        P6["Responsive Layout"]
        P7["shadcn/ui + Bits UI"]
        P8["TipTap"]
        P9["Schedule-X Calendar"]
    end

    subgraph Business["BUSINESS LOGIC LAYER"]
        BStores["mailboxStore | mailboxActions | mailService\nsettingsStore | searchStore | conversationStore\nviewStore | folderStore | messageStore"]
        BCaps["Threading | Search parsing | Filtering | Security checks"]
    end

    subgraph Data["DATA LAYER"]
        DB["db.worker\nDexie 4 / IndexedDB\n13 tables"]
        SYNC["sync.worker\nAPI fetch / PostalMime\nOpenPGP"]
        SEARCH["search.worker\nFlexSearch\nFull-text indexing"]
        SYNC -->|writes| DB
        SYNC -->|indexes| SEARCH
    end

    subgraph Service["SERVICE LAYER"]
        SW["Service Worker (Workbox)\nAsset precaching\nSPA fallback routing"]
        BG["Background Sync (sw-sync.js)\nOffline mutation replay\nOutbox queue processing"]
    end

    Presentation --> Business
    Business --> Data
    Data --> Service

    style Presentation fill:#e8f5e9,stroke:#2e7d32
    style Business fill:#e3f2fd,stroke:#1565c0
    style Data fill:#fff3e0,stroke:#e65100
    style Service fill:#f3e5f5,stroke:#7b1fa2
```

## What This Unlocks

```mermaid
flowchart LR
    subgraph Row1[" "]
        direction LR
        F1["OFFLINE PARITY\n\nRead, search, compose,\nand queue actions\nwithout a network."]
        F2["FAST SEARCH\n\nFlexSearch runs locally.\nNo server round-trips\nfor instant results."]
        F3["NATIVE FEEL\n\nUI stays at 60fps.\nWorkers handle all\nheavy lifting off-thread."]
    end
    subgraph Row2[" "]
        direction LR
        F4["PRIVACY FIRST\n\nStatic hosting,\nno tracking, local-first\ndata storage."]
        F5["MULTI-ACCOUNT\n\nPer-account IndexedDB keys,\ninstant switch with\npreloaded cache."]
        F6["PGP BUILT-IN\n\nClient-side decryption\nvia OpenPGP in the\nsync worker."]
    end

    Row1 ~~~ Row2

    style F1 fill:#e8f5e9,stroke:#2e7d32
    style F2 fill:#e3f2fd,stroke:#1565c0
    style F3 fill:#fff3e0,stroke:#e65100
    style F4 fill:#f3e5f5,stroke:#7b1fa2
    style F5 fill:#fff8e1,stroke:#f9a825
    style F6 fill:#fce4ec,stroke:#c62828
    style Row1 fill:none,stroke:none
    style Row2 fill:none,stroke:none
```

## Key Design Decisions

| Decision                    | Why                                                    |
| --------------------------- | ------------------------------------------------------ |
| Client-only PWA             | No server-rendered UI = immutable, globally fast       |
| IndexedDB over server state | Local reads are 0-latency, survive offline             |
| Workers for all heavy work  | UI thread stays free, 60fps guaranteed                 |
| Optimistic updates          | Apply locally first, sync API in background            |
| Generation counters         | Prevent stale API responses from clobbering fresh data |
| Leading-edge debounce       | Account switches feel instant, last one wins           |
| Atomic cache swap           | Read IDB before resetting stores = no blank flash      |
| Vendor chunk splitting      | Core deps cached separately from app code              |
| Lazy-loaded routes          | Calendar, contacts, compose load on demand             |

## The Bet

If we get the architecture right, everything else scales: faster UX, better
privacy, richer features, and a codebase that ships as a PWA today and wraps
as a native app tomorrow. The constraint is the advantage.

---

**Next:** [Technology Stack](building-webmail-technology-stack.md) — the tools
that make this constraint real.
