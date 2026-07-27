# tauri-plugin-mobile-push

Push notifications for Tauri v2 apps on iOS (APNs) and Android (FCM).

[![Crates.io](https://img.shields.io/crates/v/tauri-plugin-mobile-push.svg)](https://crates.io/crates/tauri-plugin-mobile-push)
[![npm](https://img.shields.io/npm/v/tauri-plugin-mobile-push-api.svg)](https://www.npmjs.com/package/tauri-plugin-mobile-push-api)

A Tauri v2 plugin that provides native remote push notification support using Apple Push Notification service (APNs) on iOS and Firebase Cloud Messaging (FCM) on Android. Unlike `tauri-plugin-notification` which only handles local notifications, this plugin handles **server-sent remote push notifications** -- the kind you need for chat apps, alerts, and any real-time engagement.

The plugin uses **explicit AppDelegate delegation** instead of method swizzling, making it reliable, transparent, and compatible with iOS 26+ where swizzling-based approaches break.

## Features

- **APNs on iOS** -- native device token registration and push delivery
- **FCM on Android** -- Firebase Cloud Messaging integration with automatic token management
- **Foreground notifications** -- receive and display pushes while the app is open
- **Notification tap handling** -- deep-link into your app when users tap a notification
- **Token refresh events** -- stay in sync when the OS rotates device tokens
- **No method swizzling** -- explicit delegation pattern that is debuggable and future-proof
- **Desktop no-op** -- compiles on macOS/Windows/Linux without error; commands return `Err` at runtime so you can gate push logic behind platform checks
- **TypeScript API** -- fully typed async functions and event listeners

## Platform Support

| Platform | Push Token | Foreground Notifications | Notification Tap | Token Refresh |
|----------|-----------|--------------------------|------------------|---------------|
| iOS 13+  | APNs device token (hex) | Yes | Yes | Yes |
| Android 7+ (API 24) | FCM registration token | Yes | Yes | Yes |
| Desktop  | No-op (returns error) | N/A | N/A | N/A |

## Why This Plugin?

**The official `tauri-plugin-notification` only supports local notifications.** It cannot receive server-sent pushes. If you need to send notifications from your backend to your users' devices, you need this plugin.

**Third-party alternatives use method swizzling**, which intercepts Objective-C method calls at runtime. This technique is fragile -- it breaks when multiple plugins swizzle the same methods, produces difficult-to-debug failures, and Apple has been deprecating the APIs that enable it. On iOS 26+, swizzling-based push plugins can silently fail.

**This plugin uses explicit AppDelegate delegation.** You create a small `AppDelegate.swift` file that forwards APNs callbacks to the plugin via `NotificationCenter`. This approach is:

- **Reliable** -- no hidden runtime magic that can silently break
- **Debuggable** -- you can set breakpoints in the delegate methods and see exactly what happens
- **Future-proof** -- uses standard Apple APIs that will not be deprecated
- **Composable** -- works alongside any other plugins or libraries without conflicts

## Installation

### Rust

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
# From crates.io
tauri-plugin-mobile-push = "0.1"

# Or from git
tauri-plugin-mobile-push = { git = "https://github.com/yanqianglu/tauri-plugin-mobile-push" }
```

### JavaScript / TypeScript

```bash
npm install tauri-plugin-mobile-push-api
# or
pnpm add tauri-plugin-mobile-push-api
# or
bun add tauri-plugin-mobile-push-api
```

Requires `@tauri-apps/api` >= 2.0.0 as a peer dependency.

### Capabilities

Add to your capabilities file (e.g., `src-tauri/capabilities/mobile.json`):

```json
{
  "permissions": ["mobile-push:default"]
}
```

This grants both `allow-request-permission` and `allow-get-token`.

### Plugin Registration

In `src-tauri/src/lib.rs`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_mobile_push::init())
    // ... other plugins
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

## Setup

### iOS

#### 1. Enable Push Notifications Capability

In Xcode, select your target, go to **Signing & Capabilities**, and add the **Push Notifications** capability. This adds the `aps-environment` entitlement automatically.

#### 2. Create AppDelegate.swift

Create the file at `src-tauri/gen/apple/Sources/AppDelegate.swift`. This file forwards APNs callbacks to the plugin -- it is required because the plugin does **not** use method swizzling.

```swift
import SwiftUI
import Tauri
import UIKit
import UserNotifications
import WebKit

class AppDelegate: TauriAppDelegate {
    override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // Set self as the notification center delegate so foreground
        // notifications and tap events are routed to this class.
        UNUserNotificationCenter.current().delegate = self
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    // Called by iOS when APNs registration succeeds.
    // Converts the raw token data to a hex string and posts it
    // so the plugin can resolve the pending getToken() call.
    override func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)

        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NotificationCenter.default.post(
            name: Notification.Name("APNsTokenReceived"),
            object: nil,
            userInfo: ["token": hex]
        )
    }

    // Called by iOS when APNs registration fails.
    override func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)

        NotificationCenter.default.post(
            name: Notification.Name("APNsRegistrationFailed"),
            object: nil,
            userInfo: ["error": error.localizedDescription]
        )
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension AppDelegate: UNUserNotificationCenterDelegate {
    // Called when a notification arrives while the app is in the foreground.
    // Posts to the plugin and shows the notification as a banner.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let userInfo = notification.request.content.userInfo
        NotificationCenter.default.post(
            name: Notification.Name("PushNotificationReceived"),
            object: nil,
            userInfo: userInfo as? [String: Any]
        )
        completionHandler([.banner, .sound, .badge])
    }

    // Called when the user taps a notification.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        NotificationCenter.default.post(
            name: Notification.Name("PushNotificationTapped"),
            object: nil,
            userInfo: userInfo as? [String: Any]
        )
        completionHandler()
    }
}
```

#### 3. Entitlements

Ensure your `.entitlements` file includes:

```xml
<key>aps-environment</key>
<string>development</string>
```

Change to `production` for App Store / TestFlight builds. If you added the Push Notifications capability via Xcode, this is handled automatically.

### Android

#### 1. Add Firebase

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com/) and add your Android app.
2. Download `google-services.json` and place it in `src-tauri/gen/android/app/`.
3. Configure your Gradle files:

```kotlin
// project-level build.gradle.kts
plugins {
    id("com.google.gms.google-services") version "4.4.2" apply false
}

