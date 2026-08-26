# Vendored fork of tauri-plugin-opener 2.5.4

Byte-identical to the crates.io 2.5.4 release except for one fix in
ios/Sources/OpenerPlugin.swift: UIApplication.open is dispatched to the main
thread. Upstream calls it on the plugin invoke (IPC) queue, which Main Thread
Checker flags on device and which is undefined behavior for UIKit.

Captured on a physical iPhone 2026-08-26 (Forward Email debug build):

    Main Thread Checker: UI API called on a background thread:
    -[UIApplication openURL:options:completionHandler:]
    ... OpenerPlugin.open ... Queue name: ipc

Delete this directory and restore the crates.io dependency once an upstream
release contains the fix (submitted from this repo; see the PR referenced in
the commit that added this fork).
