package xyz.tinycloud.exo.capture

import android.content.Context
import android.os.Build
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import xyz.tinycloud.exo.capture.core.*
import java.io.File
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
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
    private val autoExecutor = Executors.newSingleThreadExecutor { task -> Thread(task, "ExoCaptureAutoStop") }
    private val autoStopPending = AtomicBoolean(false)
    private val limitTick = object : Runnable {
        override fun run() {
            if (id == null) return
            try {
                if (context.filesDir.usableSpace < 100L * 1024 * 1024) scheduleAutoStop("disk_full")
                else if (intent != "paused" && recordedElapsedMs() >= maxMs) scheduleAutoStop("max_duration")
            } finally { if (id != null) main.postDelayed(this, 1000) }
        }
    }
    val library = RecordingLibrary(File(context.filesDir, "voice-notes"), AndroidFileOps())
    private val prefs = context.getSharedPreferences("exo.capture.defaults", Context.MODE_PRIVATE)
    private val inputs = InputDevices(context)
    @Volatile private var input: AudioCapture? = null
    private var encoder: AacAdtsEncoder? = null
    @Volatile private var id: String? = null
    private var startedAt = 0L
    @Volatile private var sequence: CaptureSequence? = null
    private val audioMs get() = sequence?.audioMs ?: 0L
    private val durableAudioMs get() = sequence?.durableAudioMs ?: 0L
    private var pausedMs = 0L
    private var pausedAt = 0L
    @Volatile private var state = "idle"
    @Volatile private var reason: String? = null
    @Volatile private var intent = "stopped"
    @Volatile private var availability = "available"
    private var maxMs = MAX_DURATION_MS
    private var source = "in_app"
    private var options = defaultOptions()
    private var owner: String? = null
    private var transitionGen = 0L
    private var gen = 0L
    private var epoch = 0L
    private var silencedAt = 0L
    private var silencedMs = 0L
    private var silencedEvents = 0
    private var noSignalAt = 0L
    private var noSignalMs = 0L
    private var lastPeakAt = System.currentTimeMillis()
    private var spans = JSONArray()
    private var openSpan: JSONObject? = null
    @Volatile var startBeforeAttach: (() -> Unit)? = null // Instrumented suspension gate.
    private class StaleStart : RuntimeException("stale_start")
    private val retry: Runnable = object : Runnable {
        override fun run() {
            if (id == null || intent != "recording" || availability == "available") return
            runCatching { resume() }.onFailure { scheduleRetry() }
        }
    }
    private var retryDelayMs = 500L
    private var interruptedAt = 0L
    init {
        context.getSystemService(AudioManager::class.java).registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = devicesChanged()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = devicesChanged()
        }, main)
        if (Build.VERSION.SDK_INT >= 31) context.getSystemService(AudioManager::class.java)
            .addOnModeChangedListener(context.mainExecutor) { mode ->
                if (mode == AudioManager.MODE_NORMAL) interruptionEnded() else interruptionBegan("call")
            }
    }
    private fun devicesChanged() {
        emit("inputs", listInputs())
        if (id != null && intent == "recording" && input != null) Thread { rebuild("route_change") }.start()
    }
    fun listInputs(): JSONObject = inputs.list(input?.activeInputId())
    fun selectInput(selectedId: String?) {
        inputs.select(selectedId)
        emit("inputs", listInputs())
        if (id != null && intent == "recording" && input != null) rebuild("route_change")
    }
    private fun scheduleRetry() {
        if (interruptedAt == 0L) interruptedAt = System.currentTimeMillis()
        if (System.currentTimeMillis() - interruptedAt >= 600_000) {
            availability = "blocked"; state = "needs_user"; publishState()
            CaptureNotifications.showResumeAlert(context, status())
            return
        }
        main.removeCallbacks(retry)
        main.postDelayed(retry, retryDelayMs)
        retryDelayMs = minOf(retryDelayMs * 2, 30_000)
    }
    private fun interruptionBegan(why: String) = controlLock.withLock {
        val current = id ?: return@withLock
        if (intent != "recording" || availability != "available") return@withLock
        val captured = input ?: return@withLock
        sequence?.beginClose()
        try { captured.drain(); encoder?.finish() }
        catch (e: Exception) { Log.e("ExoCapture", "Interruption drain failed", e); encoder?.abort() }
        finally { captured.release(); input = null; encoder = null }
        closeSilence(current)
        val at = System.currentTimeMillis()
        gen++
        sequence?.interrupt(why, why, gen, at)
        openSpan = JSONObject().put("kind", "omitted").put("reason", why)
            .put("startedAt", at).put("endedAt", JSONObject.NULL).put("atAudioMs", audioMs).put("audioMs", 0)
        availability = "interrupted"; state = "interrupted"; reason = why
        interruptedAt = at; retryDelayMs = 500
        publishState()
    }
    private fun interruptionEnded() {
        if (id != null && intent == "recording" && availability == "interrupted") main.post(retry)
    }
    private fun rebuild(why: String) {
        interruptionBegan(why)
        interruptionEnded()
    }
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
        try { library.recoverOnce({ note, out -> RecordingFinalizer.mux(library.session(note), out) }, LegacyProbe::inspect, exitReason) }
        catch (e: Exception) {
            Log.e("ExoCapture", "Recovery needs retry", e)
            emit("recoveryFailed", JSONObject().put("error", e.message ?: "recovery_failed"))
        }
        for (note in library.list()) if (note.optBoolean("recovered") && announcedRecovered.add(note.optString("id")))
            emit("recovered", JSONObject().put("recording", note))
    }
    @JvmOverloads fun presentRecorder(commandId: String? = null, why: String? = null) {
        val current = id
        val event = JSONObject().put("id", current ?: JSONObject.NULL)
        if (why != null) event.put("reason", why)
        emit("presentRecorder", event)
        if (commandId != null && current != null)
            emit("started", JSONObject().put("commandId", commandId).put("id", current))
    }
    fun startFailed(commandId: String?, error: Exception) {
        if (commandId != null) emit("startFailed", JSONObject().put("commandId", commandId)
            .put("code", error.message ?: "start_failed"))
    }
    fun defaults(): JSONObject = JSONObject().put("accountDid", prefs.getString("accountDid", null) ?: JSONObject.NULL)
        .put("transitionGen", prefs.getLong("transitionGen", 0)).put("transcriber", prefs.getString("transcriber", "on-device"))
        .put("identifySpeakers", prefs.getBoolean("identifySpeakers", false))
    @Synchronized fun setDefaults(value: JSONObject): JSONArray {
        val next = value.optLong("transitionGen", -1)
        val old = prefs.getLong("transitionGen", 0)
        requireTransitionGeneration(next, old)
        val did = value.opt("accountDid")?.takeUnless { it == JSONObject.NULL }?.toString()?.takeIf { it.isNotEmpty() }
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
    fun start(requestedMs: Long?, requestedOptions: JSONObject?, startSource: String, commandId: String? = null): JSONObject = controlLock.withLock {
        if (id != null) throw IllegalStateException("already_recording")
        if (context.filesDir.usableSpace < 300L * 1024 * 1024) throw IllegalStateException("insufficient_storage")
        recover() // Reports failed sessions, but never treats them as a prerequisite for this new id.
        startAfterRecovery(requestedMs, requestedOptions, startSource, commandId)
    }
    private fun startAfterRecovery(requestedMs: Long?, requestedOptions: JSONObject?, startSource: String, commandId: String?): JSONObject {
        val defaults = defaults()
        owner = defaults.opt("accountDid")?.takeUnless { it == JSONObject.NULL }?.toString()?.takeIf { it.isNotEmpty() }
        transitionGen = defaults.optLong("transitionGen")
        options = JSONObject().put("transcriber", if (owner == null) "on-device" else requestedOptions?.optString("transcriber", defaults.optString("transcriber")) ?: defaults.optString("transcriber"))
            .put("identifySpeakers", requestedOptions?.optBoolean("identifySpeakers", defaults.optBoolean("identifySpeakers")) ?: defaults.optBoolean("identifySpeakers"))
        maxMs = requestedMs?.takeIf { it > 0 }?.coerceIn(1000, MAX_DURATION_MS) ?: MAX_DURATION_MS
        val newId = UUID.randomUUID().toString()
        startedAt = System.currentTimeMillis()
        sequence = CaptureSequence(library, newId).also {
            it.start(startSource, owner, transitionGen, options, maxMs, startedAt)
        }
        id = newId
        pausedMs = 0; pausedAt = 0; silencedMs = 0; silencedEvents = 0; noSignalMs = 0
        noSignalAt = 0; lastPeakAt = System.currentTimeMillis()
        source = startSource; intent = "recording"; availability = "available"; state = "recording"; reason = null; gen++
        spans = JSONArray(); openSpan = null
        try { acquire {
            sequence!!.firstInput(gen)
        } } catch (e: Exception) {
            if (id == newId && intent == "recording") {
                library.closeSession(newId)
                id = null; intent = "stopped"; state = "idle"
            }
            throw e
        }
        main.removeCallbacks(limitTick); main.postDelayed(limitTick, 1000)
        epoch++
        publishState()
        if (commandId != null) emit("started", JSONObject().put("commandId", commandId).put("id", newId))
        if (startSource != "in_app") presentRecorder()
        return JSONObject().put("id", newId).put("startedAt", startedAt).put("maxDurationMs", maxMs)
    }
    private fun acquire(beforeStart: () -> Unit = {}, afterStart: () -> Unit = {}) {
        val current = id ?: return
        val attempt = gen
        val localEncoder = AacAdtsEncoder { frame ->
            synchronized(this) {
                if (id != current || gen != attempt || intent != "recording") return@synchronized
                sequence!!.frame(frame)
                if (recordedElapsedMs() >= maxMs) scheduleAutoStop("max_duration")
            }
        }
        val localInput = try { AudioCapture({ pcm -> localEncoder.offer(pcm, pcm.size) }, { level, peak ->
            emit("level", JSONObject().put("level", level).put("peak", peak))
            val now = System.currentTimeMillis()
            if (peak > 0) {
                if (noSignalAt > 0) {
                    noSignalMs += now - noSignalAt; noSignalAt = 0
                    if (reason == "no_signal") { reason = null; publishState() }
                }
                lastPeakAt = now
            } else if (now - lastPeakAt > 2000 && noSignalAt == 0L) {
                noSignalAt = lastPeakAt; reason = "no_signal"; publishState()
            }
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
            if (error.startsWith("read_") && localInputStopped(current, attempt)) return@AudioCapture
            if (error == "writer_stalled") {
                journalLiveTransition(current, "span_open", JSONObject().put("kind", "omitted").put("reason", "writer_stalled"))
            } else if (error == "writer_resumed") {
                journalLiveTransition(current, "span_close", JSONObject().put("kind", "omitted").put("reason", "writer_stalled"))
            }
            if (error != "writer_resumed") Log.e("ExoCapture", error)
            reason = if (error == "writer_resumed") null else error; publishState()
            if (error.startsWith("write_failed")) scheduleAutoStop("write_failed")
            if (error == "read_error" || error.startsWith("read_failed"))
                Thread { handleReadFailure(current, attempt) }.start()
            if (error == "stalled") Thread { rebuild("stalled") }.start()
        }, inputs, { emit("inputs", listInputs()) }) } catch (e: Exception) { localEncoder.abort(); throw e }
        // A start can wait in Android or in the test gate. Pause/Stop/Discard must
        // take the control lock meanwhile, and only this attempt may be torn down.
        check(controlLock.holdCount == 1)
        controlLock.unlock()
        var failure: Exception? = null
        try {
            localInput.start {
                startBeforeAttach?.invoke()
                controlLock.withLock {
                    if (id != current || gen != attempt || intent != "recording") throw StaleStart()
                    input = localInput; encoder = localEncoder
                    try { beforeStart(); afterStart(); localInput.startWorkers() }
                    catch (e: Exception) { input = null; encoder = null; throw e }
                }
            }
        } catch (e: Exception) { failure = e }
        finally { controlLock.lock() }
        failure?.let {
            try { localInput.release() } catch (release: Exception) { Log.e("ExoCapture", "Stale input release failed", release) }
            localEncoder.abort()
            throw it
        }
    }
    private fun localInputStopped(current: String, attempt: Long) =
        id != current || gen != attempt || intent != "recording" || input?.inputStopped == true
    private fun journalLiveTransition(current: String, name: String, extra: JSONObject) = synchronized(this) {
        if (id != current || library.tombstone(current).exists()) return@synchronized
        sequence?.transition(name, extra)
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
    private fun closeOmitted(current: String, at: Long) {
        val span = openSpan ?: return
        if (span.optString("kind") != "omitted") return
        sequence?.transition("span_close", JSONObject().put("kind", "omitted")
            .put("reason", span.optString("reason")), at)
        span.put("endedAt", at).put("audioMs", 0)
        spans.put(span)
        openSpan = null
    }
    private fun handleReadFailure(current: String, attempt: Long) = controlLock.withLock {
        if (id != current || gen != attempt || intent != "recording" || input == null) return@withLock
        val captured = input!!
        var teardownFailed = false
        sequence?.beginClose()
        try {
            captured.drainAfterReadFailure()
            encoder?.finish(); encoder = null
            closeSilence(current)
            val at = System.currentTimeMillis()
            gen++
            sequence!!.interrupt("read_error", "read_error", gen, at)
            openSpan = JSONObject().put("kind", "omitted").put("reason", "read_error")
                .put("startedAt", at).put("endedAt", JSONObject.NULL)
                .put("atAudioMs", audioMs).put("audioMs", 0)
            availability = "interrupted"; state = "interrupted"; reason = "read_error"
            publishState()
        } catch (e: Exception) {
            Log.e("ExoCapture", "Read failure teardown failed", e)
            encoder?.abort(); encoder = null
            teardownFailed = true
        } finally {
            try { captured.release() } catch (e: Exception) { Log.e("ExoCapture", "Input release after read error", e) }
            input = null
        }
        if (teardownFailed) autoStop("write_failed") else {
            interruptedAt = System.currentTimeMillis(); retryDelayMs = 500
            scheduleRetry()
        }
    }
    internal fun injectReadErrorForTest() {
        val current = id ?: throw IllegalStateException("not_recording")
        check(input != null) { "input_not_attached" }
        handleReadFailure(current, gen)
    }
    internal fun hasAttachedInputForTest(): Boolean = input != null
    fun pause() = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        if (intent == "paused") return@withLock
        if (input == null) {
            val at = System.currentTimeMillis()
            closeOmitted(current, at)
            sequence!!.pause(at)
            gen++; epoch++; intent = "paused"; state = "paused"; reason = "user"; pausedAt = at
            CaptureNotifications.cancelAlert(context)
            main.removeCallbacks(retry)
            publishState()
            return@withLock
        }
        // AudioRecord.stop cuts the input first. AudioCapture then collects the
        // in-flight read and any post-stop readable tail before draining PCM.
        val captured = input ?: throw IllegalStateException("pause_failed")
        sequence?.beginClose()
        try { captured.drain() } catch (e: Exception) {
            if (!captured.inputStopped) {
                sequence?.cancelClose()
                throw IllegalStateException("pause_failed", e)
            }
            failStoppedPause(current, captured, e)
        }
        try {
            encoder?.finish(); encoder = null
            closeSilence(current)
            val at = System.currentTimeMillis()
            sequence!!.pause(at)
            pausedAt = at
        } catch (e: Exception) { failStoppedPause(current, captured, e) }
        try { captured.release() } catch (e: Exception) {
            Log.e("ExoCapture", "AudioRecord release failed after durable pause", e)
        }
        input = null
        gen++; epoch++; intent = "paused"; state = "paused"; reason = "user"
        CaptureNotifications.cancelAlert(context)
        main.removeCallbacks(retry)
        publishState()
    }
    private fun failStoppedPause(current: String, captured: AudioCapture, failure: Exception): Nothing {
        try { captured.release() } catch (e: Exception) { Log.e("ExoCapture", "AudioRecord release after failed Pause", e) }
        input = null
        try { encoder?.abort() } catch (e: Exception) { Log.e("ExoCapture", "AAC abort after failed Pause", e) }
        encoder = null
        try { sequence?.closeSegment() }
        catch (e: Exception) { Log.e("ExoCapture", "Final checkpoint after failed Pause", e) }
        autoStop("write_failed")
        if (id != null) {
            availability = "blocked"; state = "needs_user"; reason = "write_failed"; publishState()
        }
        throw IllegalStateException("pause_failed", failure)
    }
    fun resume(): Unit = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        val wasPaused = intent == "paused"
        if (!wasPaused && !(intent == "recording" && availability != "available" && input == null)) return@withLock
        val at = System.currentTimeMillis()
        if (pausedAt > 0) { pausedMs += at - pausedAt; pausedAt = 0 }
        gen++
        val attempt = gen
        intent = "recording"; state = "recording"; reason = null
        if (wasPaused) sequence!!.resumeIntent(at)
        try {
            acquire(afterStart = {
                availability = "available"
                if (wasPaused) sequence!!.resumeAcquired(gen, at)
                else {
                    val omittedReason = openSpan?.takeIf { it.optString("kind") == "omitted" }?.optString("reason")
                    if (omittedReason != null) sequence!!.restartAfterInterruption(omittedReason, gen, at)
                    else sequence!!.resumeAcquired(gen, at)
                    closeOmittedInMemory(at)
                }
            })
        } catch (e: Exception) {
            if (id != current || gen != attempt || intent != "recording") return@withLock
            availability = "blocked"; state = "needs_user"
            reason = if (e is SecurityException) "resume_not_allowed" else "mic_unavailable"
            sequence!!.resumeFailed(gen, at, reason!!)
            publishState()
            CaptureNotifications.showResumeAlert(context, status())
            throw IllegalStateException("resume_failed", e)
        }
        epoch++
        interruptedAt = 0; retryDelayMs = 500; main.removeCallbacks(retry)
        CaptureNotifications.cancelAlert(context)
        publishState()
    }
    private fun closeOmittedInMemory(at: Long) {
        val span = openSpan ?: return
        span.put("endedAt", at).put("audioMs", 0)
        spans.put(span)
        openSpan = null
    }
    fun stop(reason: String = "user"): JSONObject = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        if (input == null) library.read(current)?.let { saved ->
            id = null; state = "idle"; this.reason = null; intent = "stopped"; availability = "available"
            main.removeCallbacks(limitTick)
            publishState(); emit("committed", saved)
            return@withLock saved
        }
        // AudioCapture.stop drains its bounded queue. Never hold the engine monitor
        // while joining that writer, because each encoded frame enters that monitor.
        val captured = input
        var captureFailure: Exception? = null
        if (captured != null) {
            sequence?.beginClose()
            try { captured.drain() } catch (e: Exception) {
                captureFailure = e
                Log.e("ExoCapture", "Input drain failed; committing durable audio", e)
            } finally {
                try { captured.release() } catch (e: Exception) { Log.e("ExoCapture", "Input release failed", e) }
                input = null
            }
        }
        var finalReason = reason
        val note = try {
            if (captureFailure == null) {
                try { encoder?.finish() } catch (e: Exception) { captureFailure = e; Log.e("ExoCapture", "Encoder finish failed", e) }
            }
            if (captureFailure != null) encoder?.abort()
            encoder = null
            closeSilence(current)
            closeOmitted(current, System.currentTimeMillis())
            gen++; epoch++; intent = "stopped"; CaptureNotifications.cancelAlert(context); main.removeCallbacks(retry)
            if (pausedAt > 0) { pausedMs += System.currentTimeMillis() - pausedAt; pausedAt = 0 }
            val at = System.currentTimeMillis()
            finalReason = if (captureFailure != null) "write_failed" else reason
            sequence!!.stop(finalReason, at)
            library.commit(current, { RecordingFinalizer.mux(library.session(current), it) },
                metrics = JSONObject().put("silencedMs", silencedMs).put("silencedEvents", silencedEvents).put("noSignalMs", noSignalMs))
        } catch (e: Exception) {
            try { encoder?.abort() } catch (abort: Exception) { Log.e("ExoCapture", "AAC abort after failed Stop", abort) }
            encoder = null
            gen++; epoch++; intent = "stopped"; CaptureNotifications.cancelAlert(context); main.removeCallbacks(retry)
            library.closeSession(current)
            state = "needs_user"; this.reason = "write_failed"; availability = "blocked"
            main.removeCallbacks(limitTick)
            publishState()
            throw e
        }
        id = null; state = "idle"; this.reason = if (finalReason == "user") null else finalReason
        main.removeCallbacks(limitTick)
        publishState(); emit("committed", note)
        note
    }
    fun discard(): String? = controlLock.withLock {
        val current = id ?: return@withLock null
        if (library.sidecar(current).exists()) throw IllegalStateException("already_committed")
        gen++; epoch++; intent = "stopped"; CaptureNotifications.cancelAlert(context); main.removeCallbacks(retry)
        val captured = input
        try { captured?.drain() } catch (e: Exception) { Log.e("ExoCapture", "Discard input drain failed", e) }
        finally {
            try { captured?.release() } catch (e: Exception) { Log.e("ExoCapture", "Discard input release failed", e) }
            input = null
        }
        encoder?.abort(); encoder = null
        library.discardUncommitted(current)
        id = null; state = "idle"; reason = null; publishState()
        main.removeCallbacks(limitTick)
        current
    }
    private fun autoStop(why: String) {
        if (id == null || intent != "recording") return
        try {
            val note = stop(why)
            emit("autoStopped", JSONObject().put("reason", why).put("maxDurationMs", maxMs)
                .put("at", System.currentTimeMillis()).put("recording", note))
        } catch (e: Exception) {
            Log.e("ExoCapture", "Auto-stop failed", e)
            emit("autoStopFailed", JSONObject().put("reason", why).put("error", e.message ?: "stop_failed"))
        }
    }
    private fun scheduleAutoStop(why: String) {
        if (!autoStopPending.compareAndSet(false, true)) return
        autoExecutor.execute { try { autoStop(why) } finally { autoStopPending.set(false) } }
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
        .put("input", input?.activeInputId()?.let { active ->
            inputs.list(active).getJSONArray("inputs").let { array ->
                (0 until array.length()).map { array.getJSONObject(it) }.firstOrNull { it.optString("id") == active }
            }
        } ?: JSONObject.NULL)
        .put("owner", owner ?: JSONObject.NULL)
        .put("transitionGen", transitionGen).put("gen", gen).put("epoch", epoch)
        .put("activeId", input?.activeInputId() ?: JSONObject.NULL)
        .put("androidSdkInt", Build.VERSION.SDK_INT)
    companion object {
        @Volatile private var instance: CaptureEngine? = null
        @JvmStatic fun get(context: Context): CaptureEngine = instance ?: synchronized(this) {
            instance ?: CaptureEngine(context.applicationContext).also { instance = it }
        }
    }
}
