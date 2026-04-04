#!/usr/bin/env bash
# Build Android APK/AAB with proper environment setup.

set -euo pipefail

# ── Android SDK/NDK environment ────────────────────────────────────────────
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || echo '')}"

if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
  NDK_VERSION=$(ls -1 "$ANDROID_HOME/ndk" | sort -V | tail -1)
  if [ -n "$NDK_VERSION" ]; then
    export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
  fi
fi

# ── Preflight checks ──────────────────────────────────────────────────────
MISSING=""
[ ! -d "$ANDROID_HOME" ] && MISSING="$MISSING\n  - Android SDK not found at $ANDROID_HOME"
[ -z "$JAVA_HOME" ] && MISSING="$MISSING\n  - JDK 17 not found"
[ -z "${ANDROID_NDK_HOME:-}" ] && MISSING="$MISSING\n  - Android NDK not found"

if [ -n "$MISSING" ]; then
  echo "❌ Missing prerequisites:$MISSING"
  exit 1
fi

echo "📦 Android Build"
echo "   SDK:  $ANDROID_HOME"
echo "   NDK:  $ANDROID_NDK_HOME"
echo ""

exec npx tauri android build "$@"
