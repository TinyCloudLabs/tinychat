package xyz.tinycloud.exo.stt.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Coordinates capture-start against an in-progress on-device decode (plan capture-priority
 * handoff, §2.5). Capture must never wait unboundedly for STT to release its native engine: a
 * single VAD segment's recognize() call isn't interruptible mid-call, so the most STT can promise
 * is to release at its next checkpoint. [awaitRelease] blocks up to a bound either way, so a long
 * recognize() call can never delay the microphone opening indefinitely — capture always wins.
 */
internal class ReleaseHandoff {
    @Volatile private var latch: CountDownLatch? = null

    /** Called when STT begins a unit of work that holds its native engine; pair with [release]. */
    fun begin(): CountDownLatch = CountDownLatch(1).also { latch = it }

    /** Called once STT has released its native engine. */
    fun release(started: CountDownLatch) {
        started.countDown()
        if (latch === started) latch = null
    }

    /** Called by capture before opening the mic. Returns as soon as STT releases, or after
     * [timeoutMs] — whichever comes first; capture proceeds either way. */
    fun awaitRelease(timeoutMs: Long) {
        latch?.await(timeoutMs, TimeUnit.MILLISECONDS)
    }
}
