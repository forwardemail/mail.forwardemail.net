package net.forwardemail.mail

import android.content.Intent
import android.os.Bundle
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
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView

    // If a share intent arrived before the WebView was ready, execute it now
    pendingShareJs?.let { js ->
      webView.evaluateJavascript(js, null)
      pendingShareJs = null
    }

    applySystemBarInsets(webView)
  }

  /**
   * Handle Android system bar insets (status bar, navigation bar, gestures).
   *
   * We use a two-layered approach for maximum reliability:
   *   1. Pad the WebView itself so content doesn't draw under the system bars
   *      (no need for CSS to compensate; works on all pages immediately).
   *   2. Also inject --safe-area-inset-* CSS variables for any components
   *      that want fine-grained control (e.g. sticky elements that should
   *      extend to the edge with their own background).
   */
  private fun applySystemBarInsets(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())

      // Pad the WebView directly with system bar insets so content never
      // draws under the status bar or navigation bar. IME (keyboard) bottom
      // takes precedence over the navigation bar when the keyboard is up.
      val bottomInset = maxOf(systemBars.bottom, imeInsets.bottom)
      view.setPadding(systemBars.left, systemBars.top, systemBars.right, bottomInset)

      // Also expose insets as CSS variables for components that need them
      val density = view.resources.displayMetrics.density
      val top = (systemBars.top / density).toInt()
      val bottom = (systemBars.bottom / density).toInt()
      val left = (systemBars.left / density).toInt()
      val right = (systemBars.right / density).toInt()

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

      insets
    }

    // Re-inject CSS variables after each page load so navigation doesn't lose them
    webView.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)
        lastInsetsJs?.let { view?.evaluateJavascript(it, null) }
      }
    }

    ViewCompat.requestApplyInsets(webView)
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
