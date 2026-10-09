package xyz.tinycloud.exo.capture.core

import org.junit.Assert.*
import org.junit.Test

class RestartBackoffTest {
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
