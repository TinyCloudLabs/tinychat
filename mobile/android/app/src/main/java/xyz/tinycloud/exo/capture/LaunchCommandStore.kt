package xyz.tinycloud.exo.capture

import android.content.Context
import android.util.Log
import java.util.UUID
import xyz.tinycloud.exo.capture.core.LaunchCommandCodec
import xyz.tinycloud.exo.capture.core.LaunchCommandValue

/** One durable pending launch command. Expiry avoids recording after an old permission dialog. */
class LaunchCommandStore(context: Context) {
    private val prefs = context.getSharedPreferences("exo.capture.launch", Context.MODE_PRIVATE)
    data class Command(val id: String, val action: String, val source: String, val createdAt: Long)
    @Synchronized fun put(action: String, source: String): Command {
        require(action == "RECORD" || action == "SHOW_RECORDER")
        val command = Command(UUID.randomUUID().toString(), action, source, System.currentTimeMillis())
        prefs.edit().putString("slot", LaunchCommandCodec.encode(
            LaunchCommandValue(command.id, action, source, command.createdAt))).commit()
        return command
    }
    @JvmOverloads @Synchronized fun pending(now: Long = System.currentTimeMillis()): Command? {
        val raw = prefs.getString("slot", null) ?: return null
        val value = try { LaunchCommandCodec.decode(raw) } catch (e: Exception) {
            Log.e("ExoCapture", "Dropped invalid launch command", e)
            prefs.edit().remove("slot").commit()
            return null
        }
        if (LaunchCommandCodec.pending(raw, now) == null) {
            Log.i("ExoCapture", "Dropped expired launch command ${value.id}")
            clear(value.id); return null
        }
        return Command(value.id, value.action, value.source, value.createdAt)
    }
    @Synchronized fun clear(id: String) {
        if (prefs.getString("slot", null)?.let { runCatching { LaunchCommandCodec.decode(it).id }.getOrNull() } == id)
            prefs.edit().remove("slot").commit()
    }
}
