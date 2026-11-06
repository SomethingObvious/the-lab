package com.somethingobvious.thelab

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellTest {
    @Test fun keepsThePageAwayFromAnsweringAndPairing() {
        for (p in listOf(
            "/answer", "/ANSWER", "/answer/", "//answer", "/./answer", "/memory/../answer",
            "/%61nswer", "/%2561nswer", "/%252561nswer", "/x/%2e%2e/answer", "/x/%2E%2E/Answer",
            "/asks", "/asks/toolu_1", "/Asks/x", "/asks%2Fx", "/pair", "/pair?t=abc", "/pair/claim",
            "/PAIR-PHONE", "/pair-phone?x=1", "/push/register", "/PUSH/unregister",
            "/memory\\..\\answer", "/answer?x=1?y=2", "/answer%3Fx", "/answer#x", "/memory%", "/memory%zz",
            "/answer%00", "/%",
        )) assertTrue(p, closedToPage(p))
    }

    @Test fun leavesThePageItsOwnRoutes() {
        for (p in listOf("/memory", "/schedules", "/models?saved=1", "/check", "/pairs", "/answers", "/asksome",
            "/memory?q=answer", "/memory?next=/answer", "/files/r%C3%A9sum%C3%A9.png", "/settings"))
            assertFalse(p, closedToPage(p))
    }

    @Test fun takesOnlyAPlainFileName() {
        assertEquals("ab12cd34-photo.jpg", plainName("ab12cd34-photo.jpg"))
        assertEquals("...", plainName("..."))
        for (bad in listOf("", ".", "..", "x/../", "a/b", "a\\b", "/etc", "a\u0000b", "a\nb", "x".repeat(256)))
            assertNull(bad, plainName(bad))
    }

    @Test fun keepsAThemeThatChecksOut() {
        val t = cleanTheme(JSONObject("""{"bg":"#101010","dark":true,"topDark":false,"bottomDark":true,"head":"#5a2ee6","headHeight":64,"headRadius":12.5}"""))!!
        assertEquals("#101010", t.getString("bg"))
        assertEquals(true, t.getBoolean("dark"))
        assertEquals(false, t.getBoolean("topDark"))
        assertEquals("#5a2ee6", t.getString("head"))
        assertEquals(64.0, t.getDouble("headHeight"), 0.0)
        assertEquals(12.5, t.getDouble("headRadius"), 0.0)
    }

    @Test fun dropsTheHeaderBandWhenANumberIsOff() {
        for (bad in listOf(""""NaN"""", """"64"""", "-1", "1e999", "5000", "null", "true")) {
            val t = cleanTheme(JSONObject("""{"bg":"#101010","head":"#5a2ee6","headHeight":$bad}"""))!!
            assertEquals(bad, setOf("bg"), t.keys().asSequence().toSet())
        }
        val r = cleanTheme(JSONObject("""{"bg":"#101010","head":"#5a2ee6","headHeight":64,"headRadius":"NaN"}"""))!!
        assertEquals(setOf("bg"), r.keys().asSequence().toSet())
        val noRadius = cleanTheme(JSONObject("""{"bg":"#101010","head":"#5a2ee6","headHeight":64}"""))!!
        assertEquals(0.0, noRadius.getDouble("headRadius"), 0.0)
    }

    @Test fun refusesAThemeWithNoUsableBackground() {
        for (bg in listOf("\"red\"", "\"#12345\"", "\"#1234567g\"", "12", "null")) assertNull(bg, cleanTheme(JSONObject("""{"bg":$bg}""")))
        assertNull(cleanTheme(JSONObject("{}")))
        val t = cleanTheme(JSONObject("""{"bg":"#ffffff","dark":"yes"}"""))!!
        assertFalse(t.has("dark"))
    }
}
