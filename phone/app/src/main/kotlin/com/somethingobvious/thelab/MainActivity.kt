package com.somethingobvious.thelab

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.provider.Settings
import android.widget.Toast
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
    // Text or files shared in, held until the page has subscribed.
    private var compose: JSONObject? = null
    private var insets = JSONObject().put("kind", "insets")
    private var fold = JSONObject().put("kind", "fold").put("posture", JSONObject.NULL).put("hinge", JSONObject.NULL)
    private var imeMoving = false
    private var imeFrom = 0.0
    private var imeTo = 0.0
    private val layout by lazy { WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(this)) }
    private val onLayout = Consumer<WindowLayoutInfo> { onFold(it) }
    private val watchdog = Runnable {
        if (!ready && rescueReason == null) {
            Hub.reportBroken(pageError ?: "The page didn't call lab.ready() within 8 seconds.")
            autoRescue = true
            rescue("The design didn't finish loading, so this is the safe screen. The ${PC} is putting the version before it back.")
        }
    }
    private var autoRescue = false
    // The first error the page reported before it was ready, sent with the report.
    private var pageError: String? = null
    private val onDesign = {
        if (autoRescue) { autoRescue = false; rescueReason = null }
        if (rescueReason == null) { if (visible) load() else stale = true }
    }
    // A hidden WebView never runs requestAnimationFrame, so the page can't
    // call lab.ready() and the watchdog only counts while it's on screen.
    private var visible = false
    private var stale = false
    private var showingApp = false
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
        intent?.let { arrive(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == SAFE) rescue("Safe mode, opened from the app shortcut.")
        arrive(intent)
    }

    // Shares, the tile, the widget, the assistant gesture and the pairing link.
    private fun arrive(intent: Intent) {
        when (intent.action) {
            COMPOSE, Intent.ACTION_ASSIST -> toCompose(JSONObject().put("kind", "compose").put("text", ""))
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> shared(intent)
            Intent.ACTION_VIEW -> intent.data?.takeIf { it.scheme == "thelab" && it.host == "pair" }?.let { pairFrom(it) }
        }
    }

    private fun toCompose(e: JSONObject) {
        if (port != null && ready) { send(e); keyboard() } else compose = e
    }

    // The page focuses the message box, but a focus no one tapped doesn't
    // raise the keyboard, so the app asks for it once the focus has landed.
    private fun keyboard() {
        web?.postDelayed({ web?.let { it.requestFocus(); it.windowInsetsController?.show(WindowInsets.Type.ime()) } }, 300)
    }

    private fun shared(intent: Intent) {
        val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getStringExtra(Intent.EXTRA_TEXT))
            .filter { it.isNotBlank() }.distinct().joinToString("\n")
        val uris = ArrayList<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.addAll(it) }
        else intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)?.let { uris.add(it) }
        if (uris.isEmpty()) return toCompose(JSONObject().put("kind", "compose").put("text", text))
        Toast.makeText(this, "Sending to the ${PC}", Toast.LENGTH_SHORT).show()
        Hub.later {
            val out = JSONArray()
            val error = try { for (u in uris.take(20)) out.put(Hub.upload(u)); null } catch (e: IOException) { e.message ?: "Couldn't send that to the ${PC}." }
            Hub.onMain {
                if (error != null) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
                toCompose(JSONObject().put("kind", "compose").put("text", text).put("files", out))
            }
        }
    }

    // A pairing link only counts once he has said yes to the address in it.
    private fun pairFrom(uri: Uri) {
        val code = uri.getQueryParameter("c") ?: return
        val tunnel = uri.getQueryParameter("o")?.let { room ->
            Tunnel.Spec.parse(JSONObject().put("relay", uri.getQueryParameter("r") ?: "").put("room", room)
                .put("key", uri.getQueryParameter("k") ?: "").put("pass", uri.getQueryParameter("p") ?: "")
                .put("lan", JSONArray((uri.getQueryParameter("l") ?: "").split(',').filter { it.isNotBlank() })))
                ?: return Toast.makeText(this, "That pairing link is damaged. Show a new code on the ${PC}.", Toast.LENGTH_LONG).show()
        }
        val base = uri.getQueryParameter("u")?.trimEnd('/')
        if (tunnel == null && (base == null || Uri.parse(base).scheme != "https")) return Toast.makeText(this, "That pairing link isn't for a ${PC}.", Toast.LENGTH_LONG).show()
        val host = tunnel?.let { t -> t.relay?.let { Uri.parse(it).host } ?: "your Wi-Fi" } ?: Uri.parse(base).host ?: return
        AlertDialog.Builder(this)
            .setTitle("Pair With This ${PC}?")
            .setMessage(if (tunnel != null) "The Lab will talk to the ${PC} that showed this code, straight over Wi-Fi when it can and through $host otherwise. Only say yes if you just scanned the code on your own ${PC}."
                else "The Lab will talk to $host from now on. Only say yes if you just scanned the code on your own ${PC}.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Pair") { _, _ ->
                Hub.claim(base, tunnel, code) { err ->
                    Toast.makeText(this, err ?: "Paired with the ${PC}.", Toast.LENGTH_LONG).show()
                    if (err == null) { LinkService.start(this); rescueReason = null; load() }
                }
            }
            .show()
    }

    // The Mac's checks, then this phone's own.
    private fun check(id: String) {
        Hub.request("GET", "/check", null) { text, err ->
            val items = text?.let { runCatching { JSONObject(it).getJSONArray("items") }.getOrNull() }
                ?: JSONArray().put(JSONObject().put("ok", false).put("title", "Can't reach the ${PC}").put("detail", err ?: "Check the ${PC} is awake and Tailscale is on."))
            val nm = getSystemService(NotificationManager::class.java)
            val asks = nm.getNotificationChannel("asks")
            if (!nm.areNotificationsEnabled() || asks?.importance == NotificationManager.IMPORTANCE_NONE)
                items.put(JSONObject().put("ok", false).put("title", "Notifications are off for The Lab").put("detail", "You won't hear when it needs your OK.").put("fix", "notifications"))
            else items.put(JSONObject().put("ok", true).put("title", "This phone shows The Lab's notifications"))
            val cm = getSystemService(ConnectivityManager::class.java)
            val vpn = cm.getNetworkCapabilities(cm.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            if (Tunnel.spec != null) when (Tunnel.route) {
                "direct" -> items.put(JSONObject().put("ok", true).put("title", "Connected straight to the ${PC} over this network"))
                "relay" -> items.put(JSONObject().put("ok", true).put("title", "Connected to the ${PC} through the relay"))
            }
            else if (vpn) items.put(JSONObject().put("ok", true).put("title", "Tailscale is running on this phone"))
            else items.put(JSONObject().put("ok", false).put("title", "Tailscale is off on this phone").put("detail", "The phone can only reach the ${PC} through Tailscale.").put("fix", "tailscale"))
            answer(id, JSONObject().put("items", items).toString())
        }
    }

    override fun onStart() {
        super.onStart()
        layout.addWindowLayoutInfoListener(this, mainExecutor, onLayout)
        visible = true
        if (stale) { stale = false; load() }
        else if (showingApp && !ready) { frame.removeCallbacks(watchdog); frame.postDelayed(watchdog, 8000) }
    }

    override fun onStop() {
        visible = false
        frame.removeCallbacks(watchdog)
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
        pageError = null
        wantsBack(false)
        frame.removeCallbacks(watchdog)
        val hasDesign = Hub.designDir.resolve("index.html").exists()
        showingApp = !(rescueReason != null || !hasDesign || !Hub.paired)
        if (!showingApp) {
            w.loadUrl("$ORIGIN/shell/rescue.html?pc=$PC")
        } else {
            w.loadUrl("$ORIGIN/app/index.html")
            if (visible) frame.postDelayed(watchdog, 8000)
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
                for (e in Hub.live.values) batch.put(e)
                val hasDesign = Hub.designDir.resolve("index.html").exists()
                val reason = rescueReason ?: if (!hasDesign && Hub.paired) "Your design hasn't arrived from the ${PC} yet. It loads as soon as the ${PC} is reachable." else null
                if (reason != null) batch.put(JSONObject().put("kind", "rescue").put("reason", reason).put("hasDesign", hasDesign && rescueReason != null))
                reply.postMessage(JSONObject().put("batch", batch).toString())
                Hub.onLoaded {
                    if (port !== reply) return@onLoaded
                    val history = JSONArray()
                    for (e in Hub.events) history.put(e)
                    history.put(JSONObject().put("kind", "loaded"))
                    reply.postMessage(JSONObject().put("batch", history).toString())
                    unlisten = Hub.listen { send(it) }
                    compose?.let { reply.postMessage(it.toString()); keyboard() }
                    compose = null
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
                Hub.answer(ref, m.optBoolean("allow"), m.optBoolean("always")) { ok -> if (!ok) send(JSONObject().put("kind", "answerFailed").put("ref", ref)) }
            }
            "call" -> {
                val id = m.optString("id")
                val method = m.optString("method", "GET").uppercase().takeIf { it == "GET" || it == "POST" } ?: return answer(id, null, "Only GET and POST go to the ${PC}.")
                Hub.request(method, m.optString("path"), m.optString("body").ifBlank { null }) { text, err -> answer(id, text, err) }
            }
            "check" -> check(m.optString("id"))
            "undo" -> Hub.undoDesign { ok ->
                send(JSONObject().put("kind", "undone").put("ok", ok))
                if (ok) { rescueReason = null }
            }
            "leaveRescue" -> { rescueReason = null; autoRescue = false; load() }
            "pageError" -> {
                val text = m.optString("message").take(500)
                if (!ready && pageError == null) pageError = text
                Hub.reportError(text, m.optString("where"))
            }
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
            "fix" -> when (m.optString("fix")) {
                "tailscale" -> openApp("com.tailscale.ipn")
                "notifications" -> startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            }
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
        const val COMPOSE = "com.somethingobvious.thelab.COMPOSE"
        const val PICK = 7
    }
}
