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

# CocoaPods (required by Tauri's `ios init` to run `pod install`)
if ! command -v pod &>/dev/null; then
  MISSING="$MISSING\n  - CocoaPods not found (install: brew install cocoapods)"
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

# ── Helper: extract simulator name and UDID from simctl output ────────────
# simctl format: "    iPhone 16e (B4A99C0E-FB18-4322-9960-8931763CC2ED) (Booted)"
# We need the UDID for `simctl boot` but the NAME for `tauri ios dev`
# because the Tauri CLI uses fuzzy name-matching, not UDID lookup.
extract_sim_name() {
  sed -E 's/^[[:space:]]*//' | sed -E 's/ \([0-9A-Fa-f-]{36}\).*//'
}

extract_sim_udid() {
  sed -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/'
}

# ── Boot a simulator if none booted ───────────────────────────────────────
BOOTED_LINE="$(xcrun simctl list devices | grep '(Booted)' | head -1 || true)"
BOOTED_UDID=""
BOOTED_NAME=""

if [ -n "${BOOTED_LINE:-}" ]; then
  BOOTED_UDID="$(echo "$BOOTED_LINE" | extract_sim_udid)"
  BOOTED_NAME="$(echo "$BOOTED_LINE" | extract_sim_name)"
fi

if [ -z "${BOOTED_UDID:-}" ]; then
  # Pick the newest iPhone runtime available
  DEVICE_LINE="$(xcrun simctl list devices available 2>/dev/null \
    | grep -E 'iPhone 1[5-9]|iPhone 2[0-9]' \
    | tail -1 || true)"

  if [ -z "${DEVICE_LINE:-}" ]; then
    DEVICE_LINE="$(xcrun simctl list devices available 2>/dev/null \
      | grep -E 'iPhone ' \
      | tail -1 || true)"
  fi

  DEVICE_UDID=""
  DEVICE_NAME=""
  if [ -n "${DEVICE_LINE:-}" ]; then
    DEVICE_UDID="$(echo "$DEVICE_LINE" | extract_sim_udid)"
    DEVICE_NAME="$(echo "$DEVICE_LINE" | extract_sim_name)"
  fi

  if [ -n "${DEVICE_UDID:-}" ]; then
    echo "   📲 Booting simulator $DEVICE_NAME ($DEVICE_UDID)..."
    xcrun simctl boot "$DEVICE_UDID" 2>/dev/null || true
    open -a Simulator
  else
    echo "   ⚠️  No iPhone simulator device found — open Simulator.app manually and retry"
  fi
else
  echo "   📲 Using booted simulator: $BOOTED_NAME ($BOOTED_UDID)"
fi

# iOS Simulator shares host loopback, so no port-forwarding equivalent of
# `adb reverse` is needed — Vite on localhost:5174 is reachable directly.

# ── Generated-project integration ──────────────────────────────────────────
if [ ! -d src-tauri/gen/apple ]; then
  echo "   🏗️  Initializing generated iOS project..."
  npx tauri ios init --ci
fi
node scripts/configure-mobile-display-name.cjs

# ── Launch ─────────────────────────────────────────────────────────────────
# `tauri ios dev` takes DEVICE as a positional arg — pass the simulator NAME
# (not the UDID) because the Tauri CLI resolves it via fuzzy name-matching.
DEVICE_ARG=""
if [ -n "${BOOTED_NAME:-}" ]; then
  DEVICE_ARG="$BOOTED_NAME"
elif [ -n "${DEVICE_NAME:-}" ]; then
  DEVICE_ARG="$DEVICE_NAME"
fi

echo "   🚀 Starting tauri ios dev..."
echo ""
if [ -n "$DEVICE_ARG" ]; then
  exec npx tauri ios dev "$DEVICE_ARG" "$@"
else
  exec npx tauri ios dev "$@"
fi