// app-level build.gradle.kts
plugins {
    id("com.google.gms.google-services")
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:33.8.0"))
    implementation("com.google.firebase:firebase-messaging")
}
```

#### 2. Register the FCM Service

Add to your `AndroidManifest.xml` inside the `<application>` tag:

```xml
<service
    android:name="app.tauri.mobilepush.FCMService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

This registers the plugin's `FCMService` which forwards incoming messages and token refreshes to the Tauri event system.

## Usage

### Request Permission

Shows the system permission dialog on iOS. On Android 13+ (API 33), requests the `POST_NOTIFICATIONS` runtime permission. Earlier Android versions return `{ granted: true }` immediately.

```typescript
import { requestPermission } from "tauri-plugin-mobile-push-api";

const { granted } = await requestPermission();
if (!granted) {
  console.warn("Push notification permission denied");
}
```

### Get Device Token

Returns the APNs device token (hex string) on iOS or the FCM registration token on Android. On iOS, this triggers `registerForRemoteNotifications()` and resolves when the OS delivers the token via the AppDelegate.

```typescript
import { getToken } from "tauri-plugin-mobile-push-api";

const token = await getToken();
console.log("Device push token:", token);
```

### Complete Registration Flow

The typical integration: request permission, get the token, and register it with your backend.

```typescript
import {
  requestPermission,
  getToken,
  onNotificationReceived,
  onNotificationTapped,
  onTokenRefresh,
} from "tauri-plugin-mobile-push-api";

// 1. Request permission
const { granted } = await requestPermission();
if (!granted) {
  console.warn("Push permission denied");
  return;
}

// 2. Get the device push token
const token = await getToken();

// 3. Send token to your backend
await fetch("https://your-api.com/push/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token, platform: "ios" }),
});

// 4. Listen for foreground notifications
const unsubReceived = await onNotificationReceived((notification) => {
  console.log("Received:", notification.title, notification.body);
  console.log("Custom data:", notification.data);
});

// 5. Listen for notification taps (user opened app from notification)
const unsubTapped = await onNotificationTapped((notification) => {
  console.log("Tapped:", notification.data);
  // Navigate to the relevant screen based on notification.data
});

// 6. Listen for token refreshes (re-register with your backend)
const unsubToken = await onTokenRefresh(({ token }) => {
  console.log("Token refreshed:", token);
  // Send new token to your backend
});

// Cleanup when your component unmounts
unsubReceived.unregister();
unsubTapped.unregister();
unsubToken.unregister();
```

