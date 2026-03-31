#!/usr/bin/env bash
# Detect stale Cargo build cache caused by project directory rename/move.
# Only runs `cargo clean` when necessary — checks if any cached build
# script output references a different project root than the current one.

set -euo pipefail

TAURI_DIR="$(cd "$(dirname "$0")/../src-tauri" && pwd)"
TARGET_DIR="$TAURI_DIR/target"

# Skip if no target directory exists (fresh build)
if [ ! -d "$TARGET_DIR" ]; then
  exit 0
fi

# Look for build-script output files that reference a wrong project root.
# Tauri's build script writes absolute paths into `output` files inside
# target/debug/build/*/. If any of those paths don't start with the
# current src-tauri directory, the cache is stale.
STALE=false
for output_file in "$TARGET_DIR"/debug/build/*/output; do
  [ -f "$output_file" ] || continue
  while IFS= read -r line; do
    case "$line" in
      cargo:rerun-if-changed=/*)
        path_value="${line#cargo:rerun-if-changed=}"
        # If it's an absolute path outside our tree and not a system path, cache is stale
        if [ "${path_value#"$TAURI_DIR"}" = "$path_value" ] \
          && [ "${path_value#/usr}" = "$path_value" ] \
          && [ "${path_value#/tmp}" = "$path_value" ] \
          && [ "${path_value#/nix}" = "$path_value" ] \
          && [ "${path_value#/opt}" = "$path_value" ]; then
          STALE=true
          break 2
        fi
        ;;
    esac
  done < "$output_file"
done

if [ "$STALE" = true ]; then
  echo "⚠️  Stale Cargo build cache detected (project was moved/renamed)."
  echo "   Running 'cargo clean' to rebuild with correct paths..."
  cd "$TAURI_DIR" && cargo clean
  echo "   ✅ Cache cleaned. Build will proceed with fresh compilation."
fi
