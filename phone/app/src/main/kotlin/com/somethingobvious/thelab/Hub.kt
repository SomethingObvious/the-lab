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
import android.provider.OpenableColumns
import android.util.Log
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

// Everything that has to outlive the screen: the stream from the computer, the
// cached history, the outbox and the downloaded design. All state is touched
// on the main thread only.
// What every line the app writes calls the computer, set by the build.

object Hub {
    private const val TAG = "Lab"
    private const val KEEP = 2000
    private const val PAIR_AGAIN = "Ask the agent on the computer to show the pairing code, then point this phone's camera at it."
    private val JSON_TYPE = "application/json".toMediaType()

    lateinit var app: Application
        private set
    private lateinit var prefs: SharedPreferences
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    // Its own thread, so writing an event never waits behind a design download.
    private val disk = Executors.newSingleThreadExecutor()
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // The server pings every 25 s, so a minute of silence is a dead link.
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    // A notification button's receiver has about 10 s to finish.
    private val quick = client.newBuilder().callTimeout(8, TimeUnit.SECONDS).build()
    // Listing Claude's models can take the server 20 s, on top of a relay dial.
    private val slow = client.newBuilder().callTimeout(40, TimeUnit.SECONDS).build()

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
    var foreground = false
    // The last run's end, so the status line can say Done for a while after.
    var lastDone: JSONObject? = null
        private set

    private val listeners = LinkedHashSet<(JSONObject) -> Unit>()
    val designListeners = LinkedHashSet<() -> Unit>()
    // The history was thrown away and fetched again, so the page has to start over.
    val resetListeners = LinkedHashSet<() -> Unit>()

    private var source: EventSource? = null
    private var failures = 0
    private var designFailures = 0
    // Whether the default network has a VPN and is validated, the two changes worth redialing for.
    private var shape: Pair<Boolean, Boolean>? = null
    private var retry: Runnable? = null
    private var flushing = false
    private var syncing = false
    private var started = false
    private var loaded = false
    private var connectWhenLoaded = false
    private val whenLoaded = ArrayList<() -> Unit>()

    // Through the tunnel once it's paired that way, or Tailscale's address
    // for a phone paired before the tunnel existed.
    // Null for a moment if the phone can't open the tunnel's port, which callers treat as unreachable.
    val url: String? get() = if (Tunnel.spec != null) runCatching { Tunnel.base() }.getOrNull() else prefs.getString("url", null)
    private val token get() = prefs.getString("token", null)
    val paired get() = (Tunnel.spec != null || prefs.getString("url", null) != null) && token != null
    private var network: Network? = null
    val hasNetwork get() = app.getSystemService(ConnectivityManager::class.java).activeNetwork != null
    // Taken from events.jsonl on load, so the cursor never runs ahead of what's on disk.
    private var lastId = 0L
    var designVersion
        get() = prefs.getString("design", null)
        private set(v) = prefs.edit { putString("design", v) }

    val designDir get() = File(app.filesDir, "design/current")
    private val eventsFile get() = File(app.filesDir, "events.jsonl")
    private val outboxFile get() = File(app.filesDir, "outbox.json")

