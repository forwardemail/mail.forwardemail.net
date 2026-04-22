/**
 * Repository configuration.
 *
 * A Repository is a local git working directory the user has registered with
 * the app so the AI can grep/read it when drafting support replies. Registration
 * lives in the `meta` Dexie table under `ai:repo:{id}` keys.
 *
 * Paths are stored as-entered (platform-native). Path safety is enforced on
 * every access via `resolveSafePath` — we never trust the path at storage
 * time; we resolve and validate when the AI actually asks to read.
 */

export interface RepositoryConfig {
  /** Stable id (slugified label). Also the `ai:repo:{id}` meta key suffix. */
  id: string;
  /** Short display label ("acme-backend"). Shown in Settings + the repo chip. */
  label: string;
  /**
   * Absolute path to the repository root. Users select this via the folder
   * picker; we validate the path exists and is a directory at registration.
   */
  path: string;
  /**
   * Optional hints for which threads the AI should pair with this repo.
   * Free-form substrings matched against `from` addresses / subjects during
   * thread→repo auto-suggestion (future). Not used for access control.
   */
  associations?: {
    senders?: string[];
    domains?: string[];
  };
  createdAt: number;
  updatedAt: number;
}

export interface RepositorySummary {
  id: string;
  label: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}
