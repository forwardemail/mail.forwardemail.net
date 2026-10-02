# Store Submission & Compliance Pack

Answers for the App Store Connect and Google Play Console submissions, taken from the app and
server code. Where a value is a judgment call it is marked **[CONFIRM]**.

Pipeline state: every `v*` tag uploads the signed IPA to TestFlight and the signed AAB to the
Google Play **internal** track; what remains is console metadata, listing assets, and promotion
(see [release-readiness.md](./release-readiness.md)).

---

## 1. App facts

| Field                       | Value                                                         | Source                                         |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| Product name                | Forward Email                                                 | `src-tauri/tauri.conf.json`                    |
| Bundle ID (iOS/Android)     | `net.forwardemail.mail`                                       | `tauri.conf.json`                              |
| Version                     | the `version` in `package.json`; App Store Connect must match | `scripts/sync-version.cjs`                     |
| iOS min version             | 16.0                                                          | `tauri.conf.json` `iOS.minimumSystemVersion`   |
| Android minSdk / targetSdk  | 24 (Android 7.0) / 36                                         | manifest                                       |
| Apple Team ID               | `FH83QMJS7P`                                                  | `tauri.conf.json`                              |
| Privacy policy URL          | `https://forwardemail.net/en/privacy`                         | the app links `/privacy`, which redirects here |
| Account deletion in the app | Settings → General → **Delete account**                       | `Settings.svelte`                              |
| Account deletion (public)   | `https://forwardemail.net/en/faq#how-do-i-delete-my-account`  | Play's Delete account URL                      |
| Support contact             | support@forwardemail.net (feedback emails here)               | `FeedbackModal.svelte`                         |
| Backend API                 | `https://api.forwardemail.net` (CSP-pinned)                   | `tauri.conf.json` CSP                          |

**Device family: universal (iPhone + iPad).** `scripts/configure-ios-store-metadata.cjs` sets
`TARGETED_DEVICE_FAMILY = "1,2"` explicitly in the generated project (it was previously
unset and universal only by Xcode default). App Store Connect therefore requires **iPad
screenshots** as well (see §6).

---

## 2. Hard-blocker checklist (these cause guaranteed rejection if missing)

| Requirement                                  | Status            | Notes                                                                                                                    |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| In-app account deletion                      | ✅ done           | Settings → General → **Delete account** → web flow. Distinct from Sign out.                                              |
| No purchase or sign-up links in store builds | ✅ done           | `src/utils/store-policy.js` hides Increase storage, the storage meter link, Sign up and the demo's sign-up prompts (§4). |
| Web inspector left out of release builds     | ✅ done           | The `devtools` Cargo feature is opt-in (`WEB_INSPECTOR=true`); on iOS it sets a private WebKit key.                      |
| iOS encryption declaration                   | ✅ done           | `ITSAppUsesNonExemptEncryption=false` while the app is not offered in France (§4).                                       |
| `NSPhotoLibraryUsageDescription`             | ✅ done           | injected at build (image picker for attachments/avatars).                                                                |
| Privacy manifest (`PrivacyInfo.xcprivacy`)   | ✅ done           | Declares the same data types as the App Privacy answers in §4.                                                           |
| Privacy policy covers the apps               | ⚠️ **publish it** | The forwardemail.net policy has an Apps and Webmail section; deploy it before submitting.                                |
| Privacy labels / Data Safety form            | ⬜ fill in        | Exact answers in §4 / §5.                                                                                                |
| Screenshots per device class                 | ⬜ upload         | Specs in §6.                                                                                                             |
| Apple deletion path is reachable             | ✅ done           | Reviewer follows the link; it lands on the deletion page directly.                                                       |

---

## 3. What the app sends and what the server keeps (the basis for all label answers)

**From the app:**

- **Mail, contacts, calendars, labels and filters:** synced with the user's own Forward Email
  account over HTTPS and WSS (`api.forwardemail.net`) and cached on the device in IndexedDB
  (encrypted at rest when App Lock is on).
- **Sign-in:** the alias address and its generated password, stored on the device and sent with
  each API request.
- **Search:** runs on the device and on the server at once; server search terms travel in the
  request URL.
- **Push registration:** the push token, the platform and a device name built from the WebView
  user agent (`background-service.js`).
- **Feedback (user-initiated):** Settings → About & Help → **Send Feedback** emails
  support@forwardemail.net from the user's alias. System info, JS errors, the end of the app log
  and network errors are optional, off by default, and redacted (`feedback-payload.ts`).
- **Report spam:** forwards the original message to `abuse@forwardemail.net` (configurable).
- **No analytics, crash reporting or ad SDKs.** The iOS app and the Google-free Android build have
  no third-party SDKs. The Play build includes Firebase Cloud Messaging, which sends Google a
  Firebase installation ID, the app version and the Firebase user agent.
- **Remote images** in mail load from the sender's servers unless the user turns on **Block all
  external images by default**. Tracking pixels are blocked by default. There is no image proxy.

**On the server (forwardemail.net):**

- **API analytics:** one event per API call with the alias ID, the request path, and the browser,
  OS and device type; kept 30 days.
