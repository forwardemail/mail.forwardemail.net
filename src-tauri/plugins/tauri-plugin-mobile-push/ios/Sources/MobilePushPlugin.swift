import UIKit
import WebKit
import UserNotifications
import Tauri
import ObjectiveC

// MARK: - Result codes shared with src/commands.rs

/// Returned by `mobile_push_request_permission`.
private let PERMISSION_GRANTED: Int32 = 1
/// The user was asked and declined.
private let PERMISSION_DENIED: Int32 = 0
/// Permission was denied earlier. iOS never shows the prompt again; the user
/// has to re-enable notifications in the Settings app.
private let PERMISSION_PREVIOUSLY_DENIED: Int32 = 2
/// requestAuthorization reported an error (message written to the buffer).
private let PERMISSION_ERROR: Int32 = 3
/// No answer before the timeout.
private let PERMISSION_TIMEOUT: Int32 = -2

/// Returned (negative) by `mobile_push_get_device_token`.
private let TOKEN_ERROR: Int32 = -1
private let TOKEN_TIMEOUT: Int32 = -2
private let TOKEN_SIMULATOR: Int32 = -3

private let LAST_TOKEN_DEFAULTS_KEY = "net.forwardemail.mobile-push.apns-token"

// MARK: - Token Fetcher (thread-safe async token retrieval)

/// Fetches an APNs device token by registering for remote notifications
/// and blocking until the AppDelegate callback fires.
private final class TokenFetcher {
    let semaphore = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var settled = false
    private(set) var token: String?
    private(set) var error: String?

    func resolve(_ tokenString: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !settled else { return }
        settled = true
        token = tokenString
        semaphore.signal()
    }

    func reject(_ errorMessage: String) {
        lock.lock()
        defer { lock.unlock() }
        guard !settled else { return }
        settled = true
        error = errorMessage
        semaphore.signal()
    }
}

/// The in-flight fetcher. Written from the Tauri IPC thread and read from the
/// main thread (APNs callbacks), so every access goes through `fetcherLock`.
private var activeTokenFetcher: TokenFetcher?
private let fetcherLock = NSLock()
/// Serializes whole getDeviceToken calls: one registration at a time.
private let tokenLock = NSLock()

private func setActiveFetcher(_ fetcher: TokenFetcher?) {
    fetcherLock.lock()
    activeTokenFetcher = fetcher
    fetcherLock.unlock()
}

private func currentFetcher() -> TokenFetcher? {
    fetcherLock.lock()
    defer { fetcherLock.unlock() }
    return activeTokenFetcher
}

/// Every APNs token delivery goes through here, whichever path it arrived by
/// (ObjC +load injection, the Swift fallback injection, or a host post).
private func deliverToken(_ tokenString: String) {
    NSLog("[mobile-push] APNs token received: %@...", String(tokenString.prefix(16)))
    UserDefaults.standard.set(tokenString, forKey: LAST_TOKEN_DEFAULTS_KEY)
    currentFetcher()?.resolve(tokenString)
    MobilePushPlugin.instance?.handleTokenString(tokenString)
}

private func deliverTokenError(_ message: String) {
    NSLog("[mobile-push] APNs registration failed: %@", message)
    currentFetcher()?.reject(message)
}

private func tokenHex(_ data: Data) -> String {
    return data.map { String(format: "%02.2hhx", $0) }.joined()
}

/// Copy a UTF-8 message into a caller-owned C buffer (always NUL-terminated).
private func writeCString(_ message: String, _ buffer: UnsafeMutablePointer<CChar>?, _ bufferLen: Int32) {
    guard let buffer = buffer, bufferLen > 0 else { return }
    let bytes = Array(message.utf8.prefix(Int(bufferLen) - 1))
    for (i, b) in bytes.enumerated() {
        buffer[i] = CChar(bitPattern: b)
    }
    buffer[bytes.count] = 0
}

// MARK: - Notification observers and UNUserNotificationCenter delegate

/// Configured foreground presentation options. Set via FFI at plugin init.
private var configuredForegroundPresentation: UNNotificationPresentationOptions =
    [.banner, .list, .sound, .badge]

