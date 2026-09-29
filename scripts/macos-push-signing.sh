#!/usr/bin/env bash
# APNs signing for the Developer ID (non App Store) macOS build.
#
#   scripts/macos-push-signing.sh prepare <profile.provisionprofile> <team-id>
#   scripts/macos-push-signing.sh verify  <Forward Email.app> <profile.provisionprofile> <team-id>
#
# Remote push on macOS needs com.apple.developer.aps-environment. That is a
# restricted entitlement: a Developer ID app may carry it only when the bundle
# embeds a Developer ID provisioning profile that grants it. Without the
# profile, codesign and notarization still succeed but the kernel kills the
# app at launch (docs/desktop-postmortem-macos-entitlements-2026-05-19.md).
#
# prepare validates the profile, copies it to
# src-tauri/ForwardEmail-DeveloperID.provisionprofile, writes
# src-tauri/Entitlements.push.plist (Entitlements.plist plus the APNs,
# application-identifier and team-identifier entitlements), and points
# bundle.macOS.entitlements and bundle.macOS.files in src-tauri/tauri.conf.json
# at them, so the next `tauri build` embeds the profile and signs with them.
# Entitlements.plist itself never changes: builds without the profile (local,
# pull request, and e2e builds) keep signing without APNs.
#
# verify checks a signed bundle: the embedded profile is the expected one, the
# signing certificate is one the profile lists, and the signed entitlements
# match the profile.
#
# macOS only (security, codesign, plutil, PlistBuddy).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAURI_DIR="$ROOT/src-tauri"
PROFILE_DEST="$TAURI_DIR/ForwardEmail-DeveloperID.provisionprofile"
PUSH_ENTITLEMENTS="$TAURI_DIR/Entitlements.push.plist"
PLISTBUDDY="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"
APS_KEY="com.apple.developer.aps-environment"
APP_ID_KEY="com.apple.application-identifier"
TEAM_KEY="com.apple.developer.team-identifier"
# Warn when the profile expires sooner than this. An installed build whose
# profile has expired no longer launches, so a renewal has to ship before then.
EXPIRY_WARNING_DAYS=90

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

usage() {
  echo "::error::usage: $0 prepare <profile> <team-id> | verify <app> <profile> <team-id>"
  exit 2
}

bundle_identifier() {
  node -p "require('$TAURI_DIR/tauri.conf.json').identifier"
}

# Print a value from a plist whose key path may contain dots.
plist_value() {
  "$PLISTBUDDY" -c "Print :$2" "$1" 2>/dev/null || true
}

decode_profile() {
  local profile="$1" out="$2"
  if [ ! -s "$profile" ]; then
    echo "::error::Provisioning profile not found or empty: $profile"
    exit 1
  fi
  if ! security cms -D -i "$profile" > "$out" 2>/dev/null || ! plutil -lint -s "$out"; then
    echo "::error::$profile is not a signed provisioning profile (security cms -D failed). Download it again from Apple Developer and re-encode it with base64."
    exit 1
  fi
}

check_profile() {
  local decoded="$1" team="$2" identifier="$3"
  local status=0

  local name aps app_id profile_team profile_team_entitlement all_devices expires
  name="$(plist_value "$decoded" Name)"
  aps="$(plist_value "$decoded" "Entitlements:$APS_KEY")"
  app_id="$(plist_value "$decoded" "Entitlements:$APP_ID_KEY")"
  profile_team="$(plist_value "$decoded" TeamIdentifier:0)"
  profile_team_entitlement="$(plist_value "$decoded" "Entitlements:$TEAM_KEY")"
  all_devices="$(plist_value "$decoded" ProvisionsAllDevices)"
  expires="$(plutil -extract ExpirationDate raw -o - "$decoded" 2>/dev/null || true)"

  echo "Provisioning profile: ${name:-<unnamed>}"
  echo "  application-identifier: ${app_id:-<missing>}"
  echo "  team: ${profile_team:-<missing>}"
  echo "  aps-environment: ${aps:-<missing>}"
  echo "  provisions all devices: ${all_devices:-false}"
  echo "  expires: ${expires:-<unknown>}"

  if [ "$aps" != "production" ]; then
    echo "::error::The profile does not grant $APS_KEY=production. Enable Push Notifications for the $identifier App ID, then regenerate the Developer ID profile."
    status=1
  fi
  if [ "$app_id" != "$team.$identifier" ]; then
    echo "::error::The profile is for ${app_id:-<no App ID>}, not $team.$identifier."
    status=1
  fi
  if [ "$profile_team" != "$team" ] || [ "$profile_team_entitlement" != "$team" ]; then
    echo "::error::The profile belongs to team ${profile_team:-<missing>}, not $team (APPLE_TEAM_ID)."
    status=1
  fi
  if [ "$all_devices" != "true" ]; then
    echo "::error::This is not a Developer ID profile (ProvisionsAllDevices is not set). Create the profile under Distribution > Developer ID, not Development or Mac App Store."
    status=1
  fi

  if [ -n "$expires" ]; then
    local expires_epoch now_epoch days_left
    expires_epoch="$(date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$expires" '+%s' 2>/dev/null || true)"
    now_epoch="$(date -u '+%s')"
    if [ -z "$expires_epoch" ]; then
      echo "::warning::Could not read the profile expiration date ($expires)."
      return "$status"
    fi
    days_left=$(( (expires_epoch - now_epoch) / 86400 ))
    if [ "$expires_epoch" -le "$now_epoch" ]; then
      echo "::error::The profile expired on $expires. Regenerate it in Apple Developer."
      status=1
    elif [ "$days_left" -lt "$EXPIRY_WARNING_DAYS" ]; then
      echo "::warning::The provisioning profile expires in $days_left days ($expires). Builds signed with it stop launching after that date; renew it and ship a release before then."
    fi
  fi

  return "$status"
}

