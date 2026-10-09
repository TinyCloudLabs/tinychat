package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CaptureYieldingLoopTest {
    private fun loopOver(pending: MutableList<String>, gate: CapturePauseGate, processed: MutableList<String>): Boolean =
        CaptureYieldingLoop.run(
            hasNext = { pending.isNotEmpty() },
            next = { pending.removeAt(0) },
            isPaused = { gate.isActive() },
        ) { unit -> processed.add(unit) }

    @Test fun drainsEverythingWhenNeverPaused() {
        val pending = mutableListOf("a", "b", "c")
        val processed = mutableListOf<String>()
        val completed = loopOver(pending, CapturePauseGate(), processed)
        assertTrue(completed)
        assertEquals(listOf("a", "b", "c"), processed)
        assertTrue(pending.isEmpty())
    }

    @Test fun releasesAfterTheCurrentUnitNotMidUnit() {
        // STT running -> capture starts: the gate flips active from inside the "a" unit's own
        // work (as a real recognize() call would notice mid-decode), not before it. The loop must
        // still let "a" finish — the running work unit is never interrupted, only the next one
        // is withheld (plan §2.5's "finishes and checkpoints, then everything is released").
        val pending = mutableListOf("a", "b", "c")
        val processed = mutableListOf<String>()
        val gate = CapturePauseGate()
        val completed = CaptureYieldingLoop.run(
            hasNext = { pending.isNotEmpty() },
            next = { pending.removeAt(0) },
            isPaused = { gate.isActive() },
        ) { unit ->
            processed.add(unit)
            if (unit == "a") gate.captureStarted() // noticed mid-"a", takes effect at the next checkpoint
        }
        assertFalse(completed)
        assertEquals(listOf("a"), processed)
        assertEquals(listOf("b", "c"), pending) // left exactly where it was, including "b" itself
    }

    @Test fun noReloadWhilePaused() {
        // Once paused, calling the loop again must not start a single further unit — modelling
        // "the queue stays idle while any capture session exists, including a paused one".
        val pending = mutableListOf("a", "b", "c")
        val processed = mutableListOf<String>()
        val gate = CapturePauseGate()
        gate.captureStarted()
        val first = loopOver(pending, gate, processed)
        val second = loopOver(pending, gate, processed) // pump() called again while still paused
        assertFalse(first)
        assertFalse(second)
        assertTrue(processed.isEmpty())
        assertEquals(listOf("a", "b", "c"), pending)
    }

    @Test fun resumesFromTheCheckpointAfterCaptureEnds() {
        val pending = mutableListOf("a", "b", "c")
        val processed = mutableListOf<String>()
        val gate = CapturePauseGate()
        val first = CaptureYieldingLoop.run(
            hasNext = { pending.isNotEmpty() },
            next = { pending.removeAt(0) },
            isPaused = { gate.isActive() },
        ) { unit ->
            processed.add(unit)
            if (unit == "a") gate.captureStarted()
        }
        assertFalse(first)
        assertEquals(listOf("a"), processed)

        gate.captureEnded() // Stop: the queue resumes from its checkpoint, not from the top.
        val second = loopOver(pending, gate, processed)
        assertTrue(second)
        assertEquals(listOf("a", "b", "c"), processed)
        assertTrue(pending.isEmpty())
    }

    @Test fun neverBlocks() {
        // Capture must never be blocked: the predicates are plain reads and `process` is the only
        // thing that can take real time, so a paused run returns practically instantly.
        val pending = mutableListOf("a")
        val gate = CapturePauseGate().also { it.captureStarted() }
        val startedAt = System.nanoTime()
        CaptureYieldingLoop.run(hasNext = { pending.isNotEmpty() }, next = { pending.removeAt(0) },
            isPaused = { gate.isActive() }) { }
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
        assertTrue("expected an effectively instant return, took ${elapsedMs}ms", elapsedMs < 50)
    }
}
