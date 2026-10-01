# Push Notifications Setup Guide

This document describes the Forward Email push architecture and its deployment requirements. The native transports are **APNs on iOS and macOS** and one dual-provider Android release containing both **FCM and UnifiedPush**. FCM is the runtime default when configured; users can explicitly select UnifiedPush as the Google-free alternative. macOS registers for APNs only in release builds signed with a Developer ID provisioning profile that grants Push Notifications (see [macOS application and signing configuration](#macos-application-and-signing-configuration)). Browsers register a **Web Push** subscription with the same VAPID key pair. The Windows and Linux apps display local notifications from the WebSocket while they run and do not register a remote push subscription.

## Support and permission matrix

| Target or profile     | Remote transport                            | Local display                                                | Build and permission source                                                                                                                                       | Status                                                                                        |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| iOS                   | APNs                                        | Tauri notification plugin                                    | iOS-only mobile-push commands, runtime authorization, and generated iOS `aps-environment` entitlement                                                             | Supported                                                                                     |
| Android, Google-free  | UnifiedPush                                 | Native background notification plus foreground Tauri display | First-party UnifiedPush connector, `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, and Android-only UnifiedPush capability                                        | Supported; no Firebase or Play Services dependency                                            |
| Android, dual release | FCM plus user-selectable UnifiedPush        | Tauri/native display                                         | FCM Cargo feature and generated FCM capability, plus the always-present UnifiedPush connector                                                                     | Supported; one APK and AAB                                                                    |
| macOS                 | APNs (release builds with the push profile) | Tauri notification plugin; system alert for APNs pushes      | macOS mobile-push commands; `Entitlements.push.plist` and an embedded Developer ID provisioning profile, written by `scripts/macos-push-signing.sh` in release CI | Supported when `MACOS_PROVISIONING_PROFILE_BASE64` is set; otherwise local notifications only |
| Windows               | None                                        | Tauri notification plugin                                    | Shared notification commands                                                                                                                                      | Local notifications only                                                                      |
| Ubuntu/Linux          | None                                        | Desktop notification service                                 | Shared notification commands                                                                                                                                      | Local notifications only                                                                      |
| Browser/PWA           | Web Push (VAPID)                            | Service worker (`public/sw-sync.js`)                         | Browser notification permission, asked from **Settings → Push notifications**; `VAPID_PUBLIC_KEY` in the web build                                                | Supported in Chromium, Firefox and Safari; on iOS/iPadOS only when added to the Home Screen   |

> **UnifiedPush is not a manifest permission.** It is a distributor-mediated Android protocol. A compatible distributor application must be installed and selected, and the backend must encrypt each message to the subscription’s endpoint and public keys.

## Architecture

```mermaid
sequenceDiagram
    participant App as Forward Email mobile app
    participant API as Forward Email API
    participant Provider as APNs, FCM, or UnifiedPush distributor

    App->>App: Request notification permission
    App->>Provider: Obtain APNs/FCM token or UnifiedPush subscription
    App->>API: POST /v1/push-tokens with alias Basic auth
    API->>API: Store token/subscription and return registration ID
    Note over App,API: A push-worthy mail event occurs
    API->>Provider: Send provider-specific payload
    Provider->>App: Deliver notification/message
    App->>App: Refresh state and route notification tap
    App->>API: DELETE /v1/push-tokens/:id on sign-out, account switch, or subscription rotation
```

UnifiedPush registration returns a serialized Web Push-compatible subscription:

```json
{
  "endpoint": "https://distributor.example/path/token",
  "keys": {
    "p256dh": "base64url-uncompressed-p256-public-key",
    "auth": "base64url-auth-secret"
  }
}
```

The backend validates and canonicalizes this structure, rejects unsafe endpoints, encrypts notification JSON with RFC 8291 Web Push encryption, and signs the request with VAPID. The Android connector decrypts the message before it reaches the application callback service.

Backend event producers call one transport-neutral notifier with one immutable `notification_id`. That notifier explicitly starts alias-scoped push delivery to every active token and publishes the same envelope to Redis for WebSocket fan-out. The API subscriber owns only socket delivery. Push therefore starts even when the alias has **zero active WebSocket clients** or no WebSocket subscriber is available; a Redis claim suppresses duplicate provider fan-out if the same immutable notification envelope is retried.

The client initializes remote push only when `alias_auth` identifies an active alias. It stores the server registration ID, deletes that exact resource before credentials are cleared, and re-registers after an account switch or provider subscription rotation. API-key-only sessions do not initialize alias-scoped remote push.

## Provider provisioning and cross-repository values

The client never receives APNs signing keys, Firebase service-account credentials, or the VAPID private key. Configure those values in `forwardemail.net` according to its [push provider setup guide](https://github.com/forwardemail/forwardemail.net/blob/master/PUSH_NOTIFICATIONS.md), then copy only the explicitly identified public client values into this repository.

### APNs and the shared Apple services key

The backend deliberately reuses its existing `APPLE_KEY_ID`, `APPLE_TEAM_ID`, and `APPLE_KEY_PATH` credentials from Sign in with Apple for APNs. Do not create or document separate APNs-specific credential variables.

| Backend variable  | Requirement                | Exact value and source                                                                                |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `APPLE_KEY_ID`    | Required for APNs          | The 10-character Key ID displayed for the Apple services `.p8` key                                    |
| `APPLE_TEAM_ID`   | Required for APNs          | The 10-character Team ID shown in Apple Developer **Membership details**                              |
| `APPLE_KEY_PATH`  | Required for APNs          | Absolute server path to the shared `.p8` file, normally `/var/www/production/AuthKey_<KEY_ID>.p8`     |
| `APNS_BUNDLE_ID`  | Required for this app      | `net.forwardemail.mail`                                                                               |
| `APNS_PRODUCTION` | Required deployment choice | `true` for TestFlight/App Store tokens; `false` for development-signed device and APNs sandbox tokens |

In [Apple Developer](https://developer.apple.com/account/resources/authkeys/list), reuse the existing key when it already has both **Sign in with Apple** and **Apple Push Notifications service (APNs)** enabled. Otherwise, an Account Holder or Admin must create or reconfigure the shared key, record its Key ID, download the `.p8` file once, and enable Push Notifications on the `net.forwardemail.mail` App ID. Regenerate the development and distribution provisioning profiles after changing the App ID capability.

The backend certificate playbook prompts for the local `.p8` path and uploads it to `/var/www/production/<local-basename>`. Set `APPLE_KEY_PATH` to that deployed path. The client repository does not receive this `.p8` file; its separate iOS signing certificate, provisioning profile, and App Store Connect values are documented in [`docs/SECRETS.md`](SECRETS.md).

### Firebase values

The Google Play build and backend sender use the same Firebase project but require different files:

| Value                         | Used by                | How to obtain and store it                                                                                                                                             |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FCM_PROJECT_ID`              | Backend                | Firebase **Project settings → General → Project ID**; do not use the display name, project number, or application ID                                                   |
| `FCM_SERVICE_ACCOUNT_PATH`    | Backend                | Absolute path to a secret service-account JSON key authorized for FCM HTTP v1; the backend playbook installs it as `/var/www/production/firebase-service-account.json` |
| `GOOGLE_SERVICES_JSON`        | Local FCM build        | Absolute local path to the Android app’s downloaded `google-services.json` client configuration                                                                        |
| `GOOGLE_SERVICES_JSON_BASE64` | GitHub Android release | Base64 encoding of that same `google-services.json`, stored as a GitHub Actions secret                                                                                 |

In the [Firebase console](https://console.firebase.google.com/), create or select the production project, register the Android application ID `net.forwardemail.mail`, and download its latest `google-services.json` from **Project settings → General → Your apps**. Enable the Firebase Cloud Messaging API. For the backend, generate a dedicated service-account JSON key from **Project settings → Service accounts** or Google Cloud IAM and grant only the permissions needed to send FCM HTTP v1 messages to that project.

> `google-services.json` is client configuration; `firebase-service-account.json` is a backend credential. They are not interchangeable. Never copy the backend service-account JSON into this repository, an APK/AAB, or GitHub Actions for the client build.

Create the Play-release secret without introducing line wrapping:

```bash
base64 < /absolute/path/google-services.json | tr -d '\n'
```

Store the result as GitHub Actions secret `GOOGLE_SERVICES_JSON_BASE64`. Local FCM-enabled builds instead set `GOOGLE_SERVICES_JSON=/absolute/path/google-services.json`.

### UnifiedPush and VAPID

Generate one stable VAPID pair from the backend repository and retain it across releases:

```bash
pnpm exec web-push generate-vapid-keys
```

| Generated or chosen value | Backend setting     | Mail repository setting                                                                             |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| Public key                | `VAPID_PUBLIC_KEY`  | GitHub Actions variable and local build environment `VAPID_PUBLIC_KEY`                              |
| Private key               | `VAPID_PRIVATE_KEY` | Never copy to this repository, Actions, APK, AAB, or CI logs                                        |
| Contact URI               | `VAPID_SUBJECT`     | Backend only; normally `mailto:support@forwardemail.net` or an HTTPS URL controlled by the operator |

The public and private values must remain a matched pair. Changing the VAPID pair requires Android clients to create new UnifiedPush subscriptions; browsers notice the new key and subscribe again on their next start.

The web build reads the same `VAPID_PUBLIC_KEY` Actions variable (the Build steps in `deploy.yml` and `release.yml`). Without it the web app shows push as unsupported. The public key is intentionally embedded in Android artifacts; the private key remains a backend-only production secret.

A complete backend example is:

```env
APPLE_TEAM_ID=TEAM123456
APPLE_KEY_ID=ABC123DEFG
APPLE_KEY_PATH=/var/www/production/AuthKey_ABC123DEFG.p8
APNS_BUNDLE_ID=net.forwardemail.mail
APNS_PRODUCTION=true

FCM_PROJECT_ID=forward-email-production
FCM_SERVICE_ACCOUNT_PATH=/var/www/production/firebase-service-account.json

VAPID_SUBJECT=mailto:support@forwardemail.net
VAPID_PUBLIC_KEY=BN...
VAPID_PRIVATE_KEY=...
```

The UnifiedPush sender treats HTTP `404` and `410` responses as permanently invalid subscriptions and participates in the existing failure-count and token-pruning lifecycle. Retryable provider or network failures retain the subscription for later delivery.

## iOS application and signing configuration

The bundle identifier is `net.forwardemail.mail`. Enable **Push Notifications** for that App ID and regenerate the provisioning profile. Signed device profiles must include `aps-environment`.

The shared `src-tauri/Entitlements.plist` remains free of `aps-environment` because macOS also consumes it. `scripts/inject-ios-signing.cjs` generates an iOS-only entitlement file and selects `production` for distribution exports or `development` for development-signed device builds.

Use `scripts/ios-build.sh` for signed builds. Release automation uses these Actions secrets: `APPLE_TEAM_ID`, `IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `APP_STORE_CONNECT_API_KEY`, `APP_STORE_CONNECT_KEY_ID`, and `APP_STORE_CONNECT_ISSUER_ID`.

A missing entitlement does not fail the build. It only shows up on devices as a registration that never completes. The release workflow therefore runs `scripts/verify-ios-push-entitlement.sh` on the built and on the re-signed IPA, and stops the release when the signed app or its embedded provisioning profile lacks `aps-environment`. The same check works locally:

```bash
bash scripts/verify-ios-push-entitlement.sh path/to/app.ipa production
```

When registration fails on a device, **Settings → Push notifications** shows the reason reported by iOS or the server, for example `no valid "aps-environment" entitlement string found for application`. iOS shows the permission prompt only once; after **Don't Allow**, the same screen offers **Open Settings** instead.

## macOS application and signing configuration

macOS uses the same App ID as iOS, `net.forwardemail.mail`, and the same backend APNs key and topic, so the server needs no macOS-specific setting. macOS needs the signing setup below:

- `com.apple.developer.aps-environment` is a restricted entitlement. A Developer ID (outside the Mac App Store) app may carry it only when the bundle embeds a **Developer ID provisioning profile** that grants it. Signing with the entitlement but without the profile passes codesign and notarization, and then the kernel kills the app at launch; that is what happened in 0.10.17 to 0.10.21 ([postmortem](./desktop-postmortem-macos-entitlements-2026-05-19.md)).
- `src-tauri/Entitlements.plist` therefore never contains the entitlement. Local, pull request and e2e builds are signed without it, and the app reports push as unavailable in **Settings → Push notifications** ("not signed for Apple Push Notifications"). Notifications still arrive over the WebSocket while the app runs.

To enable remote push in releases:

1. In [Certificates, Identifiers & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list), open `net.forwardemail.mail` and confirm **Push Notifications** is enabled (it is already required for iOS).
2. Under **Profiles**, create a profile of type **Distribution → Developer ID** for the macOS platform and that App ID, and select the **Developer ID Application** certificate whose `.p12` is stored in `APPLE_CERTIFICATE`.
3. Download it, base64-encode it (`base64 -i Forward_Email_Developer_ID.provisionprofile | pbcopy`) and store it as the Actions secret `MACOS_PROVISIONING_PROFILE_BASE64`.
4. Once a release with push has shipped, set the repository variable `MACOS_PUSH_REQUIRED=true` so a missing profile fails the macOS rows instead of shipping without push.

The release workflow then runs `scripts/macos-push-signing.sh prepare` before the build. It checks that the profile is a Developer ID profile for `<APPLE_TEAM_ID>.net.forwardemail.mail`, grants `aps-environment=production`, and is not expired (it warns 90 days ahead: a build whose profile has expired no longer launches, so a renewal has to ship before then). It then writes `src-tauri/Entitlements.push.plist` (the shared entitlements plus the APNs, application-identifier and team-identifier entitlements) and adds the profile to the bundle as `Contents/embedded.provisionprofile`. After signing, `scripts/macos-push-signing.sh verify` checks the embedded profile, the signed entitlements, and that the signing certificate is one the profile lists, and the existing launch test still has to pass.

The app registers its token as an `apns` registration for every signed-in account, like iOS. While the user is in the app, the native side tells macOS not to draw the alert and the page shows its own notice; otherwise macOS draws it and the page draws nothing (the WebSocket copy of the event waits up to three seconds for the push to say which).

If APNs does not answer within 15 seconds, the plugin unregisters and registers again once per launch, through `-registerForRemoteNotificationTypes:` this time. A repeated registration may never be called back, and a registration that stalled in `apsd` stays stalled. If that gets no answer either, Settings shows why after 40 seconds, for example `Apple Push Notification service did not answer within 40 seconds (delegate TaoAppDelegateParent (handles the token); bundle net.forwardemail.mail; aps-environment production; registered yes)`. `registered yes` only means AppKit considers the app registered; Apple documents it as unrelated to connectivity, so it does not mean a token was issued.

A token that arrives after the page stopped waiting is not lost. The plugin keeps it for the rest of the launch and announces it, and the page finishes the registration without another click.

Reading the reason:

- `delegate … (does not handle the token)` or `delegate none`: AppKit has nowhere to deliver the token. The plugin adds the callbacks to the app delegate at setup and again before every registration.
- `bundle com.apple.Terminal (Info.plist: net.forwardemail.mail)`: `-[NSBundle bundleIdentifier]` has been replaced, so APNs was asked for another app's topic. tauri-plugin-notification's macOS backend (mac-notification-sys) does this on the first local notification when Launch Services does not know the app; the plugin restores the real identifier before registering and logs `restored bundle identifier`.
- Everything as expected: the Mac is not reaching APNs, or `apsd` is refusing the app. Run `log stream --info --debug --predicate 'process == "apsd"'` in Terminal, click **Register this device**, and look for lines naming `net.forwardemail.mail`: `not connected` means no connection to APNs (check that outbound TCP 5223, or 443, to `*.push.apple.com` is not blocked by a VPN, proxy or firewall); a rejected topic or entitlement means the signing does not match the profile.

A second registration started while one is waiting shares its answer rather than queueing behind it.

## Web Push in the browser

`src/utils/web-push.js` subscribes the browser with `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` and registers the subscription with `POST /v1/push-tokens` as platform `web-push` for every signed-in account. The permission prompt is shown only from the **Register** button in Settings, because browsers ignore prompts that no click started; once allowed, each start keeps the registration current without prompting.

The server encrypts new-mail alerts with RFC 8291 and signs them with VAPID, like UnifiedPush. Silent events are never sent to browsers (Safari revokes subscriptions that receive pushes without a notification). The service worker shows the alert unless a window of the app is focused in a Chromium or Firefox browser (WebKit, which includes every browser on iOS, always gets one) and opens the message in its account when clicked; the page tells the worker which account each alias ID belongs to. While Web Push is registered, a hidden tab does not also draw the WebSocket copy of the alert.

## Notifications from the WebSocket

On every platform the app also hears about new mail over its WebSocket connection while it runs. On Windows and Linux that is the only source, and in a browser without Web Push. `src/utils/notification-manager.js` decides what to show:

- **The user is in the app** (the page is visible and its window has focus): an in-app toast, no system notification. On phones, being on screen is enough.
- **The app is open but not in use** (hidden, minimized, or a visible window or tab behind another app): a system notification, through the Tauri notification plugin in the desktop and mobile apps and the service worker (or `new Notification()`) in the browser.
- **No system notification is possible** (permission not granted, no notification support, or the OS refused it): the message is remembered, and a toast summarising what arrived is shown as soon as the user comes back to the app.

Browsers ignore or auto-deny a permission request that no click started, so the web app never asks on its own. It offers the permission once per device in a toast with a **Turn on** button, and **Settings → General → Notifications → New mail notifications** shows the current state with **Allow notifications** and **Send a test notification** buttons. The desktop and mobile apps ask directly, as before.

## Opening a notification

Tapping or clicking a notification opens the message it is about, in its own account, on every platform: an APNs alert (iOS, macOS), an FCM or UnifiedPush notification (Android), a notification the app drew itself (desktop and mobile), a web notification (the service worker's `notificationclick`), and the in-app toast. Everything goes through `src/utils/notification-open.ts`:

- The tap is held until the app is signed in, App Lock is unlocked and boot has finished, then acted on once. A tap that launches the app is kept natively until the page takes it (`take_pending_taps` on the `mobile-push` plugin for iOS and macOS, and on the `unified-push` plugin for both Android transports, which open the app with the payload on the launch intent).
- A tap for another signed-in account switches to it first and navigates when the switch has finished.
- The message is opened by the id in the push payload (`message_id`, the API id), in the folder it arrived in (`mailbox`). When it is not in the loaded page of the list, the mailbox fetches it by id.

## Android UnifiedPush configuration

The first-party Tauri plugin under `src-tauri/plugins/tauri-plugin-unified-push` uses the stable UnifiedPush Android connector. It performs distributor discovery, explicit user-driven distributor selection, VAPID-bound registration, callback persistence, subscription rotation, message acknowledgment, foreground event forwarding, and background native notification display.

A user needs a compatible UnifiedPush distributor. After installing one, the user can open Forward Email settings and select or change the distributor. In the dual-provider APK, FCM is the default until the user makes that explicit choice; the selected UnifiedPush preference then persists across application restarts and is attempted before FCM. The application opens the distributor picker only from the explicit settings action.

The client queues messages received while the webview is unavailable. It drains them on initialization and marks notifications already displayed by Android so the frontend can refresh mailbox state without displaying a duplicate notification.

### Build profiles

| Profile     | Command                           | Native content                                                                                                                            | Intended distribution                                                     |
| ----------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Google-free | `pnpm tauri:android:build:fdroid` | UnifiedPush only; no Firebase Gradle plugin, Firebase Messaging library, FCM service, generated FCM capability, or `google-services.json` | F-Droid, direct APK, alternative stores, and privacy-focused distribution |
| Play        | `pnpm tauri:android:build:play`   | UnifiedPush plus FCM; runtime defaults to FCM and honors a durable user-selected UnifiedPush distributor                                  | Single GitHub release APK/AAB and Google Play                             |
| Default     | `pnpm tauri:android:build`        | Same as Google-free                                                                                                                       | Safe default for downstream packagers                                     |

Development equivalents are `pnpm tauri:android:dev:fdroid` and `pnpm tauri:android:dev:play`.

Every profile that contains UnifiedPush requires the public key at build time. This is the Forward Email application server's public VAPID identity, not a distributor setting and not a value entered by end users. Android users choose or change any installed UnifiedPush distributor through the system picker in Settings; the private VAPID key remains only on the matching Forward Email backend.

```bash
VAPID_PUBLIC_KEY='BN...' \
  pnpm tauri:android:build:fdroid -- --apk
```

For a Play dual-provider build, also supply Firebase configuration:

```bash
VAPID_PUBLIC_KEY='BN...' \
GOOGLE_SERVICES_JSON=/absolute/path/google-services.json \
  pnpm tauri:android:build:play -- --aab
```

`scripts/configure-android-push.cjs` is idempotent. It removes stale Firebase files, Gradle declarations, manifest services, and generated FCM capabilities before applying the selected profile. This prevents a previous Play build from contaminating a later F-Droid artifact.

### Continuous integration and releases

Store `VAPID_PUBLIC_KEY` as a GitHub Actions **variable**. Its value must exactly equal backend `VAPID_PUBLIC_KEY`. Store `GOOGLE_SERVICES_JSON_BASE64` as a `release` environment **secret**. Both are required by the fail-fast preflight for the single dual-provider release.

The release workflow creates a signed dual-provider APK and matching AAB for GitHub Releases and optional Google Play upload. It also creates `forwardemail-mail_<version>_fdroid.apk`, a separately signed Google-free UnifiedPush-only APK, for the official self-hosted F-Droid-compatible repository and Obtainium. Routine Android CI and emulator E2E builds retain Google-free coverage so the first-party connector continuously compiles without Firebase or Google Play Services.

The Google-free release build invokes the `:fdroid` command with `VAPID_PUBLIC_KEY` in the controlled build environment. It needs neither a proprietary Firebase artifact nor a Firebase secret. See [distribution-publishing.md](./distribution-publishing.md) for publishing, repository installation, and Obtainium guidance.

## Authentication and token lifecycle

The push-token endpoint requires alias-scoped HTTP Basic credentials. Registration is rejected when alias credentials are missing or ambiguous. The client never sends provider credentials; it sends only an APNs/FCM token or a UnifiedPush subscription.

On sign-out, account replacement, provider change, registration failure, or endpoint rotation, the client deletes the old backend registration where possible and unregisters native listeners/subscriptions as appropriate. Instance identifiers prevent callbacks from an obsolete UnifiedPush registration from replacing the active subscription.

## Validation and device smoke tests

| Validation                   | Expected result                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Google-free dependency audit | Built dependency graph contains UnifiedPush connector but no Firebase Messaging or Play Services push dependency           |
| Profile-switch test          | Running Play configuration and then Google-free configuration removes all Firebase files and declarations                  |
| UnifiedPush registration     | Settings shows the selected distributor and backend stores a complete serialized subscription                              |
| Encrypted delivery           | A backend event reaches the distributor and is decrypted by the connector without plaintext provider payloads              |
| Background receipt           | Android displays one `new-mail` notification while the webview is suspended                                                |
| Foreground receipt           | Mailbox state refreshes and only one notification is displayed                                                             |
| Subscription rotation        | Old backend registration is deleted and the replacement subscription becomes active                                        |
| Permanent endpoint failure   | `404` or `410` increments/prunes the obsolete registration through the normal failure lifecycle                            |
| Sign-out/account switch      | Existing server registration, native listeners, and provider state are cleaned up before new credentials initialize        |
| Dual-provider release        | One APK contains FCM and UnifiedPush; an explicit distributor choice persists and takes precedence after restart           |
| iOS/macOS entitlement split  | iOS signed build has `aps-environment`; shared macOS entitlement does not; only the macOS push build (with profile) has it |
| Notification tap routing     | Cold start, App Lock and another account: the tapped message opens in its account                                          |

Physical-device tests should cover at least one distributor from the intended F-Droid ecosystem, Android 13+ notification permission, process termination/restart, distributor replacement, network loss, account switch, and notification tap routing. A successful compile alone does not validate distributor behavior.
