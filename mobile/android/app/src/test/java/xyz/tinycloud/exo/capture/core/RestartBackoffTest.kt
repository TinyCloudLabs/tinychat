package xyz.tinycloud.exo.capture.core

import org.junit.Assert.*
import org.junit.Test

class RestartBackoffTest {
    @Test fun exhaustedSessionDoesNotConsumeTheNextRecordingBudget() {
        var now = 1_000L
        val delayed = mutableListOf<Long>()
        val backoff = RestartBackoff({ now }, {}, { delayed += it })
        backoff.interruptionEnded()
        now += 600_001
        assertFalse(backoff.failedAttempt())
        backoff.reset() // Stop, then a new start.
        now += 60_000
        backoff.interruptionEnded()
        assertTrue(backoff.failedAttempt())
        assertEquals(listOf(500L), delayed)
    }
    @Test fun stopWithinFiveSecondsOfRestartClearsTheNextSessionsWindow() {
        var now = 1_000L
        val delayed = mutableListOf<Long>()
        val backoff = RestartBackoff({ now }, {}, { delayed += it })
        backoff.interruptionEnded()
        assertTrue(backoff.failedAttempt())
        now += 1_000 // Restart succeeded, then Stop before the five-second healthy mark.
        backoff.reset()
        now += 600_000
        backoff.interruptionEnded()
        assertTrue(backoff.failedAttempt())
        assertEquals(listOf(500L, 500L), delayed)
    }
    @Test fun interruptionEndRestampsAnAttemptMadeDuringALongCall() {
        var now = 1_000L
        val delayed = mutableListOf<Long>()
        val backoff = RestartBackoff({ now }, {}, { delayed += it })
        backoff.interruptionEnded()
        assertTrue(backoff.failedAttempt()) // An app-active attempt while the call continues.
        now += 12 * 60_000
        backoff.interruptionEnded()
        assertTrue(backoff.failedAttempt())
        assertEquals(listOf(500L, 500L), delayed)
    }
    @Test fun quickFailuresKeepTheOriginalTenMinuteBudget() {
        var now = 1_000L
        val delayed = mutableListOf<Long>()
        val backoff = RestartBackoff({ now }, {}, { delayed += it })
        backoff.interruptionEnded()
        repeat(4) {
            now += 1_000
            assertTrue(backoff.failedAttempt())
            // A successful restart followed by a quick failure uses the engine's
            // quick path, which calls failedAttempt without interruptionEnded.
        }
        assertEquals(listOf(500L, 1000L, 2000L, 5000L), delayed)
        now += 600_000
        assertFalse(backoff.failedAttempt())
    }
    @Test fun twelveMinuteInterruptionGetsAnImmediateRestartAndAFullRetryWindow() {
        var now = 1_000L
        var immediate = 0
        val delayed = mutableListOf<Long>()
        val backoff = RestartBackoff({ now }, { immediate++ }, { delayed += it })
        val transitions = TransitionMachine().apply { start(); acquired(gen) }
        transitions.send(TransitionMachine.Event.INTERRUPTION_BEGAN)

        now += 12 * 60_000
        backoff.interruptionEnded()
        assertEquals(1, immediate)
        assertTrue(delayed.isEmpty())
        assertEquals(TransitionMachine.Availability.INTERRUPTED, transitions.availability)
        assertTrue(transitions.send(TransitionMachine.Event.INTERRUPTION_ENDED))
        assertTrue(transitions.acquired(transitions.gen))
        assertEquals(TransitionMachine.Availability.AVAILABLE, transitions.availability)

        // A failed first attempt still receives backoff after the long call.
        assertTrue(backoff.failedAttempt())
        assertEquals(listOf(500L), delayed)
    }

    @Test fun routeChangePostsItsFirstRestartWithoutAScheduledDelay() {
        var now = 5_000L
        var immediate = 0
        val delayed = mutableListOf<Long>()
        val backoff = RestartBackoff({ now }, { immediate++ }, { delayed += it })
        val transitions = TransitionMachine().apply { start(); acquired(gen) }
        transitions.send(TransitionMachine.Event.ROUTE_CHANGE)

        backoff.interruptionEnded()
        assertEquals(1, immediate)
        assertTrue(delayed.isEmpty())
        assertEquals(TransitionMachine.Availability.INTERRUPTED, transitions.availability)

        now += 20
        assertTrue(backoff.failedAttempt())
        assertEquals(listOf(500L), delayed)
    }
}
