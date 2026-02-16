# Forward Email Webmail

A privacy-first, offline-capable Progressive Web App for Forward Email. Ships as static assets and runs entirely in the browser with local caching, full-text search, and multi-account support.

## Features

- **Multi-account** — Login with multiple Forward Email accounts, alias auth, and optional API key override
- **Mailbox** — Folders, message threading, bulk actions, keyboard shortcuts, attachment handling, PGP decryption
- **Compose** — Rich text editor (TipTap), CC/BCC, emoji picker, attachments, draft autosave, offline outbox queue
- **Search** — Full-text search with FlexSearch, optional body indexing, saved searches, background indexing
- **Offline** — IndexedDB caching for folders/messages/bodies, sync queue for pending actions, service worker caching
- **Calendar** — Month/week/day views, quick add/edit/delete, iCal export
- **Contacts** — CRUD operations, vCard import/export, deep links to compose/search
- **Settings** — Theme (system/light/dark), cache controls, keyboard shortcuts, PGP key management

## Tech Stack

| Category       | Technologies                            |
| -------------- | --------------------------------------- |
| **Framework**  | Svelte 5, Vite 5                        |
| **Styling**    | Tailwind CSS 4, PostCSS                 |
| **State**      | Svelte Stores                           |
| **Database**   | Dexie 4 (IndexedDB)                     |
| **Search**     | FlexSearch                              |
| **Editor**     | TipTap 2                                |
| **Calendar**   | schedule-x                              |
| **Encryption** | OpenPGP                                 |
| **Testing**    | Vitest, Playwright                      |
| **Tooling**    | ESLint 9, Prettier 3, Husky, commitlint |

## Architecture

The application follows a client-first, offline-capable architecture with three main layers:

```mermaid
graph LR
    CDN["Static Assets (CDN)"] --> SW["Service Worker"] --> MT["Main Thread"] --> WW["Web Workers"]
    MT --> IDB["IndexedDB (Dexie)"]
    IDB --> API["API (data fallback)"]
```

### Key Components

- **Main Thread** — Svelte components, stores, routing, UI rendering
- **db.worker** — Owns IndexedDB via Dexie, handles all database operations
- **sync.worker** — API fetching, message parsing (PostalMime), data normalization
- **search.worker** — FlexSearch indexing and query execution

### Documentation

Detailed architecture documentation is available in the `docs/` directory:

- [Vision & Architecture](docs/building-webmail-vision-architecture.md) — Design principles and architectural patterns
- [Worker Architecture](docs/worker-architecture.md) — Worker responsibilities and message passing
- [Cache & Indexing](docs/cache-indexing-architecture.md) — Storage layers and data flow
- [Search](docs/building-webmail-search.md) — FlexSearch setup and query parsing
- [Service Worker](docs/building-webmail-service-worker.md) — Asset caching strategy
- [DB Schema & Recovery](docs/building-webmail-db-schema-recovery.md) — Database management

## Project Structure

```
src/
├── main.ts                 # App bootstrap, routing, service worker registration
├── config.ts               # Environment configuration
├── stores/                 # Svelte stores (state management)
│   ├── mailboxStore.ts     # Message list, folders, threading
│   ├── mailboxActions.ts   # Move, delete, flag, label actions
│   ├── messageStore.ts     # Selected message, body, attachments
│   ├── searchStore.ts      # Search queries and index health
│   ├── settingsStore.ts    # User preferences, theme, PGP keys
│   └── ...
├── svelte/                 # Svelte components
│   ├── Mailbox.svelte      # Main email interface
│   ├── Compose.svelte      # Email composer
│   ├── Calendar.svelte     # Calendar view
│   ├── Contacts.svelte     # Contact management
│   ├── Settings.svelte     # User settings
│   └── components/         # Reusable components
├── workers/                # Web Workers
│   ├── db.worker.ts        # IndexedDB operations
│   ├── sync.worker.ts      # API sync and parsing
│   └── search.worker.ts    # Search indexing
├── utils/                  # Utilities
│   ├── remote.js           # API client
│   ├── db.js               # Database initialization
│   ├── storage.js          # LocalStorage management
│   └── ...
├── lib/components/ui/      # UI component library (shadcn/ui)
├── styles/                 # CSS (Tailwind + custom)
├── locales/                # i18n translations
└── types/                  # TypeScript definitions
```

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9.0.0+

