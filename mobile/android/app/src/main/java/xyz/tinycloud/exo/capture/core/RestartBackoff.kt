package xyz.tinycloud.exo.capture.core

/** The retry budget starts when capture can resume, not when an interruption begins. */
class RestartBackoff(
    private val nowMs: () -> Long,
    private val postNow: () -> Unit,
    private val postDelayed: (Long) -> Unit,
) {
    private val delaysMs = longArrayOf(500, 1000, 2000, 5000, 10_000, 30_000)
    private var startedAtMs: Long? = null
    private var step = 0

    fun interruptionEnded() {
        startedAtMs = nowMs()
        step = 0
        postNow()
    }

    /** Returns false only after ten minutes of failed automatic attempts. */
    fun failedAttempt(): Boolean {
        val now = nowMs()
        val started = startedAtMs ?: now.also { startedAtMs = it }
        if (now - started >= 600_000) return false
        postDelayed(delaysMs[step])
        step = minOf(step + 1, delaysMs.lastIndex)
        return true
    }

    fun reset() {
        startedAtMs = null
        step = 0
    }

    internal fun expireForTest() { startedAtMs = nowMs() - 600_001 }
}
