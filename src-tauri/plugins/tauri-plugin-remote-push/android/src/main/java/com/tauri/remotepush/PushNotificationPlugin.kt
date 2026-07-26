package app.tauri.remotepush

import android.Manifest
import android.app.Activity
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

val mainScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")
    ]
)
class PushNotificationPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        var instance: PushNotificationPlugin? = null
    }

    override fun load(webView: WebView) {
        super.load(webView)
        instance = this
    }

    @Command
    fun getToken(invoke: Invoke) {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) {
                invoke.reject("Failed to get FCM token", task.exception)
                return@addOnCompleteListener
            }
            val token = task.result
            val result = JSObject()
            result.put("token", token)
            invoke.resolve(result)
        }
    }

    @Command
    override fun requestPermissions(invoke: Invoke) {
        mainScope.launch {
            requestPermissionForAlias("notifications", invoke, "requestPermissionsCallback")
        }
    }

    @app.tauri.annotation.PermissionCallback
    fun requestPermissionsCallback(invoke: Invoke) {
        val state = getPermissionState("notifications")
        val permissions = JSObject()
        permissions.put("permissionState", state.toString().lowercase())
        trigger("permissionStateChange", permissions)
        // Resolve with the grant result. The frontend push gate reads `granted`;
        // resolving empty made every FCM registration look denied even when
        // POST_NOTIFICATIONS was actually granted.
        val result = JSObject()
        result.put("granted", state.toString().lowercase() == "granted")
        invoke.resolve(result)
    }

    fun handleNewToken(token: String) {
        val data = JSObject()
        data.put("token", token)
        trigger("token-received", data)
    }

    fun handleMessage(message: RemoteMessage) {
        val data = JSObject()
        message.notification?.let {
            val notification = JSObject()
            notification.put("title", it.title)
            notification.put("body", it.body)
            data.put("notification", notification)
        }
        data.put("data", message.data)
        trigger("notification-received", data)
    }
} 