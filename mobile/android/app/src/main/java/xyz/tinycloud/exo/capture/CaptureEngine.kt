package xyz.tinycloud.exo.capture

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import xyz.tinycloud.exo.capture.core.*
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** Process singleton. Neither the capture nor recovery depends on a WebView being alive. */
class CaptureEngine private constructor(private val context: Context) {
    interface Listener { fun event(name: String, data: JSONObject) }
    private val listeners = CopyOnWriteArrayList<Listener>()
    private val retainedEvents = ArrayDeque<Pair<String, JSONObject>>()
    @Volatile private var retentionConsumer: Listener? = null
    private val announcedRecovered = java.util.Collections.synchronizedSet(HashSet<String>())
    private val controlLock = ReentrantLock()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private val limitTick = object : Runnable {
        override fun run() {
            if (id == null) return
            if (context.filesDir.usableSpace < 100L * 1024 * 1024) autoStop("disk_full")
            else if (intent != "paused" && recordedElapsedMs() >= maxMs) autoStop("max_duration")
            else main.postDelayed(this, 1000)
        }
    }
    val library = RecordingLibrary(File(context.filesDir, "voice-notes"), AndroidFileOps())
    private val prefs = context.getSharedPreferences("exo.capture.defaults", Context.MODE_PRIVATE)
    private var input: AudioCapture? = null
    private var encoder: AacAdtsEncoder? = null
    private var id: String? = null
    private var startedAt = 0L
    private var audioMs = 0L
    private var durableAudioMs = 0L
    private var frames = 0L
    private var segment = 0
    private var segmentFrames = 0L
    private var pausedMs = 0L
    private var pausedAt = 0L
    private var lastCheckpoint = 0L
    private var state = "idle"
    private var reason: String? = null
    private var intent = "stopped"
    private var availability = "available"
    private var maxMs = MAX_DURATION_MS
    private var source = "in_app"
    private var options = defaultOptions()
    private var owner: String? = null
    private var transitionGen = 0L
    private var gen = 0L
    private var silencedAt = 0L
    private var silencedMs = 0L
    private var silencedEvents = 0
    private var noSignalAt = 0L
    private var noSignalMs = 0L
    private var lastPeakAt = System.currentTimeMillis()
    private var spans = JSONArray()
    private var openSpan: JSONObject? = null
    fun addListener(listener: Listener) {
        listeners.add(listener)
        listener.event("micState", status())
    }
    fun addConsumerListener(listener: Listener) {
        val pending = synchronized(retainedEvents) {
            listeners.add(listener)
            retentionConsumer = listener
            retainedEvents.toList().also { retainedEvents.clear() }
        }
        listener.event("micState", status())
        for ((name, value) in pending) listener.event(name, value)
    }
    fun removeListener(listener: Listener) {
        synchronized(retainedEvents) {
            listeners.remove(listener)
            if (retentionConsumer === listener) retentionConsumer = null
        }
    }
    private fun emit(name: String, data: JSONObject) {
        if (name in listOf("autoStopped", "presentRecorder", "recovered", "committed"))
            synchronized(retainedEvents) { if (retentionConsumer == null) retainedEvents.addLast(name to data.copy()) }
        for (listener in listeners) listener.event(name, data)
    }
    private fun publishState() { emit("micState", status()) }
    fun recover() {
        val exitReason = if (Build.VERSION.SDK_INT >= 30) {
            val manager = context.getSystemService(android.app.ActivityManager::class.java)
            manager.getHistoricalProcessExitReasons(context.packageName, 0, 1).firstOrNull()?.let { "android:${it.reason}" }
        } else null
        library.recoverOnce({ note, out -> RecordingFinalizer.mux(library.session(note), out) }, LegacyProbe::inspect, exitReason)
        for (note in library.list()) if (note.optBoolean("recovered") && announcedRecovered.add(note.optString("id")))
            emit("recovered", JSONObject().put("recording", note))
    }
    fun defaults(): JSONObject = JSONObject().put("accountDid", prefs.getString("accountDid", null) ?: JSONObject.NULL)
        .put("transitionGen", prefs.getLong("transitionGen", 0)).put("transcriber", prefs.getString("transcriber", "on-device"))
        .put("identifySpeakers", prefs.getBoolean("identifySpeakers", false))
    @Synchronized fun setDefaults(value: JSONObject): JSONArray {
        val next = value.optLong("transitionGen", -1)
        val old = prefs.getLong("transitionGen", 0)
        if (next < old) throw IllegalStateException("stale_transition")
        val did = value.optString("accountDid").takeUnless { it == "null" || it.isEmpty() }
        val transcriber = if (did == null) "on-device" else value.optString("transcriber", "on-device")
        check(prefs.edit().putLong("transitionGen", next).putString("accountDid", did)
            .putString("transcriber", transcriber).putBoolean("identifySpeakers", value.optBoolean("identifySpeakers"))
            .commit()) { "defaults_write_failed" }
        val claimed = JSONArray()
        if (did != null) {
            if (id != null && owner == null) { owner = did; journalLiveTransition(id!!, "owner", JSONObject().put("did", did)); claimed.put(id) }
            for (note in library.list()) {
                if (note.optInt("version") == 2 && !note.optBoolean("ownerUnknown") && note.optString("owner") == "null") {
                    library.claim(note.getString("id"), did, "signed_out_v2"); claimed.put(note.getString("id"))
                }
            }
        }
        return claimed
    }
    @Synchronized fun setRecordingOptions(value: JSONObject) {
        val current = id ?: throw IllegalStateException("not_recording")
        val transcriber = if (owner == null) "on-device" else value.optString("transcriber", options.optString("transcriber"))
        options = JSONObject().put("transcriber", transcriber)
            .put("identifySpeakers", value.optBoolean("identifySpeakers", options.optBoolean("identifySpeakers")))
        journalLiveTransition(current, "options", options.copy())
        publishState()
    }
    @Synchronized fun start(requestedMs: Long?, requestedOptions: JSONObject?, startSource: String, commandId: String? = null): JSONObject {
        if (id != null) throw IllegalStateException("already_recording")
        if (context.filesDir.usableSpace < 300L * 1024 * 1024) throw IllegalStateException("insufficient_storage")
        recover()
        val defaults = defaults()
        owner = defaults.optString("accountDid").takeUnless { it.isEmpty() || it == "null" }
        transitionGen = defaults.optLong("transitionGen")
        options = JSONObject().put("transcriber", if (owner == null) "on-device" else requestedOptions?.optString("transcriber", defaults.optString("transcriber")) ?: defaults.optString("transcriber"))
            .put("identifySpeakers", requestedOptions?.optBoolean("identifySpeakers", defaults.optBoolean("identifySpeakers")) ?: defaults.optBoolean("identifySpeakers"))
        maxMs = requestedMs?.takeIf { it > 0 }?.coerceIn(1000, MAX_DURATION_MS) ?: MAX_DURATION_MS
        val newId = UUID.randomUUID().toString()
        library.start(newId, startSource, owner, transitionGen, options, maxMs)
        id = newId; startedAt = System.currentTimeMillis(); audioMs = 0; durableAudioMs = 0; frames = 0; segment = 0; segmentFrames = 0
        pausedMs = 0; pausedAt = 0; silencedMs = 0; silencedEvents = 0; noSignalMs = 0
        source = startSource; intent = "recording"; availability = "available"; state = "recording"; reason = null; gen++
        spans = JSONArray(); openSpan = null; lastCheckpoint = startedAt
        try { acquire {
            library.openFirstSegment(newId, 0, gen)
            lastCheckpoint = System.currentTimeMillis()
        } } catch (e: Exception) {
            id = null; intent = "stopped"; state = "idle"; throw e
        }
        main.removeCallbacks(limitTick); main.postDelayed(limitTick, 1000)
        publishState()
        if (commandId != null) emit("started", JSONObject().put("commandId", commandId).put("id", newId))
        if (startSource != "in_app") emit("presentRecorder", JSONObject().put("id", newId))
        return JSONObject().put("id", newId).put("startedAt", startedAt).put("maxDurationMs", maxMs)
    }
    private fun acquire(beforeStart: () -> Unit = {}) {
        val current = id ?: return
        val attempt = gen
        encoder = AacAdtsEncoder { frame ->
            synchronized(this) {
                if (id != current || gen != attempt || intent != "recording") return@synchronized
                library.append(current, segment, frame)
                frames++ ; segmentFrames++
                audioMs = frames * 1024L * 1000 / SAMPLE_RATE
                val now = System.currentTimeMillis()
                if (segmentFrames * 1024L / SAMPLE_RATE >= 60) {
                    library.checkpoint(current, segment, audioMs, "recording", "available", close = true)
                    durableAudioMs = audioMs
                    segment++; segmentFrames = 0; library.roll(current, segment, audioMs); lastCheckpoint = now
                } else if (availability == "available" && now - lastCheckpoint >= 2000) {
                    library.checkpoint(current, segment, audioMs, "recording", "available")
                    durableAudioMs = audioMs
                    lastCheckpoint = now
                }
                if (recordedElapsedMs() >= maxMs) android.os.Handler(android.os.Looper.getMainLooper()).post { autoStop("max_duration") }
            }
        }
        input = try { AudioCapture({ pcm -> encoder?.offer(pcm, pcm.size) }, { level, peak ->
            emit("level", JSONObject().put("level", level).put("peak", peak))
            val now = System.currentTimeMillis()
            if (peak > 0) { if (noSignalAt > 0) noSignalMs += now - noSignalAt; noSignalAt = 0; lastPeakAt = now }
            else if (now - lastPeakAt > 2000 && noSignalAt == 0L) { noSignalAt = now; reason = "no_signal"; publishState() }
        }, { silenced ->
            synchronized(this) {
                if (id != current || gen != attempt || intent != "recording") return@synchronized
                if (silenced && silencedAt == 0L) {
                    silencedAt = System.currentTimeMillis(); silencedEvents++
                    openSpan = JSONObject().put("kind", "silenced").put("reason", "os_silenced")
                        .put("startedAt", silencedAt).put("endedAt", JSONObject.NULL).put("atAudioMs", audioMs).put("audioMs", 0)
                    journalLiveTransition(current, "span_open", JSONObject().put("kind", "silenced").put("reason", "os_silenced"))
                    state = "silenced"; reason = "os_silenced"; publishState()
                }
                if (!silenced && silencedAt != 0L) { closeSilence(current); state = "recording"; reason = null; publishState() }
            }
        }, { error ->
            if (error == "writer_stalled") {
                journalLiveTransition(current, "span_open", JSONObject().put("kind", "omitted").put("reason", "writer_stalled"))
            } else if (error == "writer_resumed") {
                journalLiveTransition(current, "span_close", JSONObject().put("kind", "omitted").put("reason", "writer_stalled"))
            }
            if (error != "writer_resumed") Log.e("ExoCapture", error)
            reason = if (error == "writer_resumed") null else error; publishState()
            if (error.startsWith("write_failed")) android.os.Handler(android.os.Looper.getMainLooper()).post { autoStop("write_failed") }
        }) } catch (e: Exception) { encoder?.abort(); encoder = null; throw e }
        try { beforeStart(); input!!.start() }
        catch (e: Exception) {
            input?.release(); input = null
            encoder?.abort(); encoder = null
            throw e
        }
    }
    private fun journalLiveTransition(current: String, name: String, extra: JSONObject) = synchronized(this) {
        if (id != current || library.tombstone(current).exists()) return@synchronized
        if (intent == "recording") {
            if (!File(library.session(current), "seg-%05d.aac".format(segment)).isFile) return@synchronized
            library.syncAudio(current, segment)
            durableAudioMs = audioMs
        }
        library.transition(current, name, durableAudioMs, extra)
    }
    private fun closeSilence(current: String) {
        if (silencedAt == 0L) return
        val now = System.currentTimeMillis()
        silencedMs += now - silencedAt; silencedAt = 0
        journalLiveTransition(current, "span_close", JSONObject().put("kind", "silenced").put("reason", "os_silenced"))
        openSpan?.put("endedAt", now)?.put("audioMs", audioMs - openSpan!!.optLong("atAudioMs"))
        if (openSpan != null) spans.put(openSpan)
        openSpan = null
    }
    fun pause() = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        if (intent == "paused") return@withLock
        // AudioRecord.stop cuts the input first. AudioCapture then collects the
        // in-flight read and any post-stop readable tail before draining PCM.
        val captured = input ?: throw IllegalStateException("pause_failed")
        val at = System.currentTimeMillis()
        try { captured.drain() } catch (e: Exception) {
            if (!captured.inputStopped) throw IllegalStateException("pause_failed", e)
            failStoppedPause(current, captured, e)
        }
        try {
            encoder?.finish(); encoder = null
            closeSilence(current)
            library.checkpoint(current, segment, audioMs, "recording", "available", close = true, at = at)
            durableAudioMs = audioMs
            library.transition(current, "intent", audioMs, JSONObject().put("value", "paused").put("by", "user"), at)
        } catch (e: Exception) { failStoppedPause(current, captured, e) }
        try { captured.release() } catch (e: Exception) {
            Log.e("ExoCapture", "AudioRecord release failed after durable pause", e)
        }
        input = null
        gen++; intent = "paused"; state = "paused"; reason = "user"; pausedAt = at
        publishState()
    }
    private fun failStoppedPause(current: String, captured: AudioCapture, failure: Exception): Nothing {
        try { captured.release() } catch (e: Exception) { Log.e("ExoCapture", "AudioRecord release after failed Pause", e) }
        input = null
        try { encoder?.abort() } catch (e: Exception) { Log.e("ExoCapture", "AAC abort after failed Pause", e) }
        encoder = null
        try { library.checkpoint(current, segment, audioMs, "recording", "available", close = true); durableAudioMs = audioMs }
        catch (e: Exception) { Log.e("ExoCapture", "Final checkpoint after failed Pause", e) }
        autoStop("write_failed")
        if (id != null) {
            availability = "blocked"; state = "needs_user"; reason = "write_failed"; publishState()
        }
        throw IllegalStateException("pause_failed", failure)
    }
    fun resume() = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        if (intent != "paused" && !(intent == "recording" && availability == "blocked" && input == null)) return@withLock
        val at = System.currentTimeMillis()
        if (pausedAt > 0) { pausedMs += at - pausedAt; pausedAt = 0 }
        gen++; segmentFrames = 0; lastCheckpoint = at
        intent = "recording"; state = "recording"; reason = null
        try {
            acquire {
                library.transition(current, "intent", audioMs, JSONObject().put("value", "recording").put("by", "user"), at)
                availability = "available"
                library.transition(current, "avail", audioMs, JSONObject().put("value", "available")
                    .put("reason", JSONObject.NULL).put("gen", gen), at)
                library.roll(current, segment + 1, audioMs)
                segment++
            }
        } catch (e: Exception) {
            availability = "blocked"; state = "needs_user"; reason = "resume_blocked"
            library.transition(current, "avail", audioMs, JSONObject().put("value", "blocked")
                .put("reason", "resume_blocked").put("gen", gen), at)
            publishState()
            throw IllegalStateException("resume_failed", e)
        }
        publishState()
    }
    fun stop(reason: String = "user"): JSONObject = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        // AudioCapture.stop drains its bounded queue. Never hold the engine monitor
        // while joining that writer, because each encoded frame enters that monitor.
        val wasCapturing = input != null
        input?.stop(); input = null; encoder?.finish(); encoder = null
        closeSilence(current)
        gen++; intent = "stopped"
        if (pausedAt > 0) { pausedMs += System.currentTimeMillis() - pausedAt; pausedAt = 0 }
        val at = System.currentTimeMillis()
        if (wasCapturing) {
            library.checkpoint(current, segment, audioMs, "recording", "available", close = true, at = at)
            durableAudioMs = audioMs
        }
        library.stopJournal(current, audioMs, reason, at)
        library.commit(current, { RecordingFinalizer.mux(library.session(current), it) })
        val note = library.mutate(current, "stop.metrics") { side ->
            side.put("silencedMs", silencedMs).put("silencedEvents", silencedEvents).put("noSignalMs", noSignalMs)
        }
        id = null; state = "idle"; this.reason = if (reason == "user") null else reason
        main.removeCallbacks(limitTick)
        publishState(); emit("committed", note)
        note
    }
    fun discard(): String? = controlLock.withLock {
        val current = id ?: return@withLock null
        gen++; intent = "stopped"; library.delete(current)
        input?.stop(); input = null; encoder?.finish(); encoder = null
        id = null; state = "idle"; reason = null; publishState()
        main.removeCallbacks(limitTick)
        current
    }
    private fun autoStop(why: String) {
        if (id == null || intent != "recording") return
        val note = try { stop(why) } catch (e: Exception) { Log.e("ExoCapture", "Auto-stop failed", e); null }
        emit("autoStopped", JSONObject().put("reason", why).put("maxDurationMs", maxMs)
            .put("at", System.currentTimeMillis()).put("recording", note ?: JSONObject.NULL))
    }
    private fun recordedElapsedMs(): Long {
        if (id == null) return 0
        val now = System.currentTimeMillis()
        return now - startedAt - pausedMs - if (pausedAt > 0) now - pausedAt else 0
    }
    @Synchronized fun status(): JSONObject = JSONObject().put("state", state).put("reason", reason ?: JSONObject.NULL)
        .put("id", id ?: JSONObject.NULL).put("intent", intent).put("availability", availability)
        .put("startedAt", if (id == null) JSONObject.NULL else startedAt)
        .put("elapsedMs", recordedElapsedMs()).put("pausedMs", pausedMs + if (pausedAt > 0) System.currentTimeMillis() - pausedAt else 0)
        .put("audioMs", durableAudioMs).put("maxDurationMs", maxMs)
        .put("spans", JSONArray(spans.toString())).put("openSpan", openSpan?.copy() ?: JSONObject.NULL)
        .put("source", source).put("options", options.copy())
        .put("input", if (id == null) JSONObject.NULL else JSONObject().put("id", "built-in")
            .put("name", "Built-in microphone").put("kind", "built_in"))
        .put("owner", owner ?: JSONObject.NULL)
        .put("transitionGen", transitionGen).put("gen", gen).put("androidSdkInt", Build.VERSION.SDK_INT)
    companion object {
        @Volatile private var instance: CaptureEngine? = null
        @JvmStatic fun get(context: Context): CaptureEngine = instance ?: synchronized(this) {
            instance ?: CaptureEngine(context.applicationContext).also { instance = it }
        }
    }
}
