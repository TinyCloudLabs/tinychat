package xyz.tinycloud.exo.capture

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import xyz.tinycloud.exo.BuildConfig
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONArray
import org.json.JSONObject
import xyz.tinycloud.exo.capture.core.MAX_DURATION_MS
import xyz.tinycloud.exo.capture.core.AccountStateDebugFailure
import java.io.FileNotFoundException
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.io.RandomAccessFile
import java.util.concurrent.ConcurrentHashMap
import java.util.UUID

@CapacitorPlugin(name = "VoiceNotes", permissions = [
    Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]),
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    Permission(alias = "bluetooth", strings = [Manifest.permission.BLUETOOTH_CONNECT])
])
class VoiceNotesPlugin : Plugin(), CaptureEngine.Listener {
    private lateinit var engine: CaptureEngine
    private val main = Handler(Looper.getMainLooper())
    private val audioUploads = ConcurrentHashMap<String, HttpURLConnection>()
    private val cancelledAudioUploads = AudioUploadCancellation()
    private val audioUploadLock = Any()
    @Volatile private var pendingStart: Pair<String, PluginCall>? = null
    override fun load() {
        engine = CaptureEngine.get(context)
        engine.addConsumerListener(this)
        engine.beginLaunchRecovery()
    }
    override fun handleOnResume() {
        super.handleOnResume()
        if (::engine.isInitialized && MicShortcutRecovery.denied(context) &&
            MicShortcutRecovery.permissionGranted(context)) {
            MicShortcutRecovery.markGranted(context)
            engine.presentRecorder(null, "permission_granted")
        }
    }
    override fun handleOnDestroy() { engine.removeListener(this); super.handleOnDestroy() }
    override fun event(name: String, data: JSONObject) {
        if (name == "started") {
            val pending = pendingStart
            if (pending != null && pending.first == data.optString("commandId")) {
                pendingStart = null
                val status = engine.status()
                main.post { pending.second.resolve(JSObject().put("id", data.getString("id"))
                    .put("startedAt", status.getLong("startedAt")).put("maxDurationMs", status.getLong("maxDurationMs"))) }
            }
        } else if (name == "startFailed") {
            val pending = pendingStart
            if (pending != null && pending.first == data.optString("commandId")) {
                pendingStart = null
                val code = data.optString("code", "start_failed")
                main.post { pending.second.reject(code, code) }
            }
        } else notifyListeners(name, JSObject.fromJSONObject(data), name in listOf("micState", "autoStopped", "autoStopFailed", "presentRecorder", "recovered", "recoveryFailed", "writeFailure", "committed"))
    }
    @PluginMethod fun start(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { requestPermissionForAlias("microphone", call, "afterMic"); return }
        startReady(call)
    }
    @PermissionCallback private fun afterMic(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) startReady(call)
        else {
            MicShortcutRecovery.markDenied(context, false)
            engine.presentRecorder(null, "permission_denied")
            call.reject("Microphone permission denied", "permission_denied")
        }
    }
    private fun startReady(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED &&
            !context.getSharedPreferences("exo.capture", 0).getBoolean("notificationAsked", false)) {
            context.getSharedPreferences("exo.capture", 0).edit().putBoolean("notificationAsked", true).apply()
            requestPermissionForAlias("notifications", call, "afterNotification")
            return
        }
        if (pendingStart != null || engine.status().optString("state") != "idle") { call.reject("Already recording", "already_recording"); return }
        val commandId = UUID.randomUUID().toString()
        pendingStart = commandId to call
        val max = (call.data.opt("maxDurationMs") as? Number)?.toLong()?.coerceIn(1000, MAX_DURATION_MS) ?: MAX_DURATION_MS
        try { CaptureService.startFromPlugin(context, max, commandId, call.data.optJSONObject("options") ?: call.data) }
        catch (e: Exception) { pendingStart = null; call.reject(e.message ?: "start_failed", e.message ?: "start_failed") }
    }
    @PermissionCallback private fun afterNotification(call: PluginCall) { startReady(call) }
    private fun async(call: PluginCall, body: () -> JSONObject?) {
        Thread {
            try { val result = body(); main.post { call.resolve(if (result == null) JSObject() else JSObject.fromJSONObject(result)) } }
            catch (e: Exception) { main.post { call.reject(e.message ?: "Capture failed", e.message ?: "capture_failed") } }
        }.start()
    }
    @PluginMethod fun stop(call: PluginCall) = async(call) {
        val result = engine.stop()
        context.stopService(android.content.Intent(context, CaptureService::class.java))
        result
    }
    @PluginMethod fun pause(call: PluginCall) = async(call) { engine.pause(); CaptureService.send(context, CaptureService.ACTION_PAUSE); null }
    @PluginMethod fun resume(call: PluginCall) = async(call) { engine.resume(); CaptureService.send(context, CaptureService.ACTION_RESUME); null }
    @PluginMethod fun discard(call: PluginCall) = async(call) {
        val id = engine.discard(); context.stopService(android.content.Intent(context, CaptureService::class.java))
        JSONObject().put("id", id ?: JSONObject.NULL)
    }
    @PluginMethod fun status(call: PluginCall) {
        call.resolve(JSObject.fromJSONObject(engine.status()
            .put("micDeniedPresentation", MicShortcutRecovery.denied(context) && !MicShortcutRecovery.permissionGranted(context))
            .put("shortcutRecordPending", MicShortcutRecovery.recordPending(context))
            .put("microphonePermissionGranted", MicShortcutRecovery.permissionGranted(context))))
    }
    @PluginMethod fun dismissShortcutRecovery(call: PluginCall) {
        MicShortcutRecovery.dismiss(context)
        call.resolve()
    }
    @PluginMethod fun consumeShortcutRecord(call: PluginCall) {
        MicShortcutRecovery.consumeRecordOffer(context)
        call.resolve()
    }
    @PluginMethod fun openSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            MicShortcutRecovery.markSettingsOpened(context)
            context.startActivity(intent)
            call.resolve()
        } catch (error: Exception) {
            MicShortcutRecovery.takeSettingsReturn(context)
            call.reject(error.message ?: "Could not open Settings", "settings_unavailable", error)
        }
    }
    @PluginMethod fun listPending(call: PluginCall) = async(call) {
        engine.awaitRecovery()
        JSONObject().put("recordings", JSONArray(engine.library.list()))
    }
    @PluginMethod fun deleteAudio(call: PluginCall) = async(call) {
        val id = call.getString("id") ?: throw IllegalArgumentException("invalid_argument")
        if (engine.status().optString("id") == id) throw IllegalStateException("recording_in_progress")
        engine.library.delete(id); null
    }
    @PluginMethod fun readAudioChunk(call: PluginCall) = async(call) {
        val id = call.getString("id") ?: throw IllegalArgumentException("invalid_argument")
        engine.library.requireId(id)
        val offset = (call.data.opt("offset") as? Number)?.toLong() ?: throw IllegalArgumentException("invalid_argument")
        val length = (call.data.opt("length") as? Number)?.toLong() ?: throw IllegalArgumentException("invalid_argument")
        require(offset >= 0 && length > 0) { "invalid_argument" }
        val file = engine.library.audio(id)
        if (!file.isFile) throw IllegalStateException("not_found")
        try { RandomAccessFile(file, "r").use { input ->
            val size = input.length()
            val count = minOf(length, 4L * 1024 * 1024, maxOf(0L, size - offset)).toInt()
            val bytes = ByteArray(count)
            input.seek(offset); input.readFully(bytes)
            JSONObject().put("id", id).put("offset", offset).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("bytesRead", count).put("size", size).put("eof", offset + count >= size)
        } } catch (_: FileNotFoundException) { throw IllegalStateException("not_found") }
    }
    @PluginMethod fun audioMetadata(call: PluginCall) = async(call) {
        val id = call.getString("id") ?: throw IllegalArgumentException("invalid_argument")
        engine.library.requireId(id)
        val file = engine.library.audio(id)
        if (!file.isFile) throw IllegalStateException("not_found")
        val mime = engine.library.list().firstOrNull { it.optString("id") == id }?.optString("mimeType") ?: "audio/mp4"
        JSONObject().put("size", file.length()).put("mimeType", mime).put("sha256", AudioUploadFiles.sha256(file))
    }
    @PluginMethod fun uploadAudio(call: PluginCall) = async(call) {
        val id = call.getString("id") ?: throw IllegalArgumentException("invalid_argument")
        val uploadId = call.getString("uploadId") ?: throw IllegalArgumentException("invalid_argument")
        val url = call.getString("url") ?: throw IllegalArgumentException("invalid_argument")
        val capability = call.getString("capability") ?: throw IllegalArgumentException("invalid_argument")
        val contentType = call.getString("contentType") ?: throw IllegalArgumentException("invalid_argument")
        val contentLength = call.data.optLong("contentLength", -1)
        val file = engine.library.audio(id)
        if (!file.isFile || file.length() != contentLength) throw IllegalStateException("not_found")
        val connection = URL(url).openConnection() as HttpURLConnection
        connection.requestMethod = "PUT"; connection.doOutput = true; connection.instanceFollowRedirects = false
        connection.connectTimeout = 60_000; connection.readTimeout = 180_000
        connection.setFixedLengthStreamingMode(contentLength)
        connection.setRequestProperty("Authorization", "Bearer $capability")
        connection.setRequestProperty("Content-Type", contentType)
        connection.setRequestProperty("X-Correlation-Id", call.getString("correlationId") ?: uploadId)
        synchronized(audioUploadLock) {
            if (cancelledAudioUploads.consume(uploadId)) {
                connection.disconnect()
                throw IllegalStateException("transcription_off")
            }
            audioUploads[uploadId] = connection
        }
        try {
            FileInputStream(file).use { input -> connection.outputStream.use { output ->
                val buffer = ByteArray(1024 * 1024); var sent = 0L
                while (true) {
                    val count = input.read(buffer); if (count < 0) break
                    output.write(buffer, 0, count); sent += count
                    val loaded = sent
                    main.post { notifyListeners("audioUploadProgress", JSObject().put("uploadId", uploadId).put("loaded", loaded).put("total", contentLength)) }
                }
            } }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val text = stream?.bufferedReader()?.use { it.readText() }
            JSONObject().put("status", status).put("body", try { if (text.isNullOrBlank()) JSONObject.NULL else JSONObject(text) } catch (_: Exception) { JSONObject.NULL })
        } finally { audioUploads.remove(uploadId); cancelledAudioUploads.clear(uploadId); connection.disconnect() }
    }
    @PluginMethod fun cancelAudioUpload(call: PluginCall) {
        val uploadId = call.getString("uploadId") ?: run { call.reject("invalid_argument", "invalid_argument"); return }
        synchronized(audioUploadLock) {
            cancelledAudioUploads.cancel(uploadId)
            audioUploads.remove(uploadId)?.disconnect()
        }
        call.resolve()
    }
    @PluginMethod fun setRecordingOptions(call: PluginCall) = async(call) {
        engine.setRecordingOptions(call.data)
        null
    }
    @PluginMethod fun getCaptureDefaults(call: PluginCall) { call.resolve(JSObject.fromJSONObject(engine.defaults())) }
    @PluginMethod fun setCaptureDefaults(call: PluginCall) = async(call) {
        JSONObject().put("claimed", engine.setDefaults(call.data))
    }
    @PluginMethod fun setAccountState(call: PluginCall) = async(call) {
        if (BuildConfig.DEBUG) {
            val prefs = context.getSharedPreferences("exo.debug", 0)
            val failure = System.getProperty("exo.debug.failAccountState")
                ?: prefs.getString("exo.debug.failAccountState", null)
                ?: prefs.getString("failAccountState", null)
            AccountStateDebugFailure.check(failure, call.getString("status"),
                engine.defaults().optString("status"))
        }
        engine.setAccountState(call.data); null
    }
    @PluginMethod fun beginRemoteOp(call: PluginCall) = async(call) {
        val defaults = engine.defaults()
        val stale = defaults.optString("status") != "signed_in" ||
            defaults.optString("accountDid") != call.getString("did")
        engine.library.beginRemoteOp(call.data, forceOutbox = stale); null
    }
    @PluginMethod fun recordRemoteResult(call: PluginCall) = async(call) {
        val destination = engine.library.recordRemoteResult(call.getString("id") ?: "",
            call.getString("did") ?: "", call.getString("opId") ?: "",
            call.data.optJSONObject("result") ?: JSONObject())
        JSONObject().put("destination", destination)
    }
    @PluginMethod fun claim(call: PluginCall) = async(call) {
        val note = engine.library.claim(call.getString("id") ?: "", call.getString("did") ?: "",
            call.getString("evidence") ?: "", call.getString("rowId"))
        JSONObject().put("owner", note.opt("owner"))
    }
    @PluginMethod fun updateLedger(call: PluginCall) = async(call) {
        val did = call.getString("did") ?: ""
        val id = call.getString("id") ?: ""
        val expected = (call.data.opt("rev") as? Number)?.toInt() ?: -1
        val patch = call.data.optJSONObject("patch") ?: JSONObject()
        val note = engine.library.mutate(id, "ledger.write") { side ->
            if (side.optString("owner") != did) throw IllegalStateException("owner_mismatch")
            if (side.optInt("rev") != expected) throw IllegalStateException("rev_conflict")
            val ledger = side.optJSONObject("ledger") ?: JSONObject()
            for (key in patch.keys()) ledger.put(key, patch.get(key))
            side.put("ledger", ledger)
        }
        JSONObject().put("rev", note.getInt("rev"))
    }
    @PluginMethod fun localAudioUrl(call: PluginCall) = async(call) {
        val id = call.getString("id") ?: throw IllegalArgumentException("invalid_argument")
        engine.library.requireId(id)
        val file = engine.library.audio(id)
        if (!file.isFile) throw IllegalStateException("not_found")
        JSONObject().put("url", android.net.Uri.fromFile(file).toString())
    }
    @PluginMethod fun putTranscript(call: PluginCall) = async(call) {
        engine.library.putTranscript(call.getString("id") ?: "", call.data.optJSONObject("transcript") ?: JSONObject())
        null
    }
    @PluginMethod fun getTranscript(call: PluginCall) = async(call) {
        JSONObject().put("transcript", engine.library.getTranscript(call.getString("id") ?: "") ?: JSONObject.NULL)
    }
    @PluginMethod fun listQuarantine(call: PluginCall) = async(call) {
        val array = engine.library.failedRecoveryItems()
        for (file in engine.library.quarantine.listFiles().orEmpty().filter { it.name.endsWith(".m4a") })
            array.put(JSONObject().put("id", file.name.removeSuffix(".m4a")).put("reason", "unplayable").put("sizeBytes", file.length()))
        JSONObject().put("items", array)
    }
    @PluginMethod fun deleteQuarantined(call: PluginCall) = async(call) {
        val id = call.getString("id") ?: ""; engine.library.requireId(id)
        if (engine.library.quarantine.resolve("$id.failure.json").exists())
            engine.library.discardFailedRecording(id)
        else {
            engine.library.quarantine.resolve("$id.m4a").delete()
            engine.library.quarantine.resolve("$id.json").delete()
        }
        null
    }
    @PluginMethod fun retryRecovery(call: PluginCall) = async(call) {
        engine.retryRecovery(call.getString("id") ?: ""); null
    }
    @PluginMethod fun discardFailedRecording(call: PluginCall) = async(call) {
        engine.library.discardFailedRecording(call.getString("id") ?: ""); null
    }
    @PluginMethod fun listOutbox(call: PluginCall) = async(call) {
        JSONObject().put("entries", engine.library.listOutbox(call.getString("did") ?: ""))
    }
    @PluginMethod fun completeOutbox(call: PluginCall) = async(call) {
        engine.library.completeOutbox(call.getString("entryId") ?: "", call.getString("result") ?: ""); null
    }
    @PluginMethod fun listInputs(call: PluginCall) = async(call) { engine.listInputs() }
    @PluginMethod fun selectInput(call: PluginCall) {
        val selected = call.getString("id")
        val bluetooth = selected != null && (selected.startsWith("${android.media.AudioDeviceInfo.TYPE_BLUETOOTH_SCO}:") ||
            (Build.VERSION.SDK_INT >= 31 && selected.startsWith("${android.media.AudioDeviceInfo.TYPE_BLE_HEADSET}:")))
        if (bluetooth && Build.VERSION.SDK_INT >= 31 &&
            getPermissionState("bluetooth") != PermissionState.GRANTED) {
            requestPermissionForAlias("bluetooth", call, "afterBluetooth")
            return
        }
        async(call) { engine.selectInput(selected); null }
    }
    @PermissionCallback private fun afterBluetooth(call: PluginCall) {
        if (getPermissionState("bluetooth") == PermissionState.GRANTED)
            async(call) { engine.selectInput(call.getString("id")); null }
        else call.reject("Bluetooth permission denied", "bluetooth_permission_required")
    }
}