### Installation

```bash
pnpm install
```

### Development

```bash
pnpm dev          # Start dev server (http://localhost:5174)
```

### Build

```bash
pnpm build        # Build to dist/ + generate service worker
pnpm preview      # Preview production build locally
pnpm analyze      # Build with bundle analyzer
```

### Code Quality

```bash
pnpm lint         # Run ESLint
pnpm lint:fix     # Fix linting issues
pnpm format       # Check formatting
pnpm format:fix   # Fix formatting
pnpm check        # Run svelte-check
```

### Testing

```bash
# Unit tests (Vitest)
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # Generate coverage report

# E2E tests (Playwright)
pnpm exec playwright install --with-deps  # First-time setup
pnpm test:e2e          # Run e2e tests
```

## Contributing

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint. Every commit message must follow the format:

```
type(scope): description
```

| Type       | When to use                             | Version bump |
| ---------- | --------------------------------------- | ------------ |
| `feat`     | New feature                             | minor        |
| `fix`      | Bug fix                                 | patch        |
| `docs`     | Documentation only                      | none         |
| `refactor` | Code change that neither fixes nor adds | none         |
| `perf`     | Performance improvement                 | patch        |
| `test`     | Adding or updating tests                | none         |
| `chore`    | Build, CI, tooling changes              | none         |

Scope is optional: `fix(compose): handle pasted recipients` or `fix: handle pasted recipients` are both valid.

To trigger a **major** version bump, add a `BREAKING CHANGE:` footer:

```
feat: redesign settings page

BREAKING CHANGE: settings store schema changed, requires cache clear
```

### Releasing

Releases are cut locally using [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version). It reads commits since the last tag, bumps `package.json`, updates `CHANGELOG.md`, and creates a git tag.

```bash
pnpm release            # auto-detect bump from commits (fix→patch, feat→minor)
pnpm release:minor      # force a minor bump
pnpm release:major      # force a major bump
git push --follow-tags   # push the commit + tag to trigger CI/CD
```

## Configuration

Create a `.env` file to override defaults:

```bash
# API base URL (Vite requires VITE_ prefix for client exposure)
VITE_WEBMAIL_API_BASE=https://api.forwardemail.net
```

## Deployment

> **First time setup?** See the complete [Deployment Checklist](docs/deployment-checklist.md) for step-by-step instructions on Cloudflare, GitHub Actions, and DNS configuration.

### Infrastructure

```mermaid
graph TB
    subgraph Edge["Cloudflare Edge"]
        subgraph Worker["Cloudflare Worker"]
            W1["SPA routing (returns index.html for /mailbox, etc)"]
            W2["Cache headers (immutable for assets, no-cache HTML)"]
        end
        Worker --> R2
        subgraph R2["Cloudflare R2"]
            R2A["Static assets (dist/)"]
            R2B["Fingerprinted bundles (/assets/*.js, *.css)"]
        end
    end
```

### Cache Strategy

| Asset Type                                  | Cache-Control                 | Reason                                       |
| ------------------------------------------- | ----------------------------- | -------------------------------------------- |
| `index.html`, `/mailbox`, `/calendar`, etc. | `no-cache, no-store`          | Always fetch fresh HTML for updates          |
| `/assets/*` (JS, CSS)                       | `immutable, max-age=31536000` | Fingerprinted by Vite, safe to cache forever |
| `sw.js`, `sw-*.js`, `version.json`          | `no-cache, must-revalidate`   | Service worker must check for updates        |
| `/icons/*`                                  | `max-age=2592000`             | 30 days, rarely change                       |
| Fonts (`.woff2`)                            | `immutable, max-age=31536000` | Fingerprinted, cache forever                 |

