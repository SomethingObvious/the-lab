package com.somethingobvious.thelab

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

// Everything that has to outlive the screen: the stream from the Mac, the
// cached history, the outbox and the downloaded design. All state is touched
// on the main thread only.
object Hub {
    private const val TAG = "Lab"
    private const val KEEP = 2000
    private val JSON_TYPE = "application/json".toMediaType()

    lateinit var app: Context
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

    val events = ArrayList<JSONObject>()
    private val outbox = JSONArray()
    var link = JSONObject().put("kind", "link").put("state", "connecting")
        private set
    var status = JSONObject().put("kind", "status").put("working", false).put("label", "")
        private set
    // Kept across restarts so the page can show them while the Mac is away.
    var mac: JSONObject? = null
        private set
    var shortcuts: JSONObject? = null
        private set
    var foreground = false

    private val listeners = LinkedHashSet<(JSONObject) -> Unit>()
    val designListeners = LinkedHashSet<() -> Unit>()

    private var source: EventSource? = null
    private var failures = 0
    private var retry: Runnable? = null
    private var flushing = false
    private var syncing = false
    private var started = false
    private var loaded = false
    private var connectWhenLoaded = false
    private val whenLoaded = ArrayList<() -> Unit>()

    val url get() = prefs.getString("url", null)
    private val token get() = prefs.getString("token", null)
    val paired get() = url != null && token != null
    private var lastId
        get() = prefs.getLong("lastId", 0)
        set(v) = prefs.edit().putLong("lastId", v).apply()
    var designVersion
        get() = prefs.getString("design", null)
        private set(v) = prefs.edit().putString("design", v).apply()

    val designDir get() = File(app.filesDir, "design/current")
    private val eventsFile get() = File(app.filesDir, "events.jsonl")
    private val outboxFile get() = File(app.filesDir, "outbox.json")

