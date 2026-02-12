# Building Webmail

A technical deep-dive into how we built a privacy-first, offline-capable webmail
PWA that runs entirely in the browser.

```mermaid
flowchart TD
    A["Read Mail"] --> E["Forward Email<br/>Webmail PWA"]
    B["Search Instant"] --> E
    C["Compose Rich"] --> E
    D["Offline First"] --> E
```

## The Series

```mermaid
flowchart TD
    START["START HERE"] --> A

    A["1. Vision & Architecture<br/>Why client-only? Why offline-first?<br/>The constraints that drive everything."]
    A --> B["2. Technology Stack<br/>Svelte 5 + Vite + Dexie + Workers.<br/>Every choice, why it was made."]

    B --> C["3. Worker Mesh<br/>3 workers, 1 owner, 0 UI jank"]
    B --> D["4. Data Layer<br/>IndexedDB as product memory"]
    B --> E["5. Search Engine<br/>FlexSearch, local-first, instant results"]

    C --> F
    D --> F
    E --> F

    F["6. Service Worker & Offline Patterns<br/>Cache the shell, not the mail.<br/>Mutation queues, optimistic updates, sync."]
    F --> G["7. Deployment<br/>Cloudflare R2 + Workers, CI/CD, go live."]
```

## Reading Guide

| You want to...                       | Start here                                                              |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Understand the big picture           | [Vision & Architecture](building-webmail-vision-architecture.md)        |
| Know why we picked Svelte/Dexie/etc  | [Technology Stack](building-webmail-technology-stack.md)                |
| Understand off-main-thread design    | [Worker Mesh](building-webmail-workers.md)                              |
| Debug cache or IndexedDB issues      | [Data Layer](building-webmail-db-schema-recovery.md)                    |
| Trace a search query end-to-end      | [Search Engine](building-webmail-search.md)                             |
| Understand offline and sync patterns | [Service Worker & Offline Patterns](building-webmail-service-worker.md) |
| Ship to production                   | [Deployment](deployment-checklist.md)                                   |

## Detailed References

These go deeper than the series articles:

| Document                                                        | Scope                                              |
| --------------------------------------------------------------- | -------------------------------------------------- |
| [Worker Architecture](worker-architecture.md)                   | Message contracts, data flows, fallback paths      |
| [Cache & Indexing Architecture](cache-indexing-architecture.md) | Storage layers, eviction, reconciliation           |
| [Mailbox Loading Flow](mailbox-loading-flow.md)                 | Full request lifecycle with timeline visualization |

## Quick Stats

```mermaid
flowchart LR
    subgraph Quick Stats
        direction LR
        A["Framework: Svelte 5 (runes)<br/>Build: Vite 5<br/>Storage: Dexie 4 (IndexedDB)<br/>Search: FlexSearch 0.7<br/>Workers: 3 dedicated + service worker<br/>Encryption: OpenPGP 6.2<br/>Editor: TipTap 2<br/>Hosting: Cloudflare R2 + Workers"]
        B["Tables: 13 IndexedDB tables<br/>Source: 190+ files<br/>Bundle: Vendor-chunked, code-split<br/>Target: Lighthouse 90+"]
    end
```
