package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AttemptGuardTest {
    @Test fun proceedsWithAnIncrementingAttemptNumberUpToTheCap() {
        var attempts = 0
        for (expected in 1..AttemptGuard.MAX_ATTEMPTS) {
            val decision = AttemptGuard.next(attempts)
            assertTrue(decision is AttemptGuard.Decision.Proceed)
            val proceed = decision as AttemptGuard.Decision.Proceed
            assertEquals(expected, proceed.attempt)
            attempts = proceed.attempt
        }
    }

    @Test fun givesUpOncePreviousAttemptsReachesTheCap() {
        val decision = AttemptGuard.next(AttemptGuard.MAX_ATTEMPTS)
        assertTrue(decision is AttemptGuard.Decision.GiveUp)
    }

    @Test fun neverProceedsAgainOnceItHasGivenUp() {
        // A crash that never updates `previousAttempts` past the cap must still never resume:
        // simulates a note that keeps crashing at the same attempt count forever.
        repeat(5) {
            val decision = AttemptGuard.next(AttemptGuard.MAX_ATTEMPTS + 10)
            assertTrue(decision is AttemptGuard.Decision.GiveUp)
        }
    }
}
