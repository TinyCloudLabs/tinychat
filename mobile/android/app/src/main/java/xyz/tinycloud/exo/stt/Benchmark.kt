package xyz.tinycloud.exo.stt

import android.os.SystemClock
import com.getcapacitor.JSObject
import com.k2fsa.sherpa.onnx.FastClusteringConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarization
import com.k2fsa.sherpa.onnx.OfflineSpeakerDiarizationConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationModelConfig
import com.k2fsa.sherpa.onnx.OfflineSpeakerSegmentationPyannoteModelConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import org.json.JSONArray
import org.json.JSONObject
import xyz.tinycloud.exo.stt.core.SpeakerAttribution
import xyz.tinycloud.exo.stt.core.SpeakerTurn
import xyz.tinycloud.exo.stt.core.TimedWord
import xyz.tinycloud.exo.stt.core.TokenWordAlignment
import xyz.tinycloud.exo.stt.core.Wav16
import xyz.tinycloud.exo.stt.core.WordErrorRate
import java.io.File
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/** One-shot diagnostic on T7's pinned 16 kHz WAV fixtures. It never enters the production queue. */
internal object Benchmark {
    private const val RATE = 16_000
    private val names = listOf("ls-1089-10m", "ami-es2004a-10m", "ls-alt-2spk-10m")

    data class Options(
        val threads: List<Int>,
        val blankPenalty: Double = 0.0,
        val padSeconds: Double = 0.0,
        val clusterThreshold: Double = .8,
        val asrOnly: Boolean = false,
    ) {
        init {
            require(threads.isNotEmpty() && threads.size == threads.toSet().size && threads.all { it == 2 || it == 4 }) {
                "threads must be a unique list of 2 and/or 4"
            }
            require(blankPenalty.isFinite() && blankPenalty in 0.0..2.0) { "blankPenalty must be 0..2" }
            require(padSeconds.isFinite() && padSeconds in 0.0..1.0) { "padSeconds must be 0..1" }
            require(clusterThreshold.isFinite() && clusterThreshold in .5..1.5) { "clusterThreshold must be 0.5..1.5" }
        }
    }

    fun run(directory: File, options: Options): JSObject {
        val output = File(directory, "results/android").also { check(it.mkdirs() || it.isDirectory) }
        val summaries = JSONArray()
        for (name in names) {
            val samples = Wav16.read(File(directory, "$name.wav"))
            val reference = referenceText(directory, name)
            for (threads in options.threads.sortedDescending()) {
                val stem = if (threads == 4) name else "$name-t$threads"
                val began = now()
                val baselineHwm = statusKb("VmHWM")
                val recognition = recognize(directory, samples, threads, options)
                val (words, vadCount, emptyCount, coverage) = recognition
                val asrEnded = now()
                val text = words.joinToString(" ") { it.text }
                val wer = WordErrorRate.score(reference, text)
                var attributed = words
                val metrics = JSObject()
                    .put("fixture", name).put("threads", threads)
                    .put("audioSeconds", samples.size.toDouble() / RATE)
                    .put("loadSeconds", recognition.loadSeconds)
                    .put("decodeSeconds", recognition.decodeSeconds)
                    .put("loadAndDecodeSeconds", asrEnded - began)
                    .put("rtf", recognition.decodeSeconds / (samples.size.toDouble() / RATE))
                    .put("blankPenalty", options.blankPenalty).put("padSeconds", options.padSeconds)
                    .put("vadSegments", vadCount).put("emptyVadSegments", emptyCount)
                    .put("vadCoverageSeconds", coverage)
                    .put("wer", wer.rate).put("werErrors", wer.errors)
                    .put("werReferenceWords", wer.referenceWords)
                    .put("werHypothesisWords", wer.hypothesisWords)
                    .put("baselineVmHwmBytes", baselineHwm * 1024)
                    .put("peakVmHwmBytes", statusKb("VmHWM") * 1024)
                val rttmFile = File(output, "$stem.rttm")
                if (name != names.first() && !options.asrOnly) {
                    val diar = diarize(directory, samples, threads, options.clusterThreshold)
                    rttmFile.writeText(diar.rttm)
                    attributed = SpeakerAttribution.assign(words, diar.turns)
                    metrics.put("diarizationSeconds", diar.seconds)
                        .put("diarizationWindowSeconds", JSONArray(diar.windowSeconds))
                        .put("maxWindowSeconds", diar.windowSeconds.maxOrNull() ?: 0.0)
                        .put("diarizationBaselineRssBytes", diar.baselineRss * 1024)
                        .put("diarizationExtraRssBytes", diar.extraRss * 1024)
                        .put("clusterThreshold", options.clusterThreshold)
                        .put("peakVmHwmBytes", statusKb("VmHWM") * 1024)
                } else {
                    rttmFile.writeText("")
                    if (options.asrOnly) metrics.put("diarizationSkipped", true)
                }
                File(output, "$stem.hyp.txt").writeText(text + "\n")
                File(output, "$stem.words.json").writeText(wordsJson(attributed).toString(2) + "\n")
                File(output, "$stem.metrics.json").writeText(metrics.toString(2) + "\n")
                summaries.put(metrics)
            }
        }
        return JSObject().put("output", output.absolutePath).put("results", summaries)
    }