/// UNUserNotificationCenter delegate for foreground notification handling.
///
/// iOS allows exactly one delegate. tauri-plugin-notification installs its
/// own for LOCAL notifications (the ones the app shows itself, and whose taps
/// drive its onAction callback). Replacing it outright silently broke those
/// taps, so anything that is not a remote push is forwarded to the delegate
/// that was installed before this one.
private final class PushNotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushNotificationHandler()
    var previousDelegate: UNUserNotificationCenterDelegate?

    private func isRemote(_ notification: UNNotification) -> Bool {
        return notification.request.trigger is UNPushNotificationTrigger
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        if !isRemote(notification),
           let previous = previousDelegate,
           previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:withCompletionHandler:))) {
            previous.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler)
            return
        }
        MobilePushPlugin.instance?.handleNotification(notification.request.content.userInfo)
        completionHandler(configuredForegroundPresentation)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if !isRemote(response.notification),
           let previous = previousDelegate,
           previous.responds(to: #selector(UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:))) {
            previous.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler)
            return
        }
        MobilePushPlugin.instance?.handleNotificationTap(response.notification.request.content.userInfo)
        completionHandler()
    }
}

private var observersInstalled = false
private var notificationDelegateInstalled = false
private var appDelegateFallbackChecked = false

/// Register the NotificationCenter observers that carry APNs callbacks from
/// TaoWindowCapture.m. These need no app delegate, so they are installed as
/// early as possible (plugin load) rather than lazily: a token refresh that
/// iOS delivers at launch used to arrive before anything was listening.
///
/// Must be called on the main thread.
private func installObserversIfNeeded() {
    guard !observersInstalled else { return }
    observersInstalled = true

    NotificationCenter.default.addObserver(
        forName: Notification.Name("APNsTokenReceived"),
        object: nil,
        queue: nil
    ) { notification in
        if let token = notification.userInfo?["token"] as? String, !token.isEmpty {
            deliverToken(token)
        } else if let data = notification.userInfo?["tokenData"] as? Data {
            deliverToken(tokenHex(data))
        }
    }
    NotificationCenter.default.addObserver(
        forName: Notification.Name("APNsRegistrationFailed"),
        object: nil,
        queue: nil
    ) { notification in
        let message = (notification.userInfo?["error"] as? String) ?? "Unknown APNs registration error"
        deliverTokenError(message)
    }
    NotificationCenter.default.addObserver(
        forName: Notification.Name("PushNotificationReceived"),
        object: nil,
        queue: nil
    ) { notification in
        if let userInfo = notification.userInfo {
            MobilePushPlugin.instance?.handleNotification(userInfo)
        }
    }
    NotificationCenter.default.addObserver(
        forName: Notification.Name("PushNotificationTapped"),
        object: nil,
        queue: nil
    ) { notification in
        if let userInfo = notification.userInfo {
            MobilePushPlugin.instance?.handleNotificationTap(userInfo)
        }
    }
    NSLog("[mobile-push] NotificationCenter observers installed")
}

/// Install the UNUserNotificationCenter delegate, remembering whichever one
/// was there before (see PushNotificationHandler).
///
/// Must be called on the main thread.
private func installNotificationDelegateIfNeeded() {
    guard !notificationDelegateInstalled else { return }
    notificationDelegateInstalled = true
    let center = UNUserNotificationCenter.current()
    if let existing = center.delegate, !(existing === PushNotificationHandler.shared) {
        PushNotificationHandler.shared.previousDelegate = existing
    }
    center.delegate = PushNotificationHandler.shared
    NSLog("[mobile-push] Set UNUserNotificationCenter.delegate (previous forwarded: %@)",
          PushNotificationHandler.shared.previousDelegate == nil ? "no" : "yes")
}

