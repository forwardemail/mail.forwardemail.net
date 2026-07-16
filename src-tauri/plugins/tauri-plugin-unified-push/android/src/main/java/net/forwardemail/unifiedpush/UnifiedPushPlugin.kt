package net.forwardemail.unifiedpush

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.nio.charset.StandardCharsets

private const val EVENT_SUBSCRIPTION = "subscription-changed"
private const val EVENT_MESSAGE = "message-received"
private const val EVENT_REGISTRATION_FAILED = "registration-failed"
private const val EVENT_UNREGISTERED = "unregistered"
private const val EVENT_TEMPORARY_UNAVAILABLE = "temporary-unavailable"
private const val NOTIFICATION_CHANNEL = "new-mail"
private const val DEFAULT_INSTANCE = "forward-email"

@InvokeArg
class RegistrationArgs {
  var instance: String = DEFAULT_INSTANCE
  var messageForDistributor: String = "Forward Email"
  var vapidPublicKey: String = ""
}

@InvokeArg
class UnregisterArgs {
  var instance: String = DEFAULT_INSTANCE
}

@TauriPlugin
class UnifiedPushPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    @Volatile
    var instance: UnifiedPushPlugin? = null

    @Volatile
    var isForeground: Boolean = false
  }

  override fun load(webView: WebView) {
    super.load(webView)
    instance = this
    isForeground = true
  }

  override fun onResume() {
    isForeground = true
  }

  override fun onPause() {
    isForeground = false
  }

  override fun onDestroy() {
    isForeground = false
    if (instance === this) instance = null
  }

  @Command
  fun getState(invoke: Invoke) {
    val context = activity.applicationContext
    val result = JSObject()
    result.put("availableDistributors", JSONArray(UnifiedPush.getDistributors(context)))
    result.put("distributor", UnifiedPush.getAckDistributor(context) ?: UnifiedPush.getSavedDistributor(context))
    result.put("selectionRequired", distributorSelectionRequired(context))
    result.put("subscription", UnifiedPushStore.getSubscription(context))
    invoke.resolve(result)
  }

  @Command
  fun register(invoke: Invoke) {
    val args = invoke.parseArgs(RegistrationArgs::class.java)
    val context = activity.applicationContext

    if (!validRegistrationArgs(args, invoke)) return

    val saved = UnifiedPush.getSavedDistributor(context)
    if (saved != null) {
      requestRegistration(context, args, invoke)
      return
    }

    val distributors = UnifiedPush.getDistributors(context)
    if (distributors.isEmpty()) {
      invoke.reject("no_unifiedpush_distributor_available")
      return
    }

    UnifiedPush.tryUseDefaultDistributor(activity) { success ->
      if (!success) {
        invoke.reject(
          if (distributors.size > 1) {
            "distributor_selection_required"
          } else {
            "no_unifiedpush_distributor_available"
          }
        )
        return@tryUseDefaultDistributor
      }
      requestRegistration(context, args, invoke)
    }
  }

  @Command
  fun pickDistributor(invoke: Invoke) {
    val args = invoke.parseArgs(RegistrationArgs::class.java)
    if (!validRegistrationArgs(args, invoke)) return

    // This command is intentionally separate from register(): the connector
    // requires the picker to be opened only after an explicit user action.
    UnifiedPush.tryPickDistributor(activity) { success ->
      if (!success) {
        invoke.reject("unifiedpush_distributor_selection_cancelled")
        return@tryPickDistributor
      }
      requestRegistration(activity.applicationContext, args, invoke)
    }
  }

  @Command
  fun drainMessages(invoke: Invoke) {
    val result = JSObject()
    result.put("messages", UnifiedPushStore.drainMessages(activity.applicationContext))
    invoke.resolve(result)
  }

  @Command
  fun unregister(invoke: Invoke) {
    val args = invoke.parseArgs(UnregisterArgs::class.java)
    val instanceId = sanitizeInstance(args.instance)
    UnifiedPush.unregister(activity.applicationContext, instanceId)
    UnifiedPushStore.clearSubscription(activity.applicationContext, instanceId)
    invoke.resolve()
  }

  private fun validRegistrationArgs(args: RegistrationArgs, invoke: Invoke): Boolean {
    if (args.vapidPublicKey.isBlank()) {
      invoke.reject("unifiedpush_vapid_public_key_required")
      return false
    }
    if (!isValidVapidPublicKey(args.vapidPublicKey)) {
      invoke.reject("invalid_unifiedpush_vapid_public_key")
      return false
    }
    return true
  }

  private fun requestRegistration(context: Context, args: RegistrationArgs, invoke: Invoke) {
    try {
      UnifiedPush.register(
        context,
        sanitizeInstance(args.instance),
        truncateUtf8(args.messageForDistributor, 100),
        normalizeVapidPublicKey(args.vapidPublicKey)
      )
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("unifiedpush_registration_failed", error)
    }
  }

  private fun distributorSelectionRequired(context: Context): Boolean {
    if (UnifiedPush.getSavedDistributor(context) != null) return false
    return UnifiedPush.getDistributors(context).size > 1
  }

  fun emitSubscription(instanceId: String, subscription: JSONObject) {
    emitOnMain(EVENT_SUBSCRIPTION, JSObject().apply {
      put("instance", instanceId)
      put("subscription", subscription)
    })
  }

  fun emitMessage(instanceId: String, payload: JSONObject): Boolean {
    if (!isForeground || !hasListener(EVENT_MESSAGE)) return false
    emitOnMain(EVENT_MESSAGE, JSObject().apply {
      put("instance", instanceId)
      put("payload", payload)
      put("displayedBySystem", false)
    })
    return true
  }

  fun emitRegistrationFailed(instanceId: String, reason: String) {
    emitOnMain(EVENT_REGISTRATION_FAILED, JSObject().apply {
      put("instance", instanceId)
      put("reason", reason)
    })
  }

  fun emitUnregistered(instanceId: String) {
    emitOnMain(EVENT_UNREGISTERED, JSObject().apply { put("instance", instanceId) })
  }

  fun emitTemporaryUnavailable(instanceId: String) {
    emitOnMain(EVENT_TEMPORARY_UNAVAILABLE, JSObject().apply { put("instance", instanceId) })
  }

  private fun emitOnMain(event: String, payload: JSObject) {
    activity.runOnUiThread { trigger(event, payload) }
  }
}

class ForwardEmailPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    val subscription = UnifiedPushStore.saveSubscription(this, instance, endpoint)
    UnifiedPushPlugin.instance?.emitSubscription(instance, subscription)
  }

  override fun onMessage(message: PushMessage, instance: String) {
    if (!message.decrypted) {
      UnifiedPushPlugin.instance?.emitRegistrationFailed(instance, "message_decryption_failed")
      return
    }

    val payloadText = String(message.content, StandardCharsets.UTF_8)
    val payload = try {
      JSONObject(payloadText)
    } catch (_: Exception) {
      JSONObject().put("body", payloadText.take(4096))
    }

    val deliveredToForeground = UnifiedPushPlugin.instance?.emitMessage(instance, payload) == true
    if (!deliveredToForeground) {
      val displayed = !UnifiedPushPlugin.isForeground && showNotification(payload)
      UnifiedPushStore.enqueueMessage(this, instance, payload, displayed)
    }
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    UnifiedPushPlugin.instance?.emitRegistrationFailed(instance, reason.name.lowercase())
  }

  override fun onUnregistered(instance: String) {
    UnifiedPushStore.clearSubscription(this, instance)
    UnifiedPushPlugin.instance?.emitUnregistered(instance)
  }

  override fun onTempUnavailable(instance: String) {
    UnifiedPushPlugin.instance?.emitTemporaryUnavailable(instance)
  }

  private fun showNotification(payload: JSONObject): Boolean {
    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return false

    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(NOTIFICATION_CHANNEL, "New Mail", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Notifications for new email messages"
        }
      )
    }

    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        payload.toString().hashCode(),
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }

    val title = payload.optString("title").take(128).ifBlank { "Forward Email" }
    val body = payload.optString("body").take(512).ifBlank { "You have new mail" }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, NOTIFICATION_CHANNEL)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    builder
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setCategory(Notification.CATEGORY_EMAIL)
      .setAutoCancel(true)
      .setContentIntent(pendingIntent)

    manager.notify(payload.toString().hashCode(), builder.build())
    return true
  }
}

