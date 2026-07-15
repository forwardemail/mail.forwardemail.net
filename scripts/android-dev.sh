#!/usr/bin/env bash
# Start Android development environment in one step.
# Sets up env vars, adb port forwarding, and launches tauri android dev.

set -euo pipefail

# ── Android SDK/NDK environment ────────────────────────────────────────────
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || echo '')}"

# Auto-detect NDK version (use latest installed)
if [ -z "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_HOME/ndk" ]; then
  NDK_VERSION=$(ls -1 "$ANDROID_HOME/ndk" | sort -V | tail -1)
  if [ -n "$NDK_VERSION" ]; then
    export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$NDK_VERSION"
  fi
fi

# ── Preflight checks ──────────────────────────────────────────────────────
MISSING=""
[ ! -d "$ANDROID_HOME" ] && MISSING="$MISSING\n  - Android SDK not found at $ANDROID_HOME"
[ -z "$JAVA_HOME" ] && MISSING="$MISSING\n  - JDK 17 not found (install via: brew install openjdk@17)"
[ -z "${ANDROID_NDK_HOME:-}" ] && MISSING="$MISSING\n  - Android NDK not found in $ANDROID_HOME/ndk/"
if ! command -v adb &>/dev/null; then
  MISSING="$MISSING\n  - adb not found (install Android SDK Platform Tools)"
fi

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

echo "📱 Android Dev Environment"
echo "   SDK:   $ANDROID_HOME"
echo "   NDK:   $ANDROID_NDK_HOME"
echo "   JDK:   $JAVA_HOME"
echo "   Push:  $ANDROID_PUSH_PROVIDER"

# ── adb reverse for emulator ──────────────────────────────────────────────
# The Vite dev server runs on localhost:5174 on the host.
# Android emulators can't reach host localhost — adb reverse tunnels it.
VITE_PORT="${VITE_PORT:-5174}"

if adb devices 2>/dev/null | grep -q "emulator"; then
  echo "   🔗 Setting up adb reverse tcp:$VITE_PORT for emulator..."
  adb reverse "tcp:$VITE_PORT" "tcp:$VITE_PORT" 2>/dev/null || true
fi

# ── Uninstall stale APK if version downgrade ──────────────────────────────
# Prevents INSTALL_FAILED_VERSION_DOWNGRADE errors
if adb devices 2>/dev/null | grep -q "device$\|emulator"; then
  INSTALLED_VERSION=$(adb shell dumpsys package net.forwardemail.mail 2>/dev/null | grep versionCode | head -1 | sed 's/[^0-9]//g' || echo "0")
  if [ "${INSTALLED_VERSION:-0}" -gt 1 ]; then
    echo "   🗑️  Removing old APK (versionCode=$INSTALLED_VERSION) to avoid downgrade error..."
    adb uninstall net.forwardemail.mail 2>/dev/null || true
  fi
fi

# ── Generated-project integration ──────────────────────────────────────────
ANDROID_MANIFEST="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
if [ ! -f "$ANDROID_MANIFEST" ]; then
  echo "   🏗️  Initializing generated Android project..."
  npx tauri android init
fi

node scripts/inject-android-mainactivity.cjs
node scripts/configure-android-push.cjs

# ── Launch ─────────────────────────────────────────────────────────────────
echo "   🚀 Starting tauri android dev..."
echo ""
npx tauri android dev "${FEATURE_ARGS[@]}" "$@"
