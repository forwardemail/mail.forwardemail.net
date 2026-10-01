# Clear-Site-Data: Client Reset Kill Switch

## Quick Reference

**What it does:** Forces all clients below a version threshold to wipe IndexedDB, SW caches, and web storage, then reload with fresh assets.

**When to use it:** Any situation where clients can't self-recover, such as a bad service worker deploy, a broken DB schema, or a corrupted cache.

**How to trigger a reset:**

Edit `public/clear-manifest.json`:

```json
{
  "version": "0.0.2",
  "clear_below": "0.0.2"
}
```

This forces every client running a version below `0.0.2` to clear everything and reload. Set `clear_below` to `null` to disable.

**How to revert:** Set `clear_below` back to `null` and deploy. Clients that already cleared are unaffected (they're on the new version). Clients that haven't loaded yet won't clear.

**What gets cleared:**

| Target         | What's wiped                                        |
| -------------- | --------------------------------------------------- |
| IndexedDB      | All databases (message cache, search index, drafts) |
| SW caches      | All Workbox precache + runtime caches               |
| Service worker | Unregistered (fresh SW installs on reload)          |
| localStorage   | Cleared (settings, preferences)                     |
| sessionStorage | Cleared (tab-scoped state)                          |
| Cookies        | **Not touched** (auth sessions preserved)           |

**CI safety net:** On every PR, CI checks if changed files match patterns in `.clear-site-data.json`. If they do, it posts a warning comment reminding you to consider updating the manifest.

**Files involved:**

| File                                   | Purpose                                           |
| -------------------------------------- | ------------------------------------------------- |
| `public/clear-manifest.json`           | The manifest. Edit this to trigger/disable clears |
| `src/main.ts` → `checkClearManifest()` | Boot check, runs before any DB/store init         |
| `.clear-site-data.json`                | Maps file patterns to clear targets (used by CI)  |
| `scripts/check-clear-manifest.js`      | CI script that warns on PRs                       |
| `workbox.config.cjs`                   | Excludes manifest from SW precache                |

---

## How It Works

### Boot Check

`checkClearManifest()` in `src/main.ts` runs at the top of `bootstrap()`, before any database or store initialization:

1. Fetches `/clear-manifest.json` with `cache: 'no-store'` (bypasses HTTP cache)
2. Reads `clear_below` from the manifest
3. Compares the client's `VITE_PKG_VERSION` (semver, e.g. `0.0.1`) against the threshold
4. If the client is below the threshold:
   - Deletes all IndexedDB databases (with Safari fallback for `indexedDB.databases()`)
   - Deletes all SW caches via `caches.keys()` + `caches.delete()`
   - Unregisters the service worker
   - Clears localStorage and sessionStorage
   - Calls `window.location.reload()`
5. If the fetch fails or `clear_below` is `null`, the app boots as usual

### Why It Doesn't Loop

After clearing and reloading, the browser fetches fresh assets from the CDN (Cloudflare cache is purged on every deploy). The fresh JS bundle has the current `VITE_PKG_VERSION` baked in at build time. Since the current version is >= `clear_below`, the check passes through. No `cleared_at` tracking needed.

### Service Worker Isolation

The manifest is excluded from the service worker's control:

- **`globIgnores`** in `workbox.config.cjs` prevents precaching `clear-manifest.json`
- **`navigateFallbackDenylist`** includes `/clear-manifest\.json$/` so the SW won't serve `index.html` for it
- **`cache: 'no-store'`** on the fetch request bypasses the HTTP cache

Even a broken SW won't intercept the manifest fetch. Combined with `updateViaCache: 'none'` on SW registration, the browser always checks for a fresh SW file and the manifest is always fetched from the network.

### CDN Cache

CI purges the entire Cloudflare cache on every deploy to main, so the edge serves the new `clear-manifest.json` immediately after deploy with no stale copies.

---

## CI Warning System

### Impact Map

`.clear-site-data.json` in the repo root maps file patterns to clear targets:

```json
{
  "triggers": {
    "cache": ["public/sw-sync.js", "workbox.config.cjs", "src/workers/sync.worker.ts"],
    "storage": [
      "src/utils/db-constants.ts",
      "src/utils/db.js",
      "src/utils/db-recovery.js",
      "src/workers/db.worker.ts"
    ]
  }
}
```

- **`cache` triggers**: files that affect SW behavior or cache strategy
- **`storage` triggers**: files that affect IndexedDB schema or database recovery

### PR Check

On every pull request, CI runs `scripts/check-clear-manifest.js` which:

1. Diffs changed files between the PR branch and the base branch
2. Matches against glob patterns in `.clear-site-data.json`
3. If any match, posts a PR comment:

```
## Clear-Site-Data Warning

The following changes may require updating `public/clear-manifest.json`.
If this release changes DB schema, service worker behavior, or cache strategy,
set `clear_below` to the current version to force client resets.

### Target: `storage`
- `src/utils/db-constants.ts`
```

The check uses `continue-on-error: true`, so it warns but never blocks the build. Existing comments are updated rather than duplicated.

### Manual Override

When automation underfires (refactors, renames, generated files that don't match patterns), edit `clear-manifest.json` by hand in the same PR. The CI warning is advisory; you can trigger a reset without it.

---

## Runbook

### Triggering a Reset

1. Decide the version threshold, typically the version you're about to release
2. Edit `public/clear-manifest.json`:
   ```json
   {
     "_docs": "Kill switch for bad releases. Set clear_below to a semver version to force all older clients to wipe local data and reload. Set to null to disable. See docs/clear-site-data-spec.md",
     "version": "0.0.2",
     "clear_below": "0.0.2"
   }
   ```
3. Commit and deploy to main
4. All clients below `0.0.2` will clear on their next page load

### Emergency Reset (post-deploy)

If a bad release is already live and you need to force resets for clients on that version:

1. Bump the version in `package.json`
2. Set `clear_below` to the new version
3. Push to main. CI builds, deploys, and purges CDN cache
4. Clients on the bad version clear and reload with the fix

### Disabling

Set `clear_below` to `null` and deploy:

```json
{
  "version": "0.0.2",
  "clear_below": null
}
```

### Verifying

After deploying a reset, check browser dev tools console for:

```
[clear-manifest] Client version 0.0.1 is below 0.0.2 — clearing site data
```

If you don't see this, check:

- Is the manifest being served fresh? (`curl -I https://your-domain/clear-manifest.json`)
- Is the SW intercepting it? (check Network tab: should show `(disk cache)` or network, not SW)
- Is `VITE_PKG_VERSION` correct in the build? (check `import.meta.env.VITE_PKG_VERSION` in console)

---

## Threat Model

### Threats

**T1. False positive: accidental mass data wipe**

Innocent refactor touches a trigger file, someone bumps `clear_below` without understanding impact. **Impact:** users lose offline data, drafts, cached settings. **Mitigations:** CI posts PR warnings when trigger files change; `clear_below` change is visible in PR diff; data re-syncs from server after clear. **Residual risk:** medium (human error), but auditable and reversible.

**T2. False negative: missed clear, unrecoverable client**

DB schema change in an unmapped file. No CI warning, no one updates the manifest, clients brick. **Impact:** silent breakage, support tickets. **Mitigations:** directory-based globs in `.clear-site-data.json`, periodic audit of IndexedDB usage vs. impact map, manual override always available. **Residual risk:** medium. That matches the status quo today, and this system strictly improves on it.

**T3. Infinite reload loop**

Client clears, reloads, clears again. **Impact:** app unusable. **Why it can't happen:** after clearing, the reload fetches fresh assets with the current `VITE_PKG_VERSION` baked in. Current version >= `clear_below`, check passes. A loop would need the CDN to serve stale JS after the manifest, and the CI pipeline purges the entire Cloudflare cache atomically.

**T4. Malicious manifest injection**

Attacker compromises R2 bucket, deploys `{ "clear_below": "999.0.0" }`. All users lose local data. **Impact:** data loss (but recoverable from server). **Mitigations:** R2 write access restricted to CI via scoped API credentials; manifest is a static JSON file, not executable; auth cookies preserved so users stay logged in. **Residual risk:** low if infra credentials are secured.

**T5. Broken SW blocks manifest fetch**

Old SW intercepts `/clear-manifest.json` and serves stale copy. **Impact:** recovery never triggers. **Mitigations:** manifest excluded from SW precache via `globIgnores`; excluded from `navigateFallback` via denylist; fetched with `cache: 'no-store'`; SW registered with `updateViaCache: 'none'` so browser always checks for fresh SW. **Residual risk:** very low.

**T6. Race during deploy**

User has tab open, CDN serves new manifest before new JS assets. Boot check runs with old `VITE_PKG_VERSION`, triggers clear. **Impact:** user loses local data on next page load, which is the intended behavior. The clear is correct; the client needs the new version. Active sessions are unaffected (check only runs on page load, not mid-session).

### Risk Profile

| Category                          | Risk                             |
| --------------------------------- | -------------------------------- |
| Data loss (false positive)        | Medium: auditable and reversible |
| Availability (reload loops)       | Very low                         |
| Security compromise               | Low                              |
| Operational error                 | Medium: mitigated by CI warnings |
| Recovery failure (false negative) | Much lower than status quo       |

---

## Future Considerations

None of these are implemented. They are recorded for when the simple approach proves insufficient.

**Granular targets:** instead of clearing everything, clear only cache or only storage based on what changed. Would require a `targets` field in the manifest and conditional clearing in `checkClearManifest()`.

**Version ranges:** instead of a single `clear_below`, support multiple ranges for cumulative clears across releases. Would require a `ranges` array and semver comparison logic.

**Cloudflare Worker (Option B):** if a broken SW ever prevents the client-side check from running, a thin Cloudflare Worker could read a version cookie and inject a `Clear-Site-Data` HTTP header at the edge, bypassing all client-side code.

**Manifest signing:** embed a SHA256 hash of the manifest in the build to detect tampering. The boot check would verify the hash before acting on the manifest.

**Automated manifest updates:** have CI set `clear_below` when trigger files change, removing the manual step. Deferred because, at current release velocity, the manual step works as a safety check.
