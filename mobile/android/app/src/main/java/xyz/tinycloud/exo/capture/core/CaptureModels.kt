package xyz.tinycloud.exo.capture.core

import org.json.JSONArray
import org.json.JSONObject

const val MAX_DURATION_MS = 3L * 3_600_000L
const val SAMPLE_RATE = 44_100
const val BITRATE = 64_000

fun defaultOptions() = JSONObject().put("transcriber", "on-device").put("identifySpeakers", false)
fun defaultLedger() = JSONObject()
    .put("spaceId", JSONObject.NULL)
    .put("audio", JSONObject().put("state", "pending").put("rowId", JSONObject.NULL).put("at", JSONObject.NULL))
    .put("transcript", JSONObject().put("state", "pending").put("outcome", JSONObject.NULL)
        .put("reason", JSONObject.NULL).put("attempts", 0).put("nextAttemptAt", JSONObject.NULL))
    .put("transcriptSync", JSONObject().put("state", "pending").put("rev", 0).put("at", JSONObject.NULL))
    .put("landed", JSONObject().put("state", "none").put("eventId", JSONObject.NULL))
    .put("remote", JSONArray())

fun defaultStt() = JSONObject().put("state", "waiting_for_model").put("engine", JSONObject.NULL)
    .put("pack", JSONObject.NULL).put("error", JSONObject.NULL).put("segmentsDone", 0).put("windowsDone", 0)

fun JSONObject.copy(): JSONObject = JSONObject(toString())
fun String.isNoteId(): Boolean = matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"))
