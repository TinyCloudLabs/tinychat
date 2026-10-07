package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Test

class TimedWordTest {
    @Test fun paddingShiftsTokenTimingBackToSource() {
        val words = TokenWordAlignment.align(arrayOf("▁Good", "▁morning"), floatArrayOf(.55f, .9f),
            floatArrayOf(.2f, .3f), origin = 10.0 - .5)
        assertEquals("Good morning", words.joinToString(" ") { it.text })
        assertEquals(10.05, words[0].start, .00001)
    }
}
