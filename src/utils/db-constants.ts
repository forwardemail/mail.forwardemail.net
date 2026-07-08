const isDev = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV;

// Storage generation. Drives the database NAME (webmail-cache-v1) and must
// match public/sw-sync.js. Bumping it points the app at a brand-new, empty
// database, so it should only change when a truly incompatible layout ships.
export const SCHEMA_VERSION = 1;

// Dexie's internal schema version for in-place upgrades (index changes and
// the like) within the same database. Bumping this migrates existing data
// where it lives; nothing re-syncs. History lives in db-engine.ts.
export const DEXIE_VERSION = 2;
const baseName = isDev ? 'webmail-cache-dev' : 'webmail-cache';
let devSuffix = '';
if (isDev) {
  try {
    devSuffix = localStorage.getItem('webmail_db_suffix') || '';
  } catch {
    devSuffix = '';
  }
}
const suffix = devSuffix ? `-${devSuffix}` : '';
export const DB_NAME = `${baseName}-v${SCHEMA_VERSION}${suffix}`;

// HMR: When db-constants changes (especially SCHEMA_VERSION), force a full page reload
// Workers can't be hot-reloaded - they need to be recreated with new bundled code
// A full reload ensures workers get the new schema version
if (import.meta.hot && typeof window !== 'undefined') {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
