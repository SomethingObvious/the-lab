package com.somethingobvious.thelab

import org.junit.Assert.assertEquals
import org.junit.Test

class HubTest {
    @Test fun takesTheCursorFromTheNewestEventOnDisk() {
        val lines = listOf("""{"id":7,"kind":"you"}""", """{"id":9,"kind":"reply"}""", """{"id":8,"kind":"step"}""")
        assertEquals(9L, newestId(readHistory(lines)))
    }

    @Test fun skipsATornLastLine() {
        val read = readHistory(listOf("""{"id":3,"kind":"reply"}""", """{"id":4,"ki"""))
        assertEquals(1, read.size)
        assertEquals(3L, newestId(read))
    }

    @Test fun startsFromNothingWithNoHistory() {
        assertEquals(0L, newestId(readHistory(emptyList())))
    }

    @Test fun keepsTryingUntilTheComputerAnswers() {
        for (code in listOf(-1, 401, 408, 429, 500, 502, 503)) assertEquals("$code", SendOutcome.RETRY, sendOutcome(code))
    }

    @Test fun givesUpOnAMessageTheComputerTurnedDown() {
        for (code in listOf(400, 404, 413)) assertEquals("$code", SendOutcome.REFUSED, sendOutcome(code))
    }

    @Test fun clearsAMessageTheComputerTook() {
        for (code in listOf(200, 202)) assertEquals("$code", SendOutcome.SENT, sendOutcome(code))
    }

    @Test fun retriesQuicklyAfterABlipThenSettlesDown() {
        assertEquals(listOf(2000L, 4000L, 8000L, 16_000L, 30_000L, 30_000L, 60_000L), listOf(1, 2, 3, 4, 5, 9, 10).map { backoff(it, false, 0.5) })
        assertEquals(300_000L, backoff(12, true, 0.5))
        assertEquals(16_000L, backoff(4, true, 0.5))
        assertEquals(1600L to 2400L, backoff(1, false, 0.0) to backoff(1, false, 1.0))
    }
}
