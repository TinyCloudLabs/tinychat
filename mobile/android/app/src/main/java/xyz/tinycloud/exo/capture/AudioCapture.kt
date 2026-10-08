package xyz.tinycloud.exo.capture

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Process
import xyz.tinycloud.exo.capture.core.SAMPLE_RATE
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.sqrt

/** AudioRecord owns the mic; the 10 s queue bounds PCM memory while the writer stalls. */
class AudioCapture(
    private val onPcm: (ByteArray) -> Unit,
    private val onLevel: (Double, Double) -> Unit,
    private val onSilenced: (Boolean) -> Unit,
    private val onError: (String) -> Unit,
    private val inputs: InputDevices? = null,
    private val onRoute: () -> Unit = {}
) {
    private val running = AtomicBoolean(false)
    private val producerDone = AtomicBoolean(false)
    private val cutting = AtomicBoolean(false)
    private val queue = ArrayBlockingQueue<ByteArray>(200) // 200 × 50 ms = 10 s
    private val firstPcm = CountDownLatch(1)
    private val minBytes = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    private val record: AudioRecord
    private var reader: Thread? = null
    private var writer: Thread? = null
    private var watchdog: Thread? = null
    @Volatile private var lastReadAt = 0L
    private var drained = false
    @Volatile private var tailLost = false
    @Volatile private var writerFailure: Exception? = null
    @Volatile var inputStopped = false
        private set
    private var recordingCallback: Any? = null
    private val routingListener = android.media.AudioRouting.OnRoutingChangedListener { onRoute() }
    init {
        require(minBytes > 0) { "Unsupported capture format" }
        val size = maxOf(minBytes * 4, SAMPLE_RATE * 2 / 5)
        val builder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build())
            .setBufferSizeInBytes(size)
        if (Build.VERSION.SDK_INT >= 30) builder.setPrivacySensitive(true)
        record = builder.build()
        require(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord initialization failed" }
        try { inputs?.apply(record) } catch (e: Exception) {
            inputs?.clearCommunicationDevice(record); record.release(); throw e
        }
        record.addOnRoutingChangedListener(routingListener, android.os.Handler(android.os.Looper.getMainLooper()))
        if (Build.VERSION.SDK_INT >= 29) {
            val callback = object : android.media.AudioManager.AudioRecordingCallback() {
                override fun onRecordingConfigChanged(configs: MutableList<android.media.AudioRecordingConfiguration>) {
                    val config = record.activeRecordingConfiguration
                    if (config != null) onSilenced(config.isClientSilenced)
                }
            }
            recordingCallback = callback
            record.registerAudioRecordingCallback(android.os.Handler(android.os.Looper.getMainLooper())::post, callback)
        }
    }
    fun start(afterRecordStarted: () -> Unit = {}) {
        record.startRecording()
        if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) throw IllegalStateException("mic_unavailable")
        try {
            afterRecordStarted()
            if (writer == null) startWorkers()
        } catch (e: Exception) {
            try { record.stop(); inputStopped = true } catch (_: Exception) { }
            throw e
        }
    }
    /** Called while the engine's control lock is held, before this input is visible to Pause. */
    fun startWorkers() {
        running.set(true)
        lastReadAt = System.currentTimeMillis()
        writer = Thread {
            Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
            while (!producerDone.get() || queue.isNotEmpty()) {
                val pcm = queue.poll(100, java.util.concurrent.TimeUnit.MILLISECONDS) ?: continue
                try { onPcm(pcm); firstPcm.countDown() } catch (e: Exception) {
                    writerFailure = e
                    firstPcm.countDown()
                    onError("write_failed: ${e.message}"); running.set(false); producerDone.set(true)
                    queue.clear()
                    break
                }
            }
        }.also { it.name = "ExoAACWriter"; it.start() }
        reader = Thread {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            val scratch = ByteArray(SAMPLE_RATE / 10) // 50 ms, mono PCM16
            var lastLevel = 0L
            var stalled = false
            while (running.get()) {
                val n = record.read(scratch, 0, scratch.size, AudioRecord.READ_BLOCKING)
                if (n < 0) {
                    if (running.get() && !cutting.get()) onError(if (n == AudioRecord.ERROR_DEAD_OBJECT) "read_error" else "read_failed:$n")
                    break
                }
                if (n == 0) continue
                lastReadAt = System.currentTimeMillis()
                val chunk = scratch.copyOf(n)
                var accepted = queue.offer(chunk)
                if (!accepted && cutting.get()) {
                    val deadline = System.currentTimeMillis() + 10_000
                    while (!accepted && writer?.isAlive == true && System.currentTimeMillis() < deadline)
                        accepted = queue.offer(chunk, 200, java.util.concurrent.TimeUnit.MILLISECONDS)
                    if (!accepted) tailLost = true
                }
                if (!accepted) {
                    if (!stalled) { stalled = true; onError("writer_stalled") }
                } else if (stalled) { stalled = false; onError("writer_resumed") }
                val now = System.currentTimeMillis()
                if (now - lastLevel >= 50) {
                    var peak = 0; var sum = 0.0; var samples = 0
                    for (i in 0 until n - 1 step 2) {
                        val value = ((scratch[i + 1].toInt() shl 8) or (scratch[i].toInt() and 0xff)).toShort().toInt()
                        peak = maxOf(peak, kotlin.math.abs(value)); sum += value.toDouble() * value; samples++
                    }
                    onLevel(if (samples == 0) 0.0 else sqrt(sum / samples) / 32768.0, peak / 32768.0)
                    lastLevel = now
                }
            }
        }.also { it.name = "ExoAudioRead"; it.start() }
        watchdog = Thread {
            while (running.get()) {
                try { Thread.sleep(500) } catch (_: InterruptedException) { return@Thread }
                if (running.get() && !cutting.get() && System.currentTimeMillis() - lastReadAt >= 3000) {
                    onError("stalled")
                    return@Thread
                }
            }
        }.also { it.name = "ExoAudioWatchdog"; it.start() }
    }
    fun awaitFirstPcm() {
        if (!firstPcm.await(3, TimeUnit.SECONDS)) throw IllegalStateException("mic_unavailable")
        writerFailure?.let { throw IllegalStateException("write_failed", it) }
    }
    fun drain() {
        if (drained) return
        // Stop cuts the capture boundary. If stop fails, the reader and writer
        // remain live so the caller can truthfully report recording.
        if (!inputStopped) {
            cutting.set(true)
            try { record.stop() } catch (e: Exception) { cutting.set(false); throw e }
            if (record.recordingState != AudioRecord.RECORDSTATE_STOPPED) {
                cutting.set(false)
                throw IllegalStateException("AudioRecord did not stop")
            }
            inputStopped = true
        }
        running.set(false)
        watchdog?.interrupt()
        reader?.join(2000)
        if (reader?.isAlive == true) throw IllegalStateException("AudioRecord reader did not stop")
        if (tailLost) throw IllegalStateException("Audio tail could not reach the writer")
        // The reader may have returned an in-flight block after stop(). Drain
        // anything else Android still makes readable before ending production.
        val scratch = ByteArray(SAMPLE_RATE / 10)
        while (true) {
            val count = record.read(scratch, 0, scratch.size, AudioRecord.READ_NON_BLOCKING)
            if (count <= 0) break // ERROR_INVALID_OPERATION means no post-stop read is available.
            while (!queue.offer(scratch.copyOf(count), 200, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                if (writer?.isAlive != true) throw IllegalStateException("Audio writer stopped before tail drain")
            }
        }
        producerDone.set(true)
        writer?.join(30_000)
        if (writer?.isAlive == true) throw IllegalStateException("Audio writer did not drain")
        writerFailure?.let { throw IllegalStateException("Audio writer failed", it) }
        drained = true
    }
    /** The reader has already exited on an AudioRecord error; retain queued PCM before teardown. */
    fun drainAfterReadFailure() {
        if (drained) return
        running.set(false)
        watchdog?.interrupt()
        try { record.stop() } catch (_: Exception) { }
        inputStopped = true
        reader?.join(2000)
        producerDone.set(true)
        writer?.join(30_000)
        if (writer?.isAlive == true) throw IllegalStateException("Audio writer did not drain after read failure")
        writerFailure?.let { throw IllegalStateException("Audio writer failed", it) }
        drained = true
    }
    fun release() {
        running.set(false)
        watchdog?.interrupt()
        producerDone.set(true)
        try {
            record.removeOnRoutingChangedListener(routingListener)
            if (Build.VERSION.SDK_INT >= 29) record.unregisterAudioRecordingCallback(
                recordingCallback as android.media.AudioManager.AudioRecordingCallback)
        } finally { record.release(); inputs?.clearCommunicationDevice(record) }
    }
    fun activeInputId(): String? = inputs?.activeId(record)
    fun stop() { drain(); release() }
}
