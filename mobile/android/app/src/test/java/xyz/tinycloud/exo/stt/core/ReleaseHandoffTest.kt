package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseHandoffTest {
    @Test fun returnsImmediatelyWhenNothingIsRunning() {
        val handoff = ReleaseHandoff()
        val elapsed = timeMillis { handoff.awaitRelease(1000) }
        assertTrue("should not have waited at all: ${elapsed}ms", elapsed < 100)
    }

    @Test fun returnsAsSoonAsReleaseHappensWellBeforeTheBound() {
        val handoff = ReleaseHandoff()
        val started = handoff.begin()
        Thread { Thread.sleep(50); handoff.release(started) }.start()
        val elapsed = timeMillis { handoff.awaitRelease(5000) }
        assertTrue("should have returned promptly once released, not waited for the full bound: ${elapsed}ms", elapsed < 1000)
    }

    @Test fun neverWaitsPastTheBoundWhenReleaseNeverHappens() {
        val handoff = ReleaseHandoff()
        handoff.begin() // never released: simulates a VAD segment's uninterruptible recognize() call
        val elapsed = timeMillis { handoff.awaitRelease(150) }
        assertTrue("must not wait past the bound: ${elapsed}ms", elapsed in 140..2000)
    }

    @Test fun aSecondBeginReplacesTheFirstSoAFreshUnitOfWorkGetsItsOwnHandoff() {
        val handoff = ReleaseHandoff()
        val first = handoff.begin()
        handoff.release(first)
        val second = handoff.begin()
        Thread { Thread.sleep(50); handoff.release(second) }.start()
        val elapsed = timeMillis { handoff.awaitRelease(5000) }
        assertTrue("should track the second, still-live unit of work: ${elapsed}ms", elapsed < 1000)
    }

    private fun timeMillis(block: () -> Unit): Long {
        val start = System.currentTimeMillis()
        block()
        return System.currentTimeMillis() - start
    }
}