    fun init(context: Context) {
        if (::app.isInitialized) return
        app = context.applicationContext as Application
        prefs = app.getSharedPreferences("lab", Context.MODE_PRIVATE)
        loadEvents()
        // The old "mac" and "shortcuts" keys go first, so a newer live: copy of
        // the same kind always wins whatever order prefs hands them back in.
        val saved = prefs.all.entries.filter { it.key.startsWith("live:") || it.key == "mac" || it.key == "shortcuts" }.sortedBy { it.key.startsWith("live:") }
        for ((_, v) in saved) runCatching { JSONObject(v as String) }.getOrNull()?.let { live[it.optString("kind")] = it }
        prefs.getString("tunnel", null)?.let { t -> Tunnel.spec = runCatching { Tunnel.Spec.parse(JSONObject(t)) }.getOrNull() }
        live["reach"]?.let { reached(it) }
        if (outboxFile.exists()) runCatching { JSONArray(outboxFile.readText()) }.getOrNull()?.let { a -> for (i in 0 until a.length()) outbox.put(a.get(i)) }
        app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post {
                    // A new network can bring a direct route, or take the old one away.
                    if (Hub.network != null && Hub.network != network && Tunnel.spec != null) Tunnel.drop()
                    Hub.network = network
                    if (link.optString("state") != "online") reconnectNow()
                }
            }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                // Tailscale coming up shows as a change to the default network.
                // Signal strength changes come through here too and aren't worth a redial.
                val now = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) to caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                main.post {
                    if (now == shape) return@post
                    shape = now
                    if (link.optString("state") != "online") reconnectNow()
                }
            }
        })
        if (!paired) setLink("unpaired", "This phone isn't paired with a computer yet. $PAIR_AGAIN")
    }

    // Reading and parsing 2,000 events takes long enough to drop frames, so
    // it happens off the main thread and anything that needs them waits.
    private fun loadEvents() {
        io.execute {
            var read = emptyList<JSONObject>()
            if (eventsFile.exists()) {
                val lines = eventsFile.readLines()
                read = readHistory(lines.takeLast(KEEP))
                if (lines.size > KEEP * 2) eventsFile.writeText(read.joinToString("\n", postfix = "\n") { it.toString() })
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

    fun listen(l: (JSONObject) -> Unit): () -> Unit {
        listeners.add(l)
        return { listeners.remove(l) }
    }

    private fun emit(e: JSONObject) {
        for (l in listeners.toList()) l(e)
    }

    fun outboxEvent(): JSONObject = JSONObject().put("kind", "outbox").put("items", JSONArray(outbox.toString()))

    // Called by the service. Safe to call again.
    fun start() {
        if (started) return
        started = true
        if (paired) connect()
    }

    fun pair(newUrl: String?, tunnel: Tunnel.Spec?, newToken: String) = onLoaded {
        val was = prefs.getString("tunnel", null)?.let { runCatching { JSONObject(it).optString("room") }.getOrNull() } ?: prefs.getString("url", null)
        val changed = (tunnel?.room ?: newUrl) != was
        prefs.edit {
            if (newUrl != null) putString("url", newUrl.trimEnd('/')) else remove("url")
            if (tunnel != null) putString("tunnel", tunnel.json().toString()) else remove("tunnel")
            putString("token", newToken)
        }
        Tunnel.spec = tunnel
        // An older reach could otherwise swap the new pairing's relay back for the old one.
        live.remove("reach")
        prefs.edit { remove("live:reach") }
        if (changed) {
            forgetHistory()
            designVersion = null
            live.clear()
            prefs.edit { for (k in prefs.all.keys) if (k.startsWith("live:") || k == "mac" || k == "shortcuts") remove(k) }
            File(app.filesDir, "design").deleteRecursively()
        }
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "paired with ${tunnel?.relay ?: tunnel?.lan?.firstOrNull() ?: newUrl}")
        reconnectNow()
    }

    private fun forgetHistory() {
        events.clear()
        disk.execute { eventsFile.delete() }
        lastId = 0
    }

    private fun setLink(state: String, detail: String = "", fix: String? = null) {
        val next = JSONObject().put("kind", "link").put("state", state).put("detail", detail)
        if (fix != null) next.put("fix", fix)
        if (next.toString() == link.toString()) return
        link = next
        emit(link)
        LinkService.refresh()
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
        source = EventSources.createFactory(client).newEventSource(req, object : EventSourceListener() {
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
        if (link.optString("state") != "online" && Tunnel.spec != null) Tunnel.drop()
        if (paired) connect()
    }

    private fun onEvent(type: String?, data: String) {
        val e = runCatching { JSONObject(data) }.getOrElse { return }
        if (type == "loaded") return Notifier.onLoaded()
        if (type == "hello") {
            // The computer's numbering went back, so every new event would
            // look already seen. Its own copy of the history takes over.
            if (e.has("last") && e.optLong("last") < lastId) {
                forgetHistory()
                for (l in resetListeners.toList()) l()
                connect()
                return
            }
            failures = 0
            setLink("online", "Connected to the computer")
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
        e.optJSONArray("lan")?.let { a -> Tunnel.lan = (0 until a.length()).map { a.optString(it) }.filter { it.isNotBlank() } }
        // A relay set up after pairing, so the phone can reach the computer away from home without pairing again.
        val relay = e.optString("relay").takeIf { it.isNotBlank() && it != "null" } ?: return
        val sp = Tunnel.spec ?: return
        if (relay == sp.relay) return
        val next = Tunnel.Spec.parse(sp.json().put("relay", relay)) ?: return
        val lan = Tunnel.lan
        Tunnel.spec = next
        Tunnel.lan = lan
        prefs.edit { putString("tunnel", next.json().toString()) }
    }

    private fun setLive(e: JSONObject) {
        val kind = e.optString("kind")
        if (kind == "reach") reached(e)
        live[kind] = e
        prefs.edit { putString("live:$kind", e.toString()) }
        emit(e)
    }

    private fun setStatus(s: JSONObject) {
        status = JSONObject(s.toString()).put("kind", "status")
        emit(status)
        LinkService.refresh()
    }

    private fun store(e: JSONObject) {
        val id = e.getLong("id")
        if (id <= lastId) return
        lastId = id
        events.add(e)
        if (e.optString("kind") == "done") { lastDone = e; LinkService.refresh() }
        if (events.size > KEEP * 1.2) events.subList(0, events.size - KEEP).clear()
        val line = e.toString() + "\n"
        disk.execute { eventsFile.appendText(line) }
        emit(e)
        Notifier.onEvent(e)
    }

    private fun onLost(t: Throwable?, code: Int?) {
        source = null
        if (code == null && Tunnel.spec != null) Tunnel.drop()
        val cm = app.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        when {
            code == 401 -> setLink("unpaired", "The computer doesn't recognise this phone any more. $PAIR_AGAIN")
            caps == null -> setLink("offline", "This phone is offline.")
            Tunnel.spec != null -> setLink("offline", when (Tunnel.why) {
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
        val wait = minOf(1000L shl minOf(failures, 5), 30_000L)
        retry = Runnable { retry = null; connect() }.also { main.postDelayed(it, wait) }
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "link lost (${code ?: t?.javaClass?.simpleName}), retry in ${wait}ms")
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
        disk.execute {
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
            if (outbox.length() == 0) Notifier.sent(app)
            flush()
        }
    }

    // The words go back to him, in the message box if the page is open and in a notification if not.
    private fun refused(m: JSONObject) {
        emit(sendFailed(m.optString("cid"), m.optString("text"), "The computer couldn't take that message. It's back in the message box so you can try again."))
        if (!foreground) Notifier.unsent(m.optString("text"))
    }

    fun sendFailed(cid: String, text: String, error: String): JSONObject =
        JSONObject().put("kind", "sendFailed").put("cid", cid).put("text", text).put("error", error)

    fun queued(cid: String) = (0 until outbox.length()).any { outbox.getJSONObject(it).optString("cid") == cid }

    // done gets false only when the computer never heard it.
    fun stop(done: (Boolean) -> Unit = {}) = post("/stop", JSONObject(), quick) { done(it in 200..299) }
    // done gets the status, and a 404 means it was already answered or has expired.
    fun answer(ref: String, allow: Boolean, always: Boolean = false, done: (Int) -> Unit = {}) =
        post("/answer", JSONObject().put("ref", ref).put("allow", allow).put("always", always), quick, done)

    // Any JSON route on the computer, for the page's memory, schedules and setup
    // sheets. done gets the body, or null and an error in plain words.
    fun request(method: String, path: String, body: String?, done: (String?, String?) -> Unit) {
        val base = url ?: return done(null, "This phone isn't paired with a computer yet.")
        if (!path.startsWith("/") || path.contains("..")) return done(null, "That isn't a route on the computer.")
        val req = Request.Builder().url(base + path).header("Authorization", "Bearer $token")
            .method(method, if (method == "GET") null else (body ?: "{}").toRequestBody(JSON_TYPE)).build()
        (if (path == "/models" || path == "/check") slow else quick).newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { main.post { done(null, "Couldn't reach the computer. Try again once it's back.") } }
            override fun onResponse(call: Call, response: Response) {
                val code = response.code
                val text = response.use { it.body.string() }
                main.post {
                    if (code in 200..299) done(text, null)
                    else done(null, runCatching { JSONObject(text).getString("error") }.getOrDefault("The computer couldn't do that just now. Try again in a minute."))
                }
            }
        })
    }

    // A QR code scanned on the computer hands over a one-time code, which the computer
    // swaps for the token here so the token never sits in a browser history.
    fun claim(base: String?, tunnel: Tunnel.Spec?, code: String, done: (String?) -> Unit) {
        // Only the claim goes to the new computer. Everything else stays with
        // the paired one until the token comes back.
        val to = if (tunnel != null) Tunnel.once(tunnel) else base ?: return done("That pairing link is missing its address.")
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
        val dir = File(app.cacheDir, "files").apply { mkdirs() }
        val tmp = File.createTempFile("upload", ".part", dir)
        try {
            // A share from an app that didn't grant read access throws SecurityException.
            val input = try { cr.openInputStream(uri) } catch (e: SecurityException) { null } ?: throw IOException("Couldn't read ${if (name == "file") "that file" else name}. The app it came from didn't let The Lab open it.")
            input.use { i -> tmp.outputStream().use { i.copyTo(it) } }
            val req = Request.Builder().url("$base/upload?name=${URLEncoder.encode(name, "UTF-8")}")
                .header("Authorization", "Bearer $token")
                .post(tmp.asRequestBody(type.toMediaTypeOrNull())).build()
            val (code, text) = try {
                client.newCall(req).execute().use { it.code to it.body.string() }
            } catch (e: IOException) {
                throw IOException("Couldn't reach the computer, so $name wasn't attached.", e)
            }
            if (code != 200) throw IOException(runCatching { JSONObject(text).getString("error") }.getOrDefault("The computer didn't take $name. Try again in a minute."))
            val j = JSONObject(text)
            tmp.renameTo(File(dir, Uri.decode(j.getString("url").removePrefix("/files/"))))
            return j
        } finally {
            tmp.delete()
        }
    }

    private fun post(path: String, body: JSONObject, via: OkHttpClient = client, done: (Int) -> Unit) {
        val base = url ?: return done(-1)
        val req = Request.Builder().url(base + path).header("Authorization", "Bearer $token")
            .post(body.toString().toRequestBody(JSON_TYPE)).build()
        via.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { main.post { done(-1) } }
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
                val root = File(app.filesDir, "design")
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
                    for (l in designListeners.toList()) l()
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
        val clean = File(name).name
        val dir = File(app.cacheDir, "files").apply { mkdirs() }
        val out = File(dir, clean)
        if (out.exists()) return out
        val base = url ?: return null
        return runCatching {
            val req = Request.Builder().url("$base/files/$clean").header("Authorization", "Bearer $token").build()
            client.newCall(req).execute().use { r ->
                if (!r.isSuccessful) return null
                val tmp = File.createTempFile("fetch", ".part", dir)
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
        val out = File(File(app.cacheDir, "thumbs").apply { mkdirs() }, "$w-${src.name}.webp")
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

    fun later(r: Runnable) = io.execute(r)
    // A tap on a file shouldn't wait behind an upload or a design sync.
    private val opens = Executors.newSingleThreadExecutor()
    fun soon(r: Runnable) = opens.execute(r)
    fun onMain(delay: Long = 0, r: Runnable) = main.postDelayed(r, delay)
}

enum class SendOutcome { SENT, REFUSED, RETRY }

// A 4xx other than these is the computer turning the message down, which
// sending it again won't change. Anything else is worth another try.
internal fun sendOutcome(code: Int): SendOutcome = when {
    code in 200..299 -> SendOutcome.SENT
    code in 400..499 && code != 401 && code != 408 && code != 429 -> SendOutcome.REFUSED
    else -> SendOutcome.RETRY
}

// A torn last line from a process killed mid-write is skipped.
internal fun readHistory(lines: List<String>): List<JSONObject> = lines.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }

internal fun newestId(events: List<JSONObject>): Long = events.maxOfOrNull { it.optLong("id") } ?: 0
