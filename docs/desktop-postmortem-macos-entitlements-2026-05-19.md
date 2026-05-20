# Postmortem: macOS Releases Unopenable (0.10.17 – 0.10.21)

**Date:** 2026-05-19
**Severity:** Critical — every macOS desktop release between 0.10.17 and 0.10.21 was unopenable.
**Resolution:** Released as part of 0.10.22 (`a4631be` — `fix(macos): remove APNs entitlement from desktop bundle`).
**Author:** Investigation summary from the 0.10.20 → 0.10.22 debug cycle.

## Summary

Five consecutive macOS releases (0.10.17, 0.10.18, 0.10.19, 0.10.20, 0.10.21) shipped `.dmg` bundles that macOS refused to launch on every architecture and every macOS version, with the kernel returning `EXC_CRASH (SIGKILL Code Signature Invalid)` / `Termination Reason: CODESIGNING 1 Taskgated Invalid Signature`. Users saw the system dialog _"the application can't be opened"_ with no Gatekeeper-specific message.

The CI release pipeline reported every step green throughout, including `codesign` and Apple notarization. The failure happened only at _exec_ time inside the kernel — not at build, sign, notary, or stapling time — which is what hid the bug from every layer of the existing automation.

The root cause was a single line in `src-tauri/Entitlements.plist`:

```xml
<key>aps-environment</key>
<string>development</string>
```

added in commit `30b111c` (push-notifications feature) for iOS. The same entitlements file was also wired to macOS desktop builds via `bundle.macOS.entitlements` in `tauri.conf.json`, so this entitlement got baked into every macOS bundle. The "Forward Email LLC" Developer ID Application certificate that signs macOS distribution builds is **not authorized for Apple Push Notifications** (APNs requires App Store distribution or an explicitly-provisioned APNs Developer ID), so the kernel rejected the bundle the moment `dyld_start` ran.

## Symptoms

End-user surface:

- Double-click `.dmg`, mount, drag `Forward Email.app` to `/Applications`, launch → "the application can't be opened".
- No Gatekeeper signature dialog ("damaged", "cannot be checked for malicious software", etc.).
- Identical failure on both Apple Silicon and Intel hardware.
- Identical failure on Sonoma (14.7.x) and Tahoe (26.x).

Crash report signature (the key fields):

```
Exception Type:  EXC_CRASH (SIGKILL (Code Signature Invalid))
Termination Reason: CODESIGNING 1 Taskgated Invalid Signature

"codeSigningID" : "",
"codeSigningTeamID" : "",
"codeSigningFlags" : 16777216,           (= 0x01000000 = CS_LINKER_SIGNED)
"codeSigningTrustLevel" : 4294967295     (= UINT32_MAX = untrusted)

Thread 0 Crashed:
0   dyld    _dyld_start + 0
```

Empty `codeSigningID` / `codeSigningTeamID` in the crash report indicate the kernel never accepted the `codesign`-applied signature — at validation time it was treated as if the binary were only linker-stamped, which is the bottom-of-the-barrel `CS_LINKER_SIGNED` flag set by the Rust toolchain on every macOS Mach-O.

## Timeline

