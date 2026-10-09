package xyz.tinycloud.exo.stt

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.VadModelConfig
import org.json.JSONArray
import org.json.JSONObject
import xyz.tinycloud.exo.capture.CaptureEngine
import xyz.tinycloud.exo.stt.core.AttemptGuard
import xyz.tinycloud.exo.stt.core.SherpaVadSource
import xyz.tinycloud.exo.stt.core.TimedWord
import xyz.tinycloud.exo.stt.core.TokenWordAlignment
import xyz.tinycloud.exo.stt.core.VadFrames
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingDeque

private class CaptureStartedException : Exception()

/**
 * Decodes a committed note's audio and produces a transcript with sherpa-onnx (plan §2.5), for
 * notes whose `options.transcriber == "on-device"`. This slice runs the whole job in-process on a
 * background thread: there is no `SttWorker`/WorkManager checkpoint persistence (T24 adds that),
 * so a note interrupted by the app dying restarts its decode from the beginning next time the
 * queue runs, instead of resuming mid-file. It never runs while a capture session is live: it
 * checks `CaptureEngine.isCapturing()` before loading a model and again before every VAD window,
 * and releases the recognizer promptly instead of competing with capture for CPU/memory. Audio is
 * decoded and fed to the VAD and recognizer in fixed-size windows (`AudioDecoder.decodeWindows`),
 * never as one in-memory array, so a note's memory use does not scale with its length: a note left
 * recording for a long time once crashed every launch decoding itself whole (TC-836 incident).
 * Before each attempt, `AttemptGuard` persists an incremented attempt count to the note's sidecar;
 * after `AttemptGuard.MAX_ATTEMPTS` a note is marked `failed` instead of retried, so a note that
 * reliably crashes the decode can never crash-loop the app at every launch again.
 */
