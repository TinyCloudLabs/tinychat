package xyz.tinycloud.exo.capture.core

import org.junit.Assert.*
import org.junit.Test
import xyz.tinycloud.exo.capture.core.TransitionMachine.Event.*

class TransitionMachineTest {
    @Test fun everyEventInRecordingColumnMatchesTheTransitionTable() {
        for (event in TransitionMachine.Event.values()) {
            val m = TransitionMachine()
            m.start(); m.acquired(m.gen)
            val gen = m.gen
            val epoch = m.epoch
            val startNeeded = m.send(event)
            assertEquals(event == ROUTE_CHANGE, startNeeded)
            assertEquals(when (event) {
                PAUSE -> TransitionMachine.Intent.PAUSED
                STOP, DISCARD -> TransitionMachine.Intent.STOPPED
                else -> TransitionMachine.Intent.RECORDING
            }, m.intent)
            assertEquals(when (event) {
                INTERRUPTION_BEGAN, MEDIA_RESET, STALL -> TransitionMachine.Availability.INTERRUPTED
                BACKOFF_EXHAUSTED -> TransitionMachine.Availability.BLOCKED
                else -> TransitionMachine.Availability.AVAILABLE
            }, m.availability)
            assertEquals(epoch + if (event == PAUSE || event == STOP || event == DISCARD) 1 else 0, m.epoch)
            assertEquals(gen + if (event in listOf(PAUSE, STOP, DISCARD, INTERRUPTION_BEGAN,
                    MEDIA_RESET, STALL, ROUTE_CHANGE)) 1 else 0, m.gen)
        }
    }

    @Test fun everyEventInEveryIntentPreservesTheStoppedAndPausedColumns() {
        for (event in TransitionMachine.Event.values()) {
            val stopped = TransitionMachine()
            assertFalse(stopped.send(event))
            assertEquals(TransitionMachine.Intent.STOPPED, stopped.intent)
            val paused = TransitionMachine().apply { start(); acquired(gen); send(PAUSE) }
            val oldEpoch = paused.epoch
            val attempt = paused.gen
            val shouldStart = paused.send(event)
            assertEquals(event == RESUME, shouldStart)
            assertEquals(if (event == RESUME) TransitionMachine.Intent.RECORDING else if (event == STOP || event == DISCARD)
                TransitionMachine.Intent.STOPPED else TransitionMachine.Intent.PAUSED, paused.intent)
            if (event != RESUME && event != STOP && event != DISCARD) {
                assertEquals(oldEpoch, paused.epoch)
                assertEquals(attempt, paused.gen)
            }
        }
    }

    @Test fun recordingColumnAndNotificationEpoch() {
        val m = TransitionMachine()
        assertTrue(m.acquired(m.start()))
        for (event in listOf(INTERRUPTION_BEGAN, MEDIA_RESET, STALL)) {
            val epoch = m.epoch
            m.send(event)
            assertEquals(TransitionMachine.Availability.INTERRUPTED, m.availability)
            assertEquals(epoch, m.epoch)
            assertTrue(m.send(INTERRUPTION_ENDED))
            assertTrue(m.acquired(m.gen))
            assertEquals(epoch + 1, m.epoch)
        }
        m.send(SILENCED); assertTrue(m.silenced)
        assertTrue(m.send(ROUTE_CHANGE)); assertTrue(m.acquired(m.gen))
        assertFalse(m.silenced)
        assertFalse(m.send(RESUME)); assertFalse(m.send(APP_ACTIVE))
        m.send(BACKOFF_EXHAUSTED)
        assertEquals(TransitionMachine.Availability.BLOCKED, m.availability)
        assertTrue(m.send(RESUME))
    }

    @Test fun inFlightStartIsInvalidatedByPauseStopAndDiscard() {
        for (event in listOf(PAUSE, STOP, DISCARD)) {
            val m = TransitionMachine(); val attempt = m.start(); val epoch = m.epoch
            m.send(event)
            assertFalse(m.accepts(attempt))
            assertFalse(m.acquired(attempt))
            assertEquals(epoch + 1, m.epoch)
        }
    }

    @Test fun failedAttemptKeepsEpochForAValidRetryAction() {
        val m = TransitionMachine(); m.start(); m.acquired(m.gen)
        m.send(PAUSE); m.send(RESUME)
        val epoch = m.epoch
        assertTrue(m.failed(m.gen))
        assertEquals(epoch, m.epoch)
        assertTrue(m.send(RESUME))
        assertTrue(m.acquired(m.gen))
        assertEquals(epoch + 1, m.epoch)
    }
}
