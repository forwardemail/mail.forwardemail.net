#!/usr/bin/env bash
set -euo pipefail

# Release script for the desktop (Tauri) app.
# Bumps version in tauri.conf.json + Cargo.toml, commits, tags, and pushes.
#
# Usage: pnpm release:desktop [patch|minor|major|<version>]
#   patch  — 0.0.1 -> 0.0.2
#   minor  — 0.0.1 -> 0.1.0
#   major  — 0.0.1 -> 1.0.0
#   0.2.0  — set exact version

TAURI_CONF="src-tauri/tauri.conf.json"
CARGO_TOML="src-tauri/Cargo.toml"

# Ensure clean working tree (allow untracked files)
if [ -n "$(git diff --cached --name-only)" ] || [ -n "$(git diff --name-only)" ]; then
  echo "Error: working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

# Ensure we're on main
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "Error: must be on main branch (currently on $BRANCH)."
  exit 1
fi

# Read current version from tauri.conf.json
CURRENT=$(node -e "console.log(require('./$TAURI_CONF').version)")
echo "Current desktop version: $CURRENT"

# Parse current version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# Determine new version
BUMP="${1:-}"
if [ -z "$BUMP" ]; then
  echo "Usage: pnpm release:desktop [patch|minor|major|<version>]"
  exit 1
fi

case "$BUMP" in
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  *)
    # Validate semver format
    if ! echo "$BUMP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      echo "Error: invalid version '$BUMP'. Use patch, minor, major, or a semver string (e.g. 1.0.0)."
      exit 1
    fi
    NEW_VERSION="$BUMP"
    ;;
esac

echo "Bumping desktop version: $CURRENT -> $NEW_VERSION"

# Update tauri.conf.json
node -e "
const fs = require('fs');
const conf = JSON.parse(fs.readFileSync('$TAURI_CONF', 'utf8'));
conf.version = '$NEW_VERSION';
fs.writeFileSync('$TAURI_CONF', JSON.stringify(conf, null, 2) + '\n');
"

# Update Cargo.toml version (first version = line under [package])
sed -i.bak -E '0,/^version = ".*"$/s/^version = ".*"$/version = "'"$NEW_VERSION"'"/' "$CARGO_TOML"
rm -f "$CARGO_TOML.bak"

# Verify both files match
TAURI_VER=$(node -e "console.log(require('./$TAURI_CONF').version)")
CARGO_VER=$(grep -m1 '^version' "$CARGO_TOML" | sed 's/version = "\(.*\)"/\1/')

if [ "$TAURI_VER" != "$NEW_VERSION" ] || [ "$CARGO_VER" != "$NEW_VERSION" ]; then
  echo "Error: version mismatch after update."
  echo "  tauri.conf.json: $TAURI_VER"
  echo "  Cargo.toml:      $CARGO_VER"
  echo "  Expected:        $NEW_VERSION"
  exit 1
fi

TAG="desktop-v$NEW_VERSION"

# Commit and tag
git add "$TAURI_CONF" "$CARGO_TOML"
git commit -m "chore(release): desktop $NEW_VERSION"
git tag -a "$TAG" -m "Desktop release $NEW_VERSION"

echo ""
echo "Created commit and tag: $TAG"
echo ""
echo "To trigger the release pipeline:"
echo "  git push origin main $TAG"
