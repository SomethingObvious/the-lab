package com.somethingobvious.thelab

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.OpenableColumns
import android.util.Log
import android.widget.Toast
import androidx.core.content.edit
import androidx.core.graphics.scale
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.URLEncoder
import java.net.UnknownHostException
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

private const val TAG = "Lab"
private const val KEEP = 2000
private const val PAIR_AGAIN = "Ask the agent on the computer to show the pairing code, then point this phone's camera at it."
private val JSON_TYPE = "application/json".toMediaType()
private val main = Handler(Looper.getMainLooper())
private val io = Executors.newSingleThreadExecutor()
// Its own thread, so writing an event never waits behind a design download.
private val disk = Executors.newSingleThreadExecutor()
private val client = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .build()
// The server pings every 25 s, so this much silence means the link is dead,
// and the sooner that's noticed the sooner it moves to another route.
private val streaming = client.newBuilder().readTimeout(40, TimeUnit.SECONDS).build()
// A notification button's receiver has about 10 s to finish.
private val quick = client.newBuilder().callTimeout(8, TimeUnit.SECONDS).build()
// The server answers /stop only once the turn has ended, which can take 15 s.
private val stopping = client.newBuilder().callTimeout(25, TimeUnit.SECONDS).build()
// Listing the agent's models can take the server 20 s, on top of a relay dial.
private val slow = client.newBuilder().callTimeout(40, TimeUnit.SECONDS).build()

// What the whole phone shares: which computers it's paired with, which one is
// on screen and whoever is listening to that one. All state is touched on the
// main thread only.
object Hub {
    private const val MAIN = "main"

    lateinit var app: Application
        private set
    private lateinit var prefs: SharedPreferences
    val computers = LinkedHashMap<String, Computer>()
    lateinit var on: Computer
        private set
    val paired get() = computers.values.any { it.paired }
    val pairedComputers get() = computers.values.filter { it.paired }
    var foreground = false
    // Text or files shared in, held until the design is up and ready to take them.
    val composing = ArrayList<JSONObject>()
    // A pairing broadcast for a computer it doesn't know, held in memory until he says yes on the phone.
    class Pairing(val url: String?, val tunnel: Tunnel.Spec?, val token: String)
    var pendingPair: Pairing? = null

    private val listeners = LinkedHashSet<(JSONObject) -> Unit>()
    val designListeners = LinkedHashSet<() -> Unit>()
    // The history was thrown away and fetched again, so the page has to start over.
    val resetListeners = LinkedHashSet<() -> Unit>()
    // A different computer is on screen now, so the page has to start over with its design.
    val switchListeners = LinkedHashSet<() -> Unit>()
    private var network: Network? = null
    // Whether the default network has a VPN and is validated, the two changes worth redialing for.
    private var shape: Pair<Boolean, Boolean>? = null
    val hasNetwork get() = app.getSystemService(ConnectivityManager::class.java).activeNetwork != null

