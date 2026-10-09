package xyz.tinycloud.exo.capture.core

/** The wire reasons in plan-r6 §1.8. Error text belongs in detail, never reason. */
object MicStateContract {
    val reasons = setOf(
        "no_signal", "os_silenced", "input_muted", "call", "user", "interruption",
        "route_change", "media_services_reset", "read_error", "stalled", "app_suspended",
        "writer_stalled", "resume_blocked", "resume_not_allowed", "mic_unavailable",
        "max_duration", "pause_timeout", "disk_full", "write_failed", "permission_revoked",
    )

    data class Snapshot(val state: String, val reason: String?, val detail: String?)

    fun snapshot(state: String, reason: String?, detail: String? = null): Snapshot {
        require(reason == null || reason in reasons) { "Invalid mic-state reason: $reason" }
        require(reason != "read_error" || state == "interrupted") {
            "A read error must be published as interrupted"
        }
        return Snapshot(state, reason, detail?.takeIf { it.isNotBlank() })
    }

    fun readFailure(detail: String?): Snapshot = snapshot("interrupted", "read_error", detail)

    /** A read error is published only after the input has moved to interrupted. */
    fun dispatchCaptureError(
        reason: String,
        detail: String?,
        publish: (String?, String?) -> Unit,
        interrupt: (String?) -> Unit,
    ) {
        when (reason) {
            "read_error" -> interrupt(detail)
            "writer_resumed" -> publish(null, null)
            else -> {
                snapshot("recording", reason, detail)
                publish(reason, detail)
            }
        }
    }
}
