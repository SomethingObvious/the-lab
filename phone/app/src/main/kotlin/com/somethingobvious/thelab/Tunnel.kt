package com.somethingobvious.thelab

import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.math.BigInteger
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.concurrent.thread

// The phone's end of computer/tunnel.ts, and it has to stay in step with it.
// OkHttp talks plain HTTP to a port on this phone's loopback, and each
// connection to that port is carried, sealed, to the computer: straight over
// the local network when one of its addresses answers, through the relay
// otherwise. Nothing outside this phone and the computer can read it.
class Tunnel {

    class Spec(val relay: String?, val room: String, val key: ByteArray, val pass: ByteArray, val lan: List<String>) {
        fun json(): JSONObject = JSONObject().put("relay", relay ?: JSONObject.NULL).put("room", room)
            .put("key", b64(key)).put("pass", b64(pass)).put("lan", JSONArray(lan))

        companion object {
            fun parse(j: JSONObject): Spec? = runCatching {
                val lan = j.optJSONArray("lan")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
                Spec(j.optString("relay").takeIf { it.isNotBlank() && it != "null" }, j.getString("room"), unb64(j.getString("key")), unb64(j.getString("pass")), lan)
                    .takeIf { s -> s.key.size == 65 && s.pass.size == 32 && (s.relay == null || RELAY.matches(s.relay)) && s.lan.all { ADDRESS.matches(it) && it.substringAfterLast(':').toInt() in 1..65535 } }
            }.getOrNull()
        }
    }

    // Why the last attempt failed, for the link line: "away" (the computer
    // isn't on the relay), "relay" (the relay can't be reached), "key" (the
    // answer didn't come from the paired computer) or "none" (no route at all).
    @Volatile var why = ""
        private set
    @Volatile var route: String? = null
        private set
    @Volatile var spec: Spec? = null
        set(v) { field = v; lan = emptyList(); oldRelay = false; drop() }
    // The newest addresses the computer sent, ahead of the ones from pairing.
    @Volatile var lan: List<String> = emptyList()

    // Making a session can take 10 seconds, so it has its own lock, and
    // the main thread only ever takes the quick one for the port.
    private val dialing = java.lang.Object()
    private val lock = java.lang.Object()
    private var server: ServerSocket? = null
    @Volatile private var session: Session? = null
    // Requests that queue up behind a dial that failed get its answer for a
    // couple of seconds, rather than each dialing again in turn.
    @Volatile private var failed: Pair<Long, IOException>? = null
    @Volatile private var waiting: WebSocket? = null
    // A relay from before the waiting socket says "away" and closes it.
    @Volatile private var oldRelay = false
    val isWaiting get() = waiting != null

    fun base(): String = synchronized(lock) {
        // Android's getLoopbackAddress() is ::1, and the address OkHttp is given is 127.0.0.1.
        val s = server ?: ServerSocket(0, 50, LOOPBACK).also { ss ->
            server = ss
            thread(name = "tunnel", isDaemon = true) {
                while (!ss.isClosed) {
                    val sock = try { ss.accept() } catch (e: IOException) {
                        // A port nobody accepts on would hang every request, so the next base() opens a new one.
                        synchronized(lock) { if (server === ss) server = null }
                        runCatching { ss.close() }
                        break
                    }
                    thread(name = "tunnel-stream", isDaemon = true) { carry(sock) }
                }
            }
        }
        "http://127.0.0.1:${s.localPort}"
    }