class TranscriptionQueue(private val context: Context, private val store: ModelStore) {
    private val capture get() = CaptureEngine.get(context)
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "exo-stt-queue").apply { isDaemon = true } }
    private val pending = LinkedBlockingDeque<String>()
    @Volatile private var running = false
    var onQueueChanged: (() -> Unit)? = null
    var onProgress: ((String, Int) -> Unit)? = null
    var onTranscribed: ((String, String) -> Unit)? = null
    var onFailed: ((String, String, String) -> Unit)? = null

    companion object {
        @Volatile private var instance: TranscriptionQueue? = null
        fun get(context: Context): TranscriptionQueue = instance ?: synchronized(this) {
            instance ?: TranscriptionQueue(context.applicationContext, ModelDownloads.sharedStore(context.applicationContext))
                .also { instance = it }
        }
    }

    /** Scans every committed note for unfinished on-device work (native work inventory, plan
     * §2.5) and adds it to the queue. Called (deferred until the UI is up; see `SttBootstrap`) at
     * process start, on every `committed`/`recovered` event, and when a model finishes
     * downloading. */
    fun reconcile() {
        executor.execute {
            val notes = try { capture.library.list() } catch (e: Exception) { Log.e("ExoStt", "reconcile list failed", e); emptyList() }
            for (note in notes) {
                val id = note.optString("id", "")
                val options = note.optJSONObject("options") ?: continue
                if (options.optString("transcriber") != "on-device") continue
                val stt = note.optJSONObject("stt") ?: continue
                if (stt.optString("state") !in listOf("waiting_for_model", "queued", "running")) continue
                if (capture.library.getTranscript(id) != null) continue
                if (!pending.contains(id)) pending.addLast(id)
            }
            pump()
        }
    }

    /** Explicit enqueue: the UI's Retry for a `failed` note, or a fresh on-device recording. Resets
     * the attempt count, since this is a deliberate retry, not an automatic one. */
    fun enqueue(id: String) {
        executor.execute {
            if (capture.library.getTranscript(id) != null) return@execute
            try { capture.library.mutate(id, "stt.write") { note -> note.getJSONObject("stt")
                .put("state", "queued").put("error", JSONObject.NULL).put("attempts", 0) } }
            catch (e: Exception) { Log.w("ExoStt", "enqueue failed for $id", e) }
            if (!pending.contains(id)) pending.addLast(id)
            onQueueChanged?.invoke()
            pump()
        }
    }

    fun cancel(id: String) {
        executor.execute {
            pending.remove(id)
            try { capture.library.mutate(id, "stt.write") { note -> note.getJSONObject("stt").put("state", "cancelled") } } catch (_: Exception) {}
            onQueueChanged?.invoke()
        }
    }

    fun queueSnapshot(): JSONArray {
        val result = JSONArray()
        for (id in pending.toList()) {
            val stt = try { capture.library.read(id)?.optJSONObject("stt") } catch (_: Exception) { null }
            result.put(JSONObject().put("id", id).put("state", stt?.optString("state") ?: "queued")
                .put("percent", JSONObject.NULL).put("error", stt?.opt("error") ?: JSONObject.NULL))
        }
        return result
    }

    private fun pump() {
        if (running || pending.isEmpty()) return
        if (capture.isCapturing()) return // Resumed by the next `committed` (capture ended).
        val memory = (context.getSystemService(android.app.ActivityManager::class.java))
            .let { manager -> android.app.ActivityManager.MemoryInfo().also { manager.getMemoryInfo(it) } }.totalMem
        val modelId = ModelManifest.primaryModel(memory)
        if (!store.isReady(modelId) || !store.isReady(ModelManifest.SILERO_VAD)) {
            for (id in pending.toList()) try { capture.library.mutate(id, "stt.write") { it.getJSONObject("stt").put("state", "waiting_for_model") } } catch (_: Exception) {}
            onQueueChanged?.invoke()
            return
        }
        running = true
        val engine = try { Engine(store, modelId) } catch (e: Exception) {
            for (id in pending.toList()) fail(id, "model_load_failed", e.message ?: "load failed")
            pending.clear()
            running = false
            onQueueChanged?.invoke()
            return
        }
        try {
            while (true) {
                val id = pending.peekFirst() ?: break
                if (capture.isCapturing()) break // Leave it queued; released below.
                pending.removeFirst()
                val previousAttempts = try { capture.library.read(id)?.optJSONObject("stt")?.optInt("attempts", 0) ?: 0 } catch (_: Exception) { 0 }
                when (val decision = AttemptGuard.next(previousAttempts)) {
                    is AttemptGuard.Decision.GiveUp -> {
                        fail(id, "too_many_attempts", "gave up after ${AttemptGuard.MAX_ATTEMPTS} attempts")
                        continue
                    }
                    is AttemptGuard.Decision.Proceed -> {
                        // Persisted before the risky decode starts: a crash mid-attempt still counts
                        // against the cap next launch, instead of retrying the same note forever.
                        try { capture.library.mutate(id, "stt.write") { it.getJSONObject("stt").put("state", "running").put("attempts", decision.attempt)
                            .put("pack", if (modelId == ModelManifest.PARAKEET_FULL) "full" else "small").put("engine", "parakeet") } } catch (_: Exception) {}
                    }
                }
                onQueueChanged?.invoke()
                try {
                    process(id, engine, modelId)
                } catch (e: CaptureStartedException) {
                    // Not a failed attempt: an orderly yield to a resumed recording. Restore the
                    // attempt count so being interrupted repeatedly never burns the crash-loop budget.
                    try { capture.library.mutate(id, "stt.write") { it.getJSONObject("stt").put("state", "queued").put("attempts", previousAttempts) } } catch (_: Exception) {}
                    pending.addFirst(id)
                    break
                } catch (e: Exception) {
                    Log.e("ExoStt", "process() threw for id=$id", e)
                    fail(id, "decode_failed", e.message ?: e.toString())
                }
            }
        } finally {
            engine.release()
            running = false
        }
        if (pending.isNotEmpty()) executor.execute { Thread.sleep(2000); pump() }
    }

    private fun fail(id: String, code: String, message: String) {
        try { capture.library.mutate(id, "stt.write") { it.getJSONObject("stt").put("state", "failed").put("error", code) } } catch (_: Exception) {}
        Log.w("ExoStt", "transcription failed id=$id code=$code message=$message")
        onFailed?.invoke(id, code, message)
        onQueueChanged?.invoke()
    }

    private fun process(id: String, engine: Engine, modelId: String) {
        val file = capture.library.audio(id)
        val totalWindows = estimatedWindows(file)
        val segments = JSONArray()
        var decodedAny = false
        var segmentsDone = 0
        var windowsDone = 0
        engine.transcribe(
            file = file,
            checkCapturing = { if (capture.isCapturing()) throw CaptureStartedException() },
            onWindow = {
                windowsDone += 1
                try { capture.library.mutate(id, "stt.write") { it.getJSONObject("stt").put("windowsDone", windowsDone) } } catch (_: Exception) {}
                val percent = totalWindows?.let { total -> minOf(99, (windowsDone.toDouble() / total * 100).toInt()) } ?: 0
                onProgress?.invoke(id, percent)
            },
            onSegment = { chunk, words ->
                if (words.isNotEmpty()) {
                    decodedAny = true
                    // Milliseconds, not fractional seconds: CanonicalJson only accepts Byte/Short/Int/Long
                    // (TC-836 — the only type every other timestamp in this schema already uses).
                    segments.put(JSONObject().put("start", chunk.start.toLong() * 1000 / 16_000)
                        .put("end", chunk.end.toLong() * 1000 / 16_000)
                        .put("text", words.joinToString(" ") { it.text }).put("speaker", JSONObject.NULL))
                }
                segmentsDone += 1
                try { capture.library.mutate(id, "stt.write") { it.getJSONObject("stt").put("segmentsDone", segmentsDone) } } catch (_: Exception) {}
            },
        )
        val outcome = if (decodedAny) "transcribed" else "no_speech"
        val isoNow = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        val transcript = JSONObject()
            .put("version", 1).put("noteId", id).put("transcriber", "on-device").put("rev", 1)
            .put("engine", if (modelId == ModelManifest.PARAKEET_FULL) "parakeet-tdt-0.6b-v3" else "parakeet-tdt-110m-en")
            .put("model", modelId).put("language", "en").put("outcome", outcome).put("diarized", false)
            .put("segments", segments).put("createdAt", isoNow)
        capture.library.putTranscript(id, transcript)
        try { capture.library.mutate(id, "stt.write") { it.getJSONObject("stt").put("state", "done").put("error", JSONObject.NULL) } } catch (_: Exception) {}
        onProgress?.invoke(id, 100)
        onTranscribed?.invoke(id, outcome)
        onQueueChanged?.invoke()
    }

    /** A cheap upper-bound estimate of VAD windows for progress reporting, from the container's
     * duration metadata; does not decode any audio. Null if the duration isn't available. */
    private fun estimatedWindows(file: File): Int? {
        val extractor = MediaExtractor()
        return try {
            extractor.setDataSource(file.path)
            var durationUs: Long? = null
            for (i in 0 until extractor.trackCount) {
                val format = extractor.getTrackFormat(i)
                val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
                if (mime.startsWith("audio/") && format.containsKey(MediaFormat.KEY_DURATION)) {
                    durationUs = format.getLong(MediaFormat.KEY_DURATION); break
                }
            }
            durationUs?.let { us -> maxOf(1, ((us * 16_000L) / 1_000_000L / VadFrames.SIZE).toInt()) }
        } catch (_: Exception) { null } finally { extractor.release() }
    }
}

