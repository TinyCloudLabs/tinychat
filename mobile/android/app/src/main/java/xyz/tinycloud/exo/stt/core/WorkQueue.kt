package xyz.tinycloud.exo.stt.core

import java.util.ArrayDeque
import java.util.concurrent.Executor

/**
 * The notes waiting for on-device transcription, and the one being decoded. Admission (an explicit
 * enqueue) and the decode loop run on different threads, so every change to this state, and the
 * check-then-add behind admission, happens under one lock: a note is never both popped for decoding
 * and admitted again, and a request is never dropped between the loop's last `hasNext` and its exit.
 */
internal class WorkQueue {
    private val lock = Any()
    private val pending = ArrayDeque<String>()
    private var current: String? = null

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
    fun pop(): String = synchronized(lock) { pending.removeFirst().also { current = it } }

    /** The decode of the current note is over (done, failed or given up). */
    fun finish() = synchronized(lock) { current = null }

    /** The current note yields to a recording: back at the head of the line, with its place kept. */
    fun requeueCurrent(id: String) = synchronized(lock) {
        current = null
        pending.addFirst(id)
    }

    fun remove(id: String) = synchronized(lock) { pending.remove(id) }

    fun pendingIds(): List<String> = synchronized(lock) { pending.toList() }

    /** Every waiting note, taken out of the line. */
    fun drain(): List<String> = synchronized(lock) { pending.toList().also { pending.clear() } }

    /** The decoding note first, then the waiting ones. */
    fun snapshotIds(): List<String> = synchronized(lock) { listOfNotNull(current) + pending.toList() }
}

/**
 * Admits explicit enqueues on [lane], never the thread that decodes: a note tapped while another
 * decodes is persisted and acknowledged at once, not after the decode (which can take minutes, and
 * which a dying process would lose the request in). Exactly one of `accepted` and `failed` runs.
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
}
