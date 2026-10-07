package xyz.tinycloud.exo.capture

import android.media.MediaExtractor
import android.media.MediaFormat
import org.json.JSONObject
import java.io.File

object LegacyProbe {
    fun inspect(file: File): JSONObject? {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            val audio = (0 until extractor.trackCount).map { extractor.getTrackFormat(it) }
                .firstOrNull { it.getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true } ?: return null
            val duration = audio.getLong(MediaFormat.KEY_DURATION) / 1000
            if (duration < 500) return null
            return JSONObject().put("startedAt", file.lastModified()).put("durationMs", duration)
                .put("mimeType", "audio/mp4").put("sizeBytes", file.length())
                .put("silencedMs", 0).put("silencedEvents", 0).put("noSignalMs", 0)
        } catch (_: Exception) { return null } finally { extractor.release() }
    }
}