    fun init(context: Context) {
        if (::app.isInitialized) return
        app = context.applicationContext as Application
        prefs = app.getSharedPreferences("lab", Context.MODE_PRIVATE)
        computers[MAIN] = Computer(0)
        val more = runCatching { JSONArray(prefs.getString("computers", "[]")) }.getOrDefault(JSONArray())
        for (i in 0 until more.length()) more.optInt(i).takeIf { it > 0 }?.let { slot -> Computer(slot).let { computers[it.id] = it } }
        on = computers[prefs.getString("active", MAIN)]?.takeIf { it.paired } ?: pairedComputers.firstOrNull() ?: computers.getValue(MAIN)
        app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post {
                    // A new network can bring a direct route, or take the old one
                    // away, so the link starts over on it straight away.
                    val changed = Hub.network != null && Hub.network != network
                    Hub.network = network
                    for (c in computers.values) c.networkChanged(changed)
                }
            }
            override fun onLost(network: Network) {
                main.post {
                    if (hasNetwork) return@post
                    for (c in computers.values) c.networkGone()
                }
            }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                // Tailscale coming up shows as a change to the default network.
                // Signal strength changes come through here too and aren't worth a redial.
                val now = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) to caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                main.post {
                    if (now == shape) return@post
                    shape = now
                    for (c in computers.values) c.networkChanged(false)
                }
            }
        })
    }

    fun listen(l: (JSONObject) -> Unit): () -> Unit {
        listeners.add(l)
        return { listeners.remove(l) }
    }

    fun emit(e: JSONObject) {
        for (l in listeners.toList()) l(e)
    }

    // Called by the service. Safe to call again.
    fun start() { for (c in computers.values) c.start() }

    fun reconnectNow() { for (c in computers.values) c.reconnectNow() }

    // After a freeze, when no session can be trusted.
    fun redial() { for (c in computers.values) { c.tunnel.drop(); c.reconnectNow() } }

    fun computer(id: String?) = id?.let { computers[it] } ?: on

    // The one most worth a look on the status card: a question, then work under way.
    fun focus(): Computer {
        val up = pairedComputers
        return up.firstOrNull { it.waiting } ?: on.takeIf { it.working } ?: up.firstOrNull { it.working } ?: on
    }

    fun computersEvent(): JSONObject {
        val items = JSONArray()
        for (c in pairedComputers) items.put(JSONObject().put("id", c.id).put("name", c.name).put("state", c.link.optString("state")).put("working", c.working).put("waiting", c.waiting))
        return JSONObject().put("kind", "computers").put("active", on.id).put("items", items)
    }

    // Something the list or the status card shows has changed.
    fun changed() {
        emit(computersEvent())
        LinkService.refresh()
    }

    fun switchTo(id: String) {
        val c = computers[id]?.takeIf { it.paired } ?: return
        if (c === on) return
        on = c
        prefs.edit { putString("active", id) }
        composing.clear()
        Notifier.clearReplies(app, c)
        for (l in switchListeners.toList()) l()
    }

    // The computer this pairing is for, if the phone knows it already.
    fun known(url: String?, tunnel: Tunnel.Spec?) = computers.values.firstOrNull { it.pairedWith(url, tunnel) }

    // A computer it knows gets its new details, and any other is added beside
    // the ones it has, or takes the first place if that's free.
    fun pair(url: String?, tunnel: Tunnel.Spec?, token: String) {
        val free = computers.getValue(MAIN).takeUnless { it.paired }
        val c = known(url, tunnel) ?: free ?: run {
            val slot = (computers.values.maxOf { it.slot }) + 1
            val made = Computer(slot)
            computers[made.id] = made
            saveList()
            made
        }
        pendingPair = null
        c.onLoaded {
            c.pair(url, tunnel, token)
            c.start()
            if (c === on) { for (l in switchListeners.toList()) l() } else switchTo(c.id)
            changed()
        }
    }

    fun forget(c: Computer) {
        c.wipe()
        if (c.slot != 0) {
            computers.remove(c.id)
            saveList()
        }
        if (c === on || !on.paired) {
            on = pairedComputers.firstOrNull() ?: computers.getValue(MAIN)
            prefs.edit { putString("active", on.id) }
            composing.clear()
            for (l in switchListeners.toList()) l()
        }
        changed()
    }

    private fun saveList() {
        val a = JSONArray()
        for (c in computers.values) if (c.slot != 0) a.put(c.slot)
        prefs.edit { putString("computers", a.toString()) }
    }

    // A QR code scanned on the computer hands over a one-time code, which the computer
    // swaps for the token here so the token never sits in a browser history.
    fun claim(base: String?, tunnel: Tunnel.Spec?, code: String, done: (String?) -> Unit) {
        // Only the claim goes to the new computer. Everything else stays with
        // the ones it's paired with until the token comes back.
        val to = if (tunnel != null) Tunnel().once(tunnel) else base ?: return done("That pairing link is missing its address.")
        // One request only, so the one-off session closes as soon as it's answered.
        val req = Request.Builder().url("${to.trimEnd('/')}/pair/claim").header("Connection", "close")
            .post(JSONObject().put("code", code).toString().toRequestBody(JSON_TYPE)).build()
        quick.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                main.post {
                    done(if (tunnel != null) "Couldn't reach the computer. Check it's awake and online, then scan the code again." else "Couldn't reach the computer. Check Tailscale is on, then scan the code again.")
                }
            }
            override fun onResponse(call: Call, response: Response) {
                val code2 = response.code
                val text = response.use { it.body.string() }
                main.post {
                    val token = runCatching { JSONObject(text).getString("token") }.getOrNull()
                    if (code2 == 200 && token != null) { pair(if (tunnel != null) null else base, tunnel, token); done(null) }
                    else done(runCatching { JSONObject(text).getString("error") }.getOrDefault("The computer turned the code down. Scan a new one."))
                }
            }
        })
    }

    fun later(r: Runnable) = io.execute(r)
    // A tap on a file shouldn't wait behind an upload or a design sync.
    private val opens = Executors.newSingleThreadExecutor()
    fun soon(r: Runnable) = opens.execute(r)
    fun onMain(delay: Long = 0, r: Runnable) = main.postDelayed(r, delay)
}

// One paired computer: its stream, cached history, outbox and downloaded
// design. The first one keeps the places a phone from before there could be
// several already has them. Each runs at once, whichever is on screen.
class Computer(val slot: Int) {
    val id = if (slot == 0) "main" else "c$slot"
    private val app get() = Hub.app
    private val prefs: SharedPreferences = Hub.app.getSharedPreferences(if (slot == 0) "lab" else "lab-$id", Context.MODE_PRIVATE)
    private val dir = if (slot == 0) Hub.app.filesDir else File(Hub.app.filesDir, "computers/$id").apply { mkdirs() }
    private val filesCache = if (slot == 0) File(Hub.app.cacheDir, "files") else File(Hub.app.cacheDir, "files/$id")
    private val thumbsCache = if (slot == 0) File(Hub.app.cacheDir, "thumbs") else File(Hub.app.cacheDir, "thumbs/$id")
    val tunnel = Tunnel()
    // Each gets its own address on the phone, so one computer's page can't read what another's saved.
    val host = if (slot == 0) MainActivity.HOST else "$id.${MainActivity.HOST}"
    val origin get() = "https://$host"
    val name get() = mac?.optString("name")?.ifBlank { null } ?: if (slot == 0) "Your computer" else "Computer ${slot + 1}"
    val working get() = link.optString("state") == "online" && status.optBoolean("working")
    val waiting get() = working && status.optString("label") == "Waiting for you"
    // The last few messages each way, so a reply notification reads as a conversation.
    // Each says who it's from: "me", "mac" or "lab".
    val recent = ArrayDeque<Triple<CharSequence, Long, String>>()

