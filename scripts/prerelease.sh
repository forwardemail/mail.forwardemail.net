#!/usr/bin/env bash
set -euo pipefail

# ── Pre-release guard ────────────────────────────────────────────────
# Runs automatically before `pnpm release` (via the npm "prerelease"
# lifecycle hook).  Ensures the local checkout is fully synced with
# the remote so that `np` never bumps from a stale version.
#
# Without this, a user who forgot `git pull && git fetch --tags` could
# accidentally create a duplicate version tag (e.g. two "0.9.5" bumps
# from different machines).  np's own tag-existence check is skipped
# when `publish: false`.
# ─────────────────────────────────────────────────────────────────────

echo "🔄 Pre-release: syncing with remote..."

# 1. Ensure we're on the main branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo "❌ Error: must be on the main branch (currently on '$BRANCH')."
  exit 1
fi

# 2. Ensure working tree is clean (allow untracked files)
if [ -n "$(git diff --cached --name-only)" ] || [ -n "$(git diff --name-only)" ]; then
  echo "❌ Error: working tree has uncommitted changes. Commit or stash first."
  exit 1
fi

# 3. Pull latest commits so package.json has the current version
git pull --rebase origin main

# 4. Fetch all tags (after pull so we have the latest commit history)
git fetch --tags --force origin

# 5. Verify local package.json version matches the latest tag
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")

# Strip the 'v' prefix from the tag for comparison
LATEST_TAG_VERSION="${LATEST_TAG#v}"

if [ "$LATEST_TAG" != "none" ] && [ "$CURRENT_VERSION" != "$LATEST_TAG_VERSION" ]; then
  echo "⚠️  Warning: package.json version ($CURRENT_VERSION) differs from latest tag ($LATEST_TAG)."
  echo "   This may indicate the local checkout is out of sync."
  echo "   Continuing anyway — np will determine the correct next version."
fi

echo "✅ Pre-release: local checkout is synced (version: $CURRENT_VERSION, latest tag: $LATEST_TAG)"