prepare() {
  local profile="${1:-}" team="${2:-}"
  [ -n "$profile" ] && [ -n "$team" ] || usage

  local identifier
  identifier="$(bundle_identifier)"

  decode_profile "$profile" "$WORK/profile.plist"
  check_profile "$WORK/profile.plist" "$team" "$identifier"

  cp "$profile" "$PROFILE_DEST"

  cp "$TAURI_DIR/Entitlements.plist" "$PUSH_ENTITLEMENTS"
  "$PLISTBUDDY" -c "Add :$APS_KEY string production" "$PUSH_ENTITLEMENTS"
  "$PLISTBUDDY" -c "Add :$APP_ID_KEY string $team.$identifier" "$PUSH_ENTITLEMENTS"
  "$PLISTBUDDY" -c "Add :$TEAM_KEY string $team" "$PUSH_ENTITLEMENTS"
  plutil -lint "$PUSH_ENTITLEMENTS"

  node - "$TAURI_DIR/tauri.conf.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const conf = JSON.parse(fs.readFileSync(file, 'utf8'));
conf.bundle.macOS.entitlements = 'Entitlements.push.plist';
conf.bundle.macOS.files = {
  ...conf.bundle.macOS.files,
  'embedded.provisionprofile': './ForwardEmail-DeveloperID.provisionprofile',
};
fs.writeFileSync(file, JSON.stringify(conf, null, 2) + '\n');
NODE

  echo "macOS push signing prepared: Entitlements.push.plist and embedded.provisionprofile"
}

verify() {
  local app="${1:-}" profile="${2:-}" team="${3:-}"
  [ -n "$app" ] && [ -n "$profile" ] && [ -n "$team" ] || usage
  if [ ! -d "$app" ]; then
    echo "::error::App bundle not found: $app"
    exit 1
  fi

  local identifier status=0
  identifier="$(bundle_identifier)"

  local embedded="$app/Contents/embedded.provisionprofile"
  if [ ! -f "$embedded" ]; then
    echo "::error::$embedded is missing. Without it the kernel kills the app at launch because of the APNs entitlement."
    return 1
  fi
  if ! cmp -s "$embedded" "$profile"; then
    echo "::error::The embedded provisioning profile is not the one prepared for this build."
    status=1
  fi
  decode_profile "$embedded" "$WORK/profile.plist"
  check_profile "$WORK/profile.plist" "$team" "$identifier" || status=1

  codesign -d --entitlements - --xml "$app" > "$WORK/signed.plist" 2>/dev/null
  local signed_aps signed_app_id signed_team
  signed_aps="$(plist_value "$WORK/signed.plist" "$APS_KEY")"
  signed_app_id="$(plist_value "$WORK/signed.plist" "$APP_ID_KEY")"
  signed_team="$(plist_value "$WORK/signed.plist" "$TEAM_KEY")"
  echo "Signed entitlements: aps-environment=${signed_aps:-<missing>} application-identifier=${signed_app_id:-<missing>} team-identifier=${signed_team:-<missing>}"
  if [ "$signed_aps" != "production" ]; then
    echo "::error::The app is not signed with $APS_KEY=production; remote push cannot register."
    status=1
  fi
  if [ "$signed_app_id" != "$team.$identifier" ] || [ "$signed_team" != "$team" ]; then
    echo "::error::The signed application or team identifier does not match $team.$identifier."
    status=1
  fi

  # The certificate that signed the app must be one the profile lists, or the
  # profile does not authorize this signature.
  codesign -d --extract-certificates="$WORK/cert" "$app" 2>/dev/null
  local leaf profile_cert found=false index=0
  leaf="$(shasum -a 256 "$WORK/cert0" | awk '{print $1}')"
  while profile_cert="$(plutil -extract "DeveloperCertificates.$index" raw -o - "$WORK/profile.plist" 2>/dev/null)"; do
    if [ "$(printf '%s' "$profile_cert" | base64 --decode | shasum -a 256 | awk '{print $1}')" = "$leaf" ]; then
      found=true
      break
    fi
    index=$((index + 1))
  done
  if [ "$found" != true ]; then
    echo "::error::The Developer ID certificate that signed the app is not in the provisioning profile. Regenerate the profile with the certificate in APPLE_CERTIFICATE selected."
    status=1
  fi

  if [ "$status" -eq 0 ]; then
    echo "macOS push signing OK"
  fi
  return "$status"
}

command="${1:-}"
shift || true
case "$command" in
  prepare) prepare "$@" ;;
  verify) verify "$@" ;;
  *) usage ;;
esac