/// Fallback for builds where TaoWindowCapture.m did not run (for example a
/// project generated without scripts/inject-ios-scene-delegate.cjs): add the
/// APNs callbacks to the app delegate class at runtime.
///
/// Must be called on the main thread.
private func ensureAppDelegateCallbacks() {
    guard !appDelegateFallbackChecked else { return }
    guard let delegate = UIApplication.shared.delegate else {
        // Retry on the next call; the delegate is normally present by the time
        // JS can invoke anything.
        NSLog("[mobile-push] ensureAppDelegateCallbacks: no UIApplication.delegate yet")
        return
    }
    appDelegateFallbackChecked = true

    let cls: AnyClass = type(of: delegate)
    let didRegisterSel = sel_registerName("application:didRegisterForRemoteNotificationsWithDeviceToken:")
    if class_respondsToSelector(cls, didRegisterSel) {
        NSLog("[mobile-push] APNs callbacks present on %@", NSStringFromClass(cls))
        return
    }

    NSLog("[mobile-push] APNs callbacks missing on %@ — injecting fallback", NSStringFromClass(cls))
    let didRegisterBlock: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { _, _, tokenNSData in
        deliverToken(tokenHex(tokenNSData as Data))
    }
    _ = class_addMethod(cls, didRegisterSel, imp_implementationWithBlock(didRegisterBlock as Any), "v@:@@")

    let didFailSel = sel_registerName("application:didFailToRegisterForRemoteNotificationsWithError:")
    let didFailBlock: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
        deliverTokenError(error.localizedDescription)
    }
    _ = class_addMethod(cls, didFailSel, imp_implementationWithBlock(didFailBlock as Any), "v@:@@")

    // UIApplication caches respondsToSelector: when the delegate is set.
    // Re-assigning the SAME object refreshes that cache; assigning nil first
    // tears down the scene lifecycle on iOS 26, so never do that.
    UIApplication.shared.delegate = delegate
}

private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
        work()
    } else {
        DispatchQueue.main.sync(execute: work)
    }
}

// MARK: - Direct FFI functions (bypass PluginManager dispatch)

/// Configure what iOS shows when a notification arrives while the app is
/// foreground. `options` is the `UNNotificationPresentationOptions` bitmask
/// assembled on the Rust side from `ForegroundPresentationOptions`.
@_cdecl("mobile_push_set_foreground_presentation")
func setForegroundPresentation(_ options: UInt32) {
    configuredForegroundPresentation =
        UNNotificationPresentationOptions(rawValue: UInt(options))
    NSLog("[mobile-push] Foreground presentation set: %u", options)
}

/// Request notification permission.
///
/// Reads the current authorization first: iOS only ever shows the system
/// prompt while the status is `.notDetermined`, so a previous "Don't Allow"
/// is reported as PERMISSION_PREVIOUSLY_DENIED instead of looking like a
/// prompt that silently never appeared.
///
/// Called on a background thread; blocks until the user answers or
/// `timeoutSecs` elapses. Error text (if any) is written to `errBuffer`.
@_cdecl("mobile_push_request_permission")
func requestPermissionDirect(
    _ timeoutSecs: Int32,
    _ errBuffer: UnsafeMutablePointer<CChar>?,
    _ errBufferLen: Int32
) -> Int32 {
    let center = UNUserNotificationCenter.current()

    let settingsSem = DispatchSemaphore(value: 0)
    var status: UNAuthorizationStatus = .notDetermined
    center.getNotificationSettings { settings in
        status = settings.authorizationStatus
        settingsSem.signal()
    }
    if settingsSem.wait(timeout: .now() + 10) == .timedOut {
        writeCString("Timed out reading notification settings", errBuffer, errBufferLen)
        return PERMISSION_TIMEOUT
    }

    var alreadyGranted = status == .authorized || status == .provisional
    if #available(iOS 14.0, *), status == .ephemeral {
        alreadyGranted = true
    }
    if alreadyGranted {
        NSLog("[mobile-push] Notification permission already granted (status=%ld)", status.rawValue)
        return PERMISSION_GRANTED
    }
    if status == .denied {
        NSLog("[mobile-push] Notification permission previously denied; iOS will not prompt again")
        return PERMISSION_PREVIOUSLY_DENIED
    }

    let sem = DispatchSemaphore(value: 0)
    var granted = false
    var requestError: String?

    // Ask from the main queue so the system alert is tied to the foreground
    // scene; iOS queues it until the app is active if it is not yet.
    DispatchQueue.main.async {
        NSLog("[mobile-push] Requesting notification authorization (system prompt)")
        center.requestAuthorization(options: [.alert, .badge, .sound]) { result, error in
            if let error = error {
                requestError = error.localizedDescription
            }
            granted = result
            sem.signal()
        }
    }

    let timeout = max(Int(timeoutSecs), 10)
    if sem.wait(timeout: .now() + .seconds(timeout)) == .timedOut {
        NSLog("[mobile-push] requestAuthorization timed out after %ds", timeout)
        writeCString("No answer to the notification permission prompt", errBuffer, errBufferLen)
        return PERMISSION_TIMEOUT
    }

    if let requestError = requestError {
        NSLog("[mobile-push] requestAuthorization error: %@", requestError)
        writeCString(requestError, errBuffer, errBufferLen)
        return granted ? PERMISSION_GRANTED : PERMISSION_ERROR
    }

    NSLog("[mobile-push] Permission %@", granted ? "granted" : "denied")
    return granted ? PERMISSION_GRANTED : PERMISSION_DENIED
}

