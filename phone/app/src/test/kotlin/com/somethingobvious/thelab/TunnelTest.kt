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
    private val conf: Map<String, String> = System.getenv("LAB_TUNNEL_TEST")?.let { f ->
        File(f).readLines().filter { '=' in it }.associate { it.substringBefore('=') to it.substringAfter('=') }
    } ?: emptyMap()
    private val http = OkHttpClient()
    private fun spec(pass: String = conf.getValue("pass")) = Tunnel.Spec(
        conf["relay"], conf.getValue("room"), Base64.getUrlDecoder().decode(conf.getValue("key")),
        Base64.getUrlDecoder().decode(pass), conf.getValue("lan").split(',').filter { it.isNotBlank() },
    )
    private fun get(path: String) = http.newCall(Request.Builder().url(Tunnel.base() + path).build()).execute().use { it.body.bytes() }

    private fun roundTrip(route: String) {
        assertEquals("ok", String(get("/health")))
        assertEquals(route, Tunnel.route)
        val up = http.newCall(Request.Builder().url(Tunnel.base() + "/up").post(ByteArray(2_000_000) { 1 }.toRequestBody()).build()).execute().use { it.body.string() }
        assertEquals("got 2000000", up)
        assertArrayEquals(ByteArray(3 * 1024 * 1024) { 7 }, get("/big"))
    }

    @Test fun carriesHttpStraightAndThroughTheRelay() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        Tunnel.direct = { true }
        Tunnel.spec = spec()
        roundTrip("direct")

        Tunnel.direct = { false }
        Tunnel.spec = spec()
        roundTrip("relay")
    }

    @Test fun turnsAwayAComputerWithTheWrongKey() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        Tunnel.direct = { true }
        val wrong = spec(Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32)))
        Tunnel.spec = wrong
        assertThrows(IOException::class.java) { get("/health") }
        assertEquals("key", Tunnel.why)
        // Straight over the Wi-Fi alone, too.
        Tunnel.spec = Tunnel.Spec(null, wrong.room, wrong.key, wrong.pass, wrong.lan)
        assertThrows(IOException::class.java) { get("/health") }
        assertEquals("key", Tunnel.why)
    }

    @Test fun aClaimGoesToTheNewComputerAndNothingElseDoes() {
        assumeTrue("set LAB_TUNNEL_TEST to run against computer/tunnel.ts", conf.isNotEmpty())
        Tunnel.direct = { true }
        Tunnel.spec = null
        val once = Tunnel.once(spec())
        assertEquals("ok", http.newCall(Request.Builder().url("$once/health").header("Connection", "close").build()).execute().use { it.body.string() })
        assertEquals(null, Tunnel.route)
        assertThrows(IOException::class.java) { http.newCall(Request.Builder().url("$once/health").header("Connection", "close").build()).execute() }
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
