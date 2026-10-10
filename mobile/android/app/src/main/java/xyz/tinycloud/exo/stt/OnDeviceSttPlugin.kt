package xyz.tinycloud.exo.stt

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import xyz.tinycloud.exo.BuildConfig
import java.io.File
import java.util.concurrent.Executors

@CapacitorPlugin(name = "OnDeviceStt")
class OnDeviceSttPlugin : Plugin() {
    private val benchmarkExecutor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "stt-benchmark").apply { isDaemon = true }
    }
    private lateinit var store: ModelStore
    private lateinit var downloads: ModelDownloads
    private lateinit var queue: TranscriptionQueue
    private val autoDownloadPrefs by lazy { context.getSharedPreferences("exo.stt", android.content.Context.MODE_PRIVATE) }

    override fun load() {
        store = ModelStore.get(context)
        downloads = ModelDownloads.get(context)
        queue = TranscriptionQueue.get(context)
        queue.onQueueChanged = { notifyListeners("status", statusObject(), true) }
        queue.onProgress = { id, percent -> notifyListeners("progress", JSObject().put("id", id).put("percent", percent)) }
        queue.onTranscribed = { id, outcome -> notifyListeners("transcribed", JSObject().put("id", id).put("outcome", outcome), true) }
        queue.onFailed = { id, code, message -> notifyListeners("failed", JSObject().put("id", id).put("code", code).put("message", message), true) }
    }

    private fun primaryModelId(): String {
        val manager = context.getSystemService(android.app.ActivityManager::class.java)
        val info = android.app.ActivityManager.MemoryInfo().also { manager.getMemoryInfo(it) }
        return ModelManifest.primaryModel(info.totalMem)
    }

    private fun statusObject(): JSObject {
        val pack = if (primaryModelId() == ModelManifest.PARAKEET_FULL) "full" else "small"
        val models = JSONArray()
        for (id in ModelManifest.ALL_IDS) {
            val (state, bytes, error) = store.status(id)
            models.put(JSObject().put("id", id).put("state", state.wire()).put("bytes", bytes)
                .put("totalBytes", ModelManifest.totalBytes(id)).put("error", error ?: JSObject.NULL))
        }
        val engine = if (store.isReady(ModelManifest.PARAKEET_FULL) || store.isReady(ModelManifest.PARAKEET_SMALL)) "parakeet" else "none"
        return JSObject().put("models", models).put("pack", pack)
            .put("autoDownload", autoDownloadPrefs.getBoolean("autoDownload", false))
            .put("download", JSObject().put("policy", "wifi").put("state", downloads.downloadState().wire()))
            .put("engine", engine).put("appleSpeech", "unsupported").put("queue", queue.queueSnapshot())
    }

    @PluginMethod
    fun status(call: PluginCall) { call.resolve(statusObject()) }

    @PluginMethod
    fun setAutoDownload(call: PluginCall) {
        // Stored, but has no automatic effect in this slice: downloads only start from
        // `downloadNow` (manual, Settings/recorder "Download"). T17 wires background auto-start.
        autoDownloadPrefs.edit().putBoolean("autoDownload", call.getBoolean("enabled") ?: false).apply()
        call.resolve()
        notifyListeners("status", statusObject(), true)
    }

    @PluginMethod
    fun downloadNow(call: PluginCall) {
        val modelId = primaryModelId()
        if (ModelManifest.filesFor(modelId) == null) {
            call.reject("The on-device model for this phone's memory tier is not downloadable yet", "small_pack_unsupported")
            return
        }
        // Wi-Fi only in this slice, whatever `allowCellular` asks (TC-836 report, deviations).
        downloads.start(ModelManifest.SILERO_VAD, { id, done, total -> emitDownloadProgress(id, done, total) }, { _, vadResult ->
            vadResult.onFailure { error ->
                call.reject("Could not download the speech-detection model", "download_failed", error as? Exception)
                return@onFailure
            }
            downloads.start(modelId, { id, done, total -> emitDownloadProgress(id, done, total) }, { _, result ->
                result.fold(
                    onSuccess = { queue.reconcile(); call.resolve() },
                    onFailure = { error -> call.reject("Could not download the on-device transcription model", "download_failed", error as? Exception) },
                )
                notifyListeners("status", statusObject(), true)
            })
        })
        notifyListeners("status", statusObject(), true)
    }

    private fun emitDownloadProgress(id: String, done: Long, total: Long) {
        store.setState(id, ModelState.DOWNLOADING, bytes = done)
        notifyListeners("status", statusObject(), true)
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        downloads.cancel()
        call.resolve()
        notifyListeners("status", statusObject(), true)
    }

    @PluginMethod
    fun deleteModels(call: PluginCall) {
        store.delete(ModelManifest.PARAKEET_FULL)
        store.delete(ModelManifest.PARAKEET_SMALL)
        store.delete(ModelManifest.SILERO_VAD)
        call.resolve()
        notifyListeners("status", statusObject(), true)
    }

    @PluginMethod
    fun enqueue(call: PluginCall) {
        val id = call.getString("id") ?: run { call.reject("id is required", "invalid_argument"); return }
        queue.enqueue(id)
        call.resolve()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("id") ?: run { call.reject("id is required", "invalid_argument"); return }
        queue.cancel(id)
        call.resolve()
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
                asrOnly = call.getBoolean("asrOnly") ?: false,
                only = call.getString("only"))
        } catch (error: Exception) { call.reject(error.message ?: "Invalid benchmark options", error); return }
        val root = context.dataDir.canonicalFile
        val directory = File(root, requested).canonicalFile
        if (!directory.path.startsWith(root.path + File.separator) || !directory.isDirectory) {
            call.reject("dir must be an existing app-private directory"); return
        }
        benchmarkExecutor.execute {
            try { call.resolve(Benchmark.run(directory, options)) }
            catch (error: Exception) { call.reject(error.message ?: "STT benchmark failed", error) }
        }
    }

    override fun handleOnDestroy() {
        benchmarkExecutor.shutdown()
        super.handleOnDestroy()
    }
}