/// Get the APNs device token. Blocks until the token is received or timeout.
/// Writes the hex token (NUL-terminated) to `buffer`, or the failure reason
/// to `errBuffer`.
/// Returns: >0 token length, -1 error, -2 timeout, -3 simulator.
@_cdecl("mobile_push_get_device_token")
func getDeviceTokenDirect(
    _ buffer: UnsafeMutablePointer<CChar>,
    _ bufferLen: Int32,
    _ timeoutSecs: Int32,
    _ errBuffer: UnsafeMutablePointer<CChar>?,
    _ errBufferLen: Int32
) -> Int32 {
    tokenLock.lock()
    defer { tokenLock.unlock() }

    #if targetEnvironment(simulator)
    // registerForRemoteNotifications raises on the iOS 26 simulator instead
    // of failing gracefully.
    writeCString("APNs is not available in the iOS Simulator", errBuffer, errBufferLen)
    return TOKEN_SIMULATOR
    #else
    onMain {
        installObserversIfNeeded()
        installNotificationDelegateIfNeeded()
        ensureAppDelegateCallbacks()
    }

    let fetcher = TokenFetcher()
    setActiveFetcher(fetcher)
    defer { setActiveFetcher(nil) }

    DispatchQueue.main.async {
        NSLog("[mobile-push] Calling registerForRemoteNotifications...")
        UIApplication.shared.registerForRemoteNotifications()
    }

    let timeout = max(Int(timeoutSecs), 5)
    let result = fetcher.semaphore.wait(timeout: .now() + .seconds(timeout))

    var resolvedToken: String?
    if result == .timedOut {
        // iOS normally answers every registerForRemoteNotifications call, but
        // on a flaky network the callback can take a long time. A token from an
        // earlier successful registration is still the device's token while
        // the app remains registered, so prefer it over failing outright.
        var registered = false
        onMain { registered = UIApplication.shared.isRegisteredForRemoteNotifications }
        if registered, let cached = UserDefaults.standard.string(forKey: LAST_TOKEN_DEFAULTS_KEY), !cached.isEmpty {
            NSLog("[mobile-push] Token callback timed out after %ds; using cached token", timeout)
            resolvedToken = cached
        } else {
            NSLog("[mobile-push] Token request timed out after %ds", timeout)
            writeCString(
                "Apple Push Notification service did not answer within \(timeout) seconds. Check the network connection and try again.",
                errBuffer, errBufferLen)
            return TOKEN_TIMEOUT
        }
    } else if let error = fetcher.error {
        writeCString(error, errBuffer, errBufferLen)
        return TOKEN_ERROR
    } else {
        resolvedToken = fetcher.token
    }

    guard let token = resolvedToken, !token.isEmpty else {
        writeCString("APNs returned an empty device token", errBuffer, errBufferLen)
        return TOKEN_ERROR
    }

    let bytes = Array(token.utf8)
    guard bytes.count < Int(bufferLen) else {
        writeCString("APNs device token is too long (\(bytes.count) bytes)", errBuffer, errBufferLen)
        return TOKEN_ERROR
    }
    for (i, b) in bytes.enumerated() {
        buffer[i] = CChar(bitPattern: b)
    }
    buffer[bytes.count] = 0

    NSLog("[mobile-push] Token (%d chars) written to buffer", bytes.count)
    return Int32(bytes.count)
    #endif
}

