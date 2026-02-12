# Building Webmail: Technology Stack

Every tool in this stack was chosen to serve one goal: a static, client-only
webmail app that behaves like a native client.

## Stack Principles

```mermaid
flowchart LR
    subgraph Stack Principles
        A["SMALL RUNTIME / BIG CAPABILITY\nPush heavy work to workers.\nLoad features on demand."]
        B["LOCAL-FIRST BY DEFAULT\nIndexedDB is the source of truth.\nThe API only supplies deltas."]
        C["DETERMINISTIC UPDATES\nStatic shell. SW controls updates.\nNo surprises mid-session."]
        D["SECURITY AS BASELINE\nSanitize HTML, encrypt secrets,\nzero third-party tracking."]
    end
```

## Core Platform

```mermaid
flowchart LR
    A["Svelte 5\nCompile-time reactivity\nwith runes"] --> B["Vite 5\nFast dev HMR + build\nVendor split"] --> C["Workbox 7\nPrecache app shell\nSW updates"]
```

| Layer       | Tool         | Version           | Why                                                                        |
| ----------- | ------------ | ----------------- | -------------------------------------------------------------------------- |
| Framework   | Svelte       | ^5.48             | Runes (`$state`, `$derived`, `$effect`), compiled reactivity, tiny runtime |
| Build       | Vite         | ^5.0              | Sub-second HMR, optimized chunking, ES modules                             |
| PWA         | Workbox      | ^7.0              | Reliable precaching, SPA fallback, cache-first                             |
| Styling     | Tailwind CSS | ^4.1              | Utility-first, purged in production                                        |
| Components  | shadcn/ui    | via Bits UI ^2.15 | Accessible, composable primitives                                          |
| TypeScript  | TypeScript   | ^5.3              | Strict mode, worker typing                                                 |
| Package Mgr | pnpm         | ^9.0              | Fast, disk-efficient, strict                                               |
| Node        | Node.js      | 20 LTS            | Stable, long-term support                                                  |

## Data & Storage

```mermaid
flowchart LR
    subgraph DATA LAYER
        A["Dexie 4\nIndexedDB wrapper\n13 tables, per-account"]
        B["FlexSearch\nFull-text search\nindex, per-account"]
        C["Mutation Queue\nOffline actions\nmeta table"]
    end
```

| Component     | Tool       | Version | Why                                                    |
| ------------- | ---------- | ------- | ------------------------------------------------------ |
| Database      | Dexie      | ^4.2    | Schema layer over IndexedDB, compound keys, migrations |
| Search        | FlexSearch | ^0.7    | Fast client-side full-text, persistent indexes         |
| HTTP Client   | ky         | ^1.14   | Lightweight, retry-aware, hooks                        |
| Email Parsing | PostalMime | ^2.6    | RFC-compliant MIME parsing in workers                  |

## Workers & Concurrency

```mermaid
flowchart TD
    subgraph Workers & Concurrency
        MT["Main Thread\nUI + Stores"] --> SW["sync.worker\nAPI fetch, PostalMime, OpenPGP"]
        MT --> DW["db.worker\nDexie CRUD, Schema"]
        MT --> SEW["search.worker\nFlexSearch, Indexing, Queries"]
        SVC["+ Service Worker (Workbox) for asset caching"]
    end
```

Every worker communicates via `MessageChannel` — no shared memory, no
contention, no UI stalls.

## Composition & Content

| Component        | Tool                 | Version | Why                                       |
| ---------------- | -------------------- | ------- | ----------------------------------------- |
| Rich Text Editor | TipTap               | ^2.6    | Extensible, ProseMirror-based, formatting |
| Calendar         | Schedule-X           | ^1.63   | Month/week/day views, no server rendering |
| Sanitizer        | DOMPurify            | ^3.1    | XSS protection for HTML email content     |
| Encryption       | OpenPGP              | ^6.2    | Client-side PGP decrypt/encrypt           |
| Markdown         | marked               | ^12.0   | Compose in markdown, render as HTML       |
| Emoji            | emoji-picker-element | ^1.21   | Native emoji selection                    |
| Icons            | Lucide Svelte        | ^0.562  | Tree-shakeable SVG icon library           |
| Dates            | date-fns             | ^3.6    | Lightweight date formatting/parsing       |

## Security & Privacy

```mermaid
flowchart LR
    subgraph SECURITY LAYERS
        A["DOMPurify\nHTML email sanitized\nbefore display"]
        B["Sandboxed Iframe\nEmail body rendered\nisolated"]
        C["OpenPGP\nEnd-to-end encryption\nin sync worker"]
        D["+ Local-first storage (no server-side UI state)\n+ Static hosting (immutable, no server-rendered HTML)\n+ Zero third-party tracking\n+ CSP headers via Cloudflare Worker"]
    end
```

## Build & Quality

| Tool                     | Purpose                                 |
| ------------------------ | --------------------------------------- |
| ESLint 9 + TypeScript    | Linting with strict rules               |
| Prettier 3               | Consistent formatting                   |
| Husky + lint-staged      | Pre-commit quality gates                |
| Vitest 2.1               | Unit tests (jsdom)                      |
| Playwright 1.57          | E2E browser tests                       |
| Lighthouse CI            | Performance, a11y, best practices (90+) |
| rollup-plugin-visualizer | Bundle analysis (`pnpm analyze`)        |

## Performance Budget

```mermaid
flowchart TD
    subgraph PERFORMANCE TARGETS
        direction TB
        T["Lighthouse: 90+\nFirst Paint: < 1s\nCached Boot: < 200ms\nMain Thread Work: Minimal\nBundle (gzipped): Chunked"]
        H["HOW WE HIT THEM:\nSvelte compiles away the framework\nVendor chunk: svelte, dexie, ky, openpgp, tiptap\nLazy routes: calendar, contacts, compose\nVirtual scrolling for message lists\nWorkers for all CPU-heavy operations"]
    end
```

## Development Commands

```bash
pnpm dev              # Dev server on :5174 with HMR
pnpm build            # Production build + SW generation
pnpm preview          # Preview production build
pnpm check            # Svelte type checking
pnpm analyze          # Bundle visualization → dist/stats.html

pnpm test             # Unit tests (Vitest)
pnpm test:watch       # Watch mode
pnpm test:coverage    # Coverage report
pnpm test:e2e         # E2E tests (Playwright)

pnpm lint             # ESLint check
pnpm lint:fix         # ESLint auto-fix
pnpm format           # Prettier check
pnpm format:fix       # Prettier auto-fix
```

---

**Next:** [Worker Mesh](building-webmail-workers.md) — the three-worker
architecture that keeps the UI at 60fps.
