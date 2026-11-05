package com.somethingobvious.thelab

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.Base64

// Talks to a real computer/tunnel.ts, so it only runs when LAB_TUNNEL_TEST
// names a file of key=value lines (relay, room, key, pass, lan) for one that
// fronts a server answering /health, /big with 3 MB of 7s and POST /up with
// "got" and the byte count.
class TunnelTest {
    private val tunnel = Tunnel()
    private val conf: Map<String, String> = System.getenv("LAB_TUNNEL_TEST")?.let { f ->
        File(f).readLines().filter { '=' in it }.associate { it.substringBefore('=') to it.substringAfter('=') }
    } ?: emptyMap()
    private val http = OkHttpClient()
    private fun spec(pass: String = conf.getValue("pass")) = Tunnel.Spec(
        conf["relay"], conf.getValue("room"), Base64.getUrlDecoder().decode(conf.getValue("key")),
        Base64.getUrlDecoder().decode(pass), conf.getValue("lan").split(',').filter { it.isNotBlank() },
    )
    private fun get(path: String) = http.newCall(Request.Builder().url(tunnel.base() + path).build()).execute().use { it.body.bytes() }

    private fun roundTrip(route: String) {
        assertEquals("ok", String(get("/health")))
        assertEquals(route, tunnel.route)
        val up = http.newCall(Request.Builder().url(tunnel.base() + "/up").post(ByteArray(2_000_000) { 1 }.toRequestBody()).build()).execute().use { it.body.string() }
        assertEquals("got 2000000", up)
        assertArrayEquals(ByteArray(3 * 1024 * 1024) { 7 }, get("/big"))
    }

    @Test fun carriesHttpStraightAndThroughTheRelay() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        tunnel.direct = { true }
        tunnel.spec = spec()
        roundTrip("direct")

        tunnel.direct = { false }
        tunnel.spec = spec()
        roundTrip("relay")
    }

    @Test fun turnsAwayAComputerWithTheWrongKey() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        tunnel.direct = { true }
        val wrong = spec(Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32)))
        tunnel.spec = wrong
        assertThrows(IOException::class.java) { get("/health") }
        assertEquals("key", tunnel.why)
        // Straight over the Wi-Fi alone, too.
        tunnel.spec = Tunnel.Spec(null, wrong.room, wrong.key, wrong.pass, wrong.lan)
        assertThrows(IOException::class.java) { get("/health") }
        assertEquals("key", tunnel.why)
    }

    @Test fun aClaimGoesToTheNewComputerAndNothingElseDoes() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        tunnel.direct = { true }
        tunnel.spec = null
        val once = tunnel.once(spec())
        assertEquals("ok", http.newCall(Request.Builder().url("$once/health").header("Connection", "close").build()).execute().use { it.body.string() })
        assertEquals(null, tunnel.route)
        assertThrows(IOException::class.java) { http.newCall(Request.Builder().url("$once/health").header("Connection", "close").build()).execute() }
    }

    @Test fun aDownloadNobodyReadsDoesNotHoldUpTheRest() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        tunnel.direct = { true }
        tunnel.spec = spec()
        val port = tunnel.base().substringAfterLast(':').toInt()
        java.net.Socket("127.0.0.1", port).use { stuck ->
            stuck.getOutputStream().write("GET /big HTTP/1.1\r\nHost: lab\r\n\r\n".toByteArray())
            Thread.sleep(1500)
            val quick = http.newBuilder().callTimeout(10, java.util.concurrent.TimeUnit.SECONDS).build()
            assertEquals("ok", quick.newCall(Request.Builder().url(tunnel.base() + "/health").build()).execute().use { it.body.string() })
        }
    }

    @Test fun findsTheComputerOnTheWifiByItsRoom() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        tunnel.spec = null
        assertEquals(conf.getValue("lan").split(','), tunnel.discover(spec(), listOf("127.0.0.1")))
        val stranger = Tunnel.Spec(null, "someone-else", spec().key, spec().pass, spec().lan)
        assertEquals(emptyList<String>(), tunnel.discover(stranger, listOf("127.0.0.1")))
    }

    @Test fun requestsBehindAFailedDialFailFast() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        tunnel.direct = { true }
        tunnel.spec = Tunnel.Spec(null, spec().room, spec().key, spec().pass, listOf("127.0.0.1:1"))
        assertThrows(IOException::class.java) { get("/health") }
        assertEquals("none", tunnel.why)
        val t = System.nanoTime()
        assertThrows(IOException::class.java) { get("/health") }
        assert((System.nanoTime() - t) / 1_000_000 < 500) { "the second request dialed again" }
        // A new network starts the dial over.
        tunnel.drop()
        val t2 = System.nanoTime()
        assertThrows(IOException::class.java) { get("/health") }
        assert((System.nanoTime() - t2) / 1_000_000 >= 700) { "the dial after a drop was skipped" }
    }

    @Test fun theRelaySaysWhenTheComputerIsBack() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        // The test computer is on the relay, so it says "here" straight away.
        tunnel.spec = spec()
        val back = java.util.concurrent.CountDownLatch(1)
        tunnel.await { back.countDown() }
        assert(back.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "no here for a computer that's on the relay" }
        // A room with no computer holds the socket open and says nothing.
        val empty = java.util.concurrent.CountDownLatch(1)
        tunnel.spec = Tunnel.Spec(conf["relay"], "A".repeat(43), spec().key, spec().pass, spec().lan)
        tunnel.await { empty.countDown() }
        assertEquals(false, empty.await(3, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(true, tunnel.isWaiting)
        tunnel.stopWaiting()
        assertEquals(false, tunnel.isWaiting)
    }

    @Test fun aPairingLinkWithABadAddressIsTurnedDown() {
        val good = JSONObject().put("relay", "https://relay.example.workers.dev").put("room", "r").put("key", Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(65)))
            .put("pass", Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32))).put("lan", JSONArray().put("192.168.0.18:8418"))
        assertEquals("https://relay.example.workers.dev", Tunnel.Spec.parse(good)?.relay)
        assertEquals(null, Tunnel.Spec.parse(JSONObject(good.toString()).put("relay", "foo:bar")))
        assertEquals(null, Tunnel.Spec.parse(JSONObject(good.toString()).put("lan", JSONArray().put("192.168.0.18:99999"))))
        assertEquals(null, Tunnel.Spec.parse(JSONObject(good.toString()).put("lan", JSONArray().put("evil.example:80"))))
    }
}
