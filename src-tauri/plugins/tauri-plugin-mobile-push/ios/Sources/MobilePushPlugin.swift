import UIKit
import WebKit
import UserNotifications
import Tauri
import ObjectiveC

// MARK: - Token Fetcher (thread-safe async token retrieval)

/// Fetches an APNs device token by registering for remote notifications
/// and blocking until the AppDelegate callback fires.
private class TokenFetcher {
    let semaphore = DispatchSemaphore(value: 0)
    var token: String?
    var error: String?

    func resolve(_ tokenString: String) {
        self.token = tokenString
        semaphore.signal()
    }

    func reject(_ errorMessage: String) {
        self.error = errorMessage
        semaphore.signal()
    }
}

/// The active token fetcher — set during getDeviceToken, read by AppDelegate callbacks.
/// Access is serialized: only one getToken call can be in-flight at a time (guarded by tokenLock).
private var activeTokenFetcher: TokenFetcher?
private let tokenLock = NSLock()

// MARK: - AppDelegate method injection

/// Whether we've already injected APNs methods into the AppDelegate class.
private var apnsDelegateSetUp = false

/// Configured foreground presentation options. Set via FFI at plugin init.
/// Defaults to banner + list + sound + badge for back-compat with 0.1.3 and
/// earlier, which hardcoded this behavior.
private var configuredForegroundPresentation: UNNotificationPresentationOptions =
    [.banner, .list, .sound, .badge]

/// UNUserNotificationCenter delegate for foreground notification handling.
/// `willPresent` fires only when the app is in the foreground; backgrounded
/// and locked states bypass this delegate entirely and iOS shows the system
/// banner natively.
private class PushNotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationHandler()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        MobilePushPlugin.instance?.handleNotification(notification.request.content.userInfo)
        completionHandler(configuredForegroundPresentation)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        MobilePushPlugin.instance?.handleNotificationTap(response.notification.request.content.userInfo)
        completionHandler()
    }
}

/// Sets up APNs delegate methods and notification observers.
///
/// APNs callback methods (didRegisterForRemoteNotificationsWithDeviceToken: etc.)
/// are now injected by TaoWindowCapture.m at +load time via a setDelegate: swizzle.
/// This ensures the methods exist BEFORE UIApplication builds its respondsToSelector:
/// cache — eliminating the need for any delegate reassignment (which crashes on iOS 26
/// because setting delegate=nil tears down the scene lifecycle).
///
/// This function only sets up the NotificationCenter observers and UNUserNotificationCenter
/// delegate. The actual APNs methods are in ObjC (TaoWindowCapture.m) and post
/// NSNotifications that we observe here.
///
/// Must be called on the main thread.
private func setupApnsDelegateInternal() {
    guard !apnsDelegateSetUp else { return }

    guard let delegate = UIApplication.shared.delegate else {
        NSLog("[mobile-push] setupApnsDelegate: no UIApplication.delegate found")
        return
    }

    let cls: AnyClass = type(of: delegate)
    NSLog("[mobile-push] setupApnsDelegate: delegate class = %@", NSStringFromClass(cls))

    // Verify that TaoWindowCapture.m already injected the APNs methods at +load time.
    // If not (e.g., inject script didn't run), fall back to adding them here + reassign.
    let didRegisterSel = sel_registerName("application:didRegisterForRemoteNotificationsWithDeviceToken:")
    let methodsAlreadyInjected = class_respondsToSelector(cls, didRegisterSel)

    if methodsAlreadyInjected {
        NSLog("[mobile-push] APNs methods already present on %@ (injected by TaoWindowCapture +load)", NSStringFromClass(cls))
    } else {
        NSLog("[mobile-push] APNs methods NOT found — injecting as fallback")

        // Fallback: inject methods here (same as before)
        let didRegisterBlock: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { _, _, tokenNSData in
            let tokenData = tokenNSData as Data
            let tokenString = tokenData.map { String(format: "%02.2hhx", $0) }.joined()
            NSLog("[mobile-push] APNs token received: %@...", String(tokenString.prefix(16)))
            activeTokenFetcher?.resolve(tokenString)
            MobilePushPlugin.instance?.handleToken(tokenData)
        }
        let didRegisterImp = imp_implementationWithBlock(didRegisterBlock as Any)
        class_addMethod(cls, didRegisterSel, didRegisterImp, "v@:@@")

        let didFailSel = sel_registerName("application:didFailToRegisterForRemoteNotificationsWithError:")
        let didFailBlock: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
            NSLog("[mobile-push] APNs registration failed: %@", error.localizedDescription)
            activeTokenFetcher?.reject(error.localizedDescription)
            MobilePushPlugin.instance?.handleTokenError(error as Error)
        }
        let didFailImp = imp_implementationWithBlock(didFailBlock as Any)
        class_addMethod(cls, didFailSel, didFailImp, "v@:@@")

        // Must reassign delegate to flush UIApplication's cache.
        // On iOS 26+ this is risky but we have no choice in fallback mode.
        if #available(iOS 26, *) {
            // On iOS 26, re-assign same object (not nil) — this MAY flush the cache
            // depending on Apple's implementation. It's our best effort fallback.
            UIApplication.shared.delegate = delegate
            NSLog("[mobile-push] iOS 26 fallback: re-assigned delegate (same object)")
        } else {
            UIApplication.shared.delegate = nil
            UIApplication.shared.delegate = delegate
            NSLog("[mobile-push] Re-assigned UIApplication.delegate to flush cache")
        }
    }

    // Set UNUserNotificationCenter delegate for foreground handling + tap handling
    UNUserNotificationCenter.current().delegate = PushNotificationHandler.shared
    NSLog("[mobile-push] Set UNUserNotificationCenter.delegate")

    // Listen for NotificationCenter-based token delivery as a fallback.
    // If the host app implements AppDelegate.swift and posts APNsTokenReceived
    // (as documented in the README), this observer resolves the token fetcher.
    NotificationCenter.default.addObserver(
        forName: Notification.Name("APNsTokenReceived"),
        object: nil,
        queue: nil
    ) { notification in
        if let token = notification.userInfo?["token"] as? String {
            NSLog("[mobile-push] Token received via NotificationCenter: %@...", String(token.prefix(16)))
            activeTokenFetcher?.resolve(token)
            MobilePushPlugin.instance?.trigger("token-received", data: ["token": token])
        }
    }
    NotificationCenter.default.addObserver(
        forName: Notification.Name("APNsRegistrationFailed"),
        object: nil,
        queue: nil
    ) { notification in
        if let error = notification.userInfo?["error"] as? String {
            NSLog("[mobile-push] Registration failed via NotificationCenter: %@", error)
            activeTokenFetcher?.reject(error)
        }
    }
    NotificationCenter.default.addObserver(
        forName: Notification.Name("PushNotificationReceived"),
        object: nil,
        queue: nil
    ) { notification in
        if let userInfo = notification.userInfo as? [AnyHashable: Any] {
            MobilePushPlugin.instance?.handleNotification(userInfo)
        }
    }
    NotificationCenter.default.addObserver(
        forName: Notification.Name("PushNotificationTapped"),
        object: nil,
        queue: nil
    ) { notification in
        if let userInfo = notification.userInfo as? [AnyHashable: Any] {
            MobilePushPlugin.instance?.handleNotificationTap(userInfo)
        }
    }

    apnsDelegateSetUp = true
}

