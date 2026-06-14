# Store Submission & Compliance Pack

Turnkey answers for the App Store Connect and Google Play Console submissions, grounded in
the actual app code. Where a value is a judgment call or needs your confirmation it is
marked **[CONFIRM]**.

Last verified against `main` on 2026-06-13.

---

## 1. App facts

| Field                      | Value                                            | Source                                       |
| -------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Product name               | Forward Email                                    | `src-tauri/tauri.conf.json`                  |
| Bundle ID (iOS/Android)    | `net.forwardemail.mail`                          | `tauri.conf.json`                            |
| iOS min version            | 16.0                                             | `tauri.conf.json` `iOS.minimumSystemVersion` |
| Android minSdk / targetSdk | 24 (Android 7.0) / 36                            | manifest                                     |
| Apple Team ID              | `FH83QMJS7P`                                     | `tauri.conf.json`                            |
| Privacy policy URL         | `https://forwardemail.net/privacy`               | linked in-app (Settings + About)             |
| Account-deletion URL       | `https://forwardemail.net/my-account/security`   | in-app "Delete account"                      |
| Support contact            | support@forwardemail.net (feedback emails here)  | `feedback-payload.ts`                        |
| Backend API                | `https://api.forwardemail.net` only (CSP-pinned) | `tauri.conf.json` CSP                        |

**Device family [CONFIRM]:** the iOS `Info.plist` carries `UISupportedInterfaceOrientations~ipad`,
implying a **universal (iPhone + iPad)** build. Confirm `TARGETED_DEVICE_FAMILY`; if universal,
you must supply **iPad screenshots** as well (see §6).

---

## 2. Hard-blocker checklist (these cause guaranteed rejection if missing)

| Requirement                       | Status             | Notes                                                                               |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------------- |
| In-app account deletion           | ✅ done            | Settings → **Delete account** → web flow. Distinct from Sign out.                   |
| iOS encryption declaration        | ✅ done            | `ITSAppUsesNonExemptEncryption=false` injected at build (`inject-ios-signing.cjs`). |
| `NSPhotoLibraryUsageDescription`  | ✅ done            | injected at build (image picker for attachments/avatars).                           |
| Privacy policy URL                | ⚠️ **publish it**  | App links `forwardemail.net/privacy` — make sure that page is live.                 |
| Privacy labels / Data Safety form | ⬜ fill in console | Exact answers in §4 / §5.                                                           |
| Screenshots per device class      | ⬜ produce         | Specs in §6.                                                                        |
| Apple deletion path is reachable  | ✅ done            | Reviewer will follow the link — it lands on the deletion page directly.             |

---

## 3. What the app actually collects (the basis for all label answers)

Verified from `feedback-payload.ts`, `error-logger.ts`, `redaction.ts`, the CSP, and a repo-wide
search for analytics/tracking SDKs.

- **Email content** (messages, attachments, contacts, calendar) — the core function. Synced
  to/from the user's **own** Forward Email account over TLS (`api.forwardemail.net`), cached
  locally in IndexedDB. Never sent to a third party.
- **Account email + credential** (alias password / API key) — stored on-device (localStorage,
  optionally encrypted via the app-lock vault), sent to `api.forwardemail.net` for auth only.
- **Feedback (user-initiated only)** — when the user taps **Send Feedback**, the app emails
  support@ with: user-agent, platform, app version, a non-identifying correlation ID, and
  **redacted** diagnostic logs (credentials/tokens/home-dir paths/emails stripped — see
  `redaction.ts`). Nothing is sent unless the user submits.
- **Diagnostic logs** — written **locally only** (rotating, redacted). They leave the device
  solely if the user attaches them to feedback. No automatic/background crash reporting.
- **No analytics, no tracking, no ads, no third-party SDKs.** A `globalThis.gtag(...)` hook
  exists in `main.ts` but **GA is never loaded** in any build (no measurement ID / script
  anywhere), so it is inert dead code — the native apps transmit nothing to Google.

**Net:** the only data leaving the device is (a) the user's own mail traffic to their own
Forward Email account, and (b) optional, user-initiated support feedback.

---

## 4. Apple — App Privacy ("nutrition labels")

In Apple's model, "collect" = transmitted off the device. Answer the questionnaire as:

**Data types collected:**

| Data type                                                                                                                       | Collected?   | Linked to user? | Used for tracking? | Purpose                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------- | ------------------ | --------------------------- |
| Email Address (the account login)                                                                                               | **Yes**      | Yes             | No                 | App Functionality           |
| Other User Content (email bodies, attachments, contacts, calendar)                                                              | **Yes**      | Yes             | No                 | App Functionality           |
| Diagnostics / Crash Data                                                                                                        | **See note** | No              | No                 | App Functionality (support) |
| Everything else (Location, Identifiers/IDFA, Usage Data, Purchases, Browsing/Search History, Financial, Health, Sensitive Info) | **No**       | —               | —                  | —                           |

- **Tracking:** **None.** No IDFA, no third-party analytics, no cross-app/site tracking →
  answer "No, we do not use data for tracking." No App Tracking Transparency prompt needed.
