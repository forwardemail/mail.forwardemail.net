package net.forwardemail.mail

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var pendingShareJs: String? = null
  private var lastInsetsJs: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    handleShareIntent(intent)

    // Pad the activity's root content view with system bar insets.
    // This ensures web content never draws under the status bar or
    // navigation bar regardless of where Tauri mounts its WebView.
    val rootView = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
      val bottomInset = maxOf(systemBars.bottom, imeInsets.bottom)
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottomInset)
      // Also inject CSS vars for any components that want fine-grained control
      webView?.let { injectInsetsCss(it, systemBars.top, systemBars.bottom, systemBars.left, systemBars.right) }
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

    // Re-inject CSS variables after each page load so navigation doesn't lose them
    webView.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        lastInsetsJs?.let { view?.evaluateJavascript(it, null) }
      }
    }

    // Trigger an initial insets pass now that the WebView exists
    ViewCompat.requestApplyInsets(findViewById(android.R.id.content))
  }

  private fun injectInsetsCss(webView: WebView, topPx: Int, bottomPx: Int, leftPx: Int, rightPx: Int) {
    val density = webView.resources.displayMetrics.density
    val top = (topPx / density).toInt()
    val bottom = (bottomPx / density).toInt()
    val left = (leftPx / density).toInt()
    val right = (rightPx / density).toInt()

    val js = """
      (function() {
        var style = document.documentElement.style;
        style.setProperty('--safe-area-inset-top', '${top}px');
        style.setProperty('--safe-area-inset-bottom', '${bottom}px');
        style.setProperty('--safe-area-inset-left', '${left}px');
        style.setProperty('--safe-area-inset-right', '${right}px');
      })();
    """.trimIndent()
    lastInsetsJs = js
    webView.evaluateJavascript(js, null)
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
