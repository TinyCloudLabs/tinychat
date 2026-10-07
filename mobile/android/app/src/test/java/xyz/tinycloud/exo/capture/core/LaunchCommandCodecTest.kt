package xyz.tinycloud.exo.capture.core

import org.junit.Assert.*
import org.junit.Test

class LaunchCommandCodecTest {
    @Test fun commandSurvivesRecreationAndExpiresAtThirtySeconds() {
        val value = LaunchCommandValue("command-a", "RECORD", "app_shortcut", 1_000)
        val stored = LaunchCommandCodec.encode(value)
        assertEquals(value, LaunchCommandCodec.pending(stored, 30_999))
        assertNull(LaunchCommandCodec.pending(stored, 31_000))
        assertNull(LaunchCommandCodec.pending(stored, 999))
    }

    @Test fun staleAccountGenerationIsRejected() {
        requireTransitionGeneration(12, 12)
        try { requireTransitionGeneration(11, 12); fail("stale generation accepted") }
        catch (e: IllegalStateException) { assertEquals("stale_transition", e.message) }
    }
}
