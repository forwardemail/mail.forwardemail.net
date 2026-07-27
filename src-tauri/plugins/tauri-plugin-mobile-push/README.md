# tauri-plugin-mobile-push

[![npm](https://img.shields.io/npm/v/tauri-plugin-mobile-push-api.svg)](https://www.npmjs.com/package/tauri-plugin-mobile-push-api)

Push notifications for Tauri v2 mobile apps -- iOS (APNs) and Android (FCM).

A Tauri v2 plugin that provides native remote push notification support using Apple Push Notification service (APNs) on iOS and Firebase Cloud Messaging (FCM) on Android. Unlike `tauri-plugin-notification` which only handles local notifications, this plugin handles **server-sent remote push notifications** -- the kind you need for chat apps, alerts, and real-time engagement.

**Zero-config on iOS.** No AppDelegate file, no method swizzling, no manual setup. The plugin automatically injects APNs handlers into the Tao AppDelegate at runtime using ObjC runtime APIs. Just enable the Push Notifications capability in Xcode and you are ready to go.

## Features

- **APNs on iOS** -- native device token registration and push delivery
- **FCM on Android** -- Firebase Cloud Messaging integration with automatic token management
- **Zero iOS configuration** -- no AppDelegate.swift file needed; APNs methods are injected automatically at runtime
- **No method swizzling** -- uses direct `@_cdecl` FFI and `class_addMethod` injection, which is transparent and future-proof
- **Foreground notifications** -- receive and display pushes while the app is open
- **Notification tap handling** -- deep-link into your app when users tap a notification
- **Token refresh events** -- stay in sync when the OS rotates device tokens
- **Desktop no-op** -- compiles on macOS/Windows/Linux without error; commands return stub values so you can gate push logic behind platform checks
- **TypeScript API** -- fully typed async functions and event listeners

## Platform Support

| Platform | Push Token | Foreground Notifications | Notification Tap | Token Refresh |
|----------|-----------|--------------------------|------------------|---------------|
| iOS 13+  | APNs device token (hex) | Yes | Yes | Yes |
| Android 7+ (API 24) | FCM registration token | Yes | Yes | Yes |
| Desktop  | No-op (stub values) | N/A | N/A | N/A |

## Why This Plugin?

**The official `tauri-plugin-notification` only supports local notifications.** It cannot receive server-sent pushes. If you need to send notifications from your backend to your users' devices -- the standard push notification flow for any chat app, messaging service, or alert system -- you need a remote push plugin.

**Third-party alternatives use method swizzling**, which intercepts Objective-C method calls at runtime. This technique is fragile: it breaks when multiple plugins swizzle the same methods, produces difficult-to-debug failures, and Apple has been deprecating the APIs that enable it.

**This plugin takes a different approach.** On iOS, it uses direct `@_cdecl` FFI between Rust and Swift, bypassing Tauri's standard `run_mobile_plugin` dispatch entirely. APNs delegate methods are injected into the Tao-generated AppDelegate at runtime using `imp_implementationWithBlock` and `class_addMethod`. This means:

- **Zero configuration** -- no AppDelegate.swift file to create or maintain
- **Reliable** -- uses the same FFI mechanism (`@_cdecl`) that Tauri uses internally for `init_plugin_<name>()`
- **Debuggable** -- all operations are logged via `NSLog` with the `[mobile-push]` prefix
- **Composable** -- does not conflict with other Tauri plugins or native code

## Installation

### Rust

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-mobile-push = { git = "https://github.com/yanqianglu/tauri-plugin-mobile-push" }
```

> The Rust crate is not yet published on crates.io. Use the git dependency for now.

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

#### 2. Verify Entitlements

Ensure your `.entitlements` file includes:

```xml
<key>aps-environment</key>
<string>development</string>
```

Change to `production` for App Store / TestFlight builds. If you added the Push Notifications capability via Xcode, this is handled automatically.

That is the complete iOS setup. No AppDelegate.swift file is needed -- the plugin handles all APNs delegate methods automatically via runtime injection.

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

Returns the APNs device token (hex string) on iOS or the FCM registration token on Android. On iOS, this triggers `registerForRemoteNotifications()` and resolves when the OS delivers the token.

```typescript
import { getToken } from "tauri-plugin-mobile-push-api";

const token = await getToken();
console.log("Device push token:", token);
// Send this token to your backend for server-side push delivery
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

## API Reference

### Commands

#### `requestPermission()`

```typescript
function requestPermission(): Promise<{ granted: boolean }>;
```

Request push notification permission from the user.

- **iOS**: Triggers the system permission dialog requesting `.alert`, `.badge`, and `.sound`. Blocks until the user responds (30s timeout).
- **Android 13+**: Requests the `POST_NOTIFICATIONS` runtime permission.
- **Android < 13**: Returns `{ granted: true }` immediately (no runtime permission needed).
- **Desktop**: Returns `{ granted: false }`.

#### `getToken()`

```typescript
function getToken(): Promise<string>;
```

Get the current device push token.

- **iOS**: Calls `registerForRemoteNotifications()`, waits for the APNs callback, and returns the device token as a hex string. Times out after 15 seconds.
- **Android**: Calls `FirebaseMessaging.getInstance().token` and returns the FCM registration token.
- **Desktop**: Returns an empty string.

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

Once you have the device token, send pushes from your backend:

- **iOS (APNs):** Use the [APNs HTTP/2 API](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) with a `.p8` signing key or `.p12` certificate. The token from `getToken()` is a hex-encoded APNs device token.
- **Android (FCM):** Use the [FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send-message) with a service account. The token from `getToken()` is an FCM registration token.

The notification payload should include `title`, `body`, and any custom `data` fields your app needs. These will be delivered to your `onNotificationReceived` and `onNotificationTapped` handlers.

## Architecture

The plugin uses different strategies per platform to work around limitations in Tauri v2's mobile plugin dispatch.

### iOS: Direct `@_cdecl` FFI

Tauri v2's `swift-rs` compilation model creates duplicate `PluginManager` singletons when multiple plugins include Swift code. This causes `run_mobile_plugin` calls to hang indefinitely -- `register_plugin()` stores the plugin in one singleton, but `run_plugin_command()` dispatches through a different one.

This plugin bypasses that system entirely using `@_cdecl` FFI functions, which is the same mechanism Tauri uses for `init_plugin_<name>()` and is proven to work reliably:

- **`request_permission`**: Rust spawns a thread that calls `extern "C" mobile_push_request_permission()` in Swift. The Swift function calls `UNUserNotificationCenter.requestAuthorization()` and blocks with a `DispatchSemaphore` until the user responds. Returns 1 (granted) or 0 (denied) to Rust.
- **`get_token`**: Rust spawns a thread that calls `extern "C" mobile_push_get_device_token()` in Swift. On first call, the Swift function lazily injects APNs delegate methods (`didRegisterForRemoteNotificationsWithDeviceToken`, `didFailToRegisterForRemoteNotificationsWithError`) into Tao's dynamically-created AppDelegate using `imp_implementationWithBlock` + `class_addMethod`. It then calls `registerForRemoteNotifications()` and blocks until the APNs callback fires, writing the hex token to a C buffer.
- **`register_listener`**: Handled as a no-op in Rust's `generate_handler!` to prevent fallthrough to the broken `run_mobile_plugin` path.

### Android: Standard Tauri Plugin Dispatch

On Android, the standard Tauri plugin dispatch works correctly. The Kotlin `MobilePushPlugin` handles commands directly, and `FCMService` (a `FirebaseMessagingService`) forwards incoming messages and token refreshes to the plugin's event system.

### TypeScript

Thin async wrappers over `invoke()` and `addPluginListener()` from `@tauri-apps/api/core`. Published as `tauri-plugin-mobile-push-api` on npm.

## Known Limitations

- **iOS event listeners are not yet functional.** `onNotificationReceived`, `onNotificationTapped`, and `onTokenRefresh` register successfully but do not deliver events on iOS. This is because the Tauri `PluginManager` dispatch issue also affects the plugin's `trigger()` method for emitting events to the webview. The commands (`requestPermission`, `getToken`) work correctly via the direct FFI path. A future release will route iOS events through `AppHandle.emit()` to bypass the `PluginManager`.
- **Android event listeners work as expected.** The standard Tauri plugin dispatch functions correctly on Android.
- **Not published on crates.io yet.** Use a git dependency in `Cargo.toml` for now.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT License](LICENSE-MIT) at your option.