    val events = ArrayList<JSONObject>()
    private val outbox = JSONArray()
    var link: JSONObject = JSONObject().put("kind", "link").put("state", "connecting")
        private set
    var status: JSONObject = JSONObject().put("kind", "status").put("working", false).put("label", "")
        private set
    // The newest event of every kind the server sends without an id, kept
    // across restarts so the page can show them while the computer is away. Any
    // kind works, so a new one needs no change here.
    val live = LinkedHashMap<String, JSONObject>()
    val mac: JSONObject? get() = live["mac"]
    // The last run's end, so the status line can say Done for a while after.
    var lastDone: JSONObject? = null
        private set
    // The computer's clock less this phone's, from the stream's Date header,
    // so an event's time can be read on this phone's clock.
    private var skew = 0L
    private var warnedFull = 0L

    private var source: EventSource? = null
    private var failures = 0
    private var designFailures = 0
    private var retry: Runnable? = null
    // Tries for a straight route while on the relay, less and less often.
    private val tryDirect = Runnable { moveToDirect() }
    private var directWait = FIRST_DIRECT_TRY
    private var suspected = 0L
    private var flushing = false
    private var syncing = false
    private var started = false
    private var loaded = false
    private var connectWhenLoaded = false
    private val whenLoaded = ArrayList<() -> Unit>()

    // Through the tunnel once it's paired that way, or Tailscale's address
    // for a phone paired before the tunnel existed.
    // Null for a moment if the phone can't open the tunnel's port, which callers treat as unreachable.
    val url: String? get() = if (tunnel.spec != null) runCatching { tunnel.base() }.getOrNull() else prefs.getString("url", null)
    private val token get() = prefs.getString("token", null)
    val paired get() = (tunnel.spec != null || prefs.getString("url", null) != null) && token != null
    // Taken from events.jsonl on load, so the cursor never runs ahead of what's on disk.
    private var lastId = 0L
    var designVersion
        get() = prefs.getString("design", null)
        private set(v) = prefs.edit { putString("design", v) }
    // The newest design that got as far as lab.ready(), the only kind a slow start can't be blamed on.
    val designOpened get() = prefs.getString("designOpened", null)
    fun openedFine() { designVersion?.let { v -> if (v != designOpened) prefs.edit { putString("designOpened", v) } } }

    val designDir get() = File(dir, "design/current")
    private val eventsFile get() = File(dir, "events.jsonl")
    private val outboxFile get() = File(dir, "outbox.json")

    init {
        loadEvents()
        // The old "mac" and "shortcuts" keys go first, so a newer live: copy of
        // the same kind always wins whatever order prefs hands them back in.
        val saved = prefs.all.entries.filter { it.key.startsWith("live:") || it.key == "mac" || it.key == "shortcuts" }.sortedBy { it.key.startsWith("live:") }
        for ((_, v) in saved) runCatching { JSONObject(v as String) }.getOrNull()?.let { live[it.optString("kind")] = it }
        prefs.getString("tunnel", null)?.let { t -> tunnel.spec = runCatching { Tunnel.Spec.parse(JSONObject(t)) }.getOrNull() }
        live["reach"]?.let { reached(it) }
        if (outboxFile.exists()) runCatching { JSONArray(outboxFile.readText()) }.getOrNull()?.let { a -> for (i in 0 until a.length()) outbox.put(a.get(i)) }
        if (!paired) link = JSONObject().put("kind", "link").put("state", "unpaired").put("detail", "This phone isn't paired with a computer yet. $PAIR_AGAIN")
    }

    // The old route may still work for a moment, so what's under way gets to
    // finish while the stream moves to whichever route answers on this network.
    fun networkChanged(moved: Boolean) {
        if (!paired) return
        directWait = FIRST_DIRECT_TRY
        if (moved) tunnel.retire()
        if (moved || link.optString("state") != "online") reconnectNow()
    }

    // Nothing gets through until a network is back, and onAvailable redials then.
    fun networkGone() {
        if (!paired) return
        retry?.let { main.removeCallbacks(it) }
        retry = null
        main.removeCallbacks(tryDirect)
        source?.cancel()
        source = null
        tunnel.drop()
        tunnel.stopWaiting()
        setLink("offline", "This phone is offline. It reconnects by itself when it's back online.")
    }

    // The stream comes back over the new route and picks up where it left off.
    private fun moveToDirect() {
        if (link.optString("state") != "online" || tunnel.route != "relay" || !tunnel.direct()) return
        thread(name = "tunnel-upgrade", isDaemon = true) {
            val moved = tunnel.upgrade()
            main.post {
                if (moved) connect()
                else {
                    directWait = minOf(directWait * 2, LAST_DIRECT_TRY)
                    main.postDelayed(tryDirect, directWait)
                }
            }
        }
    }

