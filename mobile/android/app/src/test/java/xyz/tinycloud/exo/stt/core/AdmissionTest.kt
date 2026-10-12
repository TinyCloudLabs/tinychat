package xyz.tinycloud.exo.stt.core

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AdmissionTest {
    private val decodeThread = Executors.newSingleThreadExecutor()
    private val lane = Executors.newSingleThreadExecutor()
    private val work = WorkQueue()
    private val admission = Admission(work, lane)

    @After fun stop() {
        decodeThread.shutdownNow()
        lane.shutdownNow()
    }

    private class Outcome {
        val accepted = CountDownLatch(1)
        val answers = mutableListOf<String>()
        fun acceptedWith(inLine: Boolean) { answers.add("accepted:$inLine"); accepted.countDown() }
        fun failedWith(e: Exception) { answers.add("failed:${e.message}"); accepted.countDown() }
    }

    private fun enqueue(
        id: String,
        outcome: Outcome,
        sidecar: JSONObject = JSONObject().put("state", "waiting_for_model").put("attempts", 2),
        finished: () -> Boolean = { false },
        persist: () -> Unit = { ResumableWork.requested(sidecar) },
        woke: AtomicInteger = AtomicInteger(),
    ) = admission.enqueue(id, finished, persist, outcome::acceptedWith, outcome::failedWith, changed = {}, wake = { woke.incrementAndGet() })

    /** Note `a` is being decoded on the decode thread, which stays busy until the returned latch opens. */
    private fun decodingA(): CountDownLatch {
        work.admit("a", { false }, {})
        assertEquals("a", work.pop())
        val release = CountDownLatch(1)
        decodeThread.execute { release.await() }
        return release
    }

    @Test fun aNoteTappedDuringAnotherNotesDecodeIsPersistedAndAcknowledgedAtOnce() {
        val release = decodingA()
        val sidecar = JSONObject().put("state", "waiting_for_model").put("attempts", 2)
        val outcome = Outcome()
        val woke = AtomicInteger()
        enqueue("b", outcome, sidecar = sidecar, persist = { ResumableWork.requested(sidecar) }, woke = woke)

        assertTrue("acknowledged while the decode is still running", outcome.accepted.await(2, TimeUnit.SECONDS))
        assertEquals(1, release.count)
        assertEquals(listOf("accepted:true"), outcome.answers)
        // Durable before the ack: the ledger a restart reads says Local was chosen.
        assertEquals("queued", sidecar.getString("state"))
        assertTrue(sidecar.getBoolean("requested"))
        assertTrue(ResumableWork.owed(JSONObject().put("options", JSONObject().put("transcriber", "off")).put("stt", sidecar)))
        // The decode loop sees it: the running note first, then the new one, which it pops next.
        assertEquals(listOf("a", "b"), work.snapshotIds())
        assertTrue(work.hasNext())
        work.finish()
        assertEquals("b", work.pop())
        release.countDown()
    }

    @Test fun aNoteAlreadyQueuedOrDecodingKeepsItsAttemptAndIsNotPersistedAgain() {
        val release = decodingA()
        work.admit("b", { false }, {})
        val persisted = AtomicInteger()
        for (id in listOf("a", "b")) {
            val outcome = Outcome()
            enqueue(id, outcome, persist = { persisted.incrementAndGet() })
            assertTrue(outcome.accepted.await(2, TimeUnit.SECONDS))
            assertEquals(listOf("accepted:true"), outcome.answers)
        }
        assertEquals(0, persisted.get())
        assertEquals(listOf("a", "b"), work.snapshotIds())
        release.countDown()
    }

    @Test fun aNoteWithItsTranscriptIsAnsweredFalseAndNeverQueued() {
        val outcome = Outcome()
        val persisted = AtomicInteger()
        val woke = AtomicInteger()
        enqueue("done", outcome, finished = { true }, persist = { persisted.incrementAndGet() }, woke = woke)
        assertTrue(outcome.accepted.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("accepted:false"), outcome.answers)
        assertEquals(0, persisted.get())
        assertEquals(0, woke.get())
        assertFalse(work.hasNext())
    }

    @Test fun aRequestThatCannotBePersistedFailsOnceAndLeavesTheLineAlone() {
        val outcome = Outcome()
        enqueue("gone", outcome, persist = { throw IllegalStateException("not_found") })
        assertTrue(outcome.accepted.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("failed:not_found"), outcome.answers)
        assertFalse(work.hasNext())
        assertNull(work.snapshotIds().firstOrNull())
    }

    @Test fun aNoteThatYieldsToARecordingKeepsItsPlaceAtTheHead() {
        work.admit("a", { false }, {})
        work.admit("b", { false }, {})
        assertEquals("a", work.pop())
        work.requeueCurrent("a")
        assertEquals(listOf("a", "b"), work.snapshotIds())
        assertEquals("a", work.pop())
    }
}
