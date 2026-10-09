package xyz.tinycloud.exo.capture.core

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class RecoveryCoordinatorTest {
    @Test fun listPendingWaitsForLaunchScanWithoutRescanning() {
        val recovery = RecoveryCoordinator()
        val scans = AtomicInteger()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val listed = CountDownLatch(1)
        val launch = Thread { recovery.beginLaunch({ it() }) {
            scans.incrementAndGet(); entered.countDown(); release.await()
        } }
        launch.start()
        try {
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            recovery.beginLaunch({ it() }) { scans.incrementAndGet() }
            val reader = Thread { recovery.await(); listed.countDown() }
            reader.start()
            assertFalse(listed.await(100, TimeUnit.MILLISECONDS))
            release.countDown()
            assertTrue(listed.await(2, TimeUnit.SECONDS))
            repeat(5) { recovery.await() } // listPending's path reads; it never runs recovery.
            assertEquals(1, scans.get())
            recovery.explicit { scans.incrementAndGet() } // retryRecovery is an explicit trigger.
            assertEquals(2, scans.get())
            reader.join(2_000)
        } finally {
            release.countDown()
            launch.join(2_000)
        }
    }
}