    // Everything of this computer's goes, on the phone only.
    fun wipe() {
        retry?.let { main.removeCallbacks(it) }
        retry = null
        main.removeCallbacks(tryDirect)
        source?.cancel()
        source = null
        started = false
        tunnel.stopWaiting()
        tunnel.spec = null
        Notifier.clearAll(app, this)
        forgetHistory()
        designVersion = null
        live.clear()
        for (i in outbox.length() - 1 downTo 0) outbox.remove(i)
        saveOutbox()
        status = JSONObject().put("kind", "status").put("working", false).put("label", "")
        lastDone = null
        prefs.edit { remove("url"); remove("tunnel"); remove("token"); remove("designOpened"); for (k in prefs.all.keys) if (k.startsWith("live:") || k == "mac" || k == "shortcuts") remove(k) }
        File(dir, "design").deleteRecursively()
        filesCache.deleteRecursively()
        thumbsCache.deleteRecursively()
        if (slot != 0) {
            dir.deleteRecursively()
            app.deleteSharedPreferences("lab-$id")
        }
        link = JSONObject().put("kind", "link").put("state", "unpaired").put("detail", "This phone isn't paired with a computer yet. $PAIR_AGAIN")
    }

    // Reading and parsing 2,000 events takes long enough to drop frames, so
    // it happens off the main thread and anything that needs them waits.
    private fun loadEvents() {
        io.execute {
            var read = emptyList<JSONObject>()
            try {
                if (eventsFile.exists()) {
                    val lines = eventsFile.readLines()
                    read = readHistory(lines.takeLast(KEEP))
                    if (lines.size > KEEP * 2) {
                        // Through a copy, so a full disk can't leave the history cut short.
                        val tmp = File(eventsFile.path + ".tmp")
                        tmp.writeText(read.joinToString("\n", postfix = "\n") { it.toString() })
                        tmp.renameTo(eventsFile)
                    }
                }
            } catch (e: IOException) {
                Log.w(TAG, "couldn't read or trim the history", e)
            }
            main.post {
                events.addAll(0, read)
                lastId = newestId(read)
                loaded = true
                for (r in whenLoaded.toList()) r()
                whenLoaded.clear()
                if (connectWhenLoaded) connect()
            }
        }
    }

    fun onLoaded(r: () -> Unit) {
        if (loaded) r() else whenLoaded.add(r)
    }

    // Only the one on screen has a page listening.
    private fun emit(e: JSONObject) {
        if (Hub.on === this) Hub.emit(e)
    }

    fun outboxEvent(): JSONObject = JSONObject().put("kind", "outbox").put("items", JSONArray(outbox.toString()))

    // Called by the service. Safe to call again.
    fun start() {
        if (started) return
        started = true
        if (paired) connect()
    }

    // The same computer as this one: its room, key and secret for the tunnel, or its address for Tailscale.
    fun pairedWith(newUrl: String?, spec: Tunnel.Spec?): Boolean {
        if (!paired) return false
        val now = tunnel.spec
        return if (spec != null) now != null && now.room == spec.room && now.key.contentEquals(spec.key) && now.pass.contentEquals(spec.pass)
        else now == null && newUrl != null && newUrl.trimEnd('/') == prefs.getString("url", null)
    }