### Listen for Notification Taps

When a user taps a notification, your app opens and the tap event fires with the notification payload. Use this to deep-link to the relevant screen.

```typescript
import { onNotificationTapped } from "tauri-plugin-mobile-push-api";

const unsub = await onNotificationTapped((notification) => {
  const { screen, id } = notification.data as { screen: string; id: string };
  // Navigate based on the custom data in the push payload
  navigateTo(screen, id);
});
```

### Listen for Token Refresh

The OS may rotate device tokens at any time. When this happens, send the new token to your backend.

```typescript
import { onTokenRefresh } from "tauri-plugin-mobile-push-api";

const unsub = await onTokenRefresh(({ token }) => {
  fetch("https://your-api.com/push/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
});
```

## API Reference

### Commands

#### `requestPermission()`

```typescript
function requestPermission(): Promise<{ granted: boolean }>;
```

Request push notification permission from the user.

- **iOS**: Triggers the system permission dialog requesting `.alert`, `.badge`, and `.sound`.
- **Android 13+**: Requests the `POST_NOTIFICATIONS` runtime permission.
- **Android < 13**: Returns `{ granted: true }` immediately (no runtime permission needed).
- **Desktop**: Returns an error.

#### `getToken()`

```typescript
function getToken(): Promise<string>;
```

Get the current device push token.

- **iOS**: Calls `UIApplication.shared.registerForRemoteNotifications()`, waits for the APNs callback, and returns the device token as a hex string.
- **Android**: Calls `FirebaseMessaging.getInstance().token` and returns the FCM registration token.
- **Desktop**: Returns an error.

### Events

All event listeners return `Promise<PluginListener>`. Call `.unregister()` on the returned listener to stop receiving events.

#### `onNotificationReceived(handler)`

```typescript
function onNotificationReceived(
  handler: (notification: PushNotification) => void,
): Promise<PluginListener>;
```

Fires when a push notification arrives while the app is in the **foreground**. On iOS, the notification is also displayed as a banner (with sound and badge).

#### `onNotificationTapped(handler)`

```typescript
function onNotificationTapped(
  handler: (notification: PushNotification) => void,
): Promise<PluginListener>;
```

Fires when the user **taps** a push notification to open the app. Use this for deep linking.

#### `onTokenRefresh(handler)`

```typescript
function onTokenRefresh(
  handler: (payload: { token: string }) => void,
): Promise<PluginListener>;
```

Fires when the OS issues a new push token (APNs token refresh on iOS, FCM token rotation on Android). Send the new token to your backend whenever this fires.

### Types

```typescript
/** Payload delivered with push notification events. */
interface PushNotification {
  title?: string;
  body?: string;
  data: Record<string, unknown>;
  badge?: number;
  sound?: string;
}
```

## Sending Push Notifications from Your Server

Once you have the device token, send pushes from your backend via:

- **iOS (APNs):** Use the [APNs HTTP/2 API](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) with a `.p8` signing key or `.p12` certificate.
- **Android (FCM):** Use the [FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send-message) with a service account.

The notification payload should include `title`, `body`, and any custom `data` fields your app needs. These will be delivered to your `onNotificationReceived` and `onNotificationTapped` handlers.

## Architecture

The plugin is structured as a standard Tauri v2 plugin with platform-specific native implementations:

- **Rust core** (`src/`) -- plugin registration, command definitions, and a desktop no-op fallback
- **Swift** (`ios/`) -- `MobilePushPlugin` receives APNs callbacks via `NotificationCenter` posts from your AppDelegate
- **Kotlin** (`android/`) -- `MobilePushPlugin` wraps Firebase Messaging; `FCMService` extends `FirebaseMessagingService` to forward messages and token refreshes
- **TypeScript** (`guest-js/`) -- thin async wrappers over `invoke()` and `addPluginListener()` from `@tauri-apps/api`

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT License](LICENSE-MIT) at your option.
