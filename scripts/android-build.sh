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

ANDROID_PUSH_PROVIDER="${ANDROID_PUSH_PROVIDER:-unified-push}"
case "$ANDROID_PUSH_PROVIDER" in
  unified-push)
    export VITE_ANDROID_PUSH_PROVIDER="unified-push"
    FEATURE_ARGS=()
    ;;
  fcm)
    export VITE_ANDROID_PUSH_PROVIDER="fcm"
    FEATURE_ARGS=(--features fcm)
    ;;
  both)
    export VITE_ANDROID_PUSH_PROVIDER="auto"
    FEATURE_ARGS=(--features fcm)
    ;;
  *)
    echo "Invalid ANDROID_PUSH_PROVIDER: $ANDROID_PUSH_PROVIDER (expected unified-push, fcm, or both)" >&2
    exit 1
    ;;
esac
export ANDROID_PUSH_PROVIDER

FCM_CAPABILITY="src-tauri/capabilities/android-fcm.generated.json"
trap 'rm -f "$FCM_CAPABILITY"' EXIT

echo "📦 Android Build"
echo "   SDK:   $ANDROID_HOME"
echo "   NDK:   $ANDROID_NDK_HOME"
echo "   Push:  $ANDROID_PUSH_PROVIDER"
echo ""

# ── Configure generated-project integrations ──────────────────────────────
# These scripts modify src-tauri/gen/android/ after `tauri android init`
# regenerates it. They are idempotent and safe to re-run.
node scripts/configure-android-push.cjs
node scripts/configure-mobile-display-name.cjs
node scripts/inject-android-signing.cjs
node scripts/inject-android-mainactivity.cjs

npx tauri android build "${FEATURE_ARGS[@]}" "$@"
