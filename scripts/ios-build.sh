#!/usr/bin/env bash
# Build iOS app. Defaults to an unsigned simulator build — pass --target
# aarch64 (or other device targets) plus signing env for a device build.

set -euo pipefail

XCODE_PATH="$(xcode-select -p 2>/dev/null || true)"
if [ -z "$XCODE_PATH" ] || [[ "$XCODE_PATH" == *CommandLineTools* ]]; then
  echo "❌ Full Xcode.app required (run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer)"
  exit 1
fi

# If caller didn't pass --target, default to the host-arch simulator.
TARGET_FLAG=""
if [[ "$*" != *"--target"* ]]; then
  case "$(uname -m)" in
    arm64) TARGET_FLAG="--target aarch64-sim" ;;
    x86_64) TARGET_FLAG="--target x86_64-sim" ;;
  esac
fi

echo "📦 iOS Build"
echo "   Xcode:  $XCODE_PATH"
[ -n "$TARGET_FLAG" ] && echo "   Target: ${TARGET_FLAG#--target }"
echo ""

exec npx tauri ios build $TARGET_FLAG "$@"