/// Open this app's page in the Settings app, where a previously denied
/// notification permission can be re-enabled. Returns 1 when iOS accepted
/// the request.
@_cdecl("mobile_push_open_settings")
func openSettingsDirect() -> Int32 {
    let sem = DispatchSemaphore(value: 0)
    var opened = false
    DispatchQueue.main.async {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            sem.signal()
            return
        }
        UIApplication.shared.open(url, options: [:]) { success in
            opened = success
            sem.signal()
        }
    }
    _ = sem.wait(timeout: .now() + 10)
    return opened ? 1 : 0
}

// MARK: - Plugin class (kept for event system + lifecycle)
@objc(MobilePushPlugin)
public class MobilePushPlugin: Plugin {
    public static var instance: MobilePushPlugin?
    private weak var pluginWebView: WKWebView?

    override public func load(webview: WKWebView) {
        MobilePushPlugin.instance = self
        self.pluginWebView = webview
        onMain {
            installObserversIfNeeded()
        }
        NSLog("[mobile-push] Plugin loaded (webview ready)")
    }

    // MARK: - PluginManager command handlers (kept as fallback)
    // Commands are served by the direct FFI functions above; these only run if
    // a call ever falls through to run_mobile_plugin.
    @objc override public func requestPermissions(_ invoke: Invoke) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                invoke.reject(error.localizedDescription)
                return
            }
            invoke.resolve(["granted": granted])
        }
    }

    @objc public func getToken(_ invoke: Invoke) {
        invoke.reject("getToken is served by the direct FFI path")
    }

    // MARK: - Callbacks

    public func handleTokenString(_ tokenString: String) {
        // Plugin.trigger() never reaches JS (register_listener is a no-op, so
        // the Swift listener registry stays empty). Dispatch a DOM event.
        emitToWebView("mobile-push:token-received", json: "{\"token\":\"\(tokenString)\"}")
    }

    /// Kept for source compatibility with hosts that call it directly.
    public func handleToken(_ token: Data) {
        deliverToken(tokenHex(token))
    }

    public func handleTokenError(_ error: Error) {
        deliverTokenError(error.localizedDescription)
    }

    public func handleNotification(_ userInfo: [AnyHashable: Any]) {
        // Wrap in {data: ...} to match the Android shape read by
        // dispatchPushPayload in src/utils/push-notifications.js.
        let jsonPayload = serializeUserInfo(userInfo)
        emitToWebView("mobile-push:notification-received", json: "{\"data\":\(jsonPayload)}")
    }

    public func handleNotificationTap(_ userInfo: [AnyHashable: Any]) {
        let jsonPayload = serializeUserInfo(userInfo)
        emitToWebView("mobile-push:notification-tapped", json: "{\"data\":\(jsonPayload)}")
    }

    // MARK: - Direct JS event dispatch

    private func emitToWebView(_ eventName: String, json: String) {
        let js = "window.dispatchEvent(new CustomEvent('\(eventName)',{detail:\(json)}))"
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.pluginWebView else {
                NSLog("[mobile-push] emitToWebView: no webview reference")
                return
            }
            webView.evaluateJavaScript(js) { _, error in
                if let error = error {
                    NSLog("[mobile-push] emitToWebView failed: %@", error.localizedDescription)
                }
            }
        }
    }

    /// Serialize APNs userInfo to JSON, dropping anything JSONSerialization
    /// cannot represent (it raises an Objective-C exception, which would
    /// crash the app, rather than throwing a Swift error).
    private func serializeUserInfo(_ userInfo: [AnyHashable: Any]) -> String {
        var filtered: [String: Any] = [:]
        for (key, value) in userInfo {
            guard let stringKey = key as? String else { continue }
            if JSONSerialization.isValidJSONObject([stringKey: value]) {
                filtered[stringKey] = value
            } else {
                filtered[stringKey] = String(describing: value)
            }
        }
        guard JSONSerialization.isValidJSONObject(filtered),
              let jsonData = try? JSONSerialization.data(withJSONObject: filtered, options: []),
              let jsonString = String(data: jsonData, encoding: .utf8) else {
            return "{}"
        }
        return jsonString
    }
}

// MARK: - Plugin entry point

@_cdecl("init_plugin_mobile_push")
func initPlugin() -> Plugin {
    // The app delegate may not exist yet here (Tao creates it during launch),
    // so delegate work stays lazy. Observers need no delegate and are set up
    // in load(webview:).
    return MobilePushPlugin()
}
