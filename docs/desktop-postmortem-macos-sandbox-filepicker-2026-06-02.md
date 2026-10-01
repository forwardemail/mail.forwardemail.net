# Postmortem: macOS File Picker Crash (App Sandbox / NSOpenPanel)

**Date:** 2026-06-02
**Severity:** High. Opening the native file picker (add attachment, save attachment, pick avatar/vCard/ICS) crashed the signed macOS desktop app on **every** architecture and macOS version.
**Resolution:** Remove `com.apple.security.app-sandbox` from `src-tauri/Entitlements.plist` (ship in 0.11.2+).
**Related:** [Postmortem: macOS Releases Unopenable (0.10.17–0.10.21)](./desktop-postmortem-macos-entitlements-2026-05-19.md): the _same_ shared-entitlements-file footgun, different entitlement.

## TL;DR: the gotcha

> **A sandboxed macOS app brokers `NSOpenPanel`/`NSSavePanel` through Powerbox. With `com.apple.security.app-sandbox` set but no file-access entitlement, the panel constructor returns `nil`, and the `rfd` crate (via `tauri-plugin-dialog` / `objc2-app-kit`) asserts non-nil → `objc2 retain_semantics::none_fail` panic → `SIGABRT`. App Sandbox is NOT required for notarization (Hardened Runtime is) and should not be set on a Developer-ID-distributed app.**

## Summary

Opening any native file dialog crashed the signed/notarized desktop release with:

```
EXC_CRASH (SIGABRT)
13  objc2::__macro_helpers::retain_semantics::none_fail
14  objc2_app_kit::…NSOpenPanel::openPanel
15  rfd::backend::macos::file_dialog::panel_ffi::Panel::build_pick_files
16  rfd::backend::macos::modal_future::ModalFuture::new
```

The root cause was a single line in `src-tauri/Entitlements.plist`:

```xml
<key>com.apple.security.app-sandbox</key>
<true/>
```

added in `00460d8` ("security hardening") with a comment claiming it was "required for notarization." That premise is wrong: **App Sandbox ≠ Hardened Runtime.** Notarization needs the Hardened Runtime (`com.apple.security.cs.allow-jit` + `com.apple.security.cs.allow-unsigned-executable-memory` + `codesign --options runtime`), all of which were already present and were kept. App Sandbox is a separate, primarily-Mac-App-Store mechanism; a Developer-ID-distributed app does not need it, and turning it on without the matching `com.apple.security.files.user-selected.*` entitlements broke the Powerbox-brokered file panel.

## Why it hid for so long (and sent us down the wrong path)

1. **Only signed builds reproduce it.** `tauri:dev` and local `tauri build` do not enforce the sandbox the same way, so the file picker worked in development. The crash only appeared in the signed + notarized release. (Same "invisible to the dev loop / invisible to CI's green checkmarks" property as the APNs postmortem: the failure happens at _exec_ time in a signed bundle, not at build/sign/notary time.)
2. **The first crash reports were Apple Silicon + macOS 26 (Tahoe).** With no Intel `.ips` collected yet, we wrongly concluded the bug was "Apple-Silicon-only / Tahoe-only" and chased it as an OS/arch issue, adding a custom nullable `pick_files_macos` Rust command and arch/version-based routing in `file-picker.ts` to dodge the `rfd` panic. Those were treating a symptom.
3. **An Intel Sonoma 14.7.3 crash report broke it open.** The identical `rfd → NSOpenPanel → none_fail` stack on `X86-64` proved it was neither arch- nor version-specific. The common factor across every crashing build (Intel/Apple-Silicon, Sonoma/Tahoe, since ≤ v0.10.22) was the `app-sandbox` entitlement.

## Fix

Remove the entitlement (keep network + hardened-runtime entitlements):

```diff
-  <key>com.apple.security.app-sandbox</key>
-  <true/>
```

**Validation:** run it on a **signed + notarized** build. Dev/local builds do not reproduce the crash, so they cannot confirm the fix.

## Prevention / lessons

- **App Sandbox is not Hardened Runtime, and not required for notarization.** Do not add `com.apple.security.app-sandbox` to a Developer-ID-distributed app "for hardening". It only restricts the app (and broke the file picker). Notarization requires the Hardened Runtime entitlements + `codesign --options runtime`.
- **Entitlement bugs are invisible in dev.** Anything gated by the sandbox / code signature only manifests in a signed, notarized bundle. File dialogs, push, protected resources, etc. must be smoke-tested on a real release build, not only `tauri dev`.
- **The shared `Entitlements.plist` is a recurring footgun.** This is the _second_ incident (after APNs, 2026-05-19) where one entitlements file, applied to **both** iOS and macOS desktop via `bundle.macOS.entitlements`, broke macOS desktop. **Systemic fix to consider: split macOS and iOS entitlements into separate files** so an iOS-relevant or "hardening" entitlement can't silently bake into the macOS bundle.
- **When a native crash looks OS/arch-specific, get a crash report from the "unaffected" config before concluding.** The "x86_64 unaffected / ARM-only" belief was sampling bias and cost a long arch-routing detour.

## References

- `src-tauri/Entitlements.plist` (inline comment warns against re-adding `app-sandbox`)
- `src-tauri/src/file_picker_macos.rs`: the nullable `pick_files_macos` command added during the (mis-)diagnosis; now belt-and-suspenders rather than the fix
- `src/utils/file-picker.ts`: arch routing added during the (mis-)diagnosis; can likely simplify once the signed build confirms the plugin works everywhere
- Apple: [App Sandbox](https://developer.apple.com/documentation/security/app-sandbox) vs [Hardened Runtime](https://developer.apple.com/documentation/security/hardened-runtime)
