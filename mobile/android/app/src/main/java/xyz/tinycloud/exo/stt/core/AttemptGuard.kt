package xyz.tinycloud.exo.stt.core

/**
 * Caps how many times a note may re-enter transcription after a crash or failure. Without this, a
 * note whose decode crashes the process stays in `running` forever (nothing ever moves it to
 * `failed`), and `reconcile()` requeues it on every launch: a crash loop (TC-836 incident). The
 * attempt count must be persisted *before* the risky work starts, so a crash mid-attempt still
 * counts against the cap on the next launch.
 */
internal object AttemptGuard {
    const val MAX_ATTEMPTS = 3

    sealed class Decision {
        data class Proceed(val attempt: Int) : Decision()
        object GiveUp : Decision()
    }

    fun next(previousAttempts: Int): Decision {
        val attempt = previousAttempts + 1
        return if (attempt > MAX_ATTEMPTS) Decision.GiveUp else Decision.Proceed(attempt)
    }
}
