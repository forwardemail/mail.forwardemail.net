package net.forwardemail.mail

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import androidx.annotation.RequiresApi
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var pendingShareJs: String? = null
  private var crashClientInstallAttempts = 0

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

    // Wry installs its WebViewClient after this callback returns, so wait for
    // the current main thread task to finish before wrapping it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Handler(Looper.getMainLooper()).post { installRenderCrashRecovery(webView) }
    }
  }

  // A crashed or OOM-killed WebView renderer takes the whole app down because
  // the default WebViewClient does not handle onRenderProcessGone. Wrap wry's
  // client with one that restarts the app cleanly instead.
  @RequiresApi(Build.VERSION_CODES.O)
  private fun installRenderCrashRecovery(webView: WebView) {
    val current = webView.webViewClient
    if (current is RenderCrashRecoveryClient) return
    if (current.javaClass == WebViewClient::class.java) {
      // Wry has not installed its client yet. Retry briefly, then give up
      // rather than wrap the wrong client and lose asset interception.
      if (crashClientInstallAttempts < 20) {
        crashClientInstallAttempts += 1
        Handler(Looper.getMainLooper()).postDelayed({ installRenderCrashRecovery(webView) }, 50)
      } else {
        Logger.warn("Render crash recovery not installed, wry WebViewClient never appeared")
      }
      return
    }
    webView.webViewClient = RenderCrashRecoveryClient(current)
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

// Forwards every WebViewClient callback to wry's client and adds recovery for
// a dead renderer process. When the renderer crashes or is killed under memory
// pressure, the destroyed WebView cannot be reused and the Rust side still
// references it, so a clean process restart is the only way back to a working
// state. Without this, crashpad aborts the entire app.
@RequiresApi(Build.VERSION_CODES.O)
private class RenderCrashRecoveryClient(private val delegate: WebViewClient) : WebViewClient() {
  override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
    Logger.error("WebView render process gone (didCrash=${detail?.didCrash()}), restarting the app")
    if (view != null) {
      (view.parent as? ViewGroup)?.removeView(view)
      val context = view.context
      view.destroy()
      restartApp(context)
    }
    Runtime.getRuntime().exit(0)
    return true
  }

  private fun restartApp(context: Context) {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val component = launch?.component ?: return
    // On Android 10+ a background activity start is silently dropped, so a
    // renderer killed while the app is backgrounded just exits without
    // popping the app back into the foreground.
    context.startActivity(Intent.makeRestartActivityTask(component))
  }

  override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
    delegate.shouldOverrideUrlLoading(view, request)

  @Deprecated("Deprecated in Java")
  @Suppress("DEPRECATION")
  override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean =
    delegate.shouldOverrideUrlLoading(view, url)

  override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) =
    delegate.onPageStarted(view, url, favicon)

  override fun onPageFinished(view: WebView?, url: String?) =
    delegate.onPageFinished(view, url)

  override fun onLoadResource(view: WebView?, url: String?) =
    delegate.onLoadResource(view, url)

  override fun onPageCommitVisible(view: WebView?, url: String?) =
    delegate.onPageCommitVisible(view, url)

  override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
    delegate.shouldInterceptRequest(view, request)

  override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) =
    delegate.onReceivedError(view, request, error)

  @Deprecated("Deprecated in Java")
  @Suppress("DEPRECATION")
  override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) =
    delegate.onReceivedError(view, errorCode, description, failingUrl)

  override fun onReceivedHttpError(view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?) =
    delegate.onReceivedHttpError(view, request, errorResponse)

  override fun onFormResubmission(view: WebView?, dontResend: Message?, resend: Message?) =
    delegate.onFormResubmission(view, dontResend, resend)

  override fun doUpdateVisitedHistory(view: WebView?, url: String?, isReload: Boolean) =
    delegate.doUpdateVisitedHistory(view, url, isReload)

  override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) =
    delegate.onReceivedSslError(view, handler, error)

  override fun onReceivedClientCertRequest(view: WebView?, request: ClientCertRequest?) =
    delegate.onReceivedClientCertRequest(view, request)

  override fun onReceivedHttpAuthRequest(view: WebView?, handler: HttpAuthHandler?, host: String?, realm: String?) =
    delegate.onReceivedHttpAuthRequest(view, handler, host, realm)

  override fun shouldOverrideKeyEvent(view: WebView?, event: KeyEvent?): Boolean =
    delegate.shouldOverrideKeyEvent(view, event)

  override fun onUnhandledKeyEvent(view: WebView?, event: KeyEvent?) =
    delegate.onUnhandledKeyEvent(view, event)

  override fun onScaleChanged(view: WebView?, oldScale: Float, newScale: Float) =
    delegate.onScaleChanged(view, oldScale, newScale)

  override fun onReceivedLoginRequest(view: WebView?, realm: String?, account: String?, args: String?) =
    delegate.onReceivedLoginRequest(view, realm, account, args)

  @RequiresApi(Build.VERSION_CODES.O_MR1)
  override fun onSafeBrowsingHit(view: WebView?, request: WebResourceRequest?, threatType: Int, callback: SafeBrowsingResponse?) =
    delegate.onSafeBrowsingHit(view, request, threatType, callback)
}
