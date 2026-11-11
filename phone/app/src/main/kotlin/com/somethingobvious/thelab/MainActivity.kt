package com.somethingobvious.thelab

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import android.provider.Settings
import android.speech.RecognizerIntent
import android.speech.tts.TextToSpeech
import android.widget.Toast
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.util.Log
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
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import androidx.core.content.edit
import androidx.core.graphics.drawable.toDrawable
import androidx.core.graphics.toColorInt
import androidx.core.net.toUri
import androidx.core.util.Consumer
import androidx.core.view.WindowCompat
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
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.math.roundToInt

class MainActivity : Activity() {
    private lateinit var frame: FrameLayout
    private var web: WebView? = null
    private var port: JavaScriptReplyProxy? = null
    private var unlisten: (() -> Unit)? = null
    private var rescueReason: String? = null
    private var ready = false
    private var picking: String? = null
    private var picker: JavaScriptReplyProxy? = null
    private var pickedFor: Computer? = null
    private var listener: JavaScriptReplyProxy? = null
    private var listening: String? = null
    private var voice: TextToSpeech? = null
    // Only <lab-ask> knows it, so only it can answer an Allow card.
    private var askKey = ""
    private val askScript by lazy { assets.open("ask.js").bufferedReader().use { it.readText() } }
    private var pairDialog: AlertDialog? = null
    private var updateDialog: AlertDialog? = null
    private val onUpdate: () -> Unit = { offerUpdate() }
    private var insets = JSONObject().put("kind", "insets")
    private var fold = JSONObject().put("kind", "fold").put("posture", JSONObject.NULL).put("hinge", JSONObject.NULL)
    private var imeMoving = false
    private var imeFrom = 0.0
    private var imeTo = 0.0
    private val layout by lazy { WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(this)) }
    private val onLayout = Consumer<WindowLayoutInfo> { onFold(it) }
    private val watchdog = Runnable {
        if (!ready && rescueReason == null) {
            // A busy phone can be slow to start the page, so a quiet first miss
            // gets a longer second go before the design is blamed and put back.
            if (!slow && pageError == null) {
                slow = true
                load()
                return@Runnable
            }
            broken(pageError ?: "The page didn't call lab.ready() within 8 seconds, then 20 more.")
            load()
        }
    }
    private val patience get() = if (slow) 20_000L else 8000L
    private var slow = false
    // Renderer deaths before the page was ready, so a design that keeps killing it reaches the safe screen.
    private var deaths = 0
    private var autoRescue = false
    // The first error the page reported before it was ready, sent with the report.
    private var pageError: String? = null
    private val onDesign = {
        slow = false
        deaths = 0
        if (autoRescue) { autoRescue = false; rescueReason = null }
        if (rescueReason == null) { if (visible) load() else stale = true }
    }
    private val onReset = { if (visible) load() else stale = true }
    // Another computer's design, on its own address, in a fresh WebView.
    private val onSwitch = {
        rescueReason = null
        autoRescue = false
        slow = false
        deaths = 0
        ready = false
        if (visible) build() else drop()
    }
    // A pick that was open when the screen was rebuilt, whose page is gone.
    private var pickedBefore = false
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
        updatedNotice()
        WindowCompat.setDecorFitsSystemWindows(window, false)
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

        // A rebuilt screen (a theme switch, say) carries on where it was
        // rather than acting on the intent that first opened it again.
        if (savedInstanceState != null) {
            rescueReason = savedInstanceState.getString("rescue")
            autoRescue = savedInstanceState.getBoolean("autoRescue")
            pickedBefore = savedInstanceState.getBoolean("picking")
        } else if (intent?.getBooleanExtra("rescue", false) == true || intent?.action == SAFE) {
            rescueReason = "Safe mode, opened from the app shortcut."
        }
        Hub.designListeners.add(onDesign)
        Hub.resetListeners.add(onReset)
        Hub.switchListeners.add(onSwitch)
        if (Hub.paired) LinkService.start(this)
        build()
        if (savedInstanceState == null) intent?.let { arrive(it) }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("rescue", rescueReason)
        outState.putBoolean("autoRescue", autoRescue)
        outState.putBoolean("picking", picking != null || pickedBefore)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == SAFE) rescue("Safe mode, opened from the app shortcut.")
        arrive(intent)
    }

    // Shares, the tile, the widget, the assistant gesture and the pairing link.
    private fun arrive(intent: Intent) {
        // A notification or a share to one computer in particular.
        val shortcut = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID)?.takeIf { it.startsWith("mac") }?.removePrefix("mac")?.removePrefix("-")?.ifEmpty { "main" }
        (intent.getStringExtra("computer") ?: shortcut)?.let { Hub.switchTo(it) }
        when (intent.action) {
            COMPUTERS -> chooseComputer()
            COMPOSE, Intent.ACTION_ASSIST -> toCompose(JSONObject().put("kind", "compose").put("text", ""))
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> shared(intent)
            Intent.ACTION_VIEW -> intent.data?.takeIf { it.scheme == "thelab" && it.host == "pair" }?.let { pairFrom(it) }
        }
    }

    private fun toCompose(e: JSONObject) {
        Hub.composing.add(e)
        deliverCompose()
    }

    // Held in Hub until the design is up and ready, so a share is kept
    // through a slow start, a safe screen or a rebuilt screen.
    private fun deliverCompose() {
        if (port == null || !ready || !showingApp || Hub.composing.isEmpty()) return
        for (e in Hub.composing) send(e)
        Hub.composing.clear()
        keyboard()
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
        // Any app can send this, and The Lab opens the stream with its own
        // rights, so a file:// path or its own provider would hand over its
        // private files, every computer's key among them.
        uris.retainAll { it.scheme == ContentResolver.SCHEME_CONTENT && it.authority != "$packageName.files" }
        if (uris.isEmpty()) return toCompose(JSONObject().put("kind", "compose").put("text", text))
        Toast.makeText(this, "Sending to the computer", Toast.LENGTH_SHORT).show()
        uploadAll(uris, "Couldn't send that to the computer.") { out, error ->
            if (error != null) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
            toCompose(JSONObject().put("kind", "compose").put("text", text).put("files", out))
        }
    }

    // The first 20, which is all one message can carry. error is what to tell him, if anything.
    private fun uploadAll(uris: List<Uri>, fallback: String, done: (JSONArray, String?) -> Unit) {
        Hub.later {
            val out = JSONArray()
            val error = try {
                for (u in uris.take(MAX_FILES)) out.put(Hub.on.upload(u))
                if (uris.size > MAX_FILES) "Only the first $MAX_FILES files were attached. Send the rest in another message." else null
            } catch (e: IOException) { e.message ?: fallback }
            Hub.onMain { done(out, error) }
        }
    }

    // A pairing link only counts once he has said yes to the address in it.
    private fun pairFrom(uri: Uri) {
        val code = uri.getQueryParameter("c") ?: return
        val tunnel = uri.getQueryParameter("o")?.let { room ->
            Tunnel.Spec.parse(JSONObject().put("relay", uri.getQueryParameter("r") ?: "").put("room", room)
                .put("key", uri.getQueryParameter("k") ?: "").put("pass", uri.getQueryParameter("p") ?: "")
                .put("lan", JSONArray((uri.getQueryParameter("l") ?: "").split(',').filter { it.isNotBlank() })))
                ?: return Toast.makeText(this, "That pairing link is damaged. Show a new code on the computer.", Toast.LENGTH_LONG).show()
        }
        val base = uri.getQueryParameter("u")?.trimEnd('/')
        if (tunnel == null && (base == null || base.toUri().scheme != "https")) return Toast.makeText(this, "That pairing link isn't from The Lab.", Toast.LENGTH_LONG).show()
        val host = tunnel?.let { t -> t.relay?.toUri()?.host ?: "your Wi-Fi" } ?: base?.toUri()?.host ?: return
        val known = Hub.known(if (tunnel != null) null else base, tunnel)
        val how = if (tunnel != null) "straight over Wi-Fi when it can and through $host otherwise" else "through $host"
        val (title, text) = when {
            known != null -> "Pair ${known.name} Again?" to "This phone already has ${known.name}. Pairing again gives it a new key and keeps its history."
            Hub.paired -> "Add This Computer?" to "The Lab will talk to the computer that showed this code, $how. The computers you already have stay as they are."
            else -> "Pair With This Computer?" to "The Lab will talk to the computer that showed this code, $how."
        }
        val check = tunnel?.let { " The computer's screen shows ${keyCheck(uri.getQueryParameter("k").orEmpty())} under the code, and it has to match." }.orEmpty()
        AlertDialog.Builder(this)
            .setTitle(title)
            .setMessage("$text$check Only say yes if you just scanned the code on your own computer.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton(if (known == null && Hub.paired) "Add" else "Pair") { _, _ ->
                Hub.claim(base, tunnel, code) { err ->
                    Toast.makeText(this, err ?: "Paired with the computer.", Toast.LENGTH_LONG).show()
                    if (err == null) { LinkService.start(this); rescueReason = null; load() }
                }
            }
            .show()
    }

    // The computer's checks, then this phone's own.
    private fun check(id: String, asker: JavaScriptReplyProxy) {
        Hub.on.request("GET", "/check", null) { text, err ->
            val items = text?.let { runCatching { JSONObject(it).getJSONArray("items") }.getOrNull() }
                ?: JSONArray().put(JSONObject().put("ok", false).put("title", "Can't reach the computer")
                    .put("detail", err ?: if (Hub.on.tunnel.spec != null) "Check the computer is awake and online." else "Check the computer is awake and Tailscale is on."))
            if (!notificationsOn())
                items.put(JSONObject().put("ok", false).put("title", "Notifications are off for The Lab").put("detail", "You won't hear when it needs your OK.").put("fix", "notifications"))
            else items.put(JSONObject().put("ok", true).put("title", "This phone shows The Lab's notifications"))
            if (!getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName))
                items.put(JSONObject().put("ok", false).put("title", "The phone puts The Lab to sleep to save battery")
                    .put("detail", "It can miss the computer's questions while the screen is off. On the next screen, open battery and choose Unrestricted.").put("fix", "battery"))
            else items.put(JSONObject().put("ok", true).put("title", "The Lab can stay connected in the background"))
            val cm = getSystemService(ConnectivityManager::class.java)
            val vpn = cm.getNetworkCapabilities(cm.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            if (Hub.on.tunnel.spec != null) when (Hub.on.tunnel.route) {
                "direct" -> items.put(JSONObject().put("ok", true).put("title", "Connected straight to the computer over this network"))
                "relay" -> items.put(JSONObject().put("ok", true).put("title", "Connected to the computer through the relay"))
            }
            else if (vpn) items.put(JSONObject().put("ok", true).put("title", "Tailscale is running on this phone"))
            else items.put(JSONObject().put("ok", false).put("title", "Tailscale is off on this phone").put("detail", "The phone can only reach the computer through Tailscale.").put("fix", "tailscale"))
            answer(id, JSONObject().put("items", items).toString(), to = asker)
        }
    }

    override fun onStart() {
        super.onStart()
        layout.addWindowLayoutInfoListener(this, mainExecutor, onLayout)
        visible = true
        Hub.updateListeners.add(onUpdate)
        if (web == null) { stale = false; build() }
        else if (stale) { stale = false; load() }
        else if (showingApp && !ready) { frame.removeCallbacks(watchdog); frame.postDelayed(watchdog, patience) }
    }

    override fun onStop() {
        visible = false
        Hub.updateListeners.remove(onUpdate)
        frame.removeCallbacks(watchdog)
        layout.removeWindowLayoutInfoListener(onLayout)
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        Hub.foreground = true
        AppUpdate.held = false
        Notifier.clearReplies(this, Hub.on)
        val ask = AppUpdate.confirm
        AppUpdate.confirm = null
        if (ask != null) startActivity(ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        else if (Hub.pendingPair != null) confirmPair()
        else if (Hub.paired) {
            Hub.reconnectNow()
            if (!offerUpdate()) nudge()
        }
    }

    // An update can come in while he's away, so he hears about it the next time he opens the app.
    private fun updatedNotice() {
        val prefs = getSharedPreferences("lab", MODE_PRIVATE)
        val was = prefs.getString("ranVersion", null)
        if (was == BuildConfig.VERSION_NAME) return
        prefs.edit { putString("ranVersion", BuildConfig.VERSION_NAME) }
        if (was != null) Toast.makeText(this, "The Lab updated to ${BuildConfig.VERSION_NAME}.", Toast.LENGTH_LONG).show()
    }

    // On opening, at most once a day per version unless he asks from the menu.
    private fun offerUpdate(asked: Boolean = false): Boolean {
        val (c, a) = AppUpdate.best() ?: run {
            if (asked) Toast.makeText(this, "This is already the newest app your computers have.", Toast.LENGTH_SHORT).show()
            return false
        }
        val v = a.optString("version")
        if ((AppUpdate.putOff(v) && !asked) || updateDialog?.isShowing == true || pairDialog?.isShowing == true) return false
        updateDialog = AlertDialog.Builder(this)
            .setTitle("Update The Lab?")
            .setMessage("${c.name} has The Lab $v ready, and this phone has ${BuildConfig.VERSION_NAME}. It takes a few seconds and keeps your computers and history. After this, updates install by themselves while you're not using The Lab, unless they're turned off in Settings.")
            .setNegativeButton("Later") { _, _ -> AppUpdate.later(v) }
            // Back or a tap outside means not now, the same as Later.
            .setOnCancelListener { AppUpdate.later(v) }
            .setPositiveButton("Update") { _, _ -> startUpdate(c, a) }
            .show()
        return true
    }

    private fun startUpdate(c: Computer, a: JSONObject) {
        if (!packageManager.canRequestPackageInstalls()) {
            AlertDialog.Builder(this)
                .setTitle("Let The Lab Install Updates?")
                .setMessage("Android asks once whether The Lab may install its own updates. On the next screen, turn on Allow from this source, then come back here.")
                .setNegativeButton("Not Now", null)
                .setPositiveButton("Open Settings") { _, _ ->
                    startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:$packageName".toUri()))
                }
                .show()
            return
        }
        Toast.makeText(this, "Getting The Lab ${a.optString("version")} from ${c.name}", Toast.LENGTH_SHORT).show()
        AppUpdate.install(c, a) { err -> if (err != null) Toast.makeText(this, err, Toast.LENGTH_LONG).show() }
    }

    // A pairing that came in by broadcast for a different computer than this
    // one, which only goes ahead on his yes here.
    private fun confirmPair() {
        val p = Hub.pendingPair ?: return
        if (pairDialog?.isShowing == true) return
        val drop = { if (Hub.pendingPair === p) Hub.pendingPair = null; Notifier.pairAnswered(this) }
        pairDialog = AlertDialog.Builder(this)
            .setTitle("Add Another Computer?")
            .setMessage("Something on this phone asked The Lab to pair with a computer it doesn't know yet. Only say yes if you're setting The Lab up on your own computer right now. The computers you already have stay as they are.")
            .setNegativeButton("Cancel") { _, _ -> drop() }
            .setOnCancelListener { drop() }
            .setPositiveButton("Add") { _, _ ->
                if (Hub.pendingPair !== p) return@setPositiveButton
                Notifier.pairAnswered(this)
                Hub.pair(p.url, p.tunnel, p.token)
                LinkService.start(this)
                rescueReason = null
                load()
            }
            .show()
    }

    // In the app rather than on the page, so it's there and can be trusted
    // whatever the agent has made of this computer's design.
    private fun chooseComputer() {
        val all = Hub.pairedComputers
        if (all.isEmpty()) return addComputer()
        val dim = obtainStyledAttributes(intArrayOf(android.R.attr.textColorSecondary)).run { getColor(0, Color.GRAY).also { recycle() } }
        val rows = all.map<Computer, CharSequence> { c ->
            val state = stateOf(c)
            SpannableStringBuilder(nameOf(c, all)).append("\n").append(state, RelativeSizeSpan(0.82f), 0).apply {
                setSpan(ForegroundColorSpan(dim), length - state.length, length, 0)
            }
        }
        AlertDialog.Builder(this)
            .setTitle("Your Computers")
            .setSingleChoiceItems(rows.toTypedArray(), all.indexOf(Hub.on)) { d, i ->
                d.dismiss()
                Hub.switchTo(all[i].id)
            }
            .setPositiveButton("Add Another") { _, _ -> addComputer() }
            .setNegativeButton("Close", null)
            .setNeutralButton("Forget One") { _, _ ->
                if (all.size == 1) confirmForget(all[0])
                else AlertDialog.Builder(this).setTitle("Forget Which Computer?")
                    .setItems(all.map { nameOf(it, all) }.toTypedArray()) { _, i -> confirmForget(all[i]) }
                    .setNegativeButton("Cancel", null)
                    .show()
            }
            .show()
    }

    // Two computers can carry the same name, so the list numbers them.
    private fun nameOf(c: Computer, all: List<Computer>) =
        if (all.count { it.name == c.name } > 1) "${c.name} (${all.indexOf(c) + 1})" else c.name

    private fun stateOf(c: Computer) = when {
        c.waiting -> "Needs your OK"
        c.working -> "Working"
        c.link.optString("state") == "online" -> "Ready"
        c.link.optString("state") == "connecting" -> "Connecting"
        else -> "Can't reach it right now"
    }

    private fun addComputer() {
        AlertDialog.Builder(this).setTitle("Add a Computer")
            .setMessage("On the other computer, open The Lab and choose Pair a Phone in the menu, or set The Lab up there first. Then point this phone's camera at the code it shows and tap the link. The computers you already have stay as they are.")
            .setPositiveButton("OK", null).show()
    }

    private fun confirmForget(c: Computer) {
        AlertDialog.Builder(this).setTitle("Forget ${c.name}?")
            .setMessage("This phone's copy of its history and any unsent messages go. Nothing changes on the computer, and you can pair it again later.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Forget") { _, _ -> Hub.forget(c) }
            .show()
    }

    // Either one quietly stops his questions reaching him, so it's worth a
    // word, though no more than once a day.
    private fun nudge() {
        val prefs = getSharedPreferences("lab", MODE_PRIVATE)
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("nudgedAt", 0) < 24 * 60 * 60_000L) return
        val (title, text, what) = when {
            !notificationsOn() -> Triple("Turn On Notifications?",
                "Notifications are off for The Lab, so you won't hear when the computer needs your OK.", "notifications")
            !getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName) -> Triple("Let The Lab Stay Connected?",
                "The phone is putting The Lab to sleep to save battery, so it can miss the computer's questions. On the next screen, open battery and choose Unrestricted.", "battery")
            else -> return
        }
        prefs.edit { putLong("nudgedAt", now) }
        AlertDialog.Builder(this).setTitle(title).setMessage(text)
            .setNegativeButton("Not Now", null)
            .setPositiveButton("Fix It") { _, _ -> fix(what) }
            .show()
    }

    private fun notificationsOn(): Boolean {
        val nm = getSystemService(NotificationManager::class.java)
        return nm.areNotificationsEnabled() && nm.getNotificationChannel("asks")?.importance != NotificationManager.IMPORTANCE_NONE
    }

    private fun fix(what: String) {
        when (what) {
            "tailscale" -> openApp("com.tailscale.ipn")
            "notifications" -> startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            "battery" -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri()))
        }
    }

    override fun onPause() {
        Hub.foreground = false
        AppUpdate.left()
        super.onPause()
    }

    override fun onDestroy() {
        Hub.designListeners.remove(onDesign)
        Hub.resetListeners.remove(onReset)
        Hub.switchListeners.remove(onSwitch)
        unlisten?.invoke()
        web?.destroy()
        voice?.shutdown()
        pairDialog?.dismiss()
        super.onDestroy()
    }

    private fun drop() {
        web?.let { frame.removeView(it); it.destroy() }
        web = null
        unlisten?.invoke()
        unlisten = null
        port = null
    }

    private fun build() {
        drop()
        val computer = Hub.on
        val loader = WebViewAssetLoader.Builder()
            .setDomain(computer.host)
            .addPathHandler("/app/", WebViewAssetLoader.InternalStoragePathHandler(this, computer.designDir.apply { mkdirs() }))
            .addPathHandler("/shell/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/files/") { path ->
                // lab.fileUrl(url, { w }) asks for /files/w360/name.
                val sized = Regex("^w(\\d{2,4})/(.+)$").find(path)
                val f = (if (sized != null) computer.thumb(sized.groupValues[2], sized.groupValues[1].toInt().coerceIn(48, 2048)) else computer.fetchFile(path))
                    ?: return@addPathHandler null
                WebResourceResponse(mime(f.name), null, FileInputStream(f))
            }
            .build()
        val w = WebView(this)
        // Entries cached for a year by an earlier build would still win over
        // the no-cache header, so they go once.
        val prefs = getSharedPreferences("lab", MODE_PRIVATE)
        if (!prefs.getBoolean("cacheFresh", false)) {
            w.clearCache(true)
            prefs.edit { putBoolean("cacheFresh", true) }
        }
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
            // The loader marks everything cacheable for a year, but the design and
            // the shell change under the same names, so a new index.html would
            // come up with the old app.css.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)?.apply {
                    responseHeaders = responseHeaders.orEmpty().filterKeys { !it.equals("Cache-Control", ignoreCase = true) } +
                        ("Cache-Control" to "no-cache")
                }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == computer.host) return false
                openExternal(request.url)
                return true
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Only on screen, since a hidden page never gets ready and Android reclaims hidden renderers.
                if (visible && !ready && showingApp && ++deaths >= 2) broken("The page's renderer stopped twice before the page was ready.")
                // The page's renderer died (out of memory, or a crash), so start
                // over with a fresh one, or wait for the screen if it's hidden.
                if (visible) build() else drop()
                return true
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // A fresh key for each WebView, and ask.js first, so it holds the
            // built-ins it needs before anything else on the page runs.
            askKey = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
            WebViewCompat.addDocumentStartJavaScript(w, askScript.replace("__LAB_ASK_KEY__", askKey), setOf(computer.origin))
            WebViewCompat.addDocumentStartJavaScript(w, assets.open("bridge.js").bufferedReader().readText(), setOf(computer.origin))
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "labNative", setOf(computer.origin)) { _, message, _, isMainFrame, reply ->
                if (isMainFrame) handle(message.data ?: return@addWebMessageListener, reply)
            }
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
        val hasDesign = Hub.on.designDir.resolve("index.html").exists()
        showingApp = !(rescueReason != null || !hasDesign || !Hub.on.paired)
        if (!showingApp) {
            w.loadUrl("${Hub.on.origin}/shell/rescue.html")
        } else {
            w.loadUrl("${Hub.on.origin}/app/index.html")
            if (visible) frame.postDelayed(watchdog, patience)
        }
    }

    private fun rescue(reason: String) {
        rescueReason = reason
        load()
    }

    // Leaves the loading to the caller, since a WebView whose renderer died can't load anything.
    private fun broken(why: String) {
        slow = false
        deaths = 0
        autoRescue = true
        // A version that has opened before is more likely a slow or busy
        // phone than a broken design, so it isn't undone.
        if (Hub.on.designVersion != null && Hub.on.designVersion == Hub.on.designOpened) {
            rescueReason = "The design didn't finish opening this time, so this is the safe screen. It has opened fine before, so it stays as it is. Tap Back to My Design to try it again."
            return
        }
        Hub.on.reportBroken(why)
        rescueReason = "The design didn't finish loading, so this is the safe screen. The computer is putting the version before it back."
    }

    private fun send(e: JSONObject) {
        port?.let { post(it, e.toString()) }
    }

    // A proxy only comes from the listener, so the feature is always there by now.
    private fun post(to: JavaScriptReplyProxy, text: String) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) to.postMessage(text)
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
                val batch = JSONArray().put(Hub.on.link).put(Hub.on.status).put(Hub.on.outboxEvent()).put(insets).put(fold).put(Hub.computersEvent())
                for (e in Hub.on.live.values) batch.put(e)
                val hasDesign = Hub.on.designDir.resolve("index.html").exists()
                val reason = rescueReason ?: if (!hasDesign && Hub.on.paired) "Your design hasn't arrived from the computer yet. It loads as soon as the computer is reachable." else null
                if (reason != null) batch.put(JSONObject().put("kind", "rescue").put("reason", reason).put("hasDesign", hasDesign && rescueReason != null))
                post(reply, JSONObject().put("batch", batch).toString())
                Hub.on.onLoaded {
                    if (port !== reply) return@onLoaded
                    val history = JSONArray()
                    for (e in Hub.on.events) history.put(e)
                    history.put(JSONObject().put("kind", "loaded"))
                    post(reply, JSONObject().put("batch", history).toString())
                    unlisten = Hub.listen { send(it) }
                }
            }
            "send" -> {
                val text = m.optString("text").trim()
                val cid = m.optString("cid")
                val files = m.optJSONArray("files")?.takeIf { it.length() > 0 }
                if (text.length > 50_000) send(Hub.on.sendFailed(cid, text, "That message is over 50,000 characters, so it didn't send. Try sending it in parts."))
                else if (files != null && files.length() > MAX_FILES) send(Hub.on.sendFailed(cid, text, "That message has more than $MAX_FILES files, so it didn't send. Send them in smaller batches."))
                else if ((text.isNotEmpty() || files != null) && cid.length == 36) Hub.on.send(text, cid, files)
                else if (text.isNotEmpty()) send(Hub.on.sendFailed(cid, text, "That message didn't send. Try again."))
                // Asked here, when replies and approvals start to matter, rather than on first launch.
                val prefs = getSharedPreferences("lab", MODE_PRIVATE)
                if (!prefs.getBoolean("askedNotify", false) && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    prefs.edit { putBoolean("askedNotify", true) }
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
                }
            }
            "saveShortcuts" -> {
                val id = m.optString("id")
                Hub.on.saveShortcuts(m.optJSONArray("items") ?: JSONArray()) { ok -> answer(id, ok, to = reply) }
            }
            "attach" -> pick(m.optString("id"), m.optString("kind"), reply)
            "stop" -> Hub.on.stop { ok -> if (!ok) send(JSONObject().put("kind", "stopFailed")) }
            "askInfo", "askAnswer" -> asked(m, reply)
            "call" -> {
                val id = m.optString("id")
                val method = m.optString("method", "GET").uppercase().takeIf { it == "GET" || it == "POST" } ?: return answer(id, null, "Only GET and POST go to the computer.")
                val path = m.optString("path")
                if (closedToPage(path)) return answer(id, null, "The page can't use that route. Questions are answered on their own card, and pairing happens on the phone.")
                Hub.on.request(method, path, m.optString("body").ifBlank { null }) { text, err -> answer(id, text, err, reply) }
            }
            "check" -> check(m.optString("id"), reply)
            "undo" -> Hub.on.undoDesign { ok ->
                send(JSONObject().put("kind", "undone").put("ok", ok))
                if (ok) { rescueReason = null }
            }
            "leaveRescue" -> { rescueReason = null; autoRescue = false; slow = false; load() }
            "pageError" -> {
                val text = m.optString("message").take(500)
                if (!ready && pageError == null) pageError = text
                Hub.on.reportError(text, m.optString("where"))
            }
            "rescue" -> rescue(m.optString("reason", "Opened the safe screen."))
            "ready" -> {
                ready = true
                slow = false
                deaths = 0
                frame.removeCallbacks(watchdog)
                if (showingApp) Hub.on.openedFine()
                applyTheme(m)
                reportFullyDrawn()
                deliverCompose()
            }
            "theme" -> applyTheme(m)
            "back" -> wantsBack(m.optBoolean("on"))
            "open" -> open(m.optString("url"))
            "listen" -> listen(m.optString("id"), reply)
            "speak" -> speak(m.optString("text"))
            "hush" -> voice?.stop()
            "fix" -> fix(m.optString("fix"))
            "statusCard" -> m.optString("mode").takeIf { it in setOf("always", "tasks", "never") }?.let {
                getSharedPreferences("lab", MODE_PRIVATE).edit { putString("statusCard", it) }
                LinkService.refresh()
            }
            "retry" -> if (Hub.on.link.optString("state") != "online") Hub.on.reconnectNow()
            "chooseComputer" -> chooseComputer()
            "updateApp" -> offerUpdate(asked = true)
        }
    }

    // From <lab-ask>, which alone holds this WebView's key. Anything else is
    // dropped without a reply. The reply never carries the key.
    private fun asked(m: JSONObject, reply: JavaScriptReplyProxy) {
        val key = m.opt("key") as? String ?: return
        if (askKey.isEmpty() || !MessageDigest.isEqual(key.toByteArray(), askKey.toByteArray())) return
        val nonce = m.opt("nonce") as? String ?: return
        val ref = (m.opt("ref") as? String)?.let { plainName(it) }?.takeIf { it.length <= 200 } ?: return
        val op = m.optString("op")
        val out = JSONObject().put("op", op).put("nonce", nonce)
        if (op == "askInfo") Hub.on.askInfo(ref) { code, text ->
            val ask = if (code == 200) text?.let { runCatching { JSONObject(it) }.getOrNull() } else null
            post(reply, out.put("status", code).put("ask", ask ?: JSONObject.NULL).toString())
        } else {
            val allow = m.opt("allow") as? Boolean ?: return
            val always = m.opt("always") as? Boolean ?: return
            Hub.on.answer(ref, allow, always) { code -> post(reply, out.put("status", code.coerceAtLeast(0)).toString()) }
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
        val t = cleanTheme(m) ?: return
        bars(t)
        getSharedPreferences("lab", MODE_PRIVATE).edit { putString(if (night) "look-dark" else "look-light", t.toString()) }
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
    // This runs before the safe screen exists, so a saved look that can't be
    // drawn is thrown away rather than stopping every launch.
    private fun paintStart() {
        val prefs = getSharedPreferences("lab", MODE_PRIVATE)
        val key = if (night) "look-dark" else "look-light"
        val raw = prefs.getString(key, null) ?: return
        try {
            val m = cleanTheme(JSONObject(raw)) ?: throw IllegalArgumentException("unusable look")
            val bg = m.getString("bg").toColorInt()
            val head = m.optString("head").ifEmpty { null }?.toColorInt()
            val d = resources.displayMetrics.density
            val height = (m.optDouble("headHeight", 0.0) * d).roundToInt()
            val layers = if (head != null && head != bg && height > 0) {
                val r = m.optDouble("headRadius", 0.0).toFloat() * d
                val band = GradientDrawable().apply { setColor(head); cornerRadii = floatArrayOf(0f, 0f, 0f, 0f, r, r, r, r) }
                LayerDrawable(arrayOf(bg.toDrawable(), band)).apply {
                    setLayerGravity(1, Gravity.TOP or Gravity.FILL_HORIZONTAL)
                    setLayerHeight(1, height)
                }
            } else bg.toDrawable()
            window.setBackgroundDrawable(layers)
            bars(m)
        } catch (e: Exception) {
            Log.w("Lab", "dropped a saved look that couldn't be drawn", e)
            prefs.edit { remove(key) }
        }
    }

    private fun wantsBack(on: Boolean) {
        if (on == backRegistered) return
        backRegistered = on
        if (on) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, back)
        else onBackInvokedDispatcher.unregisterOnBackInvokedCallback(back)
    }

    @RequiresApi(34)
    private fun progress(e: BackEvent) {
        send(JSONObject().put("kind", "backprogress").put("progress", e.progress.toDouble())
            .put("edge", if (e.swipeEdge == BackEvent.EDGE_RIGHT) "right" else "left"))
    }

    // Answers a promise the page is waiting on.
    // Only while the page that asked is still the one on screen. Every page
    // numbers its requests from 1, so a late answer for another computer's
    // page would otherwise land on this one's.
    private fun answer(id: String, value: Any?, error: String? = null, to: JavaScriptReplyProxy? = port) {
        if (to == null || to !== port) return
        val r = JSONObject().put("reply", id)
        if (error != null) r.put("error", error) else r.put("value", value)
        post(to, r.toString())
    }

    // The system's own speech screen, so the mic never runs without him seeing
    // it, whatever the page does, and the app needs no microphone permission.
    private fun listen(id: String, asker: JavaScriptReplyProxy) {
        listening?.let { answer(it, "", to = listener) }
        listening = id
        listener = asker
        AppUpdate.held = true
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        try { startActivityForResult(intent, LISTEN) } catch (_: ActivityNotFoundException) {
            listening = null
            answer(id, null, "There's nothing on this phone that can turn speech into text.", asker)
        }
    }

    private fun speak(text: String) {
        val said = text.take(TextToSpeech.getMaxSpeechInputLength() - 1)
        if (said.isBlank()) return
        val ready = voice
        if (ready != null) {
            ready.speak(said, TextToSpeech.QUEUE_FLUSH, null, "reply")
            return
        }
        var made: TextToSpeech? = null
        made = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) made?.speak(said, TextToSpeech.QUEUE_FLUSH, null, "reply")
        }
        voice = made
    }

    private fun pick(id: String, kind: String, asker: JavaScriptReplyProxy) {
        picking?.let { answer(it, JSONArray(), to = picker) }
        picking = id
        picker = asker
        pickedFor = Hub.on
        AppUpdate.held = true
        val photos = kind == "photos"
        val intent = if (photos) {
            Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*").putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 10)
        } else {
            Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(if (photos) "image/*" else "*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try { startActivityForResult(intent, PICK) } catch (_: ActivityNotFoundException) {
            picking = null
            answer(id, null, "There's nothing on this phone that can pick files.", asker)
        }
    }

    @Deprecated("Activity has no other way to get a picker result without AndroidX Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == LISTEN) {
            val id = listening ?: return
            listening = null
            val heard = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
            return answer(id, if (resultCode == RESULT_OK) heard.orEmpty() else "", to = listener)
        }
        if (requestCode != PICK) return super.onActivityResult(requestCode, resultCode, data)
        val id = picking
        if (id == null && !pickedBefore) return
        picking = null
        pickedBefore = false
        // Picked for one computer, so they aren't sent to another he switched to meanwhile.
        if (pickedFor != null && pickedFor !== Hub.on) return
        val uris = ArrayList<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) else data.data?.let { uris.add(it) }
        }
        if (uris.isEmpty()) {
            if (id != null) answer(id, JSONArray(), to = picker)
            return
        }
        uploadAll(uris, "Couldn't attach that.") { out, error ->
            when {
                id != null && out.length() == 0 && error != null -> answer(id, null, error, picker)
                id != null -> {
                    answer(id, out, to = picker)
                    if (error != null) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
                }
                // The page that asked was rebuilt, so the files go to the message box like a share.
                else -> {
                    if (error != null) Toast.makeText(this, error, Toast.LENGTH_LONG).show()
                    toCompose(JSONObject().put("kind", "compose").put("text", "").put("files", out))
                }
            }
        }
    }

    private fun open(url: String) {
        val uri = url.toUri()
        if (uri.scheme == "http" || uri.scheme == "https") {
            if (uri.host != Hub.on.host) return openExternal(uri)
        }
        val name = uri.lastPathSegment ?: return
        Hub.soon {
            val f = Hub.on.fetchFile(name)
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

    // Pairing only starts from the camera or another app, never from a
    // computer's own page, which could otherwise slip in a computer of its own.
    private fun openExternal(uri: Uri) {
        if (uri.scheme.equals("thelab", ignoreCase = true)) return
        try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (_: ActivityNotFoundException) {}
    }

    private fun openApp(pkg: String) {
        packageManager.getLaunchIntentForPackage(pkg)?.let { startActivity(it) }
            ?: openExternal("market://details?id=$pkg".toUri())
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
        const val SAFE = "com.somethingobvious.thelab.SAFE"
        const val COMPOSE = "com.somethingobvious.thelab.COMPOSE"
        const val COMPUTERS = "com.somethingobvious.thelab.COMPUTERS"
        const val PICK = 7
        const val LISTEN = 8
        // As many files as one message can carry.
        const val MAX_FILES = 20
    }
}

private val COLOR = Regex("^#[0-9a-fA-F]{6}$")

// Only what paintStart and bars read, each one checked, since the page is
// the agent's design and a bad number would crash every launch. Null when
// the background itself isn't a colour.
internal fun cleanTheme(m: JSONObject): JSONObject? {
    val bg = (m.opt("bg") as? String)?.takeIf { COLOR.matches(it) } ?: return null
    val out = JSONObject().put("bg", bg)
    for (k in listOf("dark", "topDark", "bottomDark")) (m.opt(k) as? Boolean)?.let { out.put(k, it) }
    val head = (m.opt("head") as? String)?.takeIf { COLOR.matches(it) }
    val height = (m.opt("headHeight") as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..1000.0 }
    val radius = ((m.opt("headRadius") ?: 0) as? Number)?.toDouble()?.takeIf { it.isFinite() && it in 0.0..500.0 }
    if (head != null && height != null && radius != null) out.put("head", head).put("headHeight", height).put("headRadius", radius)
    return out
}

// Answering questions and pairing are for the shell alone, never the page's
// own calls with the token. The page is the agent's design, so any spelling
// the server could read as one of those routes is turned down too.
internal fun closedToPage(path: String): Boolean {
    if (path.any { it == '\\' || it == '#' } || path.count { it == '?' } > 1) return true
    var p = path.substringBefore('?')
    // Escapes can be stacked, %2561 for a, so they're undone until none are left.
    var rounds = 0
    while ('%' in p) {
        if (++rounds > 4) return true
        p = unescape(p) ?: return true
    }
    if (p.any { it < ' ' || it == '\\' || it == '?' || it == '#' }) return true
    val parts = ArrayList<String>()
    for (seg in p.split('/')) when (seg) {
        "", "." -> {}
        ".." -> parts.removeLastOrNull()
        else -> parts.add(seg.lowercase())
    }
    val route = "/" + parts.joinToString("/")
    return route == "/answer" || route == "/asks" || route.startsWith("/asks/") ||
        route == "/pair" || route.startsWith("/pair/") || route == "/pair-phone" ||
        route == "/push" || route.startsWith("/push/")
}

// Percent escapes as UTF-8, or null for a stray % that isn't one.
private fun unescape(s: String): String? {
    val out = java.io.ByteArrayOutputStream()
    var i = 0
    while (i < s.length) {
        if (s[i] != '%') {
            out.write(s[i].toString().toByteArray())
            i++
            continue
        }
        if (i + 2 >= s.length) return null
        val hi = Character.digit(s[i + 1], 16)
        val lo = Character.digit(s[i + 2], 16)
        if (hi < 0 || lo < 0) return null
        out.write(hi * 16 + lo)
        i += 3
    }
    return String(out.toByteArray(), Charsets.UTF_8)
}

// The same as keyCheck in server.ts, for him to compare with the pairing page.
internal fun keyCheck(key: String) = MessageDigest.getInstance("SHA-256").digest(key.toByteArray())
    .take(4).joinToString("") { "%02X".format(it) }.let { "${it.take(4)} ${it.drop(4)}" }
