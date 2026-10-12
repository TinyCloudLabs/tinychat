package xyz.tinycloud.exo.stt.core

import org.json.JSONObject

/**
 * Whether a note's sidecar says on-device transcription is owed. A note committed to on-device
 * always is; a note committed to another mode is too once the user chose Local for it, which
 * `enqueue` records as `stt.requested` so the choice survives the app dying.
 */
internal object ResumableWork {
    private val UNFINISHED = setOf("waiting_for_model", "queued", "running")

    fun owed(note: JSONObject): Boolean {
        val stt = note.optJSONObject("stt") ?: return false
        if (stt.optString("state") !in UNFINISHED) return false
        return note.optJSONObject("options")?.optString("transcriber") == "on-device" || stt.optBoolean("requested")
    }

    /** What an explicit enqueue writes: a fresh attempt, and the user's Local choice. */
    fun requested(stt: JSONObject): JSONObject =
        stt.put("state", "queued").put("error", JSONObject.NULL).put("attempts", 0).put("requested", true)
}