private object UnifiedPushStore {
  private const val PREFS = "forward_email_unified_push"
  private const val KEY_SUBSCRIPTION = "subscription"
  private const val KEY_MESSAGES = "queued_messages"
  private const val MAX_MESSAGES = 50

  fun saveSubscription(context: Context, instance: String, endpoint: PushEndpoint): JSONObject {
    val subscription = JSONObject().apply {
      put("instance", sanitizeInstance(instance))
      put("endpoint", endpoint.url)
      put("temporary", endpoint.temporary)
      endpoint.pubKeySet?.let {
        put("p256dh", it.pubKey)
        put("auth", it.auth)
      }
    }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_SUBSCRIPTION, subscription.toString())
      .apply()
    return subscription
  }

  fun getSubscription(context: Context): JSONObject? {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(KEY_SUBSCRIPTION, null) ?: return null
    return try { JSONObject(raw) } catch (_: Exception) { null }
  }

  fun clearSubscription(context: Context, instance: String) {
    val current = getSubscription(context)
    if (current == null || current.optString("instance") == sanitizeInstance(instance)) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit()
        .remove(KEY_SUBSCRIPTION)
        .apply()
    }
  }

  @Synchronized
  fun enqueueMessage(context: Context, instance: String, payload: JSONObject, displayed: Boolean) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val queue = try { JSONArray(prefs.getString(KEY_MESSAGES, "[]")) } catch (_: Exception) { JSONArray() }
    while (queue.length() >= MAX_MESSAGES) queue.remove(0)
    queue.put(JSONObject().apply {
      put("instance", sanitizeInstance(instance))
      put("payload", payload)
      put("displayedBySystem", displayed)
    })
    prefs.edit().putString(KEY_MESSAGES, queue.toString()).apply()
  }

  @Synchronized
  fun drainMessages(context: Context): JSONArray {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val queue = try { JSONArray(prefs.getString(KEY_MESSAGES, "[]")) } catch (_: Exception) { JSONArray() }
    prefs.edit().remove(KEY_MESSAGES).apply()
    return queue
  }
}

private fun sanitizeInstance(value: String): String {
  val sanitized = value.trim().replace(Regex("[^A-Za-z0-9._-]"), "_").take(96)
  return sanitized.ifBlank { DEFAULT_INSTANCE }
}

private fun normalizeVapidPublicKey(value: String): String = value.trim().trimEnd('=')

private fun isValidVapidPublicKey(value: String): Boolean {
  val normalized = normalizeVapidPublicKey(value)
  if (!Regex("[A-Za-z0-9_-]{87}").matches(normalized)) return false

  return try {
    val decoded = Base64.decode(
      normalized,
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    )
    decoded.size == 65 && decoded[0] == 0x04.toByte()
  } catch (_: IllegalArgumentException) {
    false
  }
}

private fun truncateUtf8(value: String, maxBytes: Int): String {
  val normalized = value.trim().ifBlank { "Forward Email" }
  val result = StringBuilder()
  var byteCount = 0
  var index = 0

  while (index < normalized.length) {
    val codePoint = normalized.codePointAt(index)
    val text = String(Character.toChars(codePoint))
    val nextBytes = text.toByteArray(StandardCharsets.UTF_8).size
    if (byteCount + nextBytes > maxBytes) break
    result.append(text)
    byteCount += nextBytes
    index += Character.charCount(codePoint)
  }

  return result.toString().ifBlank { "Forward Email" }
}
