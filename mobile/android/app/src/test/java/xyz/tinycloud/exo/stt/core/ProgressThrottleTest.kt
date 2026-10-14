package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProgressThrottleTest {
    @Test fun fastWindowsEmitAtMostFourWholePercentUpdatesPerSecond() {
        val gate = ProgressThrottle()
        val emitted = mutableListOf<Pair<Long, Int>>()
        for (window in 0..3100) {
            val now = window * 32_000_000L
            val percent = (window * 100 / 3100).coerceAtMost(99)
            if (gate.event(percent, now)) emitted.add(now to percent)
        }
        assertTrue(emitted.size <= 100)
        assertTrue(emitted.zipWithNext().all { (a, b) -> b.first - a.first >= 250_000_000L && b.second > a.second })
        assertEquals(0, gate.completionDelayMillis(emitted.last().first + 250_000_000L))
    }

    @Test fun sidecarCheckpointsAreFiveSecondsApart() {
        val gate = ProgressThrottle()
        assertTrue(gate.checkpoint(0))
        assertFalse(gate.checkpoint(4_999_999_999L))
        assertTrue(gate.checkpoint(5_000_000_000L))
    }
}
