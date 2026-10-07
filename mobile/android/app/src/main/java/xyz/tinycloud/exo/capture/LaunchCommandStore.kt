package xyz.tinycloud.exo.capture

import android.content.Context
import org.json.JSONObject
import java.util.UUID

/** One durable pending launch command. Expiry avoids recording after an old permission dialog. */
class LaunchCommandStore(context: Context) {
    private val prefs = context.getSharedPreferences("exo.capture.launch", Context.MODE_PRIVATE)
    data class Command(val id: String, val action: String, val source: String, val createdAt: Long)
    @Synchronized fun put(action: String, source: String): Command {
        require(action == "RECORD" || action == "SHOW_RECORDER")
        val command = Command(UUID.randomUUID().toString(), action, source, System.currentTimeMillis())
        prefs.edit().putString("slot", JSONObject().put("commandId", command.id).put("action", action)
            .put("source", source).put("createdAt", command.createdAt).toString()).commit()
        return command
    }
    @JvmOverloads @Synchronized fun pending(now: Long = System.currentTimeMillis()): Command? {
        val raw = prefs.getString("slot", null) ?: return null
        val json = JSONObject(raw)
        val value = Command(json.getString("commandId"), json.getString("action"), json.getString("source"), json.getLong("createdAt"))
        if (now - value.createdAt >= 30_000 || now < value.createdAt) { clear(value.id); return null }
        return value
    }
    @Synchronized fun clear(id: String) {
        if (prefs.getString("slot", null)?.let { JSONObject(it).optString("commandId") } == id)
            prefs.edit().remove("slot").commit()
    }
}
