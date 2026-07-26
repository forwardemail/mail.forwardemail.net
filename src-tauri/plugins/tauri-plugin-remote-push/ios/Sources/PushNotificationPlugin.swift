import UIKit
import UserNotifications
import Tauri
import SwiftRs

@objc(PushNotificationPlugin)
public class PushNotificationPlugin: Plugin {
    public static var instance: PushNotificationPlugin?

    overridepublic func load() {
        PushNotificationPlugin.instance = self
    }

    @objc public func getToken(_ invoke: Invoke) {
        // This will be handled by the AppDelegate delegate, which calls handleToken.
        // For now, we don't resolve it here, as the token comes asynchronously.
        // In a real app, you might want a callback system.
    }

    @objc public func requestPermissions(_ invoke: Invoke) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error = error {
                invoke.reject(error.localizedDescription)
                return
            }
            invoke.resolve(["granted": granted])
        }
    }

    public func handleToken(_ token: Data) {
        let tokenString = token.map { String(format: "%02.2hhx", $0) }.joined()
        self.trigger("token-received", data: ["token": tokenString])
    }

    public func handleNotification(_ userInfo: [AnyHashable : Any]) {
        self.trigger("notification-received", data: userInfo)
    }
} 