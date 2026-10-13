package xyz.tinycloud.exo.capture.core

import org.json.JSONObject

data class LaunchCommandValue(val id: String, val action: String, val source: String, val createdAt: Long)

object LaunchCommandCodec {
    fun encode(value: LaunchCommandValue): String = JSONObject().put("commandId", value.id)
        .put("action", value.action).put("source", value.source).put("createdAt", value.createdAt).toString()

    fun decode(raw: String): LaunchCommandValue {
        val value = JSONObject(raw)
        return LaunchCommandValue(value.getString("commandId"), value.getString("action"),
            value.getString("source"), value.getLong("createdAt"))
    }

    fun pending(raw: String?, now: Long): LaunchCommandValue? {
        if (raw == null) return null
        val value = decode(raw)
        return value.takeIf { now >= it.createdAt && now - it.createdAt < 30_000 }
    }
}
