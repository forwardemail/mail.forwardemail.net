import UIKit
import WebKit
import ObjectiveC

/// A UIWindowSceneDelegate that bridges tao 0.34.x (which lacks scene lifecycle
/// support) with iOS 26's mandatory scene lifecycle.
///
/// tao 0.34.x creates a UIWindow in application:didFinishLaunchingWithOptions:
/// and calls makeKeyAndVisible(). On iOS 26, a UIWindow without a windowScene
/// is not rendered, resulting in a permanent black screen.
///
/// This delegate works in conjunction with TaoWindowCapture.m which uses +load
/// to swizzle UIWindow.makeKeyAndVisible BEFORE the app delegate runs. The
/// swizzle captures any UIWindow that calls makeKeyAndVisible without a
/// windowScene. This delegate then retrieves that captured window and assigns
/// the windowScene to it.
///
/// After assigning the scene, we fix the viewport by cycling the WKWebView frame
/// (shrink by 1px then restore). This forces WebKit to recalculate its internal
/// CSS viewport dimensions. If that doesn't work, we fall back to a single reload
/// but ONLY on the first launch (not on subsequent activations).
@objc(TaoSceneDelegate)
class TaoSceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?
    private static var hasFixedViewport = false

    /// Navigation-delegate classes that already reload on content-process
    /// termination (see installRendererRecovery).
    private static var recoveryInstalledClasses = Set<ObjectIdentifier>()
    /// Last renderer recovery reload, to avoid reload loops.
    private static var lastRecoveryReload: Date?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else {
            NSLog("[SceneDelegate] scene is not UIWindowScene, ignoring")
            return
        }

        let bounds = windowScene.coordinateSpace.bounds
        NSLog("[SceneDelegate] scene:willConnectTo: sceneBounds=(%g,%g,%g,%g)",
              bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height)

        // Get windows captured by TaoWindowCapture's +load swizzle.
        let captured = TaoWindowCapture.capturedWindows()

        if let taoWindow = captured.first {
            NSLog("[SceneDelegate] Found captured tao window")
            assignScene(window: taoWindow, windowScene: windowScene)
            TaoWindowCapture.clearCapturedWindows()
            return
        }

        // If tao hasn't created its window yet, poll until it does.
        NSLog("[SceneDelegate] No captured windows yet, starting poll timer")

        var pollCount = 0
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] timer in
            pollCount += 1

            let windows = TaoWindowCapture.capturedWindows()
            if let taoWindow = windows.first {
                NSLog("[SceneDelegate:poll:%d] Found captured tao window", pollCount)
                self?.assignScene(window: taoWindow, windowScene: windowScene)
                TaoWindowCapture.clearCapturedWindows()
                timer.invalidate()
                return
            }

            // Also check the app delegate's window property
            if let appDelegate = UIApplication.shared.delegate,
               let delegateWindow = appDelegate.window ?? nil {
                NSLog("[SceneDelegate:poll:%d] Found window via AppDelegate", pollCount)
                self?.assignScene(window: delegateWindow, windowScene: windowScene)
                timer.invalidate()
                return
            }

            if pollCount >= 200 {
                NSLog("[SceneDelegate:poll] gave up after %d polls (10s)", pollCount)
                timer.invalidate()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
    }

    /// Assign the windowScene to the window and fix the viewport.
    private func assignScene(window: UIWindow, windowScene: UIWindowScene) {
        let bounds = windowScene.coordinateSpace.bounds

        NSLog("[SceneDelegate] Assigning windowScene, bounds=(%g,%g,%g,%g)",
              bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height)

        // 1. Assign the scene — this is the critical fix for the black screen
        window.windowScene = windowScene

        // 2. Update window frame to match scene bounds
        window.frame = bounds

        // 3. Re-call makeKeyAndVisible now that the window has a scene
        window.makeKeyAndVisible()

        // 4. Store reference so UIKit knows this is our window
        self.window = window

        NSLog("[SceneDelegate] Assignment complete. isKeyWindow=%d, isHidden=%d",
              window.isKeyWindow ? 1 : 0,
              window.isHidden ? 1 : 0)

        // 5. Force a layout pass so auto-layout constraints recalculate with
        //    the real safe area insets (now that we have a scene).
        window.setNeedsLayout()
        window.layoutIfNeeded()
        if let rootVC = window.rootViewController {
            rootVC.view.setNeedsLayout()
            rootVC.view.layoutIfNeeded()
        }

        // 6. Fix the viewport. We wait for the page to finish loading, then
        //    cycle the webview frame to force a viewport recalculation.
        //    Only do this once per app launch.
        if !TaoSceneDelegate.hasFixedViewport {
            TaoSceneDelegate.hasFixedViewport = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                self?.fixViewport(window: window, attempt: 1)
            }
        }
    }

    /// Fix the WKWebView viewport by cycling its frame dimensions.
    /// This forces WebKit to recalculate the CSS viewport (window.innerWidth/Height).
    private func fixViewport(window: UIWindow, attempt: Int) {
        guard let rootVC = window.rootViewController else {
            if attempt < 30 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    self?.fixViewport(window: window, attempt: attempt + 1)
                }
            }
            return
        }

        guard let webView = findWKWebView(in: rootVC.view) else {
            if attempt < 30 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    self?.fixViewport(window: window, attempt: attempt + 1)
                }
            }
            return
        }

        // Wait for the page to finish loading before fixing the viewport.
        // If we fix it while loading, the viewport might get reset again.
        if webView.isLoading && attempt < 60 {
            NSLog("[SceneDelegate:fix] WKWebView still loading, waiting... (attempt %d)", attempt)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                self?.fixViewport(window: window, attempt: attempt + 1)
            }
            return
        }

        installRendererRecovery(on: webView)

        let frame = webView.frame
        NSLog("[SceneDelegate:fix] WKWebView frame=(%g,%g,%g,%g)",
              frame.origin.x, frame.origin.y, frame.size.width, frame.size.height)

        // Technique: Cycle the frame by shrinking 1px then restoring.
        // This forces WKWebView to invalidate its internal viewport cache.
        let shrunkFrame = CGRect(
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width - 1,
            height: frame.size.height - 1
        )

        // Temporarily disable auto-layout constraints so we can manually set frame
        webView.translatesAutoresizingMaskIntoConstraints = true
        webView.frame = shrunkFrame
        webView.setNeedsLayout()
        webView.layoutIfNeeded()

        // Restore after a brief delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            webView.frame = frame
            webView.setNeedsLayout()
            webView.layoutIfNeeded()

            // Re-enable auto-layout (the Rust code sets constraints)
            webView.translatesAutoresizingMaskIntoConstraints = false

            NSLog("[SceneDelegate:fix] Frame cycle complete, checking viewport...")

            // Verify the viewport is correct via JS
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                webView.evaluateJavaScript("JSON.stringify({w:window.innerWidth,h:window.innerHeight})") { result, error in
                    if let json = result as? String {
                        NSLog("[SceneDelegate:fix] Viewport after frame cycle: %@", json)

                        // Parse the viewport dimensions
                        if let data = json.data(using: .utf8),
                           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let w = dict["w"] as? Double,
                           let h = dict["h"] as? Double {

                            let expectedWidth = Double(frame.size.width)
                            // If viewport is still wrong (more than 10% off), do a reload
                            if abs(w - expectedWidth) > expectedWidth * 0.1 {
                                NSLog("[SceneDelegate:fix] Viewport still wrong (w=%g, expected=%g), reloading...", w, expectedWidth)
                                webView.reload()
                            } else {
                                NSLog("[SceneDelegate:fix] Viewport correct, no reload needed")
                            }
                        }
                    } else if let error = error {
                        NSLog("[SceneDelegate:fix] JS error: %@", error.localizedDescription)
                        // If we can't check, do a reload as fallback
                        webView.reload()
                    }
                }
            }
        }
    }

    /// Recursively find the WKWebView in the view hierarchy
    private func findWKWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView {
            return webView
        }
        for subview in view.subviews {
            if let found = findWKWebView(in: subview) {
                return found
            }
        }
        return nil
    }

    // MARK: - Scene Lifecycle (app foreground/background)

    // MARK: - WebContent process recovery

    /// WKWebView renders in a separate WebContent process that iOS kills
    /// under memory pressure (most often while the app is in the background,
    /// but also in the foreground on a heavy page). WKWebView then tells its
    /// navigation delegate and waits: nothing is drawn and no input is handled
    /// until someone reloads. Wry forwards that callback only to a handler
    /// Tauri 2.10 never installs, so the app froze on whatever frame was last
    /// on screen — typically the lock screen — until it was force-quit.
    ///
    /// Replace the (empty) callback on wry's navigation-delegate class with a
    /// reload. Idempotent per class.
    private func installRendererRecovery(on webView: WKWebView) {
        guard let navigationDelegate = webView.navigationDelegate,
              let cls = object_getClass(navigationDelegate) else {
            return
        }
        let key = ObjectIdentifier(cls)
        guard !TaoSceneDelegate.recoveryInstalledClasses.contains(key) else { return }
        TaoSceneDelegate.recoveryInstalledClasses.insert(key)

        let selector = sel_registerName("webViewWebContentProcessDidTerminate:")
        let block: @convention(block) (AnyObject, WKWebView) -> Void = { _, terminatedWebView in
            NSLog("[SceneDelegate] WebContent process terminated")
            TaoSceneDelegate.recoverRenderer(terminatedWebView, reason: "process terminated")
        }
        _ = class_replaceMethod(cls, selector, imp_implementationWithBlock(block as Any), "v@:@")
        NSLog("[SceneDelegate] Renderer recovery installed on %@", NSStringFromClass(cls))
    }

    /// Reload a webview whose content process is gone. Rate-limited so a page
    /// that dies again immediately is not reloaded in a tight loop.
    private static func recoverRenderer(_ webView: WKWebView, reason: String) {
        DispatchQueue.main.async {
            let now = Date()
            if let last = lastRecoveryReload, now.timeIntervalSince(last) < 5 {
                NSLog("[SceneDelegate] Skipping renderer reload (%@): reloaded %.1fs ago",
                      reason, now.timeIntervalSince(last))
                return
            }
            lastRecoveryReload = now
            NSLog("[SceneDelegate] Reloading webview (%@)", reason)
            if webView.url != nil {
                webView.reload()
            } else {
                webView.reloadFromOrigin()
            }
        }
    }

    /// Belt and braces for the delegate hook: when the app comes back to the
    /// foreground, ask the page for a trivial value. A terminated content
    /// process answers with WKError.webContentProcessTerminated.
    private func checkRendererAlive(_ webView: WKWebView) {
        webView.evaluateJavaScript("1") { _, error in
            guard let nsError = error as NSError? else { return }
            if nsError.domain == WKErrorDomain,
               nsError.code == WKError.Code.webContentProcessTerminated.rawValue {
                TaoSceneDelegate.recoverRenderer(webView, reason: "liveness check")
            }
        }
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        NSLog("[SceneDelegate] sceneDidBecomeActive")
        // Dispatch a custom event to JS so the inactivity timer knows the app
        // returned to foreground. This is more reliable than visibilitychange
        // on iOS because WKWebView may not always fire it during scene transitions.
        dispatchLifecycleEvent(name: "fe:app-foreground")
    }

    func sceneWillResignActive(_ scene: UIScene) {
        NSLog("[SceneDelegate] sceneWillResignActive")
        // Resigning active is NOT going to the background: it also happens
        // for Control Center, the notification shade, Face ID / passkey
        // sheets and system permission alerts, all while the app stays on
        // screen. Treating it as a minimize started the lock-on-minimize
        // grace period under the user, so a slow passkey or permission prompt
        // locked the app mid-use. Report it separately.
        dispatchLifecycleEvent(name: "fe:app-inactive")
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        NSLog("[SceneDelegate] sceneDidEnterBackground")
        dispatchLifecycleEvent(name: "fe:app-background")
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        NSLog("[SceneDelegate] sceneWillEnterForeground")
        // Belt-and-suspenders: also fire on foreground entry
        dispatchLifecycleEvent(name: "fe:app-foreground")
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        NSLog("[SceneDelegate] sceneDidDisconnect")
    }

    /// Dispatch a custom DOM event to the WKWebView so JavaScript can react
    /// to native app lifecycle changes (background/foreground).
    private func dispatchLifecycleEvent(name: String) {
        // Try self.window first, then fall back to finding any visible window.
        // self.window may be nil if the poll timer hasn't resolved yet.
        let webView: WKWebView? = {
            if let w = self.window, let vc = w.rootViewController {
                return findWKWebView(in: vc.view)
            }
            // Fallback: search all connected scenes for a window with a webview
            for scene in UIApplication.shared.connectedScenes {
                guard let windowScene = scene as? UIWindowScene else { continue }
                for window in windowScene.windows {
                    if let vc = window.rootViewController,
                       let wv = findWKWebView(in: vc.view) {
                        return wv
                    }
                }
            }
            return nil
        }()

        guard let webView = webView else {
            NSLog("[SceneDelegate] dispatchLifecycleEvent(%@): no WKWebView found", name)
            return
        }

        installRendererRecovery(on: webView)

        let js = "window.dispatchEvent(new CustomEvent('\(name)',{detail:{ts:Date.now()}}))"
        webView.evaluateJavaScript(js) { _, error in
            if let error = error {
                NSLog("[SceneDelegate] Failed to dispatch %@: %@", name, error.localizedDescription)
                // Coming back to a page whose content process died while
                // backgrounded: reload instead of leaving a frozen frame.
                let nsError = error as NSError
                if name == "fe:app-foreground",
                   nsError.domain == WKErrorDomain,
                   nsError.code == WKError.Code.webContentProcessTerminated.rawValue {
                    TaoSceneDelegate.recoverRenderer(webView, reason: "foreground dispatch failed")
                }
            }
        }
        if name == "fe:app-foreground" {
            checkRendererAlive(webView)
        }
    }
}
