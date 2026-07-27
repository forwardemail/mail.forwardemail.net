package app.tauri.mobilepush

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FCMService : FirebaseMessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        MobilePushPlugin.instance?.handleMessage(remoteMessage)
    }

    override fun onNewToken(token: String) {
        MobilePushPlugin.instance?.handleNewToken(token)
    }
}
