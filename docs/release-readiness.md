# Release Readiness (v1)

Status of every distribution channel, the accounts still to be opened, and the
ordered checklist to the v1.0.0 release. This file is the source of truth for
"where are we"; the per-channel runbooks live in
[distribution-publishing.md](./distribution-publishing.md),
[store-submission.md](./store-submission.md), and [SECRETS.md](./SECRETS.md).

Last verified against the live repository, GitHub settings, and the v0.13.4
release run on **2026-09-13**.

## Where we stand

Every `v*` tag already ships signed macOS, Linux, Android, and iOS binaries to
GitHub Releases, uploads the IPA to TestFlight, uploads the AAB to the Google
Play internal track, and deploys the web app. What is left for v1 is accounts,
store listings, one Windows certificate, and paperwork.

| Channel                        | Built by CI            | Signed                                 | Published today                     | State             |
| ------------------------------ | ---------------------- | -------------------------------------- | ----------------------------------- | ----------------- |
| Web / PWA                      | Yes                    | n/a                                    | Cloudflare R2 + Worker on every tag | Live              |
| GitHub Releases                | Yes                    | macOS notarized, Android + iOS signed  | Every tag, with SHA256SUMS and SLSA | Live              |
| Desktop auto-update            | Yes                    | minisign `.sig` + `latest.json`        | Every tag                           | Live              |
| Windows installers             | Yes                    | **Unsigned** (no certificate yet)      | GitHub Releases                     | Live, SmartScreen |
| iOS App Store                  | Yes                    | Apple Distribution                     | TestFlight only                     | Pending listing   |
| Google Play                    | Yes                    | Upload key                             | Internal track only                 | Pending listing   |
| Android sideload / Obtainium   | Yes                    | Release key                            | `_fdroid.apk` on every release      | Live              |
| Self-hosted F-Droid repository | Yes                    | Index key not created                  | Opt-in lane, off                    | Dark              |
| Snap Store                     | Yes                    | Store signs on upload                  | Opt-in lane, off; name unregistered | Dark              |
| Homebrew tap                   | n/a                    | Reuses the DMGs                        | Opt-in lane, off; tap repo missing  | Dark              |
| Mac App Store                  | No                     | Needs Mac App Distribution + Installer | None                                | Not built         |
| Microsoft Store                | No                     | Needs Authenticode                     | None                                | Not built         |
| winget                         | No                     | Recommended, not required              | None                                | Not built         |
| Flathub                        | Dispatch-only PR build | n/a                                    | None                                | Deferred past v1  |
| F-Droid official catalog       | n/a                    | n/a                                    | n/a                                 | Ineligible (BUSL) |
| homebrew-cask (core)           | n/a                    | n/a                                    | n/a                                 | Not yet notable   |

Notes:

- Homebrew core rejects repositories under 75 stars, 30 forks, or 30 watchers.
  The repository is at 35 / 8 / 3, so the first-party tap is the path until then.
- F-Droid's official catalog requires an OSI/FSF/DFSG-approved license; BUSL-1.1
  is none of those. The self-hosted repository is the supported route.