    // One request to a computer that isn't paired yet, over its own session,
    // so a claim that fails never reaches the computer that is.
    fun once(sp: Spec): String {
        val ss = ServerSocket(0, 1, LOOPBACK)
        thread(name = "tunnel-once", isDaemon = true) {
            ss.use {
                it.soTimeout = 30_000
                val sock = try { it.accept() } catch (e: IOException) { return@thread }
                try { open(sp, sp.lan).first.let { s -> s.carry(sock); s.dead() } } catch (e: Exception) {
                    if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "tunnel: claim couldn't connect (${e.message})")
                    runCatching { sock.close() }
                }
            }
        }
        return "http://127.0.0.1:${ss.localPort}"
    }

    // Ends the session, so the next connection picks its route again. Called
    // when the phone changes network, which is when a direct route can appear.
    fun drop() {
        val old = session
        session = null
        route = null
        failed = null
        old?.dead()
    }

    // For a new network, when the old route may be fine for a little longer.
    // New connections pick a route again, and whatever is under way, like an
    // upload, gets to finish if it can rather than failing at once.
    fun retire() {
        val old = session
        session = null
        route = null
        failed = null
        old?.retire()
    }

    // Held open on the relay while the computer is away. The relay says "here"
    // the moment the computer connects, so the phone doesn't sit out its next
    // retry. onBack runs on OkHttp's thread.
    fun await(onBack: () -> Unit) {
        val sp = spec ?: return
        val relay = sp.relay ?: return
        synchronized(lock) {
            if (waiting != null || oldRelay) return
            waiting = waitClient.newWebSocket(Request.Builder().url("${wsUrl(relay)}/r/${sp.room}?wait=1").build(), object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (text == "away") oldRelay = true
                    if (text != "here") return
                    gone(webSocket)
                    webSocket.close(1000, null)
                    if (spec === sp) onBack()
                }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { gone(webSocket); webSocket.close(1000, null) }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = gone(webSocket)
            })
        }
    }

    fun stopWaiting() = synchronized(lock) {
        waiting?.cancel()
        waiting = null
    }

    private fun gone(w: WebSocket) = synchronized(lock) { if (waiting === w) waiting = null }

    private fun wsUrl(relay: String) = relay.trimEnd('/').replaceFirst(Regex("^http"), "ws")

    // Anything thrown on this thread would take the whole app down.
    private fun carry(sock: Socket) {
        val s = try { session() } catch (e: Exception) {
            if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "tunnel: ${e.message}")
            runCatching { sock.close() }
            return
        }
        s.carry(sock)
    }

    private fun session(): Session { synchronized(dialing) {
        val sp = spec ?: throw IOException("not paired")
        session?.takeIf { it.alive && it.spec === sp }?.let { return it }
        failed?.let { (at, e) -> if (System.nanoTime() - at < 2_000_000_000L) throw e }
        val (s, how) = try { open(sp, lan.ifEmpty { sp.lan }) } catch (e: IOException) {
            why = when (e) { is Away -> "away"; is WrongKey -> "key"; is NoRoute -> "none"; else -> "relay" }
            failed = System.nanoTime() to e
            throw e
        }
        // He paired again while this was dialing, so it's for the old computer.
        if (spec !== sp) { s.dead(); throw IOException("the pairing changed while connecting") }
        session?.dead()
        session = s
        route = how
        why = ""
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "tunnel: $how")
        return s
    } }

    // Direct gets a head start and then the relay joins in, so a Wi-Fi the
    // computer isn't on costs a moment rather than every address timing out. A
    // wrong key on either means the paired computer wasn't the one that answered.
    private fun open(sp: Spec, addresses: List<String>): Pair<Session, String> {
        if (!direct()) return throughRelay(sp)
        val done = LinkedBlockingQueue<Result<Pair<Session, String>>>()
        val taken = AtomicBoolean()
        fun race(dial: () -> Pair<Session, String>) = thread(name = "tunnel-dial", isDaemon = true) {
            val r = runCatching(dial)
            done.put(r)
            // The other route won, so nothing will ever use this one.
            if (taken.get() && done.remove(r)) r.getOrNull()?.first?.dead()
        }
        fun leftovers() { taken.set(true); generateSequence { done.poll() }.forEach { it.getOrNull()?.first?.dead() } }
        race { straight(sp, addresses) }
        var racing = 1
        var relayIn = sp.relay == null
        val errors = ArrayList<Throwable>()
        while (true) {
            val r = done.poll(if (relayIn) 30_000 else HEAD_START, TimeUnit.MILLISECONDS)
            if (r == null && relayIn) { leftovers(); throw IOException("no route answered") }
            r?.getOrNull()?.let { leftovers(); return it }
            if (r != null) { r.exceptionOrNull()?.let { errors.add(it) }; racing-- }
            if (!relayIn) { relayIn = true; racing++; race { throughRelay(sp) } }
            else if (racing == 0) throw worst(errors)
        }
    }

    private fun worst(errors: List<Throwable>): IOException {
        val e = errors.firstOrNull { it is Away } ?: errors.firstOrNull { it is WrongKey } ?: errors.firstOrNull { it !is NoRoute } ?: NoRoute()
        return e as? IOException ?: IOException(e.message)
    }

    private fun throughRelay(sp: Spec): Pair<Session, String> {
        val relay = sp.relay ?: throw NoRoute()
        return Session.start(WsLink("${wsUrl(relay)}/r/${sp.room}", ws), sp, 10_000) to "relay"
    }

    // The saved addresses first, then any the Wi-Fi says the computer has now.
    private fun straight(sp: Spec, addresses: List<String>): Pair<Session, String> {
        var wrongKey = false
        val tried = addresses.take(4)
        val found = sequence {
            yieldAll(tried)
            yieldAll(discover(sp, broadcasts(addresses)).filter { it !in tried })
        }
        for (a in found) {
            try {
                val s = Session.start(TcpLink(a), sp, 2000)
                // Only for the paired computer, never for a claim to another one.
                if (a !in tried && sp === spec) lan = listOf(a) + addresses
                return s to "direct"
            } catch (e: WrongKey) {
                wrongKey = true
                if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "tunnel: $a answered with the wrong key")
            } catch (e: Exception) {
                if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "tunnel: $a didn't answer (${e.message})")
            }
        }
        throw if (wrongKey) WrongKey() else NoRoute()
    }

    // Moves off the relay when the computer has become reachable straight over
    // this network, which needs no change of network to happen. Blocking.
    fun upgrade(): Boolean {
        val sp = spec ?: return false
        if (route != "relay" || !direct()) return false
        val s = try { straight(sp, lan.ifEmpty { sp.lan }).first } catch (e: Exception) { return false }
        synchronized(dialing) {
            if (spec !== sp) { s.dead(); return false }
            val old = session
            session = s
            route = "direct"
            failed = null
            old?.retire()
        }
        if (Log.isLoggable(TAG, Log.INFO)) Log.i(TAG, "tunnel: moved to direct")
        return true
    }

    // A test on the computer has no Android network to ask.
    internal var direct: () -> Boolean = { local() }

    // The whole Wi-Fi, and the part of it each saved address was on, since a
    // new address from the router is nearly always on the same one.
    private fun broadcasts(addresses: List<String>) = listOf("255.255.255.255") +
        addresses.map { it.substringBeforeLast(':') }.filterNot { it.startsWith("100.") }.map { it.substringBeforeLast('.') + ".255" }.distinct()

    // Asks the Wi-Fi where the computer went, for when the router gave it a
    // new address. computer/tunnel.ts answers with its port, and the
    // handshake after still proves which computer it is.
    internal fun discover(sp: Spec, hosts: List<String>): List<String> = runCatching {
        DatagramSocket().use { u ->
            u.broadcast = true
            u.soTimeout = 200
            onWifi(u)
            val ask = "thelab? ${sp.room}".toByteArray()
            val ports = (lan + sp.lan).mapNotNull { it.substringAfterLast(':').toIntOrNull() }.distinct().ifEmpty { listOf(8418) }
            for (h in hosts) for (p in ports) runCatching { u.send(DatagramPacket(ask, ask.size, InetAddress.getByName(h), p)) }
            val found = LinkedHashSet<String>()
            val buf = ByteArray(64)
            var end = System.nanoTime() + 800_000_000L
            while (System.nanoTime() < end) {
                val pk = DatagramPacket(buf, buf.size)
                try { u.receive(pk) } catch (_: SocketTimeoutException) { continue }
                val text = String(pk.data, 0, pk.length)
                val port = text.removePrefix("thelab! ").toIntOrNull()?.takeIf { text.startsWith("thelab! ") && it in 1..65535 } ?: continue
                val at = "${pk.address.hostAddress}:$port"
                // Anyone on the Wi-Fi can answer, so every answer is kept and the
                // handshake picks the real one. A short wait after the first is enough.
                if (ADDRESS.matches(at) && found.add(at)) end = minOf(end, System.nanoTime() + 150_000_000L)
                if (found.size >= 8) break
            }
            found.toList()
        }
    }.getOrDefault(emptyList())

    // With Tailscale on, the default network is the VPN, which a broadcast can't cross.
    private fun onWifi(u: DatagramSocket) = runCatching {
        val cm = Hub.app.getSystemService(ConnectivityManager::class.java)
        val n = cm.activeNetwork ?: return@runCatching
        if (cm.getNetworkCapabilities(n)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) n.bindSocket(u)
    }

    // On mobile data a local address can only time out, so it isn't tried.
    // Tailscale shows as a VPN, and its addresses are worth trying too.
    private fun local(): Boolean {
        val cm = Hub.app.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    class Away : IOException("The computer isn't connected to the relay.")
    class WrongKey : IOException("The answer didn't come from the paired computer.")
    class NoRoute : IOException("No address answered and there is no relay.")

    private class Box(key: ByteArray) {
        private val k = SecretKeySpec(key, "AES")
        private var n = 0L
        private fun iv() = ByteBuffer.allocate(12).putInt(0).putLong(n++).array()
        fun seal(pt: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.ENCRYPT_MODE, k, GCMParameterSpec(128, iv())); doFinal(pt) }
        fun open(ct: ByteArray): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run { init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, iv())); doFinal(ct) }
    }

    // One link carries one session. Anything that arrives before the session
    // takes over waits in a queue for the handshake.
    private abstract class Link {
        private val early = LinkedBlockingQueue<Any>()
        @Volatile var session: Session? = null
        protected fun got(b: ByteArray) { session?.take(b) ?: early.put(b) }
        protected fun lost(why: String) { session?.dead() ?: early.put(why) }
        fun first(ms: Long): ByteArray = when (val x = early.poll(ms, TimeUnit.MILLISECONDS)) {
            is ByteArray -> x
            "away" -> throw Away()
            null -> throw IOException("no answer")
            else -> throw IOException(x.toString())
        }
        abstract fun send(b: ByteArray)
        abstract fun close()
    }

    private class TcpLink(address: String) : Link() {
        private val sock = Socket()
        private val out: DataOutputStream

        init {
            val host = address.substringBeforeLast(':')
            val port = address.substringAfterLast(':').toIntOrNull() ?: throw IOException("bad address $address")
            sock.connect(InetSocketAddress(host, port), 600)
            sock.tcpNoDelay = true
            out = DataOutputStream(sock.getOutputStream().buffered())
            val inp = DataInputStream(sock.getInputStream().buffered())
            thread(name = "tunnel-direct", isDaemon = true) {
                try {
                    while (true) {
                        val n = inp.readInt()
                        if (n < 0 || n > MAX_PACKET) throw IOException("frame of $n bytes")
                        got(ByteArray(n).also { inp.readFully(it) })
                    }
                } catch (e: IOException) {
                    lost("closed")
                }
            }
        }

        override fun send(b: ByteArray) {
            out.writeInt(b.size)
            out.write(b)
            out.flush()
        }
        override fun close() { runCatching { sock.close() } }
    }

    private class WsLink(url: String, client: OkHttpClient) : Link() {
        @Volatile private var open = true
        private val socket: WebSocket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = got(bytes.toByteArray())
            override fun onMessage(webSocket: WebSocket, text: String) { if (text == "away") lost("away") }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { open = false; webSocket.close(1000, null); lost(reason.ifBlank { "closed" }) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { open = false; lost(t.message ?: "failed") }
        })

        // OkHttp closes a socket whose queue passes 16 MB, so a big upload
        // waits here instead. Each stream's window keeps this short.
        override fun send(b: ByteArray) {
            while (open && socket.queueSize() > 4L * 1024 * 1024) Thread.sleep(20)
            if (!open || !socket.send(b.toByteString())) throw IOException("relay link closed")
        }
        override fun close() { open = false; socket.cancel() }
    }

    // What the computer sent waits in inbox for the stream's own writer, so a
    // caller that stops reading holds up only its own stream. The peer's
    // window keeps inbox under a megabyte.
    private class Stream(val sock: Socket) {
        var unacked = 0L
        val inbox = LinkedBlockingQueue<ByteArray>()
    }

    private class Session(private val link: Link, val spec: Spec, p2c: ByteArray, c2p: ByteArray) {
        private val out = Box(p2c)
        val inn = Box(c2p)
        private val streams = ConcurrentHashMap<Int, Stream>()
        private val next = AtomicInteger(1)
        @Volatile var alive = true
            private set

        fun carry(sock: Socket) {
            val id = next.getAndAdd(2)
            val st = Stream(sock)
            streams[id] = st
            // Acks go out once the bytes are written, so they also pace the computer.
            thread(name = "tunnel-out", isDaemon = true) {
                var pending = 0
                var tell = false
                try {
                    val out = sock.getOutputStream()
                    while (true) {
                        val b = st.inbox.take()
                        if (b === ENDED) break
                        out.write(b)
                        pending += b.size
                        if (pending >= ACK_EVERY) {
                            send(id, ACK, ByteBuffer.allocate(4).putInt(pending).array())
                            pending = 0
                        }
                    }
                } catch (_: Exception) {
                    tell = true
                }
                finish(id, tell)
            }
            try {
                send(id, OPEN)
                val inp = sock.getInputStream()
                val buf = ByteArray(CHUNK)
                while (alive) {
                    val n = inp.read(buf)
                    if (n < 0) break
                    synchronized(st) {
                        while (st.unacked > WINDOW && alive && streams[id] === st) (st as java.lang.Object).wait(1000)
                        st.unacked += n
                    }
                    if (streams[id] !== st) break
                    send(id, DATA, buf.copyOf(n))
                }
            } catch (_: IOException) {
            } catch (_: InterruptedException) {
            }
            finish(id, true)
        }

        private fun finish(id: Int, tell: Boolean) {
            val st = streams.remove(id) ?: return
            if (tell && alive) runCatching { send(id, END) }
            runCatching { st.sock.close() }
            st.inbox.offer(ENDED)
            synchronized(st) { (st as java.lang.Object).notifyAll() }
        }

        // On the link's reader thread, one frame at a time.
        fun take(packet: ByteArray) {
            val pt = try { inn.open(packet) } catch (e: Exception) { dead(); return }
            if (pt.size < 5) return
            val b = ByteBuffer.wrap(pt)
            val id = b.getInt()
            val type = b.get()
            val st = streams[id] ?: return
            when (type) {
                DATA -> st.inbox.put(pt.copyOfRange(5, pt.size))
                ACK -> if (pt.size == 9) synchronized(st) { st.unacked -= b.getInt().toLong() and 0xffffffffL; (st as java.lang.Object).notifyAll() }
                // After whatever is still waiting to be written.
                END -> st.inbox.put(ENDED)
            }
        }

        // Frames are numbered by the order they're sealed in, so sealing and
        // sending happen under one lock.
        @Synchronized fun send(id: Int, type: Byte, data: ByteArray = ByteArray(0)) {
            if (!alive) throw IOException("tunnel closed")
            val f = ByteBuffer.allocate(5 + data.size).putInt(id).put(type).put(data).array()
            link.send(out.seal(f))
        }

        fun retire() = thread(name = "tunnel-retire", isDaemon = true) {
            val end = System.nanoTime() + RETIRE_NANOS
            while (alive && streams.isNotEmpty() && System.nanoTime() < end) Thread.sleep(500)
            dead()
        }

        fun dead() {
            if (!alive) return
            alive = false
            for (id in streams.keys.toList()) finish(id, false)
            link.close()
        }

        companion object {
            fun start(link: Link, sp: Spec, ms: Long): Session {
                try {
                    val gen = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
                    val e = gen.generateKeyPair()
                    val pub = e.public as ECPublicKey
                    val ep = point(pub)
                    link.send(byteArrayOf(HELLO) + ep)
                    val reply = link.first(ms)
                    if (reply.size != 1 + 65 + 3 + 16 || reply[0] != WELCOME) throw WrongKey()
                    val ec = reply.copyOfRange(1, 66)
                    val agree = { other: ByteArray -> KeyAgreement.getInstance("ECDH").run { init(e.private); doPhase(key(other, pub.params), true); generateSecret() } }
                    val okm = hkdf(sp.pass, agree(sp.key) + agree(ec), LABEL + ep + ec + sp.key, 64)
                    val s = Session(link, sp, okm.copyOfRange(0, 32), okm.copyOfRange(32, 64))
                    val ok = try { String(s.inn.open(reply.copyOfRange(66, reply.size))) } catch (x: Exception) { "" }
                    if (ok != "lab") throw WrongKey()
                    link.session = s
                    return s
                } catch (x: IOException) {
                    link.close(); throw x
                } catch (x: Exception) {
                    link.close(); throw WrongKey()
                }
            }
        }
    }

    companion object {
        private const val TAG = "Lab"
        private const val HELLO: Byte = 1
        private const val WELCOME: Byte = 2
        private const val OPEN: Byte = 1
        private const val DATA: Byte = 2
        private const val END: Byte = 3
        private const val ACK: Byte = 4
        private const val CHUNK = 32 * 1024
        private const val WINDOW = 1024 * 1024
        private const val ACK_EVERY = 64 * 1024
        private const val MAX_PACKET = 256 * 1024
        private val LABEL = "the lab tunnel 1".toByteArray()
        private val RELAY = Regex("^https?://[A-Za-z0-9.-]+(:\\d{1,5})?/?$")
        private val ADDRESS = Regex("^[0-9.]{7,15}:\\d{1,5}$")
        private val LOOPBACK = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        private val ENDED = ByteArray(0)
        private const val HEAD_START = 1200L
        private const val RETIRE_NANOS = 60_000_000_000L
        // No pings of its own. The event stream's ping crosses this socket every 25 s,
        // and Hub drops the session once that goes quiet, so a second heartbeat only
        // wakes the radio more often.
        private val ws = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()
        // The waiting socket carries nothing else, so its pings keep a mobile
        // network from forgetting it and notice when it's gone.
        private val waitClient = ws.newBuilder().pingInterval(4, TimeUnit.MINUTES).build()

        private fun point(k: ECPublicKey): ByteArray {
            fun fixed(n: BigInteger) = n.toByteArray().let { b -> if (b.size > 32) b.copyOfRange(b.size - 32, b.size) else ByteArray(32 - b.size) + b }
            return byteArrayOf(4) + fixed(k.w.affineX) + fixed(k.w.affineY)
        }

        private fun key(raw: ByteArray, params: ECParameterSpec) =
            KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65))), params))

        private fun hkdf(salt: ByteArray, ikm: ByteArray, info: ByteArray, len: Int): ByteArray {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(salt, "HmacSHA256"))
            val prk = mac.doFinal(ikm)
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            val out = ByteArrayOutputStream()
            var t = ByteArray(0)
            var i = 1
            while (out.size() < len) {
                mac.update(t); mac.update(info); mac.update(i.toByte())
                t = mac.doFinal()
                out.write(t)
                i++
            }
            return out.toByteArray().copyOf(len)
        }

        private fun b64(b: ByteArray) = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b)
        private fun unb64(s: String) = java.util.Base64.getUrlDecoder().decode(s)
    }
}
