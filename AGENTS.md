# Repository Guidelines

This repository contains the Forward Email Webmail client, a client-only PWA built with Svelte 5 and Vite 5. It ships as static assets and runs entirely in the browser.

## Prerequisites

- Node.js 20+
- pnpm 9.0.0+

## Project Structure

```
src/
├── main.ts                 # App bootstrap, routing, service worker registration
├── config.ts               # Environment configuration (VITE_ vars)
├── stores/                 # Svelte stores (state management)
│   ├── mailboxStore.ts     # Message list, folders, threading, bulk operations
│   ├── mailboxActions.ts   # Actions: move, delete, flag, label
│   ├── messageStore.ts     # Selected message, body, attachments
│   ├── conversationStore.ts # Thread grouping and conversation selection
│   ├── searchStore.ts      # Search queries and index health
│   ├── settingsStore.ts    # User preferences, theme, PGP keys, labels
│   ├── folderStore.ts      # Folder list and expansion state
│   └── viewStore.ts        # UI state (sidebar, filters, sorting)
├── svelte/                 # Svelte components (views)
│   ├── Mailbox.svelte      # Main email interface
│   ├── Compose.svelte      # Email composer with TipTap editor
│   ├── Calendar.svelte     # Calendar with schedule-x
│   ├── Contacts.svelte     # Contact management
│   ├── Settings.svelte     # User preferences
│   └── components/         # Reusable Svelte components
├── workers/                # Web Workers (background processing)
│   ├── db.worker.ts        # IndexedDB owner (Dexie), all DB operations
│   ├── sync.worker.ts      # API sync, message parsing, normalization
│   └── search.worker.ts    # FlexSearch indexing and queries
├── utils/                  # Utilities
│   ├── remote.js           # API client (ky wrapper)
│   ├── db.js               # Database initialization
│   ├── storage.js          # LocalStorage (multi-account)
│   ├── threading.ts        # Thread grouping algorithm
│   └── ...                 # Many more utilities
├── lib/components/ui/      # UI component library (shadcn/ui + bits-ui)
├── styles/                 # CSS (Tailwind + custom)
├── locales/                # i18n translations
└── types/                  # TypeScript definitions

tests/
├── e2e/                    # Playwright specs (*.spec.js)
├── unit/                   # Vitest specs
└── fixtures/               # Test data

docs/                       # Architecture documentation
public/                     # Static assets (manifest, icons, fonts)
```

## Commands

```bash
# Development
pnpm install              # Install dependencies
pnpm dev                  # Start dev server (http://localhost:5174)
pnpm build                # Build to dist/ + generate service worker
pnpm preview              # Preview production build locally
pnpm analyze              # Build with bundle size analyzer

# Code Quality
pnpm lint                 # Run ESLint
pnpm lint:fix             # Auto-fix linting issues
pnpm format               # Check Prettier formatting
pnpm format:fix           # Auto-format code
pnpm check                # Run svelte-check (type diagnostics)

# Testing
pnpm test                 # Auto-fix lint+format, then run unit tests
pnpm test:unit            # Run unit tests only (fast, no lint/format)
pnpm test:watch           # Watch mode
pnpm test:coverage        # Generate coverage report
pnpm test:e2e             # Run e2e tests (Playwright)
```

## Coding Style

- **Formatting**: Prettier enforced (`singleQuote`, `semi`, `trailingComma`, `printWidth: 100`)
- **Linting**: ESLint flat config (`eslint.config.js`)
- **Module System**: ESM only (`"type": "module"` in package.json)
- **Naming**: camelCase for variables, PascalCase for components/classes
- **Unused Variables**: Prefix with `_` to indicate intentional (e.g., `_unused`)

## Testing Guidelines

- **Unit tests**: Vitest with jsdom environment
  - Place specs alongside modules or in `tests/unit/`
  - Use `.spec.ts` or `.spec.js` extension

- **E2E tests**: Playwright
  - Specs live in `tests/e2e/*.spec.js`
  - First run: `pnpm exec playwright install --with-deps`
  - Include happy path + at least one edge case for new UI flows

## Commit Guidelines

Follow Conventional Commits:

```
feat: add new feature
fix: resolve bug
chore: maintenance task
docs: documentation update
refactor: code restructure
test: add or update tests
```

Examples from history:

- `fix: label ui updates, tooltip locations and toast tweaks`
- `chore: css cleanup`
- `feat: contacts editing and search bar UX`

## Pull Request Guidelines

- Include clear description of changes
- Link related issues if applicable
- Add screenshots for UI changes
- Run `pnpm test` locally before pushing (auto-fixes lint+format, then runs unit tests)
- For fast TDD loops use `pnpm test:unit` (skips lint/format)
- Ensure CI passes (lint, format, test:unit, build)

## Configuration

Client-exposed environment variables must use `VITE_` prefix:

```bash
# .env (local only, not committed)
VITE_WEBMAIL_API_BASE=https://api.forwardemail.net
```

## Architecture Notes

### State Management

- Svelte stores are the single source of truth
- Use `get(store)` in actions, `$store` in reactive contexts
- Derived stores for computed values
- Actions should go through store action functions, not direct `.set()` calls

### Worker Communication

- Workers use message-passing (postMessage/onmessage)
- db.worker owns IndexedDB exclusively to prevent conflicts
- sync.worker handles API calls and data normalization
- search.worker manages FlexSearch indexing

### Performance Considerations

- Use bulk operations for multiple items (bulkMoveMessages, bulkDeleteMessages)
- Debounce frequent operations (search, filters)
- Batch database writes when possible
- Use optimistic UI updates with rollback on failure

## Key Files to Understand

1. `src/main.ts` — App bootstrap and routing
2. `src/stores/mailboxStore.ts` — Core message list orchestration
3. `src/svelte/Mailbox.svelte` — Main UI (largest component)
4. `src/workers/db.worker.ts` — Database schema and operations
5. `src/workers/sync.worker.ts` — API sync logic
6. `docs/worker-architecture.md` — Worker design documentation
