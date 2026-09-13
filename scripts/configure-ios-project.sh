#!/usr/bin/env bash
# Ordered post-init configuration for the generated iOS project.
#
# Every build path (ios-dev.sh, ios-build.sh, and each CI workflow) runs this
# after `tauri ios init` instead of maintaining its own copy of the step list.
# The release pipeline once missed the camera step because the list lived in
# several places, and a missing NSCameraUsageDescription is not a denied
# permission on iOS: UIKit kills the process on first camera access.
#
# ORDER MATTERS: the camera and store-metadata scripts write into project.yml,
# and the scene-delegate script then runs xcodegen, which regenerates the
# Xcode project and Info.plist FROM project.yml. Running xcodegen first
# silently discards their entries.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node scripts/configure-mobile-camera.cjs
node scripts/configure-ios-store-metadata.cjs
node scripts/inject-ios-scene-delegate.cjs
