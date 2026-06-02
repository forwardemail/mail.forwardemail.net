#!/usr/bin/env bash
#
# Android e2e launcher for reactivecircus/android-emulator-runner.
#
# WHY THIS IS A FILE (and not an inline `script:` block):
# the emulator-runner action's parseScript() SPLITS the `script` input on
# newlines and runs EACH line in its own `sh -c` invocation. That makes
# multi-line shell constructs impossible (an `if ... then` line is parsed
# alone → "Syntax error: end of file unexpected (expecting fi)") and drops
# variables between lines ($APK_PATH wouldn't survive to the Appium launch).
# So the workflow invokes this whole file with a single `bash` command, which
# runs it as one coherent shell — restoring if/for, variable persistence, and
# `set -o pipefail` (bash, unlike the action's dash, supports it).
#
# Runs from the repo root (the action's cwd is GITHUB_WORKSPACE), so all paths
# below are relative to the repo root.
set -euo pipefail

APK_DIR="src-tauri/gen/android/app/build/outputs/apk"
# `tauri android build --apk --target x86_64 --debug` writes a single
# "universal" APK: $APK_DIR/universal/debug/app-universal-debug.apk. It bundles
# the x86_64 lib we built, so it installs on the x86_64 emulator — but the path
# has no "x86_64" in it. Prefer an x86_64-named APK if one ever appears, then
# the universal, then any APK.
APK_PATH="$(find "$APK_DIR" -name '*.apk' -path '*x86_64*' 2>/dev/null | head -n1)"
[ -n "$APK_PATH" ] || APK_PATH="$(find "$APK_DIR" -name '*.apk' -path '*universal*' 2>/dev/null | head -n1)"
[ -n "$APK_PATH" ] || APK_PATH="$(find "$APK_DIR" -name '*.apk' 2>/dev/null | head -n1)"
if [ -z "$APK_PATH" ]; then
  echo "::error::No APK found under $APK_DIR"
  echo "--- contents of $APK_DIR ---"
  find "$APK_DIR" -type f 2>/dev/null || echo "(directory does not exist)"
  exit 1
fi
APK_PATH="$(realpath "$APK_PATH")"
echo "Using APK: $APK_PATH"
export APK_PATH

# Force the System WebView into SOFTWARE rendering before the app launches.
# Root cause of the emulator dying at the WebView context switch: the Tauri
# WebView's GPU-accelerated Skia compositing (logcat showed an
# `s_glBindAttribLocation` shader storm + "Skipped 56 frames" + 1s Davey jank)
# is translated through the headless emulator's software-GL pipe, which it
# can't sustain — the whole emulator drops to adb "offline" mid-render. The
# emulator image is userdebug, so the System WebView honors this flags file
# (first token is a dummy argv[0]). --disable-gpu makes it raster in software:
# slower, but the GL storm — and the crash — go away.
adb shell "echo '_ --disable-gpu --disable-gpu-compositing' > /data/local/tmp/webview-command-line" || true
adb shell 'chmod 0644 /data/local/tmp/webview-command-line' || true
echo "WebView command-line flags: $(adb shell cat /data/local/tmp/webview-command-line 2>/dev/null || echo '(unset)')"

# Capture logcat in the background so a renderer/emulator crash is diagnosable
# after the fact (lowmemorykiller / OOM vs an app tombstone). Written to the
# repo root and uploaded as an artifact by the workflow. Best-effort: if the
# emulator dies, logcat stops but we keep everything up to the crash.
adb logcat -c 2>/dev/null || true
adb logcat > logcat.log 2>&1 &
LOGCAT_PID=$!

# Switching into the Android System WebView context needs a Chromedriver that
# matches the emulator's WebView (Chrome 113 on the API 34 image); the version
# bundled with uiautomator2 won't ("No Chromedriver found that can automate
# Chrome 113..."). Enable the chromedriver_autodownload insecure feature so the
# driver fetches the matching Chromedriver on demand at context-switch time.
appium --port 4723 --allow-insecure=uiautomator2:chromedriver_autodownload > appium.log 2>&1 &
APPIUM_PID=$!
trap 'kill "$APPIUM_PID" "$LOGCAT_PID" 2>/dev/null || true' EXIT

# Wait for Appium to be ready (max 30s).
for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:4723/status > /dev/null; then break; fi
  sleep 1
done

cd e2e-mobile
pnpm test
