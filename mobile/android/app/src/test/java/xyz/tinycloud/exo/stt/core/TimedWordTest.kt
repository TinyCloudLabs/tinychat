package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class TimedWordTest {
    @Test fun paddingShiftsTokenTimingBackToSource() {
        val words = TokenWordAlignment.align(arrayOf("▁Good", "▁morning"), floatArrayOf(.55f, .9f),
            floatArrayOf(.2f, .3f), origin = 10.0 - .5)
        assertEquals("Good morning", words.joinToString(" ") { it.text })
        assertEquals(10.05, words[0].start, .00001)
    }

    @Test fun multiTokenWordsUseLastTokenEnd() {
        val words = TokenWordAlignment.align(arrayOf("▁Go", "od", "▁morn", "ing"),
            floatArrayOf(0f, .2f, .5f, .8f), floatArrayOf(.15f, .1f, .2f, .3f), 10.0)
        assertEquals(listOf("Good", "morning"), words.map { it.text })
        assertEquals(10.0, words[0].start, .00001)
        assertEquals(10.3, words[0].end, .00001)
        assertEquals(10.5, words[1].start, .00001)
        assertEquals(11.1, words[1].end, .00001)
    }

    @Test fun tokenTimingCountMismatchFails() {
        assertThrows(IllegalArgumentException::class.java) {
            TokenWordAlignment.align(arrayOf("▁Go", "od"), floatArrayOf(0f), floatArrayOf(.1f, .1f), 0.0)
        }
    }

    @Test fun attributionUsesCoveringNearestThenPrevious() {
        val words = listOf(TimedWord(.2, .4, "one"), TimedWord(2.4, 2.5, "two"),
            TimedWord(3.0, 3.2, "three"), TimedWord(4.0, 4.2, "four"))
        val turns = listOf(SpeakerTurn(0.0, 1.0, "A"), SpeakerTurn(1.7, 2.0, "B"))
        assertEquals(listOf("A", "B", "B", "B"), SpeakerAttribution.assign(words, turns).map { it.speaker })
    }
}
