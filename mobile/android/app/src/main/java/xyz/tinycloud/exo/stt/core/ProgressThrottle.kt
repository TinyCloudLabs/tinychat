package xyz.tinycloud.exo.stt.core

/** The decode thread owns this gate. Time is monotonic nanoseconds, never wall clock time. */
class ProgressThrottle {
    private var lastEventAt = Long.MIN_VALUE
    private var lastCheckpointAt = Long.MIN_VALUE
    private var lastPercent = -1

    fun event(percent: Int, now: Long): Boolean {
        if (percent == lastPercent ||
            (lastEventAt != Long.MIN_VALUE && now - lastEventAt < 250_000_000L)) return false
        lastPercent = percent
        lastEventAt = now
        return true
    }

    fun checkpoint(now: Long): Boolean {
        if (lastCheckpointAt != Long.MIN_VALUE && now - lastCheckpointAt < 5_000_000_000L) return false
        lastCheckpointAt = now
        return true
    }

    fun completionDelayMillis(now: Long): Long = if (lastEventAt == Long.MIN_VALUE) 0 else
        ((250_000_000L - (now - lastEventAt)).coerceAtLeast(0) + 999_999L) / 1_000_000L
}
