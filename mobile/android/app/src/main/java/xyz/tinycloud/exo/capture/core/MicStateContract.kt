package xyz.tinycloud.exo.capture.core

/** The wire reasons in plan-r6 §1.8. Error text belongs in detail, never reason. */
object MicStateContract {
    const val NO_SIGNAL = "no_signal"
    const val OS_SILENCED = "os_silenced"
    const val INPUT_MUTED = "input_muted"
    const val CALL = "call"
    const val USER = "user"
    const val INTERRUPTION = "interruption"
    const val ROUTE_CHANGE = "route_change"
    const val MEDIA_SERVICES_RESET = "media_services_reset"
    const val READ_ERROR = "read_error"
    const val STALLED = "stalled"
    const val APP_SUSPENDED = "app_suspended"
    const val WRITER_STALLED = "writer_stalled"
    const val RESUME_BLOCKED = "resume_blocked"
    const val RESUME_NOT_ALLOWED = "resume_not_allowed"
    const val MIC_UNAVAILABLE = "mic_unavailable"
    const val MAX_DURATION = "max_duration"
    const val PAUSE_TIMEOUT = "pause_timeout"
    const val DISK_FULL = "disk_full"
    const val WRITE_FAILED = "write_failed"
    const val PERMISSION_REVOKED = "permission_revoked"

    val reasons = setOf(
        NO_SIGNAL, OS_SILENCED, INPUT_MUTED, CALL, USER, INTERRUPTION,
        ROUTE_CHANGE, MEDIA_SERVICES_RESET, READ_ERROR, STALLED, APP_SUSPENDED,
        WRITER_STALLED, RESUME_BLOCKED, RESUME_NOT_ALLOWED, MIC_UNAVAILABLE,
        MAX_DURATION, PAUSE_TIMEOUT, DISK_FULL, WRITE_FAILED, PERMISSION_REVOKED,
    )

    data class Snapshot(val state: String, val reason: String?, val detail: String?)

    fun snapshot(state: String, reason: String?, detail: String? = null,
                 onViolation: (String) -> Unit = {}): Snapshot {
        val safeReason = when {
            reason == null -> null
            reason !in reasons -> {
                onViolation("Invalid mic-state reason: $reason")
                null
            }
            reason == READ_ERROR && state != "interrupted" -> {
                onViolation("read_error cannot be published with state $state")
                null
            }
            else -> reason
        }
        return Snapshot(state, safeReason, detail?.takeIf { safeReason != null && it.isNotBlank() })
    }

    fun readFailure(detail: String?): Snapshot = snapshot("interrupted", READ_ERROR, detail)

    /** A read error is published only after the input has moved to interrupted. */
    fun dispatchCaptureError(
        reason: String,
        detail: String?,
        publish: (String?, String?) -> Unit,
        interrupt: (String?) -> Unit,
        onViolation: (String) -> Unit = {},
    ) {
        when (reason) {
            READ_ERROR -> interrupt(detail)
            "writer_resumed" -> publish(null, null)
            else -> {
                val safe = snapshot("recording", reason, detail, onViolation)
                publish(safe.reason, safe.detail)
            }
        }
    }
}
