package app.tauri.mobilepush

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
class MobilePushPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        var instance: MobilePushPlugin? = null
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
        val granted = getPermissionState("notifications").toString().lowercase() == "granted"
        val result = JSObject()
        result.put("granted", granted)
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
        val messageData = JSObject()
        for ((key, value) in message.data) {
            messageData.put(key, value)
        }
        data.put("data", messageData)
        trigger("notification-received", data)
    }

    fun handleNotificationTap(extras: Map<String, String>) {
        val data = JSObject()
        for ((key, value) in extras) {
            data.put(key, value)
        }
        trigger("notification-tapped", data)
    }
}
