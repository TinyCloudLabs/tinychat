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
        if (stt.optString("state") !in UNFINISHED || !stt.isNull("rerunRev") && stt.has("rerunRev")) return false
        return note.optJSONObject("options")?.optString("transcriber") == "on-device" || stt.optBoolean("requested")
    }

    fun requested(stt: JSONObject): JSONObject =
        stt.put("state", "queued").put("error", JSONObject.NULL).put("attempts", 0).put("requested", true)
            .put("rerunRev", JSONObject.NULL).put("rerunBaseRev", JSONObject.NULL).put("rerunBaseHash", JSONObject.NULL)

    /** An explicit rerun is intentionally not resumed after relaunch. */
    fun rerun(stt: JSONObject, rev: Int, baseRev: Int, baseHash: String): JSONObject =
        stt.put("state", "queued").put("error", JSONObject.NULL).put("attempts", 0).put("requested", false)
            .put("rerunRev", rev).put("rerunBaseRev", baseRev).put("rerunBaseHash", baseHash)

    /** Clears an interrupted explicit rerun; callers invoke this only during process startup. */
    fun cancelInterruptedRerun(stt: JSONObject): Boolean {
        val state = stt.optString("state")
        if (stt.isNull("rerunRev") || !stt.has("rerunRev") || state !in UNFINISHED) return false
        stt.put("state", "cancelled").put("rerunRev", JSONObject.NULL)
            .put("rerunBaseRev", JSONObject.NULL).put("rerunBaseHash", JSONObject.NULL)
        return true
    }
}
