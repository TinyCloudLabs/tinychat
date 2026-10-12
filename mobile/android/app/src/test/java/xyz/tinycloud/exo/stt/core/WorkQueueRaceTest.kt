package xyz.tinycloud.exo.stt.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Queue membership and its ledger state change together under the queue's lock. */
class WorkQueueRaceTest {
    private val work = WorkQueue()
    private val lane = Executors.newSingleThreadExecutor()
    private val admission = Admission(work, lane)
    @Volatile private var ledger = "queued"

    @After fun stop() = lane.shutdownNow().let {}

    /** Runs [block] on its own thread; the latch opens when it returns. */
    private fun async(block: () -> Unit): CountDownLatch = CountDownLatch(1).also { done -> thread { block(); done.countDown() } }

    @Test fun aCancelAndAnAdmissionOfTheSameNoteNeverInterleave() {
        work.admit("b", { false }, {})
        val insideCancel = CountDownLatch(1)
        val letCancelFinish = CountDownLatch(1)
        val cancelled = async { work.cancel("b") { insideCancel.countDown(); letCancelFinish.await(); ledger = "cancelled" } }
        assertTrue(insideCancel.await(2, TimeUnit.SECONDS))
        // The note has left the line but is not yet marked: an admission now must wait, or the mark would overwrite it.
        val admitted = async { work.admit("b", { false }) { ledger = "queued" } }
        assertFalse("the admission waits for the cancel", admitted.await(300, TimeUnit.MILLISECONDS))
        letCancelFinish.countDown()
        assertTrue(cancelled.await(2, TimeUnit.SECONDS))
        assertTrue(admitted.await(2, TimeUnit.SECONDS))
        assertEquals("queued", ledger)
        assertEquals(listOf("b"), work.snapshotIds())
    }

    @Test fun aQueuedNoteCancelledOnTheLaneNeverReachesTheDecoder() {
        work.admit("a", { false }, {})
        assertEquals("a", work.pop()) // A is decoding; the decode thread is busy.
        work.admit("b", { false }, {})
        val changed = CountDownLatch(1)
        admission.cancel("b", markCancelled = { ledger = "cancelled" }, cancelled = {}, failed = { throw it }, changed = { changed.countDown() })
        assertTrue("the cancel does not wait for the decode", changed.await(2, TimeUnit.SECONDS))
        assertEquals("cancelled", ledger)
        assertEquals(listOf("a"), work.snapshotIds())
        work.finish()
        assertFalse(work.hasNext())
    }

    @Test fun cancellingTheNoteBeingDecodedFlagsItAndTheLoopEndsItCancelledNotRequeued() {
        work.admit("a", { false }, {})
        assertEquals("a", work.pop())
        val changed = CountDownLatch(1)
        admission.cancel("a", markCancelled = { ledger = "cancelled" }, cancelled = {}, failed = { throw it }, changed = { changed.countDown() })
        assertTrue(changed.await(2, TimeUnit.SECONDS))
        assertTrue(work.isCancelRequested())
        assertEquals("the decode still owns the note until it stops", listOf("a"), work.snapshotIds())
        assertEquals("queued", ledger)

        // A capture started at the same moment: the cancel wins over the requeue.
        work.yieldCurrent("a", markQueued = { ledger = "requeued" }, markCancelled = { ledger = "cancelled" })
        assertEquals("cancelled", ledger)
        assertFalse(work.hasNext())
        assertFalse(work.isCancelRequested())
        assertNull(work.snapshotIds().firstOrNull())
    }

    @Test fun aCancelDoesNotCarryOverToTheNextNote() {
        work.admit("a", { false }, {})
        work.admit("b", { false }, {})
        assertEquals("a", work.pop())
        work.cancel("a") {}
        work.finish { ledger = "cancelled" }
        assertEquals("b", work.pop())
        assertFalse(work.isCancelRequested())
    }

    @Test fun aFailDrainMarksOnlyTheNotesItTookAndNeverOverwritesALaterAdmission() {
        work.admit("b", { false }, {})
        val failed = mutableListOf<String>()
        val insideDrain = CountDownLatch(1)
        val letDrainFinish = CountDownLatch(1)
        var drained = emptyList<String>()
        val draining = async {
            drained = work.drainFailing(
                markFailed = { id -> insideDrain.countDown(); letDrainFinish.await(); failed.add(id); ledger = "failed" },
                unmarked = { _, e -> throw e },
            )
        }
        assertTrue(insideDrain.await(2, TimeUnit.SECONDS))
        // The same note is asked for again mid-drain: it must wait, then queue after the failure is written.
        val admitted = async { work.admit("b", { false }) { ledger = "queued" } }
        assertFalse("the admission waits for the drain", admitted.await(300, TimeUnit.MILLISECONDS))
        letDrainFinish.countDown()
        assertTrue(draining.await(2, TimeUnit.SECONDS))
        assertTrue(admitted.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("b"), drained)
        assertEquals(listOf("b"), failed)
        assertEquals("queued", ledger)
        assertEquals(listOf("b"), work.snapshotIds())
    }

    @Test fun aNoteAdmittedAfterTheDrainIsNotMarkedFailed() {
        work.admit("b", { false }, {})
        val failed = mutableListOf<String>()
        assertEquals(listOf("b"), work.drainFailing({ failed.add(it) }, { _, e -> throw e }))
        work.admit("c", { false }, {})
        assertEquals(listOf("b"), failed)
        assertEquals(listOf("c"), work.snapshotIds())
    }

    @Test fun aCancelWhoseLedgerWriteFailsLeavesTheNoteInLineAndRejects() {
        work.admit("b", { false }, {})
        val answers = CopyOnWriteArrayList<String>()
        val answered = CountDownLatch(1)
        admission.cancel(
            "b",
            markCancelled = { throw IllegalStateException("disk full") },
            cancelled = { answers.add("cancelled"); answered.countDown() },
            failed = { answers.add("failed:${it.message}"); answered.countDown() },
            changed = { answers.add("changed") },
        )
        assertTrue(answered.await(2, TimeUnit.SECONDS))
        assertEquals(listOf("failed:disk full"), answers)
        assertEquals(listOf("b"), work.snapshotIds())
        assertEquals("b", work.pop())
    }

    @Test fun aFailDrainWhoseLedgerWriteFailsLeavesThatNoteInLineAndMarksTheRest() {
        work.admit("b", { false }, {})
        work.admit("c", { false }, {})
        val failed = mutableListOf<String>()
        val unmarked = mutableListOf<String>()
        val drained = work.drainFailing(
            markFailed = { id -> if (id == "b") throw IllegalStateException("disk full"); failed.add(id) },
            unmarked = { id, _ -> unmarked.add(id) },
        )
        assertEquals(listOf("c"), drained)
        assertEquals(listOf("c"), failed)
        assertEquals(listOf("b"), unmarked)
        assertEquals(listOf("b"), work.snapshotIds())
    }
}
