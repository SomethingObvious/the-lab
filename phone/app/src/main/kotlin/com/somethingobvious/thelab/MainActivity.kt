package com.somethingobvious.thelab

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.WindowInsetsAnimation
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.BackEvent
import android.window.OnBackAnimationCallback
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.core.content.FileProvider
import androidx.core.util.Consumer
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.FileInputStream
import java.io.IOException
import kotlin.math.roundToInt

class MainActivity : Activity() {
    private lateinit var frame: FrameLayout
    private var web: WebView? = null
    private var port: JavaScriptReplyProxy? = null
    private var unlisten: (() -> Unit)? = null
    private var rescueReason: String? = null
    private var ready = false
    private var picking: String? = null
    private var insets = JSONObject().put("kind", "insets")
    private var fold = JSONObject().put("kind", "fold").put("posture", JSONObject.NULL).put("hinge", JSONObject.NULL)
    private var imeMoving = false
    private var imeFrom = 0.0
    private var imeTo = 0.0
    private val layout by lazy { WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(this)) }
    private val onLayout = Consumer<WindowLayoutInfo> { onFold(it) }
    private val watchdog = Runnable {
        if (!ready && rescueReason == null) rescue("The design didn't finish loading, so this is the safe screen.")
    }
    private val onDesign = { if (rescueReason == null) load() }
    private var backRegistered = false
    // Only registered while the page has something to close, so otherwise the
    // system plays its own back-to-home preview. On 14 and up the page also
    // gets the gesture's progress, so a sheet can follow his thumb.
    private val back: OnBackInvokedCallback = if (Build.VERSION.SDK_INT >= 34) object : OnBackAnimationCallback {
        override fun onBackStarted(e: BackEvent) = progress(e)
        override fun onBackProgressed(e: BackEvent) = progress(e)
        override fun onBackCancelled() = send(JSONObject().put("kind", "backcancel"))
        override fun onBackInvoked() = send(JSONObject().put("kind", "back"))
    } else OnBackInvokedCallback { send(JSONObject().put("kind", "back")) }

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Hub.init(this)
        window.setDecorFitsSystemWindows(false)
        frame = FrameLayout(this)
        setContentView(frame)
        paintStart()
        // The keyboard is an inset the page pads by rather than a resize. On
        // the way up each frame aims one frame ahead of the keyboard, and on
        // the way down it trails it, so a page that draws a frame late still
        // never has the message bar behind the keyboard.
        frame.setOnApplyWindowInsetsListener { _, wi ->
            if (imeMoving) imeTo = bottomOf(wi) else sendInsets(wi)
            wi
        }
        frame.setWindowInsetsAnimationCallback(object : WindowInsetsAnimation.Callback(DISPATCH_MODE_STOP) {
            override fun onPrepare(a: WindowInsetsAnimation) {
                if (a.typeMask and WindowInsets.Type.ime() == 0) return
                imeMoving = true
                imeFrom = insets.optDouble("bottom", 0.0)
                imeTo = imeFrom
            }
            override fun onProgress(wi: WindowInsets, running: MutableList<WindowInsetsAnimation>): WindowInsets {
                val a = running.firstOrNull { it.typeMask and WindowInsets.Type.ime() != 0 } ?: return wi
                if (imeTo > imeFrom && a.durationMillis > 0) {
                    val ahead = ((a.fraction * a.durationMillis + 16f) / a.durationMillis).coerceAtMost(1f)
                    val k = a.interpolator?.getInterpolation(ahead) ?: ahead
                    sendInsets(wi, imeFrom + (imeTo - imeFrom) * k)
                } else {
                    sendInsets(wi)
                }
                return wi
            }
            override fun onEnd(a: WindowInsetsAnimation) {
                if (a.typeMask and WindowInsets.Type.ime() == 0) return
                imeMoving = false
                frame.rootWindowInsets?.let { sendInsets(it) }
            }
        })

        if (intent?.getBooleanExtra("rescue", false) == true || intent?.action == SAFE) rescueReason = "Safe mode, opened from the app shortcut."
        Hub.designListeners.add(onDesign)
        if (Hub.paired) LinkService.start(this)
        build()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == SAFE) rescue("Safe mode, opened from the app shortcut.")
    }

    override fun onStart() {
        super.onStart()
        layout.addWindowLayoutInfoListener(this, mainExecutor, onLayout)
    }

    override fun onStop() {
        layout.removeWindowLayoutInfoListener(onLayout)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        Hub.foreground = true
        Notifier.clearReplies(this)
        if (Hub.paired) Hub.reconnectNow()
    }

    override fun onPause() {
        Hub.foreground = false
        super.onPause()
    }

    override fun onDestroy() {
        Hub.designListeners.remove(onDesign)
        unlisten?.invoke()
        web?.destroy()
        super.onDestroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun build() {
        web?.let { frame.removeView(it); it.destroy() }
        unlisten?.invoke()
        unlisten = null
        port = null
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/app/", WebViewAssetLoader.InternalStoragePathHandler(this, Hub.designDir.apply { mkdirs() }))
            .addPathHandler("/shell/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/files/") { path ->
                // lab.fileUrl(url, { w }) asks for /files/w360/name.
                val sized = Regex("^w(\\d{2,4})/(.+)$").find(path)
                val f = (if (sized != null) Hub.thumb(sized.groupValues[2], sized.groupValues[1].toInt().coerceIn(48, 2048)) else Hub.fetchFile(path))
                    ?: return@addPathHandler null
                WebResourceResponse(mime(f.name), null, FileInputStream(f))
            }
            .build()
        val w = WebView(this)
        w.setBackgroundColor(Color.TRANSPARENT)
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            // Android 14 scales large text less than small text, so take the
            // zoom from what 16 sp actually comes to.
            val dm = resources.displayMetrics
            textZoom = (TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 16f, dm) / (16f * dm.density) * 100).roundToInt()
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                openExternal(request.url)
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // The page's renderer died (out of memory, or a crash), so start over with a fresh one.
                build()
                return true
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(w, assets.open("bridge.js").bufferedReader().readText(), setOf(ORIGIN))
        }
        WebViewCompat.addWebMessageListener(w, "labNative", setOf(ORIGIN)) { _, message, _, isMainFrame, reply ->
            if (isMainFrame) handle(message.data ?: return@addWebMessageListener, reply)
        }
        frame.addView(w, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        web = w
        frame.requestApplyInsets()
        load()
    }

    private fun load() {
        val w = web ?: return
        ready = false
        wantsBack(false)
        frame.removeCallbacks(watchdog)
        val hasDesign = Hub.designDir.resolve("index.html").exists()
        if (rescueReason != null || !hasDesign || !Hub.paired) {
            w.loadUrl("$ORIGIN/shell/rescue.html")
        } else {
            w.loadUrl("$ORIGIN/app/index.html")
            frame.postDelayed(watchdog, 8000)
        }
    }

    private fun rescue(reason: String) {
        rescueReason = reason
        load()
    }

    private fun send(e: JSONObject) {
        port?.postMessage(e.toString())
    }

    private fun handle(raw: String, reply: JavaScriptReplyProxy) {
        val m = runCatching { JSONObject(raw) }.getOrElse { return }
        when (m.optString("op")) {
            "subscribe" -> {
                port = reply
                unlisten?.invoke()
                unlisten = null
                // The header and chips draw from this straight away, and the
                // history follows once it's off the disk.
                val batch = JSONArray().put(Hub.link).put(Hub.status).put(Hub.outboxEvent()).put(insets).put(fold)
                Hub.mac?.let { batch.put(it) }
                Hub.shortcuts?.let { batch.put(it) }
                val hasDesign = Hub.designDir.resolve("index.html").exists()
                val reason = rescueReason ?: if (!hasDesign && Hub.paired) "Your design hasn't arrived from the Mac yet. It loads as soon as the Mac is reachable." else null
                if (reason != null) batch.put(JSONObject().put("kind", "rescue").put("reason", reason).put("hasDesign", hasDesign && rescueReason != null))
                reply.postMessage(JSONObject().put("batch", batch).toString())
                Hub.onLoaded {
                    if (port !== reply) return@onLoaded
                    val history = JSONArray()
                    for (e in Hub.events) history.put(e)
                    history.put(JSONObject().put("kind", "loaded"))
                    reply.postMessage(JSONObject().put("batch", history).toString())
                    unlisten = Hub.listen { send(it) }
                }
            }
            "send" -> {
                val text = m.optString("text").trim()
                val cid = m.optString("cid")
                val files = m.optJSONArray("files")?.takeIf { it.length() in 1..20 }
                if ((text.isNotEmpty() || files != null) && text.length <= 50_000 && cid.length == 36) Hub.send(text, cid, files)
                // Asked here, when replies and approvals start to matter, rather than on first launch.
                val prefs = getSharedPreferences("lab", MODE_PRIVATE)
                if (!prefs.getBoolean("askedNotify", false) && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    prefs.edit().putBoolean("askedNotify", true).apply()
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
                }
            }
            "saveShortcuts" -> {
                val id = m.optString("id")
                Hub.saveShortcuts(m.optJSONArray("items") ?: JSONArray()) { ok -> answer(id, ok) }
            }
            "attach" -> pick(m.optString("id"), m.optString("kind"))
            "stop" -> Hub.stop { ok -> if (!ok) send(JSONObject().put("kind", "stopFailed")) }
            "answer" -> {
                val ref = m.optString("ref")
                Hub.answer(ref, m.optBoolean("allow")) { ok -> if (!ok) send(JSONObject().put("kind", "answerFailed").put("ref", ref)) }
            }
            "undo" -> Hub.undoDesign { ok ->
                send(JSONObject().put("kind", "undone").put("ok", ok))
                if (ok) { rescueReason = null }
            }
            "leaveRescue" -> { rescueReason = null; load() }
            "rescue" -> rescue(m.optString("reason", "Opened the safe screen."))
            "ready" -> {
                ready = true
                frame.removeCallbacks(watchdog)
                applyTheme(m)
                reportFullyDrawn()
            }
            "theme" -> applyTheme(m)
            "back" -> wantsBack(m.optBoolean("on"))
            "open" -> open(m.optString("url"))
            "fix" -> if (m.optString("fix") == "tailscale") openApp("com.tailscale.ipn")
            "retry" -> Hub.reconnectNow()
        }
    }

    // The page paints behind the system bars and the keyboard and gets their
    // sizes as CSS pixels, so it can keep the message bar above both.
    private fun bottomOf(wi: WindowInsets): Double {
        val bars = wi.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        return maxOf(bars.bottom, wi.getInsets(WindowInsets.Type.ime()).bottom) / resources.displayMetrics.density.toDouble()
    }

    private fun sendInsets(wi: WindowInsets, bottom: Double = bottomOf(wi)) {
        val bars = wi.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        val d = resources.displayMetrics.density
        insets = JSONObject().put("kind", "insets")
            .put("top", bars.top / d).put("left", bars.left / d).put("right", bars.right / d)
            .put("bottom", bottom)
            .put("keyboard", bottom > bars.bottom / d + 1)
        send(insets)
    }

    private fun onFold(info: WindowLayoutInfo) {
        val f = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
        val d = resources.displayMetrics.density
        fold = JSONObject().put("kind", "fold")
        if (f != null && f.isSeparating && f.state == FoldingFeature.State.HALF_OPENED) {
            val b = f.bounds
            fold.put("posture", if (f.orientation == FoldingFeature.Orientation.VERTICAL) "book" else "tabletop")
                .put("hinge", JSONObject().put("left", b.left / d).put("top", b.top / d).put("right", b.right / d).put("bottom", b.bottom / d))
        } else {
            fold.put("posture", JSONObject.NULL).put("hinge", JSONObject.NULL)
        }
        send(fold)
    }

    // The bridge samples what's drawn under each system bar, so the clock can
    // be light on a violet header while the gesture bar is dark on a pale page.
    private fun applyTheme(m: JSONObject) {
        // The window background is left as it started. The page covers all of
        // it once drawn, and swapping it here would drop the header band in
        // the moment before the first paint.
        if (runCatching { Color.parseColor(m.optString("bg")) }.isFailure) return
        bars(m)
        getSharedPreferences("lab", MODE_PRIVATE).edit().putString(if (night) "look-dark" else "look-light", m.toString()).apply()
    }

    private fun bars(m: JSONObject) {
        val dark = m.optBoolean("dark")
        val flags = (if (m.optBoolean("topDark", dark)) 0 else WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS) or
            (if (m.optBoolean("bottomDark", dark)) 0 else WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        val both = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
        window.insetsController?.setSystemBarsAppearance(flags, both)
    }

    // Until the page draws, the window shows last time's background and
    // header band, so a restyled design doesn't open on the stock colours.
    // A first run has only the theme's windowBackground.
    private fun paintStart() {
        val raw = getSharedPreferences("lab", MODE_PRIVATE).getString(if (night) "look-dark" else "look-light", null) ?: return
        val m = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val bg = runCatching { Color.parseColor(m.optString("bg")) }.getOrNull() ?: return
        val head = runCatching { Color.parseColor(m.optString("head")) }.getOrNull()
        val d = resources.displayMetrics.density
        val height = (m.optDouble("headHeight", 0.0) * d).roundToInt()
        val layers = if (head != null && head != bg && height > 0) {
            val r = m.optDouble("headRadius", 0.0).toFloat() * d
            val band = GradientDrawable().apply { setColor(head); cornerRadii = floatArrayOf(0f, 0f, 0f, 0f, r, r, r, r) }
            LayerDrawable(arrayOf(ColorDrawable(bg), band)).apply {
                setLayerGravity(1, Gravity.TOP or Gravity.FILL_HORIZONTAL)
                setLayerHeight(1, height)
            }
        } else ColorDrawable(bg)
        window.setBackgroundDrawable(layers)
        bars(m)
    }

    private fun wantsBack(on: Boolean) {
        if (on == backRegistered) return
        backRegistered = on
        if (on) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, back)
        else onBackInvokedDispatcher.unregisterOnBackInvokedCallback(back)
    }

    private fun progress(e: BackEvent) {
        send(JSONObject().put("kind", "backprogress").put("progress", e.progress.toDouble())
            .put("edge", if (e.swipeEdge == BackEvent.EDGE_RIGHT) "right" else "left"))
    }

    // Answers a promise the page is waiting on.
    private fun answer(id: String, value: Any?, error: String? = null) {
        val r = JSONObject().put("reply", id)
        if (error != null) r.put("error", error) else r.put("value", value)
        send(r)
    }

    private fun pick(id: String, kind: String) {
        picking?.let { answer(it, JSONArray()) }
        picking = id
        val photos = kind == "photos"
        val intent = if (photos) {
            Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*").putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 10)
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(if (photos) "image/*" else "*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try { startActivityForResult(intent, PICK) } catch (_: ActivityNotFoundException) {
            picking = null
            answer(id, null, "There's nothing on this phone that can pick files.")
        }
    }

    @Deprecated("Activity has no other way to get a picker result without AndroidX Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != PICK) return super.onActivityResult(requestCode, resultCode, data)
        val id = picking ?: return
        picking = null
        val uris = ArrayList<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) else data.data?.let { uris.add(it) }
        }
        if (uris.isEmpty()) return answer(id, JSONArray())
        Hub.later {
            val out = JSONArray()
            val error = try { for (u in uris.take(20)) out.put(Hub.upload(u)); null } catch (e: IOException) { e.message ?: "Couldn't attach that." }
            Hub.onMain { if (error != null) answer(id, null, error) else answer(id, out) }
        }
    }

    private fun open(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme == "http" || uri.scheme == "https") {
            if (uri.host != HOST) return openExternal(uri)
        }
        val name = uri.lastPathSegment ?: return
        Hub.soon {
            val f = Hub.fetchFile(name)
            Hub.onMain {
                if (f == null) return@onMain send(JSONObject().put("kind", "openFailed").put("url", url))
                val content = FileProvider.getUriForFile(this, "$packageName.files", f)
                val view = Intent(Intent.ACTION_VIEW).setDataAndType(content, mime(f.name)).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                try { startActivity(view) } catch (_: ActivityNotFoundException) {
                    send(JSONObject().put("kind", "openFailed").put("url", url))
                }
            }
        }
    }

    private fun openExternal(uri: Uri) {
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: ActivityNotFoundException) {}
    }

    private fun openApp(pkg: String) {
        packageManager.getLaunchIntentForPackage(pkg)?.let { startActivity(it) }
            ?: openExternal(Uri.parse("market://details?id=$pkg"))
    }

    private fun mime(name: String): String {
        // The upload names start with an 8-character id, which MimeTypeMap ignores.
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: when (ext) {
            "js", "mjs" -> "text/javascript"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        const val SAFE = "com.somethingobvious.thelab.SAFE"
        const val PICK = 7
    }
}