    private data class Recognition(val words: List<TimedWord>, val segments: Int, val empty: Int,
        val coverage: Double, val loadSeconds: Double, val decodeSeconds: Double)

    private fun recognize(directory: File, samples: FloatArray, threads: Int, options: Options): Recognition {
        val model = File(directory, "models/full")
        val required = listOf("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
        required.forEach { require(File(model, it).isFile) { "Missing model: $it" } }
        val vadModel = File(directory, "models/silero_vad.onnx")
        require(vadModel.isFile) { "Missing model: $vadModel" }
        val loadBegan = now()
        val recognizer = OfflineRecognizer(config = OfflineRecognizerConfig(
            modelConfig = OfflineModelConfig(
                transducer = OfflineTransducerModelConfig(
                    encoder = File(model, required[0]).path,
                    decoder = File(model, required[1]).path,
                    joiner = File(model, required[2]).path),
                tokens = File(model, required[3]).path,
                modelType = "nemo_transducer", numThreads = threads, provider = "cpu"),
            decodingMethod = "greedy_search", blankPenalty = options.blankPenalty.toFloat()))
        try {
            val vad = Vad(config = VadModelConfig(
                sileroVadModelConfig = SileroVadModelConfig(model = vadModel.path,
                    minSilenceDuration = .4f, minSpeechDuration = .1f, maxSpeechDuration = 25f),
                numThreads = threads, provider = "cpu"))
            try {
                val decodeBegan = now()
                val words = mutableListOf<TimedWord>()
                var count = 0
                var empty = 0
                var coverage = 0.0
                fun drain() {
                    while (!vad.empty()) {
                        val segment = vad.front()
                        vad.pop()
                        val start = segment.start
                        val chunk = segment.samples
                        require(start >= 0 && start.toLong() + chunk.size <= samples.size) { "VAD returned audio outside fixture" }
                        coverage += chunk.size.toDouble() / RATE
                        count++
                        val pad = (options.padSeconds * RATE).toInt()
                        val padded = FloatArray(chunk.size + 2 * pad)
                        chunk.copyInto(padded, pad)
                        val stream = recognizer.createStream()
                        try {
                            stream.acceptWaveform(padded, RATE)
                            recognizer.decode(stream)
                            val result = recognizer.getResult(stream)
                            val aligned = TokenWordAlignment.align(result.tokens, result.timestamps, result.durations,
                                (start - pad).toDouble() / RATE)
                            if (aligned.isEmpty()) empty++
                            words.addAll(aligned)
                        } finally { stream.release() }
                    }
                }
                // VAD's buffer is 30 seconds. Feeding 0.5 second blocks preserves the source sample origin.
                for (start in samples.indices step RATE / 2) {
                    vad.acceptWaveform(samples.copyOfRange(start, minOf(start + RATE / 2, samples.size)))
                    drain()
                }
                vad.flush()
                drain()
                return Recognition(words.sortedBy { it.start }, count, empty, coverage,
                    decodeBegan - loadBegan, now() - decodeBegan)
            } finally { vad.release() }
        } finally { recognizer.release() }
    }

    private data class Diarization(val rttm: String, val turns: List<SpeakerTurn>,
        val seconds: Double, val windowSeconds: List<Double>, val baselineRss: Long, val extraRss: Long)

    private fun diarize(directory: File, samples: FloatArray, threads: Int, threshold: Double): Diarization {
        val seg = File(directory, "models/diarization/model.int8.onnx")
        val embedding = File(directory, "models/diarization/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx")
        require(seg.isFile && embedding.isFile) { "Missing diarization model" }
        val baseline = statusKb("VmRSS")
        val sampler = RssSampler()
        val start = now()
        try {
            val diarizer = OfflineSpeakerDiarization(config = OfflineSpeakerDiarizationConfig(
                segmentation = OfflineSpeakerSegmentationModelConfig(
                    pyannote = OfflineSpeakerSegmentationPyannoteModelConfig(model = seg.path), numThreads = threads),
                embedding = SpeakerEmbeddingExtractorConfig(model = embedding.path, numThreads = threads),
                clustering = FastClusteringConfig(threshold = threshold.toFloat())))
            try {
                require(diarizer.sampleRate() == RATE) { "Unexpected diarization sample rate" }
                val lines = mutableListOf<String>()
                val turns = mutableListOf<SpeakerTurn>()
                val windows = mutableListOf<Double>()
                val length = RATE * 60
                for (offset in samples.indices step length) {
                    val index = offset / length
                    val began = now()
                    val results = diarizer.process(samples.copyOfRange(offset, minOf(offset + length, samples.size)))
                    windows.add(now() - began)
                    for (result in results) {
                        val origin = offset.toDouble() / RATE
                        val speaker = "w${index}_speaker_${result.speaker}"
                        val turn = SpeakerTurn(origin + result.start, origin + result.end, speaker)
                        turns.add(turn)
                        lines.add(String.format(Locale.US, "SPEAKER benchmark 1 %.3f %.3f <NA> <NA> %s <NA> <NA>",
                            turn.start, turn.end - turn.start, speaker))
                    }
                }
                return Diarization(lines.joinToString("\n", postfix = "\n"), turns,
                    now() - start, windows, baseline, maxOf(0, sampler.peakKb() - baseline))
            } finally { diarizer.release() }
        } finally { sampler.close() }
    }

    private fun referenceText(directory: File, name: String): String {
        if (name == names.first()) return File(directory, "$name.ref.txt").readText()
        val suffix = if (name == names[1]) "words.json" else "ref.json"
        val array = JSONArray(File(directory, "$name.$suffix").readText())
        return (0 until array.length()).joinToString(" ") { array.getJSONObject(it).getString("text") }
    }

    private fun wordsJson(words: List<TimedWord>): JSONArray = JSONArray().also { result ->
        for (word in words) result.put(JSONObject().put("start", word.start).put("end", word.end)
            .put("text", word.text).put("speaker", word.speaker ?: JSONObject.NULL))
    }

    private fun statusKb(field: String): Long {
        val line = File("/proc/self/status").useLines { it.firstOrNull { row -> row.startsWith("$field:") } }
        return line?.split(Regex("\\s+"))?.getOrNull(1)?.toLongOrNull()
            ?: error("Cannot read $field from /proc/self/status")
    }

    private fun now(): Double = SystemClock.elapsedRealtimeNanos() / 1_000_000_000.0

    private class RssSampler : AutoCloseable {
        private val running = AtomicBoolean(true)
        @Volatile private var peak = statusKb("VmRSS")
        @Volatile private var failure: Throwable? = null
        private val worker = thread(name = "stt-bench-rss", isDaemon = true) {
            try {
                while (running.get()) {
                    peak = maxOf(peak, statusKb("VmRSS"))
                    Thread.sleep(10)
                }
            } catch (error: Throwable) { failure = error }
        }
        fun peakKb(): Long {
            failure?.let { throw IllegalStateException("RSS sampling failed", it) }
            return maxOf(peak, statusKb("VmRSS"))
        }
        override fun close() { running.set(false); worker.join(1000) }
    }
}