### CI/CD Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on push to `main` and pull requests:

1. **Install** — `pnpm install --frozen-lockfile`
2. **Lint** — `pnpm lint`
3. **Format** — `pnpm format`
4. **Build** — `pnpm build` (Vite + Workbox service worker)
5. **Deploy to R2** — Sync `dist/` to Cloudflare R2 bucket
6. **Deploy Worker** — Deploy CDN worker for SPA routing + cache headers
7. **Purge Cache** — Clear Cloudflare edge cache

### Required Secrets & Variables

**GitHub Secrets:**

| Secret                 | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `R2_ACCOUNT_ID`        | Cloudflare account ID (also used for Workers)   |
| `R2_ACCESS_KEY_ID`     | R2 API access key                               |
| `R2_SECRET_ACCESS_KEY` | R2 API secret key                               |
| `CLOUDFLARE_ZONE_ID`   | Zone ID for cache purge                         |
| `CLOUDFLARE_API_TOKEN` | API token with R2 + Workers + Cache permissions |

**GitHub Variables:**

| Variable    | Description                      |
| ----------- | -------------------------------- |
| `R2_BUCKET` | R2 bucket name for static assets |

### Cloudflare API Token Setup

Create a token at **My Profile → API Tokens → Create Token → Create Custom Token**:

**Permissions:**

| Scope   | Permission      | Access |
| ------- | --------------- | ------ |
| User    | User Details    | Read   |
| Account | Workers Scripts | Edit   |
| Zone    | Cache Purge     | Purge  |

**Account Resources:**

- Select **Include → Specific account → [Your Account]**
- Or **Include → All accounts** (if you have only one)

**Zone Resources:**

- Select **Include → Specific zone → [Your Domain]**
- Or **Include → All zones**

> ⚠️ **Common mistake:** Setting permissions but leaving Account/Zone Resources as "All accounts from..." dropdown without explicitly selecting. You must click and select your specific account/zone.

### Worker Setup

The CDN worker (`worker/`) handles:

1. **SPA Routing** — Returns `index.html` for navigation requests to `/mailbox`, `/calendar`, `/contacts`, `/login`
2. **Cache Headers** — Sets correct `Cache-Control` per asset type
3. **Security Headers** — `X-Content-Type-Options`, `X-Frame-Options`

After first deployment, configure the custom domain:

1. **Cloudflare Dashboard → Workers & Pages → webmail-cdn**
2. **Settings → Triggers → Add Custom Domain**
3. Enter your domain (e.g., `mail.example.com`)

### Manual Deployment

```bash
# Build the app
pnpm build

# Deploy to R2 (requires AWS CLI configured with R2 credentials)
aws --endpoint-url "https://ACCOUNT_ID.r2.cloudflarestorage.com" \
    s3 sync dist/ "s3://BUCKET_NAME/" --delete

# Deploy worker
cd worker
pnpm install
npx wrangler deploy

# Purge Cloudflare cache
curl -X POST "https://api.cloudflare.com/client/v4/zones/ZONE_ID/purge_cache" \
    -H "Authorization: Bearer API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '{"purge_everything":true}'
```

### Troubleshooting

**Stale assets after deploy:**

- Verify cache purge succeeded in GitHub Actions logs
- Check browser DevTools → Network → Disable cache and refresh
- Users with disk-cached HTML may need to clear browser cache or wait for the fallback recovery UI

**SPA routes return 404:**

- Ensure the worker is deployed and bound to your domain
- Check worker logs: `cd worker && npx wrangler tail`

**Service worker not updating:**

- Check `version.json` is being fetched fresh (no cache)
- Verify `sw.js` has `no-cache` header in Network tab

## License

[Business Source License 1.1](LICENSE.md) - Forward Email LLC
