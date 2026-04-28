package net.forwardemail.mail

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var pendingShareJs: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    handleShareIntent(intent)

    // Pad the activity's root content view with system bar insets so the WebView
    // is sized inside the safe area. The native padding is the source of truth for
    // inset safety; CSS env(safe-area-inset-*) returns 0 inside the padded WebView,
    // which is correct (the padding already shifted content out of the bars).
    val rootView = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
      val bottomInset = maxOf(systemBars.bottom, imeInsets.bottom)
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottomInset)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(rootView)
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView

    // If a share intent arrived before the WebView was ready, execute it now
    pendingShareJs?.let { js ->
      webView.evaluateJavascript(js, null)
      pendingShareJs = null
    }

    // Trigger an initial insets pass now that the WebView exists
    ViewCompat.requestApplyInsets(findViewById(android.R.id.content))
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleShareIntent(intent)
  }

  private fun handleShareIntent(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""
    val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: ""
    if (subject.isEmpty() && text.isEmpty()) return

    val safeSubject = escapeForJs(subject)
    val safeText = escapeForJs(text)

    val js = """
      (function() {
        var payload = { subject: "$safeSubject", text: "$safeText" };
        window.dispatchEvent(new CustomEvent('app:share-received', { detail: payload }));
      })();
    """.trimIndent()

    val wv = webView
    if (wv != null) {
      wv.evaluateJavascript(js, null)
    } else {
      pendingShareJs = js
    }
  }

  private fun escapeForJs(value: String): String {
    return value
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
      .replace("\t", "\\t")
  }
}
