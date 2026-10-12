package xyz.tinycloud.exo.stt.core

import java.util.ArrayDeque
import java.util.concurrent.Executor

/**
 * The notes waiting for on-device transcription, and the one being decoded. Admission, cancel and the
 * decode loop run on different threads, so every change to queue membership happens under one lock,
 * together with the ledger state that matches it (the caller's lambdas run inside the lock): a note is
 * never both popped for decoding and admitted again, a request is never dropped between the loop's last
 * `hasNext` and its exit, and a stale ledger write never overwrites a concurrent admission.
 */
internal class WorkQueue {
    private val lock = Any()
    private val pending = ArrayDeque<String>()
    private var current: String? = null
    private var cancelRequested = false

    enum class Admission { QUEUED, ALREADY_IN_LINE, FINISHED }

    /**
     * Puts `id` in line: [persist] runs inside the lock, so the request is on disk before the note is
     * visible to the decode loop. A note already queued or decoding keeps its attempt and is not
     * persisted again; one whose transcript exists ([finished]) is not queued.
     */
    fun admit(id: String, finished: () -> Boolean, persist: () -> Unit): Admission = synchronized(lock) {
        when {
            id == current || pending.contains(id) -> Admission.ALREADY_IN_LINE
            finished() -> Admission.FINISHED
            else -> {
                persist()
                pending.addLast(id)
                Admission.QUEUED
            }
        }
    }

    /** A note a restart scan found owed: queued if it is not already in line. */
    fun addScanned(id: String) = synchronized(lock) { if (id != current && !pending.contains(id)) pending.addLast(id) }

    fun hasNext(): Boolean = synchronized(lock) { !pending.isEmpty() }

    /** The next note, now the one being decoded. */
    fun pop(): String = synchronized(lock) {
        cancelRequested = false
        pending.removeFirst().also { current = it }
    }

    /** The decode of the current note is over (done, failed or given up); [settle] writes its ledger state. */
    fun finish(settle: () -> Unit = {}) = synchronized(lock) {
        settle()
        current = null
        cancelRequested = false
    }

    /**
     * The current note yields to a recording: back at the head of the line with its place kept
     * ([markQueued]), unless a cancel arrived first, which wins ([markCancelled]).
     */
    fun yieldCurrent(id: String, markQueued: () -> Unit, markCancelled: () -> Unit) = synchronized(lock) {
        if (cancelRequested) markCancelled() else { markQueued(); pending.addFirst(id) }
        current = null
        cancelRequested = false
    }

    /**
     * A waiting note leaves the line and is marked cancelled ([markCancelled]) in one step. The note
     * being decoded stays current and is flagged: the decode loop stops it at its next checkpoint.
     */
    fun cancel(id: String, markCancelled: () -> Unit) = synchronized(lock) {
        if (id == current) {
            cancelRequested = true
        } else {
            pending.remove(id)
            markCancelled()
        }
    }

    /** Whether the note being decoded was cancelled. */
    fun isCancelRequested(): Boolean = synchronized(lock) { cancelRequested }

    fun pendingIds(): List<String> = synchronized(lock) { pending.toList() }

    /** Every waiting note, taken out of the line and marked failed ([markFailed]) in one step: only those it took. */
    fun drainFailing(markFailed: (String) -> Unit): List<String> = synchronized(lock) {
        pending.toList().also { ids ->
            pending.clear()
            ids.forEach(markFailed)
        }
    }

    /** The decoding note first, then the waiting ones. */
    fun snapshotIds(): List<String> = synchronized(lock) { listOfNotNull(current) + pending.toList() }
}

/**
 * Runs explicit enqueues and cancels on [lane], never the thread that decodes: a note tapped while
 * another decodes is persisted and acknowledged at once, and a cancel takes effect before the next
 * decode starts, not after a decode that can take minutes (and which a dying process would lose the
 * request in). One lane keeps them in the order they were asked. Exactly one of `accepted` and
 * `failed` runs for an enqueue.
 */
internal class Admission(private val work: WorkQueue, private val lane: Executor) {
    fun enqueue(
        id: String,
        finished: () -> Boolean,
        persist: () -> Unit,
        accepted: (Boolean) -> Unit,
        failed: (Exception) -> Unit,
        changed: () -> Unit,
        wake: () -> Unit,
    ) {
        lane.execute {
            val admission = try {
                work.admit(id, finished, persist)
            } catch (e: Exception) {
                failed(e)
                return@execute
            }
            val inLine = admission != WorkQueue.Admission.FINISHED
            if (inLine) changed()
            accepted(inLine)
            if (inLine) wake()
        }
    }

    fun cancel(id: String, markCancelled: () -> Unit, changed: () -> Unit) {
        lane.execute {
            work.cancel(id, markCancelled)
            changed()
        }
    }
}
