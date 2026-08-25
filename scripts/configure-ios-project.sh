#!/usr/bin/env bash
# Ordered post-init configuration for the generated iOS project.
#
# Every build path (ios-dev.sh, ios-build.sh, and each CI workflow) runs this
# after `tauri ios init` instead of maintaining its own copy of the step list.
# The release pipeline once missed the camera step because the list lived in
# several places, and a missing NSCameraUsageDescription is not a denied
# permission on iOS: UIKit kills the process on first camera access.
#
# ORDER MATTERS: the camera script writes NSCameraUsageDescription into
# project.yml, and the scene-delegate script then runs xcodegen, which
# regenerates Info.plist FROM project.yml. Swapping them silently discards the
# plist entry.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node scripts/configure-mobile-camera.cjs
node scripts/inject-ios-scene-delegate.cjs