- Flathub is deferred by decision on 2026-09-13. See the note at the top of the
  Flathub section in [distribution-publishing.md](./distribution-publishing.md#flathub-flatpak).

## Accounts and credentials

### In place

| Account                            | Evidence                                                                | Notes                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Apple Developer Program (org)      | Developer ID + Apple Distribution certs, App Store profile, ASC API key | Team `FH83QMJS7P`. Mac App Store still needs two more certificates and a profile.          |
| App Store Connect record (iOS)     | TestFlight upload succeeds each release                                 | Listing state unknown from the repo; a macOS platform must be added to the record for MAS. |
| Google Play Console (organization) | `GOOGLE_PLAY_SERVICE_ACCOUNT` set; internal-track upload succeeds       | Org account, so the 12-testers / 14-days rule for new personal accounts does not apply.    |
| Firebase project                   | `GOOGLE_SERVICES_JSON_BASE64` set                                       | Dual-provider Android job only.                                                            |
| Android release keystore           | Four `ANDROID_*` secrets                                                | Signs both the Play AAB and the Google-free APK. Keep an offline backup.                   |
| Tauri updater key                  | `TAURI_SIGNING_PRIVATE_KEY`; pubkey in `tauri.conf.json`                | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is unset, which is correct only if the key has none.  |
| Cloudflare R2 + Workers            | Five secrets + `R2_BUCKET`                                              | Working.                                                                                   |
| GitHub Pages                       | Enabled, source = GitHub Actions                                        | Ready for the F-Droid lane.                                                                |

All of the above are stored as **repository** secrets, not in the `release`
environment the docs describe. See the note in
[SECRETS.md](./SECRETS.md#where-each-value-belongs) for the migration.

### Still needed

| Account or credential                | Unlocks                            | Owner        | Notes                                                                                                                                     |
| ------------------------------------ | ---------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Windows code-signing certificate     | Signed installers, Microsoft Store | Owner        | Azure Trusted Signing (about $10/month, US orgs) or an OV certificate. Procedure in SECRETS.md. Then set `WINDOWS_SIGNING_REQUIRED=true`. |
| Snapcraft publisher + name           | Snap Store                         | Owner        | Free. `snapcraft register forwardemail-mail`, then `snapcraft export-login` scoped to that snap and the stable channel.                   |
| F-Droid repository index key         | Self-hosted F-Droid repo           | Release eng. | Self-generated PKCS#12, alias `forwardemail-fdroid-repo`. Publish the fingerprint only after the first Pages deploy.                      |
| Homebrew tap repository + token      | Homebrew                           | Owner        | Create `forwardemail/homebrew-forwardemail` from `homebrew/`; fine-grained PAT with Contents and Pull requests write.                     |
| Mac App Store certificates + profile | Mac App Store                      | Owner        | Mac App Distribution and Mac Installer Distribution certificates, Mac App Store provisioning profile.                                     |
| Microsoft Partner Center             | Microsoft Store                    | Owner        | Registration is free for companies. Publisher name must differ from the product name (already `Forward Email LLC`).                       |
| Demo reviewer account                | Apple and Google review            | Support      | A dedicated alias seeded with mail, contacts, and calendar. Both reviews require working credentials for an email client.                 |
| `MATRIX_TOKEN` (optional)            | Release notifications              | Anyone       | Not set; the notify job succeeds without sending.                                                                                         |

## Store policy notes

- **Apple, iOS.** Hard blockers from the June audit are closed (in-app account
  deletion, encryption declaration, photo-library string). Privacy manifest and
  explicit universal device family were added 2026-09-13. Remaining: App
  Privacy labels, 6.7-inch and 12.9-inch iPad screenshots, age rating, review
  notes with the demo account, then submit the current TestFlight build.
- **Apple, Mac App Store.** Needs a separate build lane: App Sandbox with
  user-selected file entitlements (`src-tauri/Entitlements.appstore.plist`),
  the updater compiled out (guideline 2.4.5), the mandatory category (now set),
  an embedded provisioning profile (`src-tauri/tauri.appstore.conf.json`),
  a pkg from `productbuild`, and an `altool` upload. Validate the file picker on
  a signed build; the sandbox without file entitlements crashed it in June.
- **Google Play.** Organization account. Needs listing, feature graphic
  1024x500, at least two phone screenshots, Data Safety form, content rating,
  then promotion internal → closed → production. `targetSdk 36` is current.
- **Microsoft Store and winget.** Store registration is free for companies.
  Tauri's supported route is submitting the signed EXE/MSI as a Win32 app with
  the WebView2 offline installer and self-managed updates. winget needs only a
  manifest PR (NSIS silent flag `/S`); signing is recommended, not required.
- **Flathub.** Deferred. Requires BUSL redistribution confirmation and, since
  2026-05-29, disclosure of AI-assisted code with reviewer discretion to
  reject; AI tools must not open the submission PR.

## Pipeline hardening completed 2026-09-13

- Production web deploy now requires the E2E, CI, and desktop gates to succeed
  (it previously ran whenever `publish` was skipped, including on a failed gate).
- Release promotion moved after the mobile builds and checksums; the desktop
  workflow no longer publishes the draft when called from `release.yml`.
- Windows signing is wired for real (certificate import + thumbprint) with a
  per-row warning until a certificate exists and a `WINDOWS_SIGNING_REQUIRED`
  fail-closed switch.
- Secrets no longer flow to the E2E and screenshot workflows; the screenshot
  job no longer keeps a push token in `.git/config`; the Android keystore is
  passed through env; the clear-manifest PR comment no longer interpolates diff
  text into JavaScript; every action that receives a secret is SHA-pinned.
- The README screenshot refresh is no longer a required release job.
- The release CI gate runs `test:unit` instead of the mutating `test` script;
  the Worker bucket rewrite matches any bucket name and fails on an empty
  `R2_BUCKET`; the iOS preflight checks the dedicated certificate password.
- Bundle metadata (publisher, homepage, copyright, license, category,
  descriptions) is set in `tauri.conf.json`; `PrivacyInfo.xcprivacy` and
  `TARGETED_DEVICE_FAMILY` are applied to the iOS project at build; the
  metainfo release list and Flatpak tag are bumped by `sync-version.cjs`.

## v1 release checklist

Ordered so nothing goes to external review before the pipeline is trustworthy.

### Phase 0. Pipeline (done 2026-09-13, verify on the next tag)

- [x] Gate `deploy` on the E2E, CI, and desktop results
- [x] Promote the release only after mobile assets and checksums land
- [x] Wire Windows signing and warn until the certificate exists
- [x] Secret hygiene: env passthrough, script-injection fix, SHA pins, narrowed `secrets: inherit`
- [x] README screenshots non-required; `test:unit` in the gate; bucket rewrite fixed
- [ ] Move all secrets into the `release` environment and add required reviewers
- [ ] Cut a patch release and confirm a full green run, then confirm a deliberate gate failure on a branch does not deploy

### Phase 1. Metadata and native layer (done 2026-09-13 unless noted)

- [x] `bundle` block filled in `tauri.conf.json`
- [x] `PrivacyInfo.xcprivacy` copied into the Xcode target at build
- [x] `TARGETED_DEVICE_FAMILY` set explicitly (universal)
- [x] Mac App Store entitlements and config overlay scaffolded (not wired into CI)
- [x] Photo-library string unified; store-submission doc reconciled with the real permission set
- [x] Metainfo release list and Flatpak tag kept current by `sync-version.cjs`
- [ ] Store-flavored Windows config with `webviewInstallMode: offlineInstaller` (Microsoft Store)
- [ ] Mac App Store build lane in `release-desktop.yml` (universal target, updater feature off, `productbuild`, `altool`)

### Phase 2. Accounts and credentials (owner tasks, parallel with Phase 1)

- [ ] Windows certificate stored as `release` secrets; `WINDOWS_SIGNING_REQUIRED=true`
- [ ] Snapcraft publisher account, `forwardemail-mail` registered, `SNAPCRAFT_STORE_CREDENTIALS`
- [ ] F-Droid index keystore generated offline; `FDROID_KEYSTORE_BASE64` + `FDROID_KEYSTORE_PASSWORD`; backup kept
- [ ] `forwardemail/homebrew-forwardemail` created from `homebrew/`; `HOMEBREW_TAP_TOKEN`
- [ ] Mac App Distribution + Mac Installer Distribution certificates; Mac App Store provisioning profile; macOS platform on the ASC record
- [ ] Microsoft Partner Center company account verified
- [ ] Demo reviewer alias seeded with mail, contacts, calendar
- [ ] Confirm Play App Signing enrollment and that the CI keystore is the upload key
- [ ] Optional: `MATRIX_TOKEN` as a repository secret

### Phase 3. Turn on channels and submit (one release-candidate tag per round)

- [ ] `PUBLISH_SNAP_STORE=true`; tag; verify `snap info forwardemail-mail`; pass the first store review
- [ ] `PUBLISH_FDROID_REPOSITORY=true`; tag; confirm `index-v1.jar` serves from Pages; publish the fingerprint in the README
- [ ] `PUBLISH_HOMEBREW_TAP=true`; tag; merge the first cask PR; test `brew install --cask forwardemail/forwardemail/forward-email`
- [ ] winget manifest PR for the signed x64 and arm64 installers (optionally automate with `wingetcreate`)
- [ ] iOS: complete the App Store Connect listing, privacy labels, screenshots, age rating, review notes; submit the TestFlight build
- [ ] Android: complete listing, Data Safety, content rating, feature graphic; promote internal → closed → production
- [ ] Mac App Store: smoke-test the sandboxed signed pkg (file picker, mailto handler, attachments); submit
- [ ] Microsoft Store: submit the signed offline installer as a Win32 app
- [ ] Verify the desktop updater across one real version hop on all three OSes, including signed Windows

### Phase 4. Cut 1.0.0

- [ ] Replace every "Coming Soon" and "pending" cell in the README downloads table with real links
- [ ] Re-verify SECRETS.md, store-submission.md, and distribution-publishing.md against what runs
- [ ] Tag v1.0.0 with `pnpm release`; confirm every lane green in `release-summary`
- [ ] Release both store listings to production on the same day; announce
- [ ] Post-launch backlog: push notifications (1.1), Flathub decision, svelte-check ratchet, homebrew-cask core once notability is met

## Verified sources

- Google Play: [testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465)
- Microsoft Store: [free company onboarding](https://learn.microsoft.com/en-us/windows/apps/publish/whats-new-company-developer), [MSIX requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- Tauri: [Microsoft Store](https://v2.tauri.app/distribute/microsoft-store/), [App Store](https://v2.tauri.app/distribute/app-store/), [Windows signing](https://v2.tauri.app/distribute/sign/windows/)
- Microsoft: [code signing options and Trusted Signing](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- winget: [submit a manifest](https://learn.microsoft.com/en-us/windows/package-manager/package/repository)
- Homebrew: [acceptable casks](https://docs.brew.sh/Acceptable-Casks)
- F-Droid: [inclusion policy](https://f-droid.org/en/docs/Inclusion_Policy/)
- Flathub: [requirements](https://docs.flathub.org/docs/for-app-authors/requirements), [submission](https://docs.flathub.org/docs/for-app-authors/submission)
- Apple: [program enrollment](https://developer.apple.com/help/account/membership/program-enrollment/), [review guidelines](https://developer.apple.com/app-store/review/guidelines/)