- **Error logs:** failed or slow requests, with the IP address, the full URL (search terms
  included) and the user; kept 7 days.
- **Server logs:** may hold the IP address and URL of each request for up to 30 days.
- **Push tokens:** token, platform, device name and alias; kept up to a year after last use, and
  deleted on sign-out, after 3 failed deliveries, and with the alias or the account.
- **New-mail notifications:** on iOS, macOS and the Play build, the sender, subject and a preview
  pass through Apple (APNs) or Google (FCM). UnifiedPush and Web Push notifications are
  end-to-end encrypted.

The privacy policy describes all of this in its Apps and Webmail section.

---

## 4. Apple: App Privacy ("nutrition labels")

In Apple's model, "collect" = transmitted off the device and kept longer than the request needs.
Select these data types; every one is **linked to the user** and **not used for tracking**:

| Data type                              | Purposes                     | What it covers                                                      |
| -------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| Contact Info → Email Address           | App Functionality            | The alias address used to sign in.                                  |
| Contacts → Contacts                    | App Functionality            | The address book synced to Forward Email.                           |
| User Content → Emails or Text Messages | App Functionality            | Mail sent, received and drafted.                                    |
| User Content → Photos or Videos        | App Functionality            | Photos attached to mail or added to contacts.                       |
| User Content → Other User Content      | App Functionality            | Calendar events, tasks, file attachments, labels and filters.       |
| User Content → Customer Support        | App Functionality            | Feedback, which is sent from the user's alias.                      |
| Search History → Search History        | App Functionality            | Search terms in request URLs, kept in error logs for 7 days.        |
| Identifiers → User ID                  | App Functionality, Analytics | Alias and account IDs with push tokens and API analytics.           |
| Identifiers → Device ID                | App Functionality            | The push token.                                                     |
| Usage Data → Product Interaction       | Analytics                    | API analytics: the request path and alias ID per call, 30 days.     |
| Diagnostics → Crash Data               | App Functionality            | App errors and the end of the app log, when attached to feedback.   |
| Diagnostics → Other Diagnostic Data    | App Functionality, Analytics | Error logs; device and OS type in analytics; push token user agent. |

- **Everything else:** not collected.
- **Tracking:** none. No IDFA, no third-party analytics, no cross-app tracking, so no App
  Tracking Transparency prompt.
- `src-tauri/PrivacyInfo.xcprivacy` declares the same twelve types, and
  `tests/unit/configure-ios-store-metadata.test.ts` checks them.

**Purchases (Guidelines 3.1.1 and 3.1.3(f)):** the app sells nothing, and store builds (iOS, and
Android with Firebase) show no billing, storage upgrade or sign-up links
(`src/utils/store-policy.js`). The review notes should cite 3.1.3(f): a free companion app for a
paid email service.

**Encryption / export compliance (`ITSAppUsesNonExemptEncryption` = `false`):** besides the
system's TLS, the app ships standard encryption: OpenPGP.js for mail, libsodium
(XSalsa20-Poly1305, BLAKE2b) for App Lock, and Argon2id for App Lock PINs and device pairing
codes. Under App Encryption Documentation, answer **Standard encryption algorithms instead of, or
in addition to, using or accessing the encryption within Apple's operating system**, then **No**
to availability in France. That answer needs no documentation, so the flag stays false and builds
skip the compliance prompt. To add France later: file the French encryption declaration, upload it
in App Store Connect, and set the `IOS_ENCRYPTION_COMPLIANCE_CODE` repository variable to the code
Apple issues (`scripts/ios-export-compliance.cjs`).

**Privacy choices / usage strings:**

- `NSPhotoLibraryUsageDescription`: present (image picker). String: _"Forward Email uses your
  photo library so you can attach photos to emails and set profile pictures."_
- `NSCameraUsageDescription`: present. QR device pairing scans a code shown by another device
  (`scripts/configure-mobile-camera.cjs`). No camera data leaves the device.
- `NSLocalNetworkUsageDescription`: development builds only. `scripts/ios-dev.sh` sets
  `IOS_DEV_LOCAL_NETWORK=1` for `tauri ios dev`; release builds leave the string out.
- **Not needed (correctly absent):** `NSFaceIDUsageDescription` (biometric is WebAuthn/passkeys
  via the system, not `LocalAuthentication`), `NSUserTrackingUsageDescription` (no ATT/IDFA),
  location strings.

**Push notifications:** APNs support is implemented for iOS. `inject-ios-signing.cjs` generates
the iOS-only `aps-environment` entitlement while leaving the shared macOS entitlements unchanged.
The App Review note should state that Forward Email uses push notifications for new-mail delivery
and that notification permission is requested at runtime.

**Account deletion:** Settings → General → **Delete account** →
`forwardemail.net/my-account/security`. That page needs the forwardemail.net website login, which
differs from the alias password, so the review notes should give reviewers both.

**Age rating:** answer **Yes** to Messaging and Chat (email is direct messaging), **No** to
Unrestricted Web Access (links open in the browser; there is no in-app browser) and **None** or
**No** to everything else. The calculated rating is 4+; choose **Override to Higher Age Rating:
13+**, because the Terms require users to be 13 or older.