// MARK: - Direct FFI functions (bypass PluginManager dispatch)

/// Configure what iOS shows when a notification arrives while the app is
/// foreground. `options` is the `UNNotificationPresentationOptions` bitmask
/// assembled on the Rust side from `ForegroundPresentationOptions`.
/// Called once from the Rust plugin setup after `register_ios_plugin`.
@_cdecl("mobile_push_set_foreground_presentation")
func setForegroundPresentation(_ options: UInt32) {
    configuredForegroundPresentation =
        UNNotificationPresentationOptions(rawValue: UInt(options))
    NSLog("[mobile-push] Foreground presentation set: %u", options)
}

/// Request notification permission. Blocks until the user responds (30s timeout).
/// Returns 1 if granted, 0 if denied or error.
@_cdecl("mobile_push_request_permission")
func requestPermissionDirect() -> Int32 {
    let sem = DispatchSemaphore(value: 0)
    var granted = false

    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { result, error in
        if let error = error {
            NSLog("[mobile-push] requestAuthorization error: %@", error.localizedDescription)
        }
        granted = result
        sem.signal()
    }

    let result = sem.wait(timeout: .now() + 30)
    if result == .timedOut {
        NSLog("[mobile-push] requestAuthorization timed out")
        return 0
    }

    NSLog("[mobile-push] Permission %@", granted ? "granted" : "denied")
    return granted ? 1 : 0
}

