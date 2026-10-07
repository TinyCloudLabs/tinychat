package xyz.tinycloud.exo.stt

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import xyz.tinycloud.exo.BuildConfig
import java.io.File

@CapacitorPlugin(name = "OnDeviceStt")
class OnDeviceSttPlugin : Plugin() {
    @PluginMethod
    fun status(call: PluginCall) {
        val ids = arrayOf("parakeet-tdt-0.6b-v3-int8", "parakeet-tdt-110m-en-int8", "silero-vad", "diarization")
        val models = JSONArray()
        for (id in ids) models.put(JSObject().put("id", id).put("state", "absent")
            .put("bytes", 0).put("totalBytes", 0).put("error", JSObject.NULL))
        call.resolve(JSObject().put("models", models).put("pack", "full").put("autoDownload", false)
            .put("download", JSObject().put("policy", "wifi").put("state", "idle"))
            .put("engine", "none").put("appleSpeech", "unsupported").put("queue", JSONArray()))
    }

    @PluginMethod
    fun benchmark(call: PluginCall) {
        if (!BuildConfig.DEBUG) { call.reject("STT benchmark is available only in Debug builds"); return }
        val requested = call.getString("dir") ?: run { call.reject("dir is required"); return }
        val threadArray = call.getArray("threads") ?: run { call.reject("threads is required"); return }
        val threads = try { (0 until threadArray.length()).map { threadArray.getInt(it) } }
            catch (error: Exception) { call.reject("threads must be integers", error); return }
        val options = try {
            Benchmark.Options(threads = threads,
                blankPenalty = call.getDouble("blankPenalty") ?: 0.0,
                padSeconds = call.getDouble("padSeconds") ?: 0.0,
                clusterThreshold = call.getDouble("clusterThreshold") ?: .8,
                asrOnly = call.getBoolean("asrOnly") ?: false)
        } catch (error: Exception) { call.reject(error.message ?: "Invalid benchmark options", error); return }
        val root = context.dataDir.canonicalFile
        val directory = File(root, requested).canonicalFile
        if (!directory.path.startsWith(root.path + File.separator) || !directory.isDirectory) {
            call.reject("dir must be an existing app-private directory"); return
        }
        bridge.execute {
            try { call.resolve(Benchmark.run(directory, options)) }
            catch (error: Exception) { call.reject(error.message ?: "STT benchmark failed", error) }
        }
    }
}