---

## 5. Google: Play Console Data Safety

| Question                                                  | Answer                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Does your app collect or share any of the required types? | **Yes** (collected; nothing shared)                                                                       |
| Is all user data encrypted in transit?                    | **Yes** (HTTPS and WSS)                                                                                   |
| Do you provide a way for users to request deletion?       | **Yes**                                                                                                   |
| Account creation                                          | **My app does not allow users to create an account** (the Play build has no sign-up link; people sign in) |
| Delete account URL (if asked)                             | `https://forwardemail.net/en/faq#how-do-i-delete-my-account`                                              |

**Data types (all collected, none shared, none processed ephemerally):**

| Data type                                   | Required or optional | Purposes                                         |
| ------------------------------------------- | -------------------- | ------------------------------------------------ |
| Personal info → Email address               | Required             | App functionality, Account management            |
| Personal info → User IDs                    | Required             | App functionality, Account management, Analytics |
| Messages → Emails                           | Required             | App functionality                                |
| Photos and videos → Photos, Videos          | Optional             | App functionality                                |
| Audio files → Other audio files             | Optional             | App functionality                                |
| Files and docs                              | Optional             | App functionality                                |
| Calendar → Calendar events                  | Optional             | App functionality                                |
| Contacts → Contacts                         | Optional             | App functionality                                |
| App activity → App interactions             | Required             | Analytics                                        |
| App activity → In-app search history        | Optional             | App functionality                                |
| App activity → Other user-generated content | Optional             | App functionality                                |
| App info and performance → Crash logs       | Optional             | App functionality                                |
| App info and performance → Diagnostics      | Required             | App functionality, Analytics                     |
| Device or other IDs                         | Required             | App functionality                                |

**Data shared with third parties:** none. Sending mail to other people is a user-initiated
transfer, and Firebase delivers push as a service provider. Device or other IDs covers the
Firebase installation ID and the push token.

**Advertising ID:** **No**, after checking that the merged `AndroidManifest.xml` of the Play build
has no `com.google.android.gms.permission.AD_ID` (§7).

---

## 6. Screenshots & store assets

**iOS (App Store Connect):**

- **iPhone 6.9"** (1320×2868): App Store Connect scales these for the smaller iPhone sizes.
- **iPad 13"** (2064×2752): **required** because the app is universal (see §1).
- App icon 1024×1024 (no alpha), already in `src-tauri/icons`.

**Google Play:**

- Phone screenshots: **min 2**, up to 8 (16:9 or 9:16, ≥320px).
- **Feature graphic** 1024×500 (required for the listing).
- App icon 512×512.
- Tablet screenshots optional.

Suggested shot list (both stores): inbox/message list, reader, compose, mobile search overlay,
settings/account. None are in the repo (`e2e-webview/screenshots` are test artifacts).

---

## 7. Permissions declared (low review friction)

**Android:** `INTERNET`, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` (notification
plugin), `VIBRATE`, and `CAMERA` (QR device pairing; `android.hardware.camera` is declared
`required="false"` so camera-less devices stay eligible). The Play build also contains the
generated FCM service and merges Firebase Messaging's own manifest entries; both builds contain the
first-party UnifiedPush connector. It requests no SMS, location, storage, contacts, or
accessibility permission. Deep-link intent filters use `mailto:` and `forwardemail:` custom
schemes, so no `assetlinks.json` file is needed. `MainActivity` is the only exported activity, and
the FileProvider is not exported. The merged manifest is generated at build time; check it before
answering Play's Advertising ID question.

**iOS:** `NSPhotoLibraryUsageDescription` (image picker), `NSCameraUsageDescription` (QR pairing),
the `PrivacyInfo.xcprivacy` manifest, and the iOS-only `aps-environment` entitlement for APNs.
`NSLocalNetworkUsageDescription` is in development builds only. Custom-scheme deep links do not
require Associated Domains.

---

## 8. Open items / decisions to confirm

1. Deploy the forwardemail.net privacy policy with its Apps and Webmail section before submitting;
   Google checks the Data safety answers against it.
2. Set the App Store Connect version to the build's version (App Store Connect suggests 1.0).
3. ✅ Device family is universal (set explicitly). Upload iPad 13" screenshots.
4. Complete a physical-device APNs smoke test and include the new-mail push behavior in the App
   Review notes.
5. ✅ iOS TestFlight secrets are provisioned; every release uploads to TestFlight.
6. ✅ Play Console app exists; `GOOGLE_PLAY_SERVICE_ACCOUNT` is set and every release uploads the
   AAB to the `internal` track. Remaining: listing, Data Safety, content rating, feature graphic,
   then promote internal → closed → production.
7. Create a **reviewer account** (a dedicated alias seeded with mail, contacts, and calendar
   entries, plus its website login for the deletion page). Both Apple and Google review require
   working credentials for an email client.
8. **[CONFIRM]** France stays out of App Store availability until the encryption declaration is
   filed (§4).
9. Leave the `WEB_INSPECTOR` repository variable unset for store releases; set it to `true` only
   for a debugging build.
