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
cleanup() {
  rm -f "$FCM_CAPABILITY"
  if [ -n "${REVERSE_KEEPALIVE_PID:-}" ]; then
    kill "$REVERSE_KEEPALIVE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "📱 Android Dev Environment"
echo "   SDK:   $ANDROID_HOME"
echo "   NDK:   $ANDROID_NDK_HOME"
echo "   JDK:   $JAVA_HOME"
echo "   Push:  $ANDROID_PUSH_PROVIDER"

# ── adb reverse ───────────────────────────────────────────────────────────
# The Vite dev server runs on localhost:5174 on the host, and devUrl points at
# that same localhost address. `adb reverse` is what makes it resolve on the
# device, for phones over USB as well as emulators (it needs API 21+; we
# require 24).
#
# This also decides whether the webview gets a SECURE CONTEXT. A localhost
# origin is treated as potentially trustworthy; the LAN address the CLI falls
# back to is not, and getUserMedia (so QR pairing) is blocked there.
VITE_PORT="${VITE_PORT:-5174}"

DEVICE_SERIALS=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}')
if [ -n "$DEVICE_SERIALS" ]; then
  for serial in $DEVICE_SERIALS; do
    if adb -s "$serial" reverse "tcp:$VITE_PORT" "tcp:$VITE_PORT" >/dev/null 2>&1; then
      echo "   🔗 adb reverse tcp:$VITE_PORT → $serial"
    else
      echo "   ⚠️  adb reverse failed on $serial; the webview may load a LAN address,"
      echo "      which is not a secure context (camera / QR pairing will not work)."
    fi
  done
else
  echo "   ⚠️  No connected device found for adb reverse."
fi

# The tunnel lives only as long as the adb transport. A wifi roam, the phone
# sleeping, or any reconnect silently drops it, and the webview then cannot
# reach the dev server at all, which looks like a blank screen followed by the
# "unable to load app" modal with nothing wrong on the host side. Re-assert it
# for the life of the session; `adb reverse` is idempotent and cheap.
#
# The serial list is re-read on every pass rather than captured once: a
# wireless-debugging phone reconnects under a NEW ip:port or mdns serial after
# a roam, and an emulator tauri boots itself is not attached at startup at all.
# A snapshot list would keep tunnelling a dead serial while the live device has
# none, recreating the exact silent failure this loop exists to prevent.
(
  while true; do
    sleep 5
    for serial in $(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}'); do
      adb -s "$serial" reverse "tcp:$VITE_PORT" "tcp:$VITE_PORT" >/dev/null 2>&1 || true
    done
  done
) &
REVERSE_KEEPALIVE_PID=$!
echo "   ♻️  Keeping the reverse tunnel alive (pid $REVERSE_KEEPALIVE_PID)"

# ── Uninstall stale APK if version downgrade ──────────────────────────────
# Prevents INSTALL_FAILED_VERSION_DOWNGRADE errors.
#
# Every adb call is pinned with -s. Wireless debugging routinely leaves the
# same phone attached twice (a USB transport and a TCP one), and a bare
# `adb shell` then fails with "more than one device/emulator". Because stderr
# is discarded here, that failure is silent: the probe returns empty, the guard
# below decides there is nothing to remove, and the install fails later with
# the exact downgrade error this block exists to prevent.
for serial in ${DEVICE_SERIALS:-}; do
  INSTALLED_VERSION=$(adb -s "$serial" shell dumpsys package net.forwardemail.mail 2>/dev/null | grep versionCode | head -1 | sed 's/[^0-9]//g' || echo "0")
  if [ "${INSTALLED_VERSION:-0}" -gt 1 ]; then
    echo "   🗑️  Removing old APK (versionCode=$INSTALLED_VERSION) from $serial..."
    adb -s "$serial" uninstall net.forwardemail.mail >/dev/null 2>&1 || true
  fi
done

# ── Generated-project integration ──────────────────────────────────────────
ANDROID_MANIFEST="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
if [ ! -f "$ANDROID_MANIFEST" ]; then
  echo "   🏗️  Initializing generated Android project..."
  npx tauri android init
fi

node scripts/inject-android-mainactivity.cjs
node scripts/configure-android-push.cjs
node scripts/configure-mobile-camera.cjs
node scripts/configure-mobile-display-name.cjs

# ── Launch ─────────────────────────────────────────────────────────────────
echo "   🚀 Starting tauri android dev..."
echo ""
# macOS ships bash 3.2, where `set -u` treats an empty array expansion as an
# unbound variable; that was only fixed in bash 4.4. FEATURE_ARGS is empty for
# the default unified-push profile, so expand it through the ${arr[@]+...}
# guard rather than directly.
npx tauri android dev ${FEATURE_ARGS[@]+"${FEATURE_ARGS[@]}"} "$@"
