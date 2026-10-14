# Vendored fork of tauri-plugin-notification 2.3.3

Identical to the crates.io 2.3.3 release except for one change in
ios/Sources/NotificationHandler.swift and this README. (android/build,
Cargo.toml.orig and Cargo.lock from the published crate are left out.)

`toActiveNotification` force-unwrapped `notificationsMap[request.identifier]`.
That map lives in memory and only holds notifications this process scheduled.
Tapping a notification after iOS had killed the app, or presenting one the
plugin did not schedule, found no entry and crashed the app in Swift. Both
`willPresent` and `didReceive` (the tap) go through that function.

The fork reads the optional entry and fills `sound` and `attachments` from it
when present. It also returns the notification's `extra`, which the plugin
already stores in `userInfo["__EXTRA__"]` and which survives the app being
killed. Upstream's tap event carries no `extra` on iOS, so the app could not
tell which message a tap was for (src/utils/notification-bridge.js also keeps
an id map as a fallback).

Delete this directory and restore the crates.io dependency once an upstream
release fixes the force unwrap.