    fun pair(newUrl: String?, spec: Tunnel.Spec?, newToken: String) {
        prefs.edit {
            if (newUrl != null) putString("url", newUrl.trimEnd('/')) else remove("url")
            if (spec != null) putString("tunnel", spec.json().toString()) else remove("tunnel")
            putString("token", newToken)
        }
        tunnel.spec = spec
        // An older reach could otherwise swap the new pairing's relay back for the old one.
        live.remove("reach")
        prefs.edit { remove("live:reach") }
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "paired with ${spec?.relay ?: spec?.lan?.firstOrNull() ?: newUrl}")
        reconnectNow()
    }

    private fun forgetHistory() {
        events.clear()
        onDisk { eventsFile.delete() }
        lastId = 0
    }

    // A full disk mustn't take the app down. Whatever couldn't be written is
    // still held in memory, the outbox included.
    private fun onDisk(r: () -> Unit) = disk.execute {
        try { r() } catch (e: IOException) {
            Log.w(TAG, "couldn't write to storage", e)
            main.post { storageFull() }
        }
    }

    private fun storageFull() {
        val now = SystemClock.elapsedRealtime()
        if (warnedFull != 0L && now - warnedFull < 60_000) return
        warnedFull = now
        Toast.makeText(app, "This phone's storage is full, so The Lab couldn't save. Unsent messages are kept while the app stays open. Free up some space to keep them safe.", Toast.LENGTH_LONG).show()
    }

    // An event's time on this phone's clock, or null if it has none.
    fun phoneTime(at: String): Long? = runCatching { Instant.parse(at).toEpochMilli() - skew }.getOrNull()

    private fun setLink(state: String, detail: String = "", fix: String? = null) {
        val next = JSONObject().put("kind", "link").put("state", state).put("detail", detail)
        if (fix != null) next.put("fix", fix)
        if (next.toString() == link.toString()) return
        link = next
        emit(link)
        Hub.changed()
    }

    private fun connect() {
        if (!loaded) { connectWhenLoaded = true; return }
        source?.cancel()
        val base = url ?: return onLost(null, null)
        val req = Request.Builder().url("$base/events")
            .header("Authorization", "Bearer $token")
            .apply { if (lastId > 0) header("Last-Event-ID", lastId.toString()) }
            .build()
        if (link.optString("state") != "online") setLink("connecting", "Reaching the computer")
        source = EventSources.createFactory(streaming).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                val theirs = response.headers.getDate("Date")?.time ?: return
                val ours = System.currentTimeMillis()
                main.post { if (source === eventSource) skew = theirs - ours }
            }
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                main.post { if (source === eventSource) onEvent(type, data) }
            }
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                val code = response?.code
                response?.close()
                main.post { if (source === eventSource) onLost(t, code) }
            }
            override fun onClosed(eventSource: EventSource) {
                main.post { if (source === eventSource) onLost(null, null) }
            }
        })
    }

    fun reconnectNow() {
        retry?.let { main.removeCallbacks(it) }
        retry = null
        failures = 0
        // A session that went quiet while the app was frozen would only fail after the read timeout.
        if (link.optString("state") != "online" && tunnel.spec != null) tunnel.drop()
        if (paired) connect()
    }

    private fun onEvent(type: String?, data: String) {
        val e = runCatching { JSONObject(data) }.getOrElse { return }
        if (type == "loaded") return Notifier.onLoaded(this)
        if (type == "hello") {
            // The computer's numbering went back, so every new event would
            // look already seen. Its own copy of the history takes over.
            if (e.has("last") && e.optLong("last") < lastId) {
                forgetHistory()
                if (Hub.on === this) for (l in Hub.resetListeners.toList()) l()
                connect()
                return
            }
            failures = 0
            tunnel.stopWaiting()
            setLink("online", "Connected to the computer")
            main.removeCallbacks(tryDirect)
            if (tunnel.route == "relay") main.postDelayed(tryDirect, directWait)
            e.optJSONObject("status")?.let { setStatus(it) }
            e.optJSONObject("mac")?.let { setLive(it) }
            e.optJSONArray("shortcuts")?.let { setLive(JSONObject().put("kind", "shortcuts").put("items", it)) }
            e.optJSONArray("live")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { setLive(it) } }
            if (e.optString("design") != designVersion) syncDesign()
            flush()
            return
        }
        when (e.optString("kind")) {
            "status" -> setStatus(e)
            "design" -> if (e.optString("version") != designVersion) syncDesign()
            else -> if (e.has("id")) store(e) else if (e.optString("kind").isNotBlank()) setLive(e)
        }
    }

    private fun reached(e: JSONObject) {
        e.optJSONArray("lan")?.let { a ->
            // The address he paired on goes last, as it worked once even if the computer can't see it.
            tunnel.lan = ((0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } + tunnel.spec?.lan.orEmpty()).distinct()
            // The computer can have just come onto this Wi-Fi.
            if (tunnel.route == "relay") { directWait = FIRST_DIRECT_TRY; main.removeCallbacks(tryDirect); main.postDelayed(tryDirect, directWait) }
        }
        // A relay set up after pairing, so the phone can reach the computer away from home without pairing again.
        val relay = e.optString("relay").takeIf { it.isNotBlank() && it != "null" } ?: return
        val sp = tunnel.spec ?: return
        if (relay == sp.relay) return
        val next = Tunnel.Spec.parse(sp.json().put("relay", relay)) ?: return
        val lan = tunnel.lan
        tunnel.spec = next
        tunnel.lan = lan
        prefs.edit { putString("tunnel", next.json().toString()) }
    }

    private fun setLive(e: JSONObject) {
        val kind = e.optString("kind")
        if (kind == "reach") reached(e)
        live[kind] = e
        prefs.edit { putString("live:$kind", e.toString()) }
        emit(e)
        if (kind == "mac") Hub.emit(Hub.computersEvent())
    }

    private fun setStatus(s: JSONObject) {
        status = JSONObject(s.toString()).put("kind", "status")
        emit(status)
        Hub.changed()
    }

    private fun store(e: JSONObject) {
        val id = e.getLong("id")
        if (id <= lastId) return
        lastId = id
        events.add(e)
        if (e.optString("kind") == "done") { lastDone = e; LinkService.refresh() }
        if (events.size > KEEP * 1.2) events.subList(0, events.size - KEEP).clear()
        val line = e.toString() + "\n"
        onDisk { eventsFile.appendText(line) }
        emit(e)
        Notifier.onEvent(this, e)
    }

    private fun onLost(t: Throwable?, code: Int?) {
        source = null
        main.removeCallbacks(tryDirect)
        val wasUp = link.optString("state") == "online"
        if (code == null && tunnel.spec != null) tunnel.drop()
        val cm = app.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        when {
            code == 401 -> setLink("unpaired", "The computer doesn't recognise this phone any more. $PAIR_AGAIN")
            caps == null -> setLink("offline", "This phone is offline. It reconnects by itself when it's back online.")
            // It usually finds another route in a moment, which isn't worth alarming him over.
            wasUp && code == null -> setLink("connecting", "Reconnecting")
            tunnel.spec != null -> setLink("offline", when (tunnel.why) {
                "away" -> "The computer isn't connected right now. It may be asleep, switched off or offline."
                "relay" -> "Can't reach the computer from here right now. It still works when this phone is on the same Wi-Fi as the computer."
                "key" -> "The Lab couldn't confirm it was talking to your computer, so it didn't connect. If this keeps happening, pair the phone again with a new code."
                "none" -> "Can't find the computer on this network. For now it only works when this phone is on the same Wi-Fi as the computer."
                else -> "Can't reach the computer. It may be asleep, switched off or offline."
            })
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> setLink("offline", "Tailscale is off on this phone, so it can't reach the computer.", "tailscale")
            code != null && code in 502..504 -> setLink("offline", "The computer is on, but The Lab's server isn't answering. It restarts itself, so give it a minute.")
            t is UnknownHostException -> setLink("offline", "This phone can't find the computer on Tailscale. Check Tailscale is connected.", "tailscale")
            else -> setLink("offline", "Can't reach the computer. It may be asleep, switched off or offline.")
        }
        if (code == 401) return
        failures++
        // With no network, or no relay and the phone off the Wi-Fi, nothing can
        // get through until the network changes, and the callback redials then.
        if (caps == null || (tunnel.spec != null && tunnel.spec?.relay == null && !tunnel.direct())) return
        if (tunnel.why == "away") tunnel.await { main.post { comeBack() } }
        val wait = backoff(failures, tunnel.isWaiting)
        retry = Runnable { retry = null; connect() }.also { main.postDelayed(it, wait) }
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "link lost (${code ?: t?.javaClass?.simpleName}), retry in ${wait}ms")
    }

    // The relay said the computer just connected, so there's no waiting out the retry.
    private fun comeBack() {
        if (!paired || link.optString("state") == "online") return
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "the computer is back on the relay")
        retry?.let { main.removeCallbacks(it) }
        retry = null
        connect()
    }

    // A request that couldn't get through says the link is probably dead, and
    // the stream alone can take a minute to notice.
    private fun suspect() {
        val now = SystemClock.elapsedRealtime()
        if (link.optString("state") != "online" || now - suspected < 10_000) return
        suspected = now
        tunnel.drop()
        reconnectNow()
    }

    // His words go to disk before anything else happens to them.
    fun send(text: String, cid: String, files: JSONArray?) {
        val m = JSONObject().put("cid", cid).put("text", text).put("at", Instant.now().toString())
        if (files != null && files.length() > 0) m.put("files", files)
        outbox.put(m)
        saveOutbox()
        emit(outboxEvent())
        flush()
    }

    private fun saveOutbox() {
        val text = outbox.toString()
        onDisk {
            val tmp = File(outboxFile.path + ".tmp")
            tmp.writeText(text)
            tmp.renameTo(outboxFile)
        }
    }

    private fun flush() {
        if (flushing || outbox.length() == 0 || link.optString("state") != "online") return
        flushing = true
        val m = outbox.getJSONObject(0)
        val body = JSONObject().put("text", m.getString("text")).put("cid", m.getString("cid"))
        m.optJSONArray("files")?.let { body.put("files", it) }
        post("/send", body) { code ->
            flushing = false
            // The server drops a repeat cid, so a retry after a lost response is safe.
            val outcome = sendOutcome(code)
            if (outcome == SendOutcome.RETRY) {
                main.postDelayed({ flush() }, 3000)
                return@post
            }
            val head = outbox.length() > 0 && outbox.getJSONObject(0).optString("cid") == m.optString("cid")
            if (head) outbox.remove(0)
            saveOutbox()
            emit(outboxEvent())
            if (head && outcome == SendOutcome.REFUSED) refused(m)
            if (outbox.length() == 0) Notifier.sent(app, this)
            flush()
        }
    }

    // The words go back to him, in the message box if the page is open and in a notification if not.
    private fun refused(m: JSONObject) {
        emit(sendFailed(m.optString("cid"), m.optString("text"), "The computer couldn't take that message. It's back in the message box so you can try again."))
        if (!Hub.foreground || Hub.on !== this) Notifier.unsent(this, m.optString("text"))
    }

    fun sendFailed(cid: String, text: String, error: String): JSONObject =
        JSONObject().put("kind", "sendFailed").put("cid", cid).put("text", text).put("error", error)

    fun queued(cid: String) = (0 until outbox.length()).any { outbox.getJSONObject(it).optString("cid") == cid }

    // done gets false only when the computer never heard it. A slow stop says
    // nothing about the link, so it never drops the tunnel.
    fun stop(done: (Boolean) -> Unit = {}) = post("/stop", JSONObject(), stopping, suspicious = false) { done(it in 200..299) }
    // done gets the status, and a 404 means it was already answered or has expired.
    fun answer(ref: String, allow: Boolean, always: Boolean = false, done: (Int) -> Unit = {}) =
        post("/answer", JSONObject().put("ref", ref).put("allow", allow).put("always", always), quick, done = done)

    // Any JSON route on the computer, for the page's memory, schedules and setup
    // sheets. done gets the body, or null and an error in plain words.
    fun request(method: String, path: String, body: String?, done: (String?, String?) -> Unit) {
        if (url == null) return done(null, "This phone isn't paired with a computer yet.")
        if (!path.startsWith("/") || path.contains("..")) return done(null, "That isn't a route on the computer.")
        fetch(method, path, body, if (path == "/models" || path == "/check") slow else quick) { code, text ->
            when {
                code == 0 -> done(null, "Couldn't reach the computer. Try again once it's back.")
                code in 200..299 -> done(text, null)
                else -> done(null, runCatching { JSONObject(text ?: "").getString("error") }.getOrDefault("The computer couldn't do that just now. Try again in a minute."))
            }
        }
    }

    // The question behind an Allow card, for <lab-ask>. done gets the status, 0 when the computer couldn't be reached, and the body.
    fun askInfo(ref: String, done: (Int, String?) -> Unit) = fetch("GET", "/asks/${Uri.encode(ref)}", null, quick, done)

    // done gets the status, or 0 and null when the computer couldn't be reached.
    private fun fetch(method: String, path: String, body: String?, via: OkHttpClient, done: (Int, String?) -> Unit) {
        val base = url ?: return done(0, null)
        val req = Request.Builder().url(base + path).header("Authorization", "Bearer $token")
            .method(method, if (method == "GET") null else (body ?: "{}").toRequestBody(JSON_TYPE)).build()
        via.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { main.post { suspect(); done(0, null) } }
            override fun onResponse(call: Call, response: Response) {
                val code = response.code
                val text = try { response.use { it.body.string() } } catch (e: IOException) { null }
                main.post { if (text == null) done(0, null) else done(code, text) }
            }
        })
    }

    fun undoDesign(done: (Boolean) -> Unit) = post("/design/undo", JSONObject()) { done(it == 200) }
    // Only for the version that's on the phone, so a report can't undo a newer one.
    fun reportBroken(message: String) {
        val v = designVersion ?: return
        post("/app-error", JSONObject().put("message", message).put("where", "opening the app").put("version", v).put("fatal", true)) {}
    }
    fun reportError(message: String, where: String) {
        val v = designVersion ?: return
        post("/app-error", JSONObject().put("message", message).put("where", where).put("version", v)) {}
    }
    fun saveShortcuts(items: JSONArray, done: (Boolean) -> Unit) = post("/shortcuts", JSONObject().put("items", items)) { done(it == 200) }

    // Blocking. Copies the pick into the file cache first, so the page can
    // show it straight away without fetching it back from the computer.
    fun upload(uri: Uri): JSONObject {
        val cr = app.contentResolver
        var name = "file"
        var size = -1L
        try {
            cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) { name = c.getString(0) ?: name; if (!c.isNull(1)) size = c.getLong(1) }
            }
        } catch (_: SecurityException) {}
        if (size > 100L * 1024 * 1024) throw IOException("$name is over the 100 MB limit.")
        val base = url ?: throw IOException("This phone isn't paired with a computer yet.")
        val type = cr.getType(uri) ?: "application/octet-stream"
        val cache = filesCache.apply { mkdirs() }
        val tmp = File.createTempFile("upload", ".part", cache)
        try {
            // A share from an app that didn't grant read access throws SecurityException.
            val input = try { cr.openInputStream(uri) } catch (e: SecurityException) { null } ?: throw IOException("Couldn't read ${if (name == "file") "that file" else name}. The app it came from didn't let The Lab open it.")
            input.use { i -> tmp.outputStream().use { i.copyTo(it) } }
            val req = Request.Builder().url("$base/upload?name=${URLEncoder.encode(name, "UTF-8")}")
                .header("Authorization", "Bearer $token")
                .post(tmp.asRequestBody(type.toMediaTypeOrNull())).build()
            // A second go after a drop, on whatever link the first failure brought up.
            val (code, text) = try {
                client.newCall(req).execute().use { it.code to it.body.string() }
            } catch (e: IOException) {
                main.post { suspect() }
                Thread.sleep(3000)
                try {
                    client.newCall(req).execute().use { it.code to it.body.string() }
                } catch (e2: IOException) {
                    throw IOException("Couldn't reach the computer, so $name wasn't attached.", e2)
                }
            }
            if (code != 200) throw IOException(runCatching { JSONObject(text).getString("error") }.getOrDefault("The computer didn't take $name. Try again in a minute."))
            val j = JSONObject(text)
            plainName(Uri.decode(j.getString("url").removePrefix("/files/")))?.let { tmp.renameTo(File(cache, it)) }
            return j
        } finally {
            tmp.delete()
        }
    }

    private fun post(path: String, body: JSONObject, via: OkHttpClient = client, suspicious: Boolean = true, done: (Int) -> Unit) {
        val base = url ?: return done(-1)
        val req = Request.Builder().url(base + path).header("Authorization", "Bearer $token")
            .post(body.toString().toRequestBody(JSON_TYPE)).build()
        via.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { main.post { if (suspicious) suspect(); done(-1) } }
            override fun onResponse(call: Call, response: Response) {
                val code = response.code
                response.close()
                main.post { done(code) }
            }
        })
    }

    // Pulls the whole app folder and swaps it in, so the page never sees a
    // half-written design.
    private fun syncDesign() {
        if (syncing) return
        val base = url ?: return
        syncing = true
        val auth = "Bearer $token"
        io.execute {
            val version = runCatching {
                val req = Request.Builder().url("$base/design").header("Authorization", auth).build()
                val body = client.newCall(req).execute().use { r ->
                    if (!r.isSuccessful) throw IOException("design: HTTP ${r.code}")
                    JSONObject(r.body.string())
                }
                val root = File(dir, "design")
                val next = File(root, "next").apply { deleteRecursively(); mkdirs() }
                val files = body.getJSONObject("files")
                for (name in files.keys()) {
                    val out = File(next, name).canonicalFile
                    if (!out.path.startsWith(next.canonicalPath + File.separator)) throw IOException("design: bad path $name")
                    out.parentFile?.mkdirs()
                    out.writeBytes(android.util.Base64.decode(files.getString(name), android.util.Base64.DEFAULT))
                }
                val current = File(root, "current")
                val old = File(root, "old").apply { deleteRecursively() }
                if (current.exists() && !current.renameTo(old)) throw IOException("design: could not move the old design aside")
                if (!next.renameTo(current)) throw IOException("design: could not swap in the new design")
                old.deleteRecursively()
                body.getString("version")
            }.onFailure { Log.w(TAG, "design sync failed", it) }.getOrNull()
            main.post {
                syncing = false
                if (version != null) {
                    designFailures = 0
                    designVersion = version
                    if (Hub.on === this) for (l in Hub.designListeners.toList()) l()
                } else if (link.optString("state") == "online") {
                    // Otherwise a failed download waits for the next reconnect, with the safe screen up meanwhile.
                    val wait = minOf(30_000L shl minOf(designFailures++, 5), 600_000L)
                    main.postDelayed({ if (link.optString("state") == "online") syncDesign() }, wait)
                }
            }
        }
    }

    // Blocking, for the WebView's request thread and for opening files.
    fun fetchFile(name: String): File? {
        val clean = plainName(name) ?: return null
        val cache = filesCache.apply { mkdirs() }
        val out = File(cache, clean)
        if (out.isFile) return out
        val base = url ?: return null
        return runCatching {
            val req = Request.Builder().url("$base/files/${Uri.encode(clean)}").header("Authorization", "Bearer $token").build()
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return null
                val tmp = File.createTempFile("fetch", ".part", cache)
                tmp.outputStream().use { r.body.byteStream().copyTo(it) }
                tmp.renameTo(out)
            }
            out
        }.getOrNull()
    }

    // Blocking. A copy of an image whose short side is at least w pixels, so a
    // thread of photos doesn't decode every 12-megapixel original at full size.
    // ImageDecoder applies the EXIF turn, so the copy faces the same way.
    fun thumb(name: String, w: Int): File? {
        val src = fetchFile(name) ?: return null
        if (src.name.endsWith(".gif", true)) return src
        val out = File(thumbsCache.apply { mkdirs() }, "$w-${src.name}.webp")
        if (out.exists()) return out
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(src.path, bounds)
        if (bounds.outWidth > 0 && minOf(bounds.outWidth, bounds.outHeight) <= w * 1.5) return src
        return try {
            var big = false
            val bm = ImageDecoder.decodeBitmap(ImageDecoder.createSource(src)) { d, info, _ ->
                val short = minOf(info.size.width, info.size.height)
                big = short > w * 1.5
                var sample = 1
                while (short / (sample * 2) >= w) sample *= 2
                d.setTargetSampleSize(sample)
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            if (!big) return src
            val scale = w.toFloat() / minOf(bm.width, bm.height)
            val sized = if (scale < 1) bm.scale((bm.width * scale).toInt(), (bm.height * scale).toInt()) else bm
            val tmp = File.createTempFile("thumb", ".part", out.parentFile)
            tmp.outputStream().use { sized.compress(Bitmap.CompressFormat.WEBP_LOSSY, 85, it) }
            tmp.renameTo(out)
            out
        } catch (e: IOException) {
            src
        }
    }

    private companion object {
        const val FIRST_DIRECT_TRY = 5_000L
        const val LAST_DIRECT_TRY = 15 * 60_000L
    }
}