| Version                 | Status         | Notes                                                                                                                                                                                     |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v0.10.16`              | Works          | `5f69fc0` shipped strip/debug/icon-template/selection-cluster fixes. Last known-good release.                                                                                             |
| `30b111c`               | Bug introduced | "feat(push): add multi-platform push notification registration and tests". Added `aps-environment` to `Entitlements.plist`.                                                               |
| `v0.10.17`              | Broken         | First release carrying `30b111c`. macOS bundles unopenable from this point forward.                                                                                                       |
| `v0.10.18` – `v0.10.20` | Broken         | All inherited the same Entitlements.plist.                                                                                                                                                |
| `d314b25`               | Defense added  | "ci(release): fail fast if macOS signing secrets are missing". Guards against a different failure mode (missing env vars), did not catch this one because secrets were present.           |
| `v0.10.21`              | Broken         | Same root cause; the new guard passed because the secrets really were configured.                                                                                                         |
| `a4631be`               | Fix            | "fix(macos): remove APNs entitlement from desktop bundle". Strips `aps-environment` from the static plist; `scripts/inject-ios-signing.cjs` inserts it only when an iOS build is running. |
| `v0.10.22`              | Works          | First release with `a4631be`. macOS opens cleanly again.                                                                                                                                  |

## Root cause walk-through

1. **The bad entitlement.** `<key>aps-environment</key><string>development</string>` is an APNs entitlement. Apple uses it to determine which APNs gateway (development sandbox vs production) push notifications route through. It is **only** valid on:
   - iOS app bundles signed for distribution.
   - Mac App Store bundles signed with a Mac App Distribution cert.
   - macOS Developer ID certs that have been specifically provisioned for APNs (rare and requires Apple support).

   The Forward Email LLC Developer ID Application cert is a standard Developer ID — none of the above.

2. **Why the same file was used for both platforms.** `tauri.conf.json` has a single `bundle.macOS.entitlements` field pointing at `src-tauri/Entitlements.plist`. Tauri 2 applies this entitlements file to _both_ macOS desktop bundling and iOS bundling. Adding an entitlement intended for iOS therefore silently affected macOS distribution builds.

3. **Why `codesign` succeeded.** `codesign` validates the **structural correctness** of entitlements (well-formed XML, recognized keys) but does _not_ validate that the signing cert is authorized to grant the entitlements it's applying. That check happens later, at exec time, in the kernel.

4. **Why notarization succeeded.** Apple's notary service runs a malware/security scan and verifies the bundle is signed with a known Developer ID. It does **not** validate the cert/entitlement compatibility either. A bundle can be signed, notarized, and stapled, yet still rejected at launch.

5. **Why the kernel rejected it.** When `launchd` execs the bundle, the kernel's `taskgated` performs entitlement validation against the embedded signature. It looks up which entitlements the signing cert is authorized to grant. Encountering `aps-environment` on a cert that isn't APNs-authorized, it rejects the entire binary with `CODESIGNING 1`. There is no recovery path — no Gatekeeper override, no `xattr -d`, no first-launch consent dialog.

## Why CI didn't catch it

Every layer reported success:

- `cargo build` succeeded (no Rust changes related to signing).
- `codesign --sign "Developer ID Application: Forward Email LLC"` succeeded.
- `xcrun notarytool submit` returned status **Accepted** with a notarization ID.
- `xcrun stapler staple` returned success.
- Upload of the resulting `.dmg` and `.app.tar.gz` succeeded.
- The post-release `attest-build-provenance` step ran without error.
- The `d314b25` secrets guard saw all six Apple secrets populated and let the build proceed.

The CI pipeline has no step that **actually launches the produced binary** to verify it can `exec`. Once the binary leaves CI and reaches a real Mac, it's too late to know.

## Why diagnosis took multiple iterations

Several misleading factors compounded:

1. **The CI log "looks" successful.** Reading the `tauri-action` output for the failing 0.10.x runs, all signing markers are present — "1 identity imported", "Signing with identity \*\*\*", "Notarizing Finished with status Accepted", "Stapling app...". A casual reader would conclude signing worked.

2. **The crash report is ambiguous.** `codeSigningID=""` and `codeSigningFlags=0x01000000` (CS*LINKER_SIGNED) make the binary \_look* like it was never `codesign`ed at all. The natural first hypothesis is "the workflow skipped the signing step" — not "the workflow signed correctly, but the kernel revoked the signature at exec time due to an entitlement-vs-cert mismatch".

3. **LaunchServices caching prolonged the bug.** After 0.10.22 fixed the entitlements, macOS still launched the stale 0.10.20 `.app` from `~/Downloads/` rather than the freshly-installed 0.10.22 from `/Applications`, because LaunchServices' registered bundle path hadn't been refreshed. The bundleInfo version field in the crash report was the decisive tell — it said `0.10.20` while the user believed they were testing `0.10.22`.

4. **Two of the bisect hypotheses were wrong:**
   - "Reverting `5f69fc0` because `strip = "none"` produces malformed Mach-Os" — false. Strip change shipped fine in 0.10.16 and was unrelated.
   - "An Intel-runner-specific signing bug in tauri-action on `macos-15-intel`" — false. The x64 build log eventually showed identical signing markers to aarch64. The bug affected both arches equally; only Intel hardware happened to be the test platform.

## The fix

`a4631be` (committed against `main` after `v0.10.21`):

- `src-tauri/Entitlements.plist` — Removed `<key>aps-environment</key>` and added a multi-line comment explaining the iOS/macOS split. The plist now contains only entitlements valid for both targets:
  - Hardened Runtime (implicit)
  - `com.apple.security.app-sandbox` (was present pre-30b111c)
  - `com.apple.security.network.client`
  - `com.apple.security.cs.allow-jit`
  - `com.apple.security.cs.allow-unsigned-executable-memory`
- `scripts/inject-ios-signing.cjs` — Was a regex-patch that toggled the `aps-environment` value between `development` and `production`. Now it **inserts** the key before `</dict>` if missing, or replaces the value if present. Idempotent. Runs only as part of the iOS build pipeline; macOS desktop builds never invoke it, so the bundle stays APNs-free.

After the fix, `codesign -d --entitlements - "Forward Email.app"` on a downloaded 0.10.22 bundle shows no `aps-environment` key.

## Prevention

### Already in place

1. **Signing-secrets guard (`d314b25`).** Catches the _related_ failure mode where macOS env vars are missing. Doesn't catch this exact bug but prevents the "release shipped completely unsigned" sub-class.

### Recommended next steps

1. **Split entitlements per platform.** The right shape is two files:

   ```
   src-tauri/Entitlements.macos.plist   ← keys valid for Developer ID + Hardened Runtime
   src-tauri/Entitlements.ios.plist     ← keys for iOS (including aps-environment)
   ```

   `tauri.conf.json` references `Entitlements.macos.plist`; the iOS build pipeline references `Entitlements.ios.plist`. Static, no injection script needed. The class of "iOS-only entitlement leaks into macOS desktop" becomes structurally impossible. This is the single highest-leverage prevention step.

2. **Pre-launch smoke test in CI.** Add a step after `tauri-action` finishes that actually `exec`s the just-built binary on the same runner with `--version` or a similar harmless flag. If the binary won't launch on the build runner due to entitlement/signing problems, fail the release. Sketch:

   ```yaml
   - name: Smoke-test macOS bundle launches
     if: runner.os == 'macOS'
     run: |
       APP="src-tauri/target/${{ matrix.target }}/release/bundle/macos/Forward Email.app"
       "$APP/Contents/MacOS/forwardemail-desktop" --version || {
         echo "::error::Built bundle won't exec on the build runner"
         codesign -d --entitlements - "$APP" || true
         exit 1
       }
   ```

   Caveat: GitHub-hosted runners may not satisfy all entitlement-validation checks (no UI, restricted launchd context). Worth prototyping — even partial coverage is better than none.

3. **Entitlement-cert audit step.** A short Bash check that diffs the bundle's entitlements against an allowlist of entitlements known to be valid for the Developer ID cert. The allowlist for Developer ID + Hardened Runtime is finite and stable:

   ```bash
   ALLOWED=(
     "com.apple.security.app-sandbox"
     "com.apple.security.network.client"
     "com.apple.security.cs.allow-jit"
     "com.apple.security.cs.allow-unsigned-executable-memory"
     "com.apple.security.cs.allow-dyld-environment-variables"
     "com.apple.security.cs.disable-library-validation"
   )
   FOUND=$(codesign -d --entitlements - "$APP" 2>&1 |
           plutil -convert json -o - - |
           jq -r 'keys[]')
   for key in $FOUND; do
     [[ " ${ALLOWED[*]} " == *" $key "* ]] || {
       echo "::error::Disallowed entitlement on macOS Developer ID bundle: $key"
       exit 1
     }
   done
   ```

4. **Release-notes blurb for upgraders.** Users upgrading from a broken 0.10.17–0.10.21 may have a stale `.app` cached by macOS LaunchServices. Include a one-line note in 0.10.22's release description:

   > **Upgrading from 0.10.17–0.10.21?** Run `mdfind 'kMDItemCFBundleIdentifier == "net.forwardemail.mail"'` in Terminal and delete any results outside `/Applications` before installing 0.10.22.

5. **Document the entitlement gotcha** in `docs/desktop-build-ci.md` so the next person adding push / keychain / network entitlements knows to think about both targets.

### Lower-priority / defer

- **Switch to a universal binary** to collapse the arch matrix and reduce surface. Independent question, valuable separately.
- **Drop Intel** when Apple removes Rosetta — same reasoning.
- **Pin `tauri-action` to a SHA, not `v0`.** The current pin is a SHA already (`fce9c61…`). Good. Keep it that way.

## Detection checklist

If a similar symptom appears in a future release:

1. Get the crash report. Check `codeSigningID`, `codeSigningTeamID`, `codeSigningFlags`. If `codeSigningID=""` and flags are `0x01000000` _but_ the CI signing log shows real activity, the answer is almost certainly an entitlement-vs-cert mismatch, not a missing signature.
2. Run `codesign -d --entitlements - /Applications/Forward\ Email.app` on the bundle. Compare its keys against the Developer ID's authorization scope.
3. Check the bundle's reported version (`Version: X.Y.Z` in the crash report's translated header, or `defaults read .../Contents/Info.plist CFBundleShortVersionString`) **before** assuming you're testing the version you think you are. macOS LaunchServices caches.

## Files referenced

- `src-tauri/Entitlements.plist` — the entitlements file, now sans APNs.
- `src-tauri/tauri.conf.json:46` — `bundle.macOS.entitlements` pointing at the plist.
- `scripts/inject-ios-signing.cjs:154+` — iOS-only insertion of `aps-environment`.
- `.github/workflows/release-desktop.yml` — desktop release matrix.
- Commit `30b111c` — introduced the bug.
- Commit `d314b25` — secrets guard.
- Commit `a4631be` — fix.
