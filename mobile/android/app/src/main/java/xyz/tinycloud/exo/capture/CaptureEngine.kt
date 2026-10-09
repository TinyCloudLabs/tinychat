package xyz.tinycloud.exo.capture

import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import xyz.tinycloud.exo.capture.core.*
import java.io.File
import java.util.UUID
import java.util.Locale
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
    private val transitionExecutor = Executors.newSingleThreadExecutor { task -> Thread(task, "ExoCaptureTransitions") }
    private val autoStopPending = AtomicBoolean(false)
    private val limitTick = object : Runnable {
        override fun run() {
            if (id == null) return
            try {
                if (context.filesDir.usableSpace < 100L * 1024 * 1024) scheduleAutoStop(MicStateContract.DISK_FULL)
                else if (intent != "paused" && recordedElapsedMs() >= maxMs) scheduleAutoStop(MicStateContract.MAX_DURATION)
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
    @Volatile private var reasonDetail: String? = null
    private fun setMicState(nextState: String, nextReason: String?, detail: String? = null) = synchronized(this) {
        state = nextState; reason = nextReason; reasonDetail = detail
    }
    private fun setMicReason(nextReason: String?, detail: String? = null) = synchronized(this) {
        reason = nextReason; reasonDetail = detail
    }
    private fun setMicStateKeepingReason(nextState: String) = synchronized(this) { state = nextState }
    private val transitions = TransitionMachine()
    private val intent get() = transitions.intent.name.lowercase(Locale.ROOT)
    private val availability get() = transitions.availability.name.lowercase(Locale.ROOT)
    private var maxMs = MAX_DURATION_MS
    private var source = "in_app"
    private var options = defaultOptions()
    private var owner: String? = null
    private var transitionGen = 0L
    private val gen get() = transitions.gen
    private val epoch get() = transitions.epoch
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
    @Volatile private var lastRoutedInputId: String? = null
    private val retry: Runnable = object : Runnable {
        override fun run() {
            transitionExecutor.execute {
                if (id == null || intent != "recording" || availability != "interrupted") return@execute
                runCatching { resumeAttempt(TransitionMachine.Event.INTERRUPTION_ENDED, automatic = true) }
                    .onFailure { if (availability == "interrupted") scheduleRetry() }
            }
        }
    }
    private val restartBackoff = RestartBackoff(
        SystemClock::elapsedRealtime,
        { main.removeCallbacks(retry); main.post(retry) },
        { delay -> main.removeCallbacks(retry); main.postDelayed(retry, delay) },
    )
    private var retryFailureReason: String? = null
    init {
        context.getSystemService(AudioManager::class.java).registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = devicesChanged(addedDevices)
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = devicesChanged(removedDevices)
        }, main)
        if (Build.VERSION.SDK_INT >= 31) context.getSystemService(AudioManager::class.java)
            .addOnModeChangedListener(context.mainExecutor) { mode ->
                transitionExecutor.execute {
                    if (mode == AudioManager.MODE_NORMAL) interruptionEnded() else interruptionBegan(MicStateContract.CALL)
                }
            }
    }
    private fun devicesChanged(changed: Array<out AudioDeviceInfo>) {
        if (changed.none { it.isSource }) return
        emit("inputs", listInputs())
        val selected = inputs.selectedId
        val active = input?.activeInputId() ?: lastRoutedInputId
        if (id != null && intent == "recording" && input != null &&
            changed.any { inputs.id(it) == selected || inputs.id(it) == active })
            transitionExecutor.execute { rebuild(MicStateContract.ROUTE_CHANGE) }
    }
    private fun routedInputChanged() {
        val active = input?.activeInputId()
        emit("inputs", listInputs())
        if (active != lastRoutedInputId) {
            lastRoutedInputId = active
            if (id != null && state == "recording" && input != null)
                transitionExecutor.execute { rebuild(MicStateContract.ROUTE_CHANGE) }
        }
    }
    fun listInputs(): JSONObject = inputs.list(input?.activeInputId())
    fun selectInput(selectedId: String?) {
        inputs.select(selectedId)
        emit("inputs", listInputs())
        if (id != null && intent == "recording" && input != null)
            transitionExecutor.execute { rebuild(MicStateContract.ROUTE_CHANGE) }
    }
    private fun scheduleRetry() {
        if (!restartBackoff.failedAttempt()) {
            if (availability != "interrupted" || id == null) return
            transitions.send(TransitionMachine.Event.BACKOFF_EXHAUSTED)
            val blockedReason = retryFailureReason ?: MicStateContract.MIC_UNAVAILABLE
            setMicState("needs_user", blockedReason)
            sequence?.resumeFailed(gen, reason = blockedReason)
            publishState()
            CaptureNotifications.showResumeAlert(context, status())
            return
        }
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
        transitions.send(when (why) {
            MicStateContract.ROUTE_CHANGE -> TransitionMachine.Event.ROUTE_CHANGE
            MicStateContract.STALLED -> TransitionMachine.Event.STALL
            else -> TransitionMachine.Event.INTERRUPTION_BEGAN
        })
        sequence?.interrupt(why, why, gen, at)
        openSpan = JSONObject().put("kind", "omitted").put("reason", why)
            .put("startedAt", at).put("endedAt", JSONObject.NULL).put("atAudioMs", audioMs).put("audioMs", 0)
        setMicState("interrupted", why)
        restartBackoff.reset(); retryFailureReason = null
        publishState()
    }
    private fun interruptionEnded() {
        if (id != null && intent == "recording" && availability == "interrupted")
            restartBackoff.interruptionEnded()
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
        source = startSource; transitions.start(); setMicState("idle", null)
        spans = JSONArray(); openSpan = null
        try { acquire(releaseLockDuringStart = false, beforeStart = {
            sequence!!.firstInput(gen)
        }) } catch (e: Exception) {
            if (id == newId && intent == "recording") {
                library.closeSession(newId)
                id = null; transitions.send(TransitionMachine.Event.STOP); setMicState("idle", null)
            }
            throw e
        }
        main.removeCallbacks(limitTick); main.postDelayed(limitTick, 1000)
        transitions.acquired(gen)
        setMicStateKeepingReason(if (silencedAt != 0L) "silenced" else "recording")
        lastRoutedInputId = input?.activeInputId()
        journalActiveInput(newId)
        publishState()
        if (commandId != null) emit("started", JSONObject().put("commandId", commandId).put("id", newId))
        if (startSource != "in_app") presentRecorder()
        return JSONObject().put("id", newId).put("startedAt", startedAt).put("maxDurationMs", maxMs)
    }
    private fun acquire(releaseLockDuringStart: Boolean = true, beforeStart: () -> Unit = {}, afterStart: () -> Unit = {}) {
        val current = id ?: return
        val attempt = gen
        val localEncoder = AacAdtsEncoder { frame ->
            synchronized(this) {
                if (id != current || gen != attempt || intent != "recording") return@synchronized
                sequence!!.frame(frame)
                if (recordedElapsedMs() >= maxMs) scheduleAutoStop(MicStateContract.MAX_DURATION)
            }
        }
        val localInput = try { AudioCapture({ pcm -> localEncoder.offer(pcm, pcm.size) }, { level, peak ->
            emit("level", JSONObject().put("level", level).put("peak", peak))
            val now = System.currentTimeMillis()
            if (peak > 0) {
                if (noSignalAt > 0) {
                    noSignalMs += now - noSignalAt; noSignalAt = 0
                    if (reason == MicStateContract.NO_SIGNAL) { setMicReason(null); publishState() }
                }
                lastPeakAt = now
            } else if (now - lastPeakAt > 2000 && noSignalAt == 0L) {
                noSignalAt = lastPeakAt; setMicReason(MicStateContract.NO_SIGNAL); publishState()
            }
        }, { silenced ->
            transitionExecutor.execute { synchronized(this) {
                if (id != current || gen != attempt || intent != "recording") return@synchronized
                if (silenced && silencedAt == 0L) {
                    transitions.send(TransitionMachine.Event.SILENCED)
                    silencedAt = System.currentTimeMillis(); silencedEvents++
                    openSpan = JSONObject().put("kind", "silenced").put("reason", MicStateContract.OS_SILENCED)
                        .put("startedAt", silencedAt).put("endedAt", JSONObject.NULL).put("atAudioMs", audioMs).put("audioMs", 0)
                    journalLiveTransition(current, "span_open", JSONObject().put("kind", "silenced").put("reason", MicStateContract.OS_SILENCED))
                    setMicState("silenced", MicStateContract.OS_SILENCED); publishState()
                }
                if (!silenced && silencedAt != 0L) {
                    transitions.send(TransitionMachine.Event.UNSILENCED)
                    closeSilence(current); setMicState("recording", null); publishState()
                }
            } }
        }, { error, errorDetail ->
            if (error == MicStateContract.READ_ERROR && localInputStopped(current, attempt)) return@AudioCapture
            if (error == MicStateContract.WRITER_STALLED) {
                journalLiveTransition(current, "span_open", JSONObject().put("kind", "omitted").put("reason", MicStateContract.WRITER_STALLED))
            } else if (error == "writer_resumed") {
                journalLiveTransition(current, "span_close", JSONObject().put("kind", "omitted").put("reason", MicStateContract.WRITER_STALLED))
            }
            if (error != "writer_resumed") Log.e("ExoCapture", if (errorDetail == null) error else "$error: $errorDetail")
            MicStateContract.dispatchCaptureError(error, errorDetail, publish = { nextReason, nextDetail ->
                setMicReason(nextReason, nextDetail)
                publishState()
            }, interrupt = { detail ->
                transitionExecutor.execute { handleReadFailure(current, attempt, detail) }
            }, onViolation = { Log.e("ExoCapture", it) })
            if (error == MicStateContract.WRITE_FAILED) scheduleAutoStop(MicStateContract.WRITE_FAILED)
            if (error == MicStateContract.STALLED) transitionExecutor.execute { rebuild(MicStateContract.STALLED) }
        }, inputs, { routedInputChanged() }) } catch (e: Exception) { localEncoder.abort(); throw e }
        // Resume releases the lock while Android opens its input, so Pause,
        // Stop and Discard can invalidate that attempt. First start keeps the
        // lock until its first PCM; an empty session cannot be paused or saved.
        check(controlLock.holdCount == 1)
        if (releaseLockDuringStart) controlLock.unlock()
        var failure: Exception? = null
        try {
            localInput.start {
                startBeforeAttach?.invoke()
                controlLock.withLock {
                    if (id != current || gen != attempt || intent != "recording") throw StaleStart()
                    input = localInput; encoder = localEncoder
                    try { beforeStart(); afterStart(); localInput.startWorkers(); localInput.awaitFirstPcm() }
                    catch (e: Exception) { input = null; encoder = null; throw e }
                }
            }
        } catch (e: Exception) { failure = e }
        finally { if (releaseLockDuringStart) controlLock.lock() }
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
    private fun journalActiveInput(current: String) {
        val device = input?.activeInput() ?: return
        val active = device.getString("id")
        journalLiveTransition(current, "input", device.copy())
        emit("inputs", inputs.list(active))
    }
    private fun closeSilence(current: String) {
        if (silencedAt == 0L) return
        val now = System.currentTimeMillis()
        silencedMs += now - silencedAt; silencedAt = 0
        journalLiveTransition(current, "span_close", JSONObject().put("kind", "silenced").put("reason", MicStateContract.OS_SILENCED))
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
    private fun handleReadFailure(current: String, attempt: Long, detail: String? = null) = controlLock.withLock {
        if (id != current || gen != attempt || intent != "recording" || input == null) return@withLock
        val captured = input!!
        var teardownFailed = false
        sequence?.beginClose()
        try {
            captured.drainAfterReadFailure()
            encoder?.finish(); encoder = null
            closeSilence(current)
            val at = System.currentTimeMillis()
            transitions.send(TransitionMachine.Event.INTERRUPTION_BEGAN)
            sequence!!.interrupt(MicStateContract.READ_ERROR, MicStateContract.READ_ERROR, gen, at)
            openSpan = JSONObject().put("kind", "omitted").put("reason", MicStateContract.READ_ERROR)
                .put("startedAt", at).put("endedAt", JSONObject.NULL)
                .put("atAudioMs", audioMs).put("audioMs", 0)
            val readState = MicStateContract.readFailure(detail)
            setMicState(readState.state, readState.reason, readState.detail)
            publishState()
        } catch (e: Exception) {
            Log.e("ExoCapture", "Read failure teardown failed", e)
            encoder?.abort(); encoder = null
            teardownFailed = true
        } finally {
            try { captured.release() } catch (e: Exception) { Log.e("ExoCapture", "Input release after read error", e) }
            input = null
        }
        if (teardownFailed) autoStop(MicStateContract.WRITE_FAILED) else {
            restartBackoff.reset(); retryFailureReason = null
            interruptionEnded()
        }
    }
    internal fun injectReadErrorForTest() {
        val current = id ?: throw IllegalStateException("not_recording")
        check(input != null) { "input_not_attached" }
        handleReadFailure(current, gen)
    }
    internal fun rebuildForTest() = rebuild(MicStateContract.ROUTE_CHANGE)
    internal fun exhaustRetryForTest() {
        restartBackoff.expireForTest()
        scheduleRetry()
    }
    internal fun retryFailureForTest(): String? = retryFailureReason
    internal fun hasAttachedInputForTest(): Boolean = input != null
    fun pause() = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        if (intent == "paused") return@withLock
        if (input == null) {
            val at = System.currentTimeMillis()
            closeOmitted(current, at)
            sequence!!.pause(at)
            transitions.send(TransitionMachine.Event.PAUSE)
            setMicState("paused", MicStateContract.USER); pausedAt = at
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
        transitions.send(TransitionMachine.Event.PAUSE)
        setMicState("paused", MicStateContract.USER)
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
        autoStop(MicStateContract.WRITE_FAILED)
        if (id != null) {
            transitions.writeFailed(); setMicState("needs_user", MicStateContract.WRITE_FAILED); publishState()
        }
        throw IllegalStateException("pause_failed", failure)
    }
    fun resume() = resumeAttempt(TransitionMachine.Event.RESUME, automatic = false)
    fun onAppActive() {
        transitionExecutor.execute {
            if (id == null || intent != "recording" || availability == "available") return@execute
            val wasBlocked = availability == "blocked"
            runCatching { resumeAttempt(TransitionMachine.Event.APP_ACTIVE, automatic = !wasBlocked,
                alertOnFailure = false) }.onFailure {
                if (availability == "interrupted") scheduleRetry()
            }
        }
    }
    private fun resumeAttempt(event: TransitionMachine.Event, automatic: Boolean,
                              alertOnFailure: Boolean = true): Unit = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        val wasPaused = intent == "paused"
        if (!wasPaused && !(intent == "recording" && availability != "available" && input == null)) return@withLock
        val at = System.currentTimeMillis()
        if (pausedAt > 0) { pausedMs += at - pausedAt; pausedAt = 0 }
        if (!transitions.send(event)) return@withLock
        val attempt = gen
        if (wasPaused) sequence!!.resumeIntent(at)
        val omittedReason = openSpan?.takeIf { it.optString("kind") == "omitted" }?.optString("reason")
        var spanClosed = false
        try {
            acquire(afterStart = {
                if (wasPaused) sequence!!.resumeAcquired(gen, at)
                else {
                    if (omittedReason != null) sequence!!.restartAfterInterruption(omittedReason, gen, at)
                    else sequence!!.resumeAcquired(gen, at)
                    closeOmittedInMemory(at)
                    spanClosed = omittedReason != null
                }
            })
        } catch (e: Exception) {
            if (id != current || gen != attempt || intent != "recording") return@withLock
            val failureReason = when {
                e is SecurityException -> MicStateContract.RESUME_NOT_ALLOWED
                e is java.io.IOException -> MicStateContract.RESUME_BLOCKED
                else -> MicStateContract.MIC_UNAVAILABLE
            }
            if (spanClosed && omittedReason != null) {
                // Android may start a mic but return no PCM. Preserve the omitted
                // interval until an attempt actually produces audio.
                sequence!!.interrupt(omittedReason, omittedReason, gen, at)
                openSpan = JSONObject().put("kind", "omitted").put("reason", omittedReason)
                    .put("startedAt", at).put("endedAt", JSONObject.NULL)
                    .put("atAudioMs", audioMs).put("audioMs", 0)
            }
            transitions.failed(attempt, automatic)
            retryFailureReason = failureReason
            if (automatic) setMicStateKeepingReason("interrupted")
            else {
                setMicState("needs_user", failureReason)
                sequence!!.resumeFailed(gen, at, failureReason)
            }
            publishState()
            if (!automatic && alertOnFailure) CaptureNotifications.showResumeAlert(context, status())
            throw IllegalStateException("resume_failed", e)
        }
        transitions.acquired(attempt)
        setMicState(if (silencedAt != 0L) "silenced" else "recording",
            if (silencedAt != 0L) MicStateContract.OS_SILENCED else null)
        restartBackoff.reset(); retryFailureReason = null; main.removeCallbacks(retry)
        lastRoutedInputId = input?.activeInputId()
        journalActiveInput(current)
        CaptureNotifications.cancelAlert(context)
        publishState()
    }
    private fun closeOmittedInMemory(at: Long) {
        val span = openSpan ?: return
        span.put("endedAt", at).put("audioMs", 0)
        spans.put(span)
        openSpan = null
    }
    fun stop(reason: String = MicStateContract.USER): JSONObject = controlLock.withLock {
        val current = id ?: throw IllegalStateException("not_recording")
        if (input == null) library.read(current)?.let { saved ->
            id = null; setMicState("idle", null); transitions.send(TransitionMachine.Event.STOP)
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
            transitions.send(TransitionMachine.Event.STOP); CaptureNotifications.cancelAlert(context); main.removeCallbacks(retry)
            if (pausedAt > 0) { pausedMs += System.currentTimeMillis() - pausedAt; pausedAt = 0 }
            val at = System.currentTimeMillis()
            finalReason = if (captureFailure != null) MicStateContract.WRITE_FAILED else reason
            sequence!!.stop(finalReason, at)
            library.commit(current, { RecordingFinalizer.mux(library.session(current), it) },
                metrics = JSONObject().put("silencedMs", silencedMs).put("silencedEvents", silencedEvents).put("noSignalMs", noSignalMs))
        } catch (e: Exception) {
            try { encoder?.abort() } catch (abort: Exception) { Log.e("ExoCapture", "AAC abort after failed Stop", abort) }
            encoder = null
            transitions.writeFailed(); CaptureNotifications.cancelAlert(context); main.removeCallbacks(retry)
            library.closeSession(current)
            setMicState("needs_user", MicStateContract.WRITE_FAILED)
            main.removeCallbacks(limitTick)
            publishState()
            throw e
        }
        id = null; setMicState("idle", if (finalReason == MicStateContract.USER) null else finalReason)
        main.removeCallbacks(limitTick)
        publishState(); emit("committed", note)
        note
    }
    fun discard(): String? = controlLock.withLock {
        val current = id ?: return@withLock null
        if (library.sidecar(current).exists()) throw IllegalStateException("already_committed")
        transitions.send(TransitionMachine.Event.DISCARD); CaptureNotifications.cancelAlert(context); main.removeCallbacks(retry)
        val captured = input
        try { captured?.drain() } catch (e: Exception) { Log.e("ExoCapture", "Discard input drain failed", e) }
        finally {
            try { captured?.release() } catch (e: Exception) { Log.e("ExoCapture", "Discard input release failed", e) }
            input = null
        }
        encoder?.abort(); encoder = null
        library.discardUncommitted(current)
        id = null; setMicState("idle", null); publishState()
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
    @Synchronized fun status(): JSONObject {
        val mic = MicStateContract.snapshot(state, reason, reasonDetail,
            onViolation = { Log.e("ExoCapture", it) })
        return JSONObject().put("state", mic.state).put("reason", mic.reason ?: JSONObject.NULL)
            .apply { if (mic.detail != null) put("detail", mic.detail) }
            .put("id", id ?: JSONObject.NULL).put("intent", intent).put("availability", availability)
            .put("startedAt", if (id == null) JSONObject.NULL else startedAt)
            .put("elapsedMs", recordedElapsedMs()).put("pausedMs", pausedMs + if (pausedAt > 0) System.currentTimeMillis() - pausedAt else 0)
            .put("audioMs", durableAudioMs).put("maxDurationMs", maxMs)
            .put("spans", JSONArray(spans.toString())).put("openSpan", openSpan?.copy() ?: JSONObject.NULL)
            .put("source", source).put("options", options.copy())
            .put("input", input?.activeInput() ?: JSONObject.NULL)
            .put("owner", owner ?: JSONObject.NULL)
            .put("transitionGen", transitionGen).put("gen", gen).put("epoch", epoch)
            .put("activeId", input?.activeInputId() ?: JSONObject.NULL)
            .put("androidSdkInt", Build.VERSION.SDK_INT)
    }
    companion object {
        @Volatile private var instance: CaptureEngine? = null
        @JvmStatic fun get(context: Context): CaptureEngine = instance ?: synchronized(this) {
            instance ?: CaptureEngine(context.applicationContext).also { instance = it }
        }
    }
}