/** One loaded recognizer + VAD config, scoped to a single `pump()` pass; `release()` frees the
 * native sherpa-onnx objects before capture competes for memory. */
private class Engine(store: ModelStore, modelId: String) {
    private val recognizer: OfflineRecognizer
    private val vadModelPath: String
    private val threads = 4

    private companion object {
        const val RATE = 16_000
    }

    init {
        val dir = store.modelDir(modelId)
        val vadDir = store.modelDir(ModelManifest.SILERO_VAD)
        for (name in listOf("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")) {
            check(File(dir, name).isFile) { "model_files_missing" } // unreachable: ModelStore verified READY first
        }
        // TC-819's T23 recommendation: greedy search, blankPenalty 1.0, no chunk padding, 25 s soft VAD cap.
        recognizer = OfflineRecognizer(config = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = RATE, featureDim = 80, dither = 0f),
            modelConfig = OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = File(dir, "encoder.int8.onnx").path,
                    decoder = File(dir, "decoder.int8.onnx").path,
                    joiner = File(dir, "joiner.int8.onnx").path),
                tokens = File(dir, "tokens.txt").path,
                modelType = "nemo_transducer", numThreads = threads, provider = "cpu"),
            decodingMethod = "greedy_search", blankPenalty = 1.0f))
        vadModelPath = File(vadDir, "silero_vad.onnx").path
    }

    data class Chunk(val start: Int, val end: Int, val samples: FloatArray)

    /** Streams `file` through the VAD and recognizer one `VadFrames.SIZE` window at a time
     * (`AudioDecoder.decodeWindows`), so memory never scales with the note's length. `checkCapturing`
     * is called before every window; `onWindow` after every window (progress); `onSegment` for every
     * VAD speech segment once its words are recognized. */
    fun transcribe(file: File, checkCapturing: () -> Unit, onWindow: () -> Unit, onSegment: (Chunk, List<TimedWord>) -> Unit) {
        val source = SherpaVadSource(config = VadModelConfig(
            sileroVadModelConfig = SileroVadModelConfig(model = vadModelPath, minSilenceDuration = .4f,
                minSpeechDuration = .1f, windowSize = VadFrames.SIZE, maxSpeechDuration = 25f),
            sampleRate = RATE, numThreads = threads, provider = "cpu"))
        try {
            fun drain() {
                while (!source.empty()) {
                    val segment = source.front()
                    source.pop()
                    val words = recognize(segment.samples, segment.start.toDouble() / RATE)
                    onSegment(Chunk(segment.start, segment.start + segment.samples.size, segment.samples), words)
                }
            }
            AudioDecoder.decodeWindows(file, VadFrames.SIZE) { window ->
                checkCapturing()
                source.acceptWaveform(window)
                drain()
                onWindow()
            }
            source.flush()
            drain()
        } finally { source.close() }
    }

    private fun recognize(samples: FloatArray, origin: Double): List<TimedWord> {
        val stream = recognizer.createStream()
        try {
            stream.acceptWaveform(samples, RATE)
            recognizer.decode(stream)
            val result = recognizer.getResult(stream)
            return TokenWordAlignment.align(result.tokens, result.timestamps, result.durations, origin)
        } finally { stream.release() }
    }

    fun release() { recognizer.release() }
}
