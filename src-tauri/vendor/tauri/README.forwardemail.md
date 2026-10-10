# Vendored tauri 2.10.3

The crates.io 2.10.3 release with two upstream fixes backported to
`src/plugin/mobile.rs`. Every other file is byte-identical to the published
crate (checksum `da77cc00…ba2d`); `Cargo.lock`, `Cargo.toml.orig` and
`.cargo_vcs_info.json` are left out.

- tauri-apps/tauri#15101 (in 2.11.0): the iOS plugin response handler no
  longer holds `PENDING_PLUGIN_CALLS` while it delivers the response.
- tauri-apps/tauri#15491 (in 2.11.3): the same for the Android handler and for
  both `CHANNELS` handlers.

## Why

In 2.10.3 the handler runs inside `if let Some(handler) = LOCK.lock()...`, so
the lock stays held while the response goes back to the web view. A Swift
plugin answers on Tauri's "ipc" queue, and on iOS 26
`-[WKURLSchemeTask didReceiveResponse:]` called off the main thread waits for
the main run loop. If the page starts another plugin call at that moment, the
main thread blocks on the same lock in `run_command`. Neither thread moves: the
screen stops taking touches, and iOS kills the app with 0x8BADF00D at the next
scene change. Every 0.14.28 watchdog report has these two threads:

    main:  __psynch_mutexwait <- app <- WebURLSchemeHandlerCocoa::platformStartTask
    ipc:   callOnMainRunLoopAndWait <- -[WKURLSchemeTaskImpl didReceiveResponse:] <- app

## Removing this

Delete this directory and the `[patch.crates-io]` entry in
`src-tauri/Cargo.toml` once the `tauri` crate, `@tauri-apps/api` and
`@tauri-apps/cli` move to 2.11.3 or later together. The CLI refuses a crate and
an npm package on different minor versions, so the crate cannot move alone.
