#!/usr/bin/env bash
#
# Generate Android adaptive launcher icons (and refresh desktop/iOS icons)
# via `pnpm tauri icon` using a manifest JSON.
#
# Required inputs (place under src-tauri/icons/source/):
#   foreground.png  — Android adaptive foreground. Transparent bg, important
#                     content within the central 66% safe zone (e.g. ~432px
#                     of artwork inside a 512×512 canvas, 720px inside 1024).
#   icon.png        — Square source for desktop/iOS/legacy mipmaps.
#                     Recommended 1024×1024.
#
# Optional inputs:
#   background.png  — Adaptive background layer (otherwise BG_COLOR is used).
#   monochrome.png  — Monochrome variant for Android 13+ themed icons.
#
# Optional env vars:
#   BG_COLOR        — Adaptive background color when no background.png exists.
#                     Default: #1c7ed6 (matches the primary calendar color).
#   FG_SCALE        — Foreground scale percentage (Tauri default ≈ 85).
#
# Usage:
#   ./scripts/generate-android-icon.sh
#
# Output:
#   src-tauri/icons/*                                 (desktop + iOS PNGs)
#   src-tauri/gen/android/app/src/main/res/mipmap-*   (legacy + adaptive)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_DIR="$ROOT/src-tauri/icons/source"
MANIFEST="$SOURCE_DIR/icon-manifest.json"

FG="$SOURCE_DIR/foreground.png"
DEFAULT="$SOURCE_DIR/icon.png"
BG="$SOURCE_DIR/background.png"
MONO="$SOURCE_DIR/monochrome.png"

BG_COLOR="${BG_COLOR:-#1c7ed6}"
FG_SCALE="${FG_SCALE:-85}"

mkdir -p "$SOURCE_DIR"

if [[ ! -f "$FG" ]]; then
  echo "✗ Missing required foreground: $FG" >&2
  echo "  Place a transparent PNG with content inside the central 66% safe zone." >&2
  exit 1
fi

if [[ ! -f "$DEFAULT" ]]; then
  echo "✗ Missing required base icon: $DEFAULT" >&2
  echo "  Place a square PNG (1024×1024 recommended) for desktop/iOS/legacy outputs." >&2
  exit 1
fi

# Build manifest. Paths are relative to the manifest file.
{
  printf '{\n'
  printf '  "default": "icon.png",\n'
  printf '  "android_fg": "foreground.png",\n'
  printf '  "android_fg_scale": %s' "$FG_SCALE"

  if [[ -f "$BG" ]]; then
    printf ',\n  "android_bg": "background.png"'
  else
    printf ',\n  "bg_color": "%s"' "$BG_COLOR"
  fi

  if [[ -f "$MONO" ]]; then
    printf ',\n  "android_monochrome": "monochrome.png"'
  fi

  printf '\n}\n'
} > "$MANIFEST"

echo "Manifest: $MANIFEST"
cat "$MANIFEST"
echo

cd "$ROOT"
pnpm tauri icon "$MANIFEST"

ANDROID_RES="$ROOT/src-tauri/gen/android/app/src/main/res"
ADAPTIVE_XML="$ANDROID_RES/mipmap-anydpi-v26/ic_launcher.xml"

if [[ -f "$ADAPTIVE_XML" ]]; then
  echo "✓ Adaptive icon XML emitted: $ADAPTIVE_XML"
else
  echo "⚠ Adaptive icon XML missing at $ADAPTIVE_XML" >&2
  echo "  Tauri CLI version may not emit it. Either upgrade the CLI or hand-write" >&2
  echo "  ic_launcher.xml referencing @mipmap/ic_launcher_foreground and either" >&2
  echo "  @mipmap/ic_launcher_background or @color/ic_launcher_background." >&2
fi

echo
echo "Next: rebuild the Android app and verify the launcher icon."
echo "  pnpm tauri android dev      # or: pnpm tauri android build"