/// Get the APNs device token. Blocks until the token is received or timeout.
/// Writes the hex token string (null-terminated) to buffer.
/// Returns: >0 = token length, -1 = error, -2 = timeout.
@_cdecl("mobile_push_get_device_token")
func getDeviceTokenDirect(_ buffer: UnsafeMutablePointer<CChar>, _ bufferLen: Int32, _ timeoutSecs: Int32) -> Int32 {
    // Serialize concurrent calls
    tokenLock.lock()
    defer { tokenLock.unlock() }

    // Ensure APNs delegate is set up
    if !apnsDelegateSetUp {
        if Thread.isMainThread {
            setupApnsDelegateInternal()
        } else {
            DispatchQueue.main.sync {
                setupApnsDelegateInternal()
            }
        }
    }

    let fetcher = TokenFetcher()
    activeTokenFetcher = fetcher

    // Register for remote notifications (must be on main thread).
    // Skip on simulator — registerForRemoteNotifications crashes on iOS 26
    // simulator because APNs is unavailable and the call triggers a fatal
    // exception rather than a graceful failure.
    DispatchQueue.main.async {
        NSLog("[mobile-push] Calling registerForRemoteNotifications...")
        #if !targetEnvironment(simulator)
        UIApplication.shared.registerForRemoteNotifications()
        #else
        NSLog("[mobile-push] Skipping registerForRemoteNotifications (simulator)")
        #endif
    }

    // Wait for the token
    let timeout = max(Int(timeoutSecs), 5)
    let result = fetcher.semaphore.wait(timeout: .now() + .seconds(timeout))
    activeTokenFetcher = nil

    if result == .timedOut {
        NSLog("[mobile-push] Token request timed out after %ds", timeout)
        return -2
    }

    if let error = fetcher.error {
        NSLog("[mobile-push] Token error: %@", error)
        return -1
    }

    guard let token = fetcher.token else {
        NSLog("[mobile-push] Token is nil after semaphore signal")
        return -1
    }

    // Write token to buffer
    let bytes = Array(token.utf8)
    guard bytes.count < Int(bufferLen) else {
        NSLog("[mobile-push] Token too long for buffer: %d >= %d", bytes.count, bufferLen)
        return -1
    }
    for (i, b) in bytes.enumerated() {
        buffer[i] = CChar(bitPattern: b)
    }
    buffer[bytes.count] = 0

    NSLog("[mobile-push] Token (%d chars) written to buffer", bytes.count)
    return Int32(bytes.count)
}

// MARK: - Plugin class (kept for event system + lifecycle)

@objc(MobilePushPlugin)
public class MobilePushPlugin: Plugin {
    public static var instance: MobilePushPlugin?

    override public func load(webview: WKWebView) {
        MobilePushPlugin.instance = self
        NSLog("[mobile-push] Plugin loaded (webview ready)")
    }

    // MARK: - PluginManager command handlers (kept as fallback)
    // These handle commands routed through run_mobile_plugin / PluginManager.
    // Currently bypassed by the direct FFI functions above.

    @objc override public func requestPermissions(_ invoke: Invoke) {
        NSLog("[mobile-push] requestPermissions via PluginManager")
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                invoke.reject(error.localizedDescription)
                return
            }
            invoke.resolve(["granted": granted])
        }
    }

    @objc public func getToken(_ invoke: Invoke) {
        NSLog("[mobile-push] getToken via PluginManager")
        DispatchQueue.main.async {
            #if !targetEnvironment(simulator)
            UIApplication.shared.registerForRemoteNotifications()
            #else
            NSLog("[mobile-push] Skipping registerForRemoteNotifications (simulator)")
            #endif
        }
        // Token arrives via handleToken() callback from AppDelegate
    }

    // MARK: - Callbacks from AppDelegate injection

    public func handleToken(_ token: Data) {
        let tokenString = token.map { String(format: "%02.2hhx", $0) }.joined()
        NSLog("[mobile-push] handleToken: %@...", String(tokenString.prefix(16)))
        activeTokenFetcher?.resolve(tokenString)
        self.trigger("token-received", data: ["token": tokenString])
    }

    public func handleTokenError(_ error: Error) {
        NSLog("[mobile-push] handleTokenError: %@", error.localizedDescription)
        activeTokenFetcher?.reject(error.localizedDescription)
    }

    public func handleNotification(_ userInfo: [AnyHashable: Any]) {
        var data: JSObject = [:]
        for (key, value) in userInfo {
            guard let stringKey = key as? String else { continue }
            if let stringValue = value as? String {
                data[stringKey] = stringValue
            } else if let numberValue = value as? NSNumber {
                data[stringKey] = numberValue.intValue
            }
        }
        self.trigger("notification-received", data: data)
    }

    public func handleNotificationTap(_ userInfo: [AnyHashable: Any]) {
        var data: JSObject = [:]
        for (key, value) in userInfo {
            guard let stringKey = key as? String else { continue }
            if let stringValue = value as? String {
                data[stringKey] = stringValue
            } else if let numberValue = value as? NSNumber {
                data[stringKey] = numberValue.intValue
            }
        }
        self.trigger("notification-tapped", data: data)
    }
}

// MARK: - Plugin entry point

@_cdecl("init_plugin_mobile_push")
func initPlugin() -> Plugin {
    // NOTE: Do NOT call setupApnsDelegateInternal() here.
    // During plugin init, UIApplication.shared.delegate may not be set yet
    // (Tao creates it dynamically and we run before didFinishLaunchingWithOptions completes).
    // The delegate setup happens lazily on the first getDeviceToken call.
    return MobilePushPlugin()
}
