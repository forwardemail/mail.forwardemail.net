#!/usr/bin/env bash
# Start iOS development environment in one step.
# Verifies Xcode, boots a simulator if none is running, and launches tauri ios dev.

set -euo pipefail

# ── Preflight ─────────────────────────────────────────────────────────────
MISSING=""

if ! command -v xcode-select &>/dev/null; then
  MISSING="$MISSING\n  - Xcode command line tools not found (install: xcode-select --install)"
fi

XCODE_PATH="$(xcode-select -p 2>/dev/null || true)"
if [ -z "$XCODE_PATH" ] || [[ "$XCODE_PATH" == *CommandLineTools* ]]; then
  MISSING="$MISSING\n  - Full Xcode.app not selected (run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer)"
fi

if ! command -v xcrun &>/dev/null; then
  MISSING="$MISSING\n  - xcrun not found"
fi

# Check a simulator runtime is installed
if command -v xcrun &>/dev/null; then
  if ! xcrun simctl list runtimes 2>/dev/null | grep -q "iOS"; then
    MISSING="$MISSING\n  - No iOS Simulator runtime installed (Xcode → Settings → Platforms → iOS)"
  fi
fi

# Rust iOS targets
for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  if ! rustup target list --installed 2>/dev/null | grep -q "^$t$"; then
    MISSING="$MISSING\n  - Rust target $t missing (run: rustup target add $t)"
  fi
done

if [ -n "$MISSING" ]; then
  printf "❌ Missing prerequisites:%b\n" "$MISSING"
  exit 1
fi

echo "🍎 iOS Dev Environment"
echo "   Xcode:  $XCODE_PATH"

# ── Boot a simulator if none booted ───────────────────────────────────────
# Format: "    iPhone 15 Pro (UDID) (Booted)" — tolerate trailing whitespace
BOOTED_UDID="$(xcrun simctl list devices | grep '(Booted)' | head -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')"

if [ -z "${BOOTED_UDID:-}" ]; then
  # Pick the newest iPhone runtime available
  DEVICE_UDID="$(xcrun simctl list devices available 2>/dev/null \
    | grep -E 'iPhone 1[5-9]|iPhone 2[0-9]' \
    | tail -1 \
    | sed -E 's/.*\(([0-9A-F-]+)\).*/\1/' || true)"

  if [ -z "${DEVICE_UDID:-}" ]; then
    DEVICE_UDID="$(xcrun simctl list devices available 2>/dev/null \
      | grep -E 'iPhone ' \
      | tail -1 \
      | sed -E 's/.*\(([0-9A-F-]+)\).*/\1/' || true)"
  fi

  if [ -n "${DEVICE_UDID:-}" ]; then
    echo "   📲 Booting simulator $DEVICE_UDID..."
    xcrun simctl boot "$DEVICE_UDID" 2>/dev/null || true
    open -a Simulator
  else
    echo "   ⚠️  No iPhone simulator device found — open Simulator.app manually and retry"
  fi
else
  echo "   📲 Using booted simulator: $BOOTED_UDID"
fi

# iOS Simulator shares host loopback, so no port-forwarding equivalent of
# `adb reverse` is needed — Vite on localhost:5174 is reachable directly.

# ── Launch ─────────────────────────────────────────────────────────────────
# `tauri ios dev` takes DEVICE as a positional arg, auto-detecting a booted
# simulator. We pass the booted UDID explicitly so it never ambiguously
# picks a device destination.
DEVICE_ARG=""
if [ -n "${BOOTED_UDID:-}" ]; then
  DEVICE_ARG="$BOOTED_UDID"
elif [ -n "${DEVICE_UDID:-}" ]; then
  DEVICE_ARG="$DEVICE_UDID"
fi

echo "   🚀 Starting tauri ios dev..."
echo ""
if [ -n "$DEVICE_ARG" ]; then
  exec npx tauri ios dev "$DEVICE_ARG" "$@"
else
  exec npx tauri ios dev "$@"
fi
