#!/usr/bin/env bash
# Fail the build when a signed iOS IPA cannot register for push notifications.
#
# Usage: scripts/verify-ios-push-entitlement.sh <path-to.ipa> [production|development]
#
# APNs refuses registerForRemoteNotifications() at runtime ("no valid
# aps-environment entitlement string found for application") unless BOTH:
#   1. the app binary is signed with an aps-environment entitlement, and
#   2. the embedded provisioning profile grants that same entitlement
#      (the App ID has Push Notifications enabled and the profile was
#      regenerated afterwards).
# Neither problem fails xcodebuild in every signing path, and both only show up
# on a device as a registration that never completes, so check them here.
# macOS only (codesign, security, plutil).
set -euo pipefail

IPA="${1:-}"
EXPECTED="${2:-}"
if [ -z "$IPA" ] || [ ! -f "$IPA" ]; then
  echo "::error::usage: $0 <path-to.ipa> [production|development]"
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
unzip -q "$IPA" -d "$WORK"

APP="$(find "$WORK/Payload" -maxdepth 1 -name '*.app' -type d | head -n 1)"
if [ -z "$APP" ]; then
  echo "::error::No .app bundle inside $IPA"
  exit 1
fi

SIGNED="$WORK/signed-entitlements.plist"
codesign -d --entitlements - --xml "$APP" > "$SIGNED" 2>/dev/null \
  || codesign -d --entitlements :- "$APP" > "$SIGNED"

signed_env="$(plutil -extract aps-environment raw -o - "$SIGNED" 2>/dev/null || true)"
echo "Signed aps-environment: ${signed_env:-<missing>}"

profile_env=""
if [ -f "$APP/embedded.mobileprovision" ]; then
  security cms -D -i "$APP/embedded.mobileprovision" > "$WORK/profile.plist"
  profile_env="$(plutil -extract Entitlements.aps-environment raw -o - "$WORK/profile.plist" 2>/dev/null || true)"
  profile_name="$(plutil -extract Name raw -o - "$WORK/profile.plist" 2>/dev/null || true)"
  echo "Provisioning profile: ${profile_name:-<unnamed>}"
  echo "Profile aps-environment: ${profile_env:-<missing>}"
else
  echo "::error::$APP has no embedded.mobileprovision"
  exit 1
fi

status=0
if [ -z "$signed_env" ]; then
  echo "::error::The signed app has no aps-environment entitlement. Push registration will fail on every device. Check that inject-ios-signing.cjs ran and that the entitlements file it generated is the one used for signing."
  status=1
fi
if [ -z "$profile_env" ]; then
  echo "::error::The provisioning profile does not grant aps-environment. Enable Push Notifications for the App ID in Apple Developer, regenerate the distribution profile, and update IOS_PROVISIONING_PROFILE_BASE64."
  status=1
fi
if [ -n "$signed_env" ] && [ -n "$profile_env" ] && [ "$signed_env" != "$profile_env" ]; then
  echo "::error::Signed aps-environment ($signed_env) does not match the profile ($profile_env)."
  status=1
fi
if [ -n "$EXPECTED" ] && [ -n "$signed_env" ] && [ "$signed_env" != "$EXPECTED" ]; then
  echo "::error::Expected aps-environment=$EXPECTED but the app is signed with $signed_env. The backend's APNS_PRODUCTION setting must match."
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "APNs entitlement OK ($signed_env)"
fi
exit "$status"
