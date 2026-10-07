package xyz.tinycloud.exo.capture

import android.Manifest
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
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
import java.io.RandomAccessFile
import java.util.UUID

@CapacitorPlugin(name = "VoiceNotes", permissions = [
    Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]),
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
])
class VoiceNotesPlugin : Plugin(), CaptureEngine.Listener {
    private lateinit var engine: CaptureEngine
    private val main = Handler(Looper.getMainLooper())
    private var pendingStart: Pair<String, PluginCall>? = null
    override fun load() { engine = CaptureEngine.get(context); engine.addListener(this); engine.recover() }
    override fun handleOnDestroy() { engine.removeListener(this); super.handleOnDestroy() }
    override fun event(name: String, data: JSONObject) {
        if (name == "started") {
            val pending = pendingStart
            if (pending != null && pending.first == data.optString("commandId")) {
                pendingStart = null
                val status = engine.status()
                pending.second.resolve(JSObject().put("id", data.getString("id"))
                    .put("startedAt", status.getLong("startedAt")).put("maxDurationMs", status.getLong("maxDurationMs")))
            }
        } else notifyListeners(name, JSObject.fromJSONObject(data), name in listOf("micState", "autoStopped", "presentRecorder", "recovered", "committed"))
    }
    @PluginMethod fun start(call: PluginCall) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) { requestPermissionForAlias("microphone", call, "afterMic"); return }
        startReady(call)
    }
    @PermissionCallback private fun afterMic(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) startReady(call)
        else call.reject("Microphone permission denied", "permission_denied")
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
        CaptureService.startFromPlugin(context, max, commandId)
        main.postDelayed({
            if (pendingStart?.first != commandId) return@postDelayed
            pendingStart = null; call.reject("Capture service did not start", "start_failed")
        }, 3000)
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
    @PluginMethod fun status(call: PluginCall) { call.resolve(JSObject.fromJSONObject(engine.status())) }
    @PluginMethod fun listPending(call: PluginCall) = async(call) {
        engine.recover()
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
        RandomAccessFile(file, "r").use { input ->
            val size = input.length()
            val count = minOf(length, 4L * 1024 * 1024, maxOf(0L, size - offset)).toInt()
            val bytes = ByteArray(count)
            input.seek(offset); input.readFully(bytes)
            JSONObject().put("id", id).put("offset", offset).put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("bytesRead", count).put("size", size).put("eof", offset + count >= size)
        }
    }
    @PluginMethod fun setRecordingOptions(call: PluginCall) = async(call) {
        engine.setRecordingOptions(call.data)
        null
    }
    @PluginMethod fun getCaptureDefaults(call: PluginCall) { call.resolve(JSObject.fromJSONObject(engine.defaults())) }
    @PluginMethod fun setCaptureDefaults(call: PluginCall) = async(call) {
        JSONObject().put("claimed", engine.setDefaults(call.data))
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
        val array = JSONArray()
        for (file in engine.library.quarantine.listFiles().orEmpty().filter { it.name.endsWith(".m4a") })
            array.put(JSONObject().put("id", file.name.removeSuffix(".m4a")).put("reason", "unplayable").put("sizeBytes", file.length()))
        JSONObject().put("items", array)
    }
    @PluginMethod fun deleteQuarantined(call: PluginCall) = async(call) {
        val id = call.getString("id") ?: ""; engine.library.requireId(id)
        engine.library.quarantine.resolve("$id.m4a").delete(); engine.library.quarantine.resolve("$id.json").delete(); null
    }
    @PluginMethod fun listOutbox(call: PluginCall) = async(call) {
        JSONObject().put("entries", engine.library.listOutbox(call.getString("did") ?: ""))
    }
    @PluginMethod fun completeOutbox(call: PluginCall) = async(call) {
        engine.library.completeOutbox(call.getString("entryId") ?: "", call.getString("result") == "done"); null
    }
    @PluginMethod fun listInputs(call: PluginCall) { call.reject("Input selection arrives in T14", "unimplemented") }
    @PluginMethod fun selectInput(call: PluginCall) { call.reject("Input selection arrives in T14", "unimplemented") }
}
