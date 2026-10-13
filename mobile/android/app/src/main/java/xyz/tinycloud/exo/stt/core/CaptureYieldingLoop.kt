package xyz.tinycloud.exo.stt.core

/**
 * The capture-priority work loop (plan §2.5): drains a pending queue one unit at a time via
 * [process], checking [isPaused] only *between* units — never mid-unit, since the native work a
 * unit guards (an ASR segment, a note's whole decode) cannot be interrupted once started. The
 * instant a pause is seen it stops without starting another unit, leaving that unit and everything
 * after it in the queue untouched ([next] is never called for it), so a later call (once
 * [isPaused] reports false again, i.e. after `captureEnded`) resumes exactly where it left off.
 * Nothing here blocks or sleeps: both predicates are plain reads, and `process` is the only thing
 * that can take real time. [hasNext]/[next] are passed by reference rather than a `List`, so this
 * drains any queue shape (a `LinkedBlockingDeque`, a plain `MutableList`, …) in place.
 */
internal object CaptureYieldingLoop {
    /** Returns true if the queue was fully drained; false if it stopped early for a pause. */
    fun <T> run(hasNext: () -> Boolean, next: () -> T, isPaused: () -> Boolean, process: (T) -> Unit): Boolean {
        while (hasNext()) {
            if (isPaused()) return false
            process(next())
        }
        return true
    }
}
