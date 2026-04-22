/**
 * Path Safety
 *
 * When the model asks to read or grep inside a registered repository, it
 * supplies a relative path. We MUST reject anything that could escape the
 * repo root — absolute paths, `..` components, drive letters, weird
 * separators. This module is the single place that decision lives.
 *
 * We do not call into the filesystem here — no symlink resolution, no stat
 * — that belongs in the tool layer on top of `tauri-plugin-fs`. This module
 * is pure string manipulation so it can be unit-tested without a real FS.
 */

export class PathSafetyError extends Error {
  readonly code:
    | 'absolute_path'
    | 'parent_traversal'
    | 'drive_letter'
    | 'null_byte'
    | 'empty'
    | 'not_utf8';
  constructor(code: PathSafetyError['code'], message: string) {
    super(message);
    this.name = 'PathSafetyError';
    this.code = code;
  }
}

/**
 * Normalize a path-fragment supplied by the model. Rejects anything the
 * caller must never pass on to the filesystem. Returns the normalized
 * relative path (always using forward slashes) on success.
 *
 * The returned path is guaranteed:
 *   - non-empty
 *   - relative (no leading slash)
 *   - no `..` components
 *   - no drive letters (Windows safety)
 *   - no null bytes
 *   - no backslashes (normalized to forward slashes)
 */
export const normalizeRelativePath = (raw: string): string => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new PathSafetyError('empty', 'path is empty');
  }
  if (raw.includes('\0')) {
    throw new PathSafetyError('null_byte', 'path contains null byte');
  }
  // Reject UNC / Windows absolute ("C:\..." or "\\server\...")
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new PathSafetyError('drive_letter', 'Windows drive letter is not allowed');
  }

  const forward = raw.replace(/\\/g, '/');

  if (forward.startsWith('/')) {
    throw new PathSafetyError('absolute_path', 'absolute paths are not allowed');
  }

  const parts = forward.split('/').filter((p) => p.length > 0 && p !== '.');
  for (const part of parts) {
    if (part === '..') {
      throw new PathSafetyError('parent_traversal', 'parent-directory segments are not allowed');
    }
  }

  if (parts.length === 0) {
    throw new PathSafetyError('empty', 'path resolves to empty after normalization');
  }

  return parts.join('/');
};

/**
 * Compose a safe absolute path for reading inside a repository root. Given
 * a root path (trusted, set by the user at repo registration) and a
 * relative path (untrusted, supplied by the model), returns the full path
 * ready to hand to `tauri-plugin-fs.readTextFile`.
 *
 * Still not enough on its own — the tool layer must ALSO check that the
 * resolved file, after symlink resolution, is still inside `rootAbsolute`.
 * That check requires the real FS and lives in the tool.
 */
export const resolveSafePath = (rootAbsolute: string, relative: string): string => {
  const normalizedRelative = normalizeRelativePath(relative);
  const normalizedRoot = rootAbsolute.replace(/[\\/]+$/g, '');
  // Forward-slashes are accepted on every platform `tauri-plugin-fs` targets.
  return `${normalizedRoot}/${normalizedRelative}`;
};

/**
 * Check whether a resolved path (after FS resolution, e.g. after readlink)
 * is still within the repo root. Both inputs should be absolute, normalized.
 * Used by tools as the second gate alongside `resolveSafePath`.
 */
export const isWithinRoot = (resolvedAbsolute: string, rootAbsolute: string): boolean => {
  const r = resolvedAbsolute.replace(/\\/g, '/').replace(/\/+$/g, '');
  const root = rootAbsolute.replace(/\\/g, '/').replace(/\/+$/g, '');
  return r === root || r.startsWith(`${root}/`);
};