    fun init(context: Context) {
        if (::app.isInitialized) return
        app = context.applicationContext
        prefs = app.getSharedPreferences("lab", Context.MODE_PRIVATE)
        loadEvents()
        mac = prefs.getString("mac", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        shortcuts = prefs.getString("shortcuts", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (outboxFile.exists()) runCatching { JSONArray(outboxFile.readText()) }.getOrNull()?.let { a -> for (i in 0 until a.length()) outbox.put(a.get(i)) }
        app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { main.post { if (link.optString("state") != "online") reconnectNow() } }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                // Tailscale coming up shows as a change to the default network.
                main.post { if (link.optString("state") != "online") reconnectNow() }
            }
        })
        if (!paired) setLink("unpaired", "This phone isn't paired with a Mac yet. Plug it into the Mac and let the agent run setup.")
    }

    // Reading and parsing 2,000 events takes long enough to drop frames, so
    // it happens off the main thread and anything that needs them waits.
    private fun loadEvents() {
        io.execute {
            val read = ArrayList<JSONObject>()
            if (eventsFile.exists()) {
                val lines = eventsFile.readLines()
                for (line in lines.takeLast(KEEP)) runCatching { read.add(JSONObject(line)) }
                if (lines.size > KEEP * 2) eventsFile.writeText(read.joinToString("\n", postfix = "\n") { it.toString() })
            }
            main.post {
                events.addAll(0, read)
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

    fun pair(newUrl: String, newToken: String) = onLoaded {
        val changed = newUrl != url
        prefs.edit().putString("url", newUrl.trimEnd('/')).putString("token", newToken).apply()
        if (changed) {
            events.clear()
            disk.execute { eventsFile.delete() }
            lastId = 0
            designVersion = null
            mac = null
            shortcuts = null
            prefs.edit().remove("mac").remove("shortcuts").apply()
            File(app.filesDir, "design").deleteRecursively()
        }
        Log.i(TAG, "paired with $newUrl")
        reconnectNow()
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
        val base = url ?: return
        val req = Request.Builder().url("$base/events")
            .header("Authorization", "Bearer $token")
            .apply { if (lastId > 0) header("Last-Event-ID", lastId.toString()) }
            .build()
        if (link.optString("state") != "online") setLink("connecting", "Reaching the Mac")
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
        if (paired) connect()
    }

    private fun onEvent(type: String?, data: String) {
        val e = runCatching { JSONObject(data) }.getOrElse { return }
        if (type == "hello") {
            failures = 0
            setLink("online", "Connected to the Mac")
            e.optJSONObject("status")?.let { setStatus(it) }
            e.optJSONObject("mac")?.let { setLive(it) }
            e.optJSONArray("shortcuts")?.let { setLive(JSONObject().put("kind", "shortcuts").put("items", it)) }
            if (e.optString("design") != designVersion) syncDesign()
            flush()
            return
        }
        when (e.optString("kind")) {
            "status" -> setStatus(e)
            "design" -> if (e.optString("version") != designVersion) syncDesign()
            "mac", "shortcuts" -> setLive(e)
            else -> if (e.has("id")) store(e)
        }
    }

    private fun setLive(e: JSONObject) {
        val kind = e.optString("kind")
        if (kind == "mac") mac = e else shortcuts = e
        prefs.edit().putString(kind, e.toString()).apply()
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
        if (events.size > KEEP * 1.2) events.subList(0, events.size - KEEP).clear()
        val line = e.toString() + "\n"
        disk.execute { eventsFile.appendText(line) }
        emit(e)
        Notifier.onEvent(e)
    }

    private fun onLost(t: Throwable?, code: Int?) {
        source = null
        val cm = app.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        when {
            code == 401 -> setLink("unpaired", "The Mac doesn't recognise this phone any more. Plug it into the Mac and let the agent pair it again.")
            caps == null -> setLink("offline", "This phone is offline.")
            !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> setLink("offline", "Tailscale is off on this phone, so it can't reach the Mac.", "tailscale")
            code != null && code in 502..504 -> setLink("offline", "The Mac is on, but The Lab's server isn't answering. It restarts itself, so give it a minute.")
            t is UnknownHostException -> setLink("offline", "This phone can't find the Mac on Tailscale. Check Tailscale is connected.", "tailscale")
            else -> setLink("offline", "Can't reach the Mac. It may be asleep, switched off or offline.")
        }
        if (code == 401) return
        failures++
        val wait = minOf(1000L shl minOf(failures, 5), 30_000L)
        retry = Runnable { retry = null; connect() }.also { main.postDelayed(it, wait) }
        Log.i(TAG, "link lost (${code ?: t?.javaClass?.simpleName}), retry in ${wait}ms")
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
            if (code in 200..299 || code == 400) {
                if (outbox.length() > 0 && outbox.getJSONObject(0).optString("cid") == m.optString("cid")) outbox.remove(0)
                saveOutbox()
                emit(outboxEvent())
                flush()
            } else {
                main.postDelayed({ flush() }, 3000)
            }
        }
    }

    // done gets false only when the Mac never heard it. A 404 means it was already answered.
    fun stop(done: (Boolean) -> Unit = {}) = post("/stop", JSONObject(), quick) { done(it in 200..299) }
    fun answer(ref: String, allow: Boolean, done: (Boolean) -> Unit = {}) =
        post("/answer", JSONObject().put("ref", ref).put("allow", allow), quick) { done(it in 200..299 || it == 404) }
    fun undoDesign(done: (Boolean) -> Unit) = post("/design/undo", JSONObject()) { done(it == 200) }
    fun saveShortcuts(items: JSONArray, done: (Boolean) -> Unit) = post("/shortcuts", JSONObject().put("items", items)) { done(it == 200) }

    // Blocking. Copies the pick into the file cache first, so the page can
    // show it straight away without fetching it back from the Mac.
    fun upload(uri: Uri): JSONObject {
        val cr = app.contentResolver
        var name = "file"
        var size = -1L
        cr.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) { name = c.getString(0) ?: name; if (!c.isNull(1)) size = c.getLong(1) }
        }
        if (size > 100L * 1024 * 1024) throw IOException("$name is over the 100 MB limit.")
        val base = url ?: throw IOException("This phone isn't paired with a Mac yet.")
        val type = cr.getType(uri) ?: "application/octet-stream"
        val dir = File(app.cacheDir, "files").apply { mkdirs() }
        val tmp = File.createTempFile("upload", ".part", dir)
        try {
            (cr.openInputStream(uri) ?: throw IOException("Couldn't read $name.")).use { input -> tmp.outputStream().use { input.copyTo(it) } }
            val req = Request.Builder().url("$base/upload?name=${URLEncoder.encode(name, "UTF-8")}")
                .header("Authorization", "Bearer $token")
                .post(tmp.asRequestBody(type.toMediaTypeOrNull())).build()
            val (code, text) = try {
                client.newCall(req).execute().use { it.code to it.body.string() }
            } catch (e: IOException) {
                throw IOException("Couldn't reach the Mac, so $name wasn't attached.", e)
            }
            if (code != 200) throw IOException(runCatching { JSONObject(text).getString("error") }.getOrDefault("The Mac didn't take $name (HTTP $code)."))
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
                    designVersion = version
                    for (l in designListeners.toList()) l()
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
            val sized = if (scale < 1) Bitmap.createScaledBitmap(bm, (bm.width * scale).toInt(), (bm.height * scale).toInt(), true) else bm
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
    fun onMain(r: Runnable) = main.post(r)
}