- **Diagnostics note:** Apple does **not** require disclosing data the user _actively chooses_
  to submit (the feedback flow) when it's used only for the stated support purpose. Simplest
  defensible answer: **do not list Diagnostics** (it's user-initiated, redacted, support-only).
  If you prefer maximum conservatism, list **Diagnostics → not linked → not tracking**. Either
  is reviewer-safe; the former matches Apple's optional-feedback carve-out.
- **"Contacts" data type [CONFIRM framing]:** the app syncs the user's _Forward Email_ contacts
  (CardDAV), which are part of their account content — it does **not** read the device address
  book. Declare these under **Other User Content**, not Apple's device-"Contacts" type.

**Encryption / export compliance — `ITSAppUsesNonExemptEncryption` = `false`:**
The app uses only (a) standard TLS in transit and (b) standard, published end-to-end crypto
(OpenPGP via `openpgp`, libsodium XChaCha20-Poly1305/Argon2id for the local app-lock vault)
where **the user holds the keys**. No proprietary or non-standard algorithms. This qualifies
for the mass-market exemption under **US EAR §740.17(b)(1) / ECCN 5D992.c**, so the answer to
"Does your app use non-exempt encryption?" is **No**. No annual self-classification report and
no French import declaration are required for mass-market exempt crypto. (Already injected, so
App Store Connect won't even prompt per build.)

**Privacy choices / usage strings:**

- `NSPhotoLibraryUsageDescription` — present (image picker). String currently: _"Forward Email
  needs access to your photos so you can attach images to emails and set a profile picture."_
- **Not needed (correctly absent):** `NSCameraUsageDescription` (no `getUserMedia`/capture),
  `NSFaceIDUsageDescription` (biometric is WebAuthn/passkeys via the system, not
  `LocalAuthentication`), `NSUserTrackingUsageDescription` (no ATT/IDFA), location strings.

**Push for 1.0 [CONFIRM]:** push (FCM/APNs) is **deferred to 1.1** but `aps-environment` is
injected by `inject-ios-signing.cjs`. An unused entitlement is harmless, but to avoid a "your
app declares push but doesn't use it" reviewer question, either (a) leave it — generally fine —
or (b) gate the `aps-environment` injection off until 1.1. Recommend (a) + a one-line review
note that push lands in a later update.

**Account deletion:** Settings → **Delete account** → `forwardemail.net/my-account/security`.
Add a review note pointing the reviewer there (it's distinct from Sign out, satisfying 5.1.1(v)).

**Age rating [CONFIRM]:** answer the questionnaire honestly — the app shows the user's own mail,
contains no app-supplied objectionable content, no gambling/contests, no unrestricted web
browser. Email apps typically land **4+**; Apple may bump to 17+ if you answer "Unrestricted
Web Access" — you should answer **No** to that (it's an email client, not a browser).

---

## 5. Google — Play Console Data Safety

| Question                                  | Answer                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| Does your app collect or share user data? | **Yes (collect), No (share with third parties)**            |
| Is all data encrypted in transit?         | **Yes** (TLS; CSP pins https/wss to `api.forwardemail.net`) |
| Can users request data deletion?          | **Yes** — in-app path + deletion URL                        |
| Account-deletion URL                      | `https://forwardemail.net/my-account/security`              |

**Data types — collected, not shared, all "App functionality":**

- **Personal info → Email address** (account login).
- **Messages → Emails** (the core content; the user's own mail).
- **Personal info → Other** / **App activity → Other user-generated content** (contacts, calendar,
  attachments — part of the user's account).
- **App info & performance → Diagnostics / Crash logs:** only if the user submits feedback →
  declare as **collected, optional, user-initiated, App functionality**, or omit if you treat the
  user-initiated send as not "collected." [CONFIRM — match Apple choice in §4.]
- **No** advertising/marketing data, **No** device/other IDs for tracking, **No** location.

**Data shared with third parties:** **None.**

---

## 6. Screenshots & store assets

**iOS (App Store Connect):**

- **6.7"** (e.g. iPhone 15 Pro Max / 14 Plus, 1290×2796) — **required**, 1–10 shots.
- **6.5"** (1242×2688) — recommended fallback.
- **iPad 12.9"** (2048×2732) — **required IF the app is universal** (see §1 [CONFIRM]).
- App icon 1024×1024 (no alpha), already in `src-tauri/icons`.

**Google Play:**

- Phone screenshots: **min 2**, up to 8 (16:9 or 9:16, ≥320px).
- **Feature graphic** 1024×500 (required for the listing).
- App icon 512×512.
- Tablet screenshots optional.

Suggested shot list (both stores): inbox/message list, reader, compose, mobile search overlay,
settings/account. None are currently in the repo (`e2e-webview/screenshots` are test artifacts).

---

## 7. Permissions declared (low review friction)

**Android** (`AndroidManifest.xml`): `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`,
`VIBRATE`. No SMS/location/storage/camera/contacts/accessibility → clean Data Safety story.
Deep-link intent filters: `mailto:` + `forwardemail:` (custom schemes, so **no** `assetlinks.json`
needed). Single exported activity (`MainActivity`); FileProvider is `exported=false`.

**iOS:** `NSPhotoLibraryUsageDescription` only (+ `aps-environment` for future push). Custom-scheme
deep links → **no** Associated Domains needed.

---

## 8. Open items / decisions to confirm

1. **[CONFIRM]** Publish `forwardemail.net/privacy` (live before submission — the app links it).
2. **[CONFIRM]** Device family — iPhone-only vs universal → determines iPad screenshot requirement.
3. **[CONFIRM]** Diagnostics-in-feedback: list it or rely on the user-initiated carve-out (pick the
   same answer for Apple §4 and Google §5).
4. **[CONFIRM]** iOS push entitlement for 1.0 — leave injected (recommended) + review note, or gate off until 1.1.
5. **[CONFIRM]** Age-rating questionnaire — answer "No" to unrestricted web access.
6. Provision the 6 iOS TestFlight secrets (build pipeline is ready; secret-gated).
7. Create the Play Console app + closed/open testing tracks; add automated AAB upload
   (`r0adkll/upload-google-play` or fastlane `supply`) to `release-mobile.yml` — the signed AAB is
   already produced, it just isn't uploaded anywhere but GitHub Releases.