enum class SendOutcome { SENT, REFUSED, RETRY }

// A 4xx other than these is the computer turning the message down, which
// sending it again won't change. Anything else is worth another try.
internal fun sendOutcome(code: Int): SendOutcome = when {
    code in 200..299 -> SendOutcome.SENT
    code in 400..499 && code != 401 && code != 408 && code != 429 -> SendOutcome.REFUSED
    else -> SendOutcome.RETRY
}

// Quick at first, for a blip, then every 30 s, then once a minute. While the
// relay is holding a socket to say when the computer is back, every 5 minutes
// is only a fallback. The spread keeps a phone and the computer from
// retrying in lockstep.
internal fun backoff(failures: Int, waiting: Boolean, spread: Double = Math.random()): Long {
    val base = when {
        failures < 5 -> 1000L shl failures.coerceAtLeast(1)
        failures < 10 -> 30_000L
        waiting -> 300_000L
        else -> 60_000L
    }
    return (base * (0.8 + 0.4 * spread)).toLong()
}

// A torn last line from a process killed mid-write is skipped.
internal fun readHistory(lines: List<String>): List<JSONObject> = lines.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }

internal fun newestId(events: List<JSONObject>): Long = events.maxOfOrNull { it.optLong("id") } ?: 0

// A file's own name, with nothing in it that could reach another folder, or null.
internal fun plainName(s: String): String? =
    s.takeIf { it.isNotEmpty() && it.length <= 255 && it != "." && it != ".." && it.none { c -> c == '/' || c == '\\' || c < ' ' } }
