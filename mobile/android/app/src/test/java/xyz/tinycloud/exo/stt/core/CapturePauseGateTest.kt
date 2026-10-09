package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CapturePauseGateTest {
    @Test fun idleBeforeAnyCapture() {
        assertFalse(CapturePauseGate().isActive())
    }

    @Test fun activeAsSoonAsCaptureStarts() {
        val gate = CapturePauseGate()
        gate.captureStarted()
        assertTrue(gate.isActive())
    }

    @Test fun staysActiveThroughAPauseResumeCycleWithinTheSameSession() {
        // A paused capture session still counts as capture (plan §2.5): CaptureEngine pushes
        // captureStarted() again on resume-from-interruption paths too, and that must not look
        // like a fresh session the gate has to "re-arm" from a cleared state.
        val gate = CapturePauseGate()
        gate.captureStarted()
        gate.captureStarted()
        assertTrue(gate.isActive())
    }

    @Test fun clearsOnlyOnCaptureEnded() {
        val gate = CapturePauseGate()
        gate.captureStarted()
        gate.captureEnded()
        assertFalse(gate.isActive())
    }

    @Test fun captureEndedWithoutAPriorStartIsANoOpNotAnError() {
        val gate = CapturePauseGate()
        gate.captureEnded()
        assertFalse(gate.isActive())
    }
}
