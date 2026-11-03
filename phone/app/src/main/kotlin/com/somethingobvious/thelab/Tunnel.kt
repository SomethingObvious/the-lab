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
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
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
object Tunnel {
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

    class Spec(val relay: String?, val room: String, val key: ByteArray, val pass: ByteArray, val lan: List<String>) {
        fun json(): JSONObject = JSONObject().put("relay", relay ?: JSONObject.NULL).put("room", room)
            .put("key", b64(key)).put("pass", b64(pass)).put("lan", JSONArray(lan))

        companion object {
            fun parse(j: JSONObject): Spec? = runCatching {
                val lan = j.optJSONArray("lan")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
                Spec(j.optString("relay").takeIf { it.isNotBlank() && it != "null" }, j.getString("room"), unb64(j.getString("key")), unb64(j.getString("pass")), lan)
                    .takeIf { it.key.size == 65 && it.pass.size == 32 }
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
        set(v) { field = v; drop() }
    // The newest addresses the computer sent, ahead of the ones from pairing.
    @Volatile var lan: List<String> = emptyList()

    // Making a session can take 10 seconds, so it has its own lock, and
    // the main thread only ever takes the quick one for the port.
    private val dialing = java.lang.Object()
    private val lock = java.lang.Object()
    private var server: ServerSocket? = null
    @Volatile private var session: Session? = null
    private val ws = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).build()

    fun base(): String = synchronized(lock) {
        val s = server ?: ServerSocket(0, 50, InetAddress.getLoopbackAddress()).also { ss ->
            server = ss
            thread(name = "tunnel", isDaemon = true) {
                while (!ss.isClosed) {
                    val sock = try { ss.accept() } catch (e: IOException) { break }
                    thread(name = "tunnel-stream", isDaemon = true) { carry(sock) }
                }
            }
        }
        "http://127.0.0.1:${s.localPort}"
    }

    // Ends the session, so the next connection picks its route again. Called
    // when the phone changes network, which is when a direct route can appear.
    fun drop() {
        val old = session
        session = null
        route = null
        old?.dead()
    }

    private fun carry(sock: Socket) {
        val s = try { session() } catch (e: IOException) {
            Log.i(TAG, "tunnel: ${e.message}")
            runCatching { sock.close() }
            return
        }
        s.carry(sock)
    }

    private fun session(): Session { synchronized(dialing) {
        val sp = spec ?: throw IOException("not paired")
        session?.takeIf { it.alive && it.spec === sp }?.let { return it }
        if (direct()) for (a in lan.ifEmpty { sp.lan }.take(4)) {
            try {
                return Session.start(TcpLink(a), sp, 2000).also { session = it; route = "direct"; why = "" }
            } catch (e: IOException) {
                Log.i(TAG, "tunnel: $a didn't answer (${e.message})")
            }
        }
        val relay = sp.relay ?: run { why = "none"; throw IOException("no address answered and there is no relay") }
        try {
            return Session.start(WsLink("${relay.trimEnd('/').replaceFirst(Regex("^http"), "ws")}/r/${sp.room}", ws), sp, 10_000)
                .also { session = it; route = "relay"; why = "" }
        } catch (e: Away) {
            why = "away"; throw e
        } catch (e: WrongKey) {
            why = "key"; throw e
        } catch (e: IOException) {
            why = "relay"; throw e
        }
    } }

    // A test on the computer has no Android network to ask.
    internal var direct: () -> Boolean = ::local

    // On mobile data a local address can only time out, so it isn't tried.
    // Tailscale shows as a VPN, and its addresses are worth trying too.
    private fun local(): Boolean {
        val cm = Hub.app.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    class Away : IOException("The computer isn't connected to the relay.")
    class WrongKey : IOException("The answer didn't come from the paired computer.")

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

    private class Stream(val sock: Socket) {
        var unacked = 0L
        var pending = 0
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
                DATA -> try {
                    st.sock.getOutputStream().write(pt, 5, pt.size - 5)
                    st.pending += pt.size - 5
                    if (st.pending >= ACK_EVERY) {
                        send(id, ACK, ByteBuffer.allocate(4).putInt(st.pending).array())
                        st.pending = 0
                    }
                } catch (e: IOException) {
                    finish(id, true)
                }
                ACK -> if (pt.size == 9) synchronized(st) { st.unacked -= b.getInt().toLong() and 0xffffffffL; (st as java.lang.Object).notifyAll() }
                END -> finish(id, false)
            }
        }

        // Frames are numbered by the order they're sealed in, so sealing and
        // sending happen under one lock.
        @Synchronized fun send(id: Int, type: Byte, data: ByteArray = ByteArray(0)) {
            if (!alive) throw IOException("tunnel closed")
            val f = ByteBuffer.allocate(5 + data.size).putInt(id).put(type).put(data).array()
            link.send(out.seal(f))
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
