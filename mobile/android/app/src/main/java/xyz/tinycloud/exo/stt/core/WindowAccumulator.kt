package xyz.tinycloud.exo.stt.core

/**
 * Buffers streamed samples into fixed-size windows, so a decoder can emit one MediaCodec buffer's
 * worth of audio at a time and still produce aligned VAD windows: the only state that grows with
 * time is this one window, not the note's length (TC-836's crash: the old decoder materialized a
 * whole note's PCM at once and OOM'd on a long recording).
 */
internal class WindowAccumulator(private val windowSize: Int, private val onWindow: (FloatArray) -> Unit) {
    private val buffer = FloatArray(windowSize)
    private var fill = 0

    fun push(samples: FloatArray) {
        var offset = 0
        while (offset < samples.size) {
            val take = minOf(windowSize - fill, samples.size - offset)
            samples.copyInto(buffer, fill, offset, offset + take)
            fill += take
            offset += take
            if (fill == windowSize) {
                onWindow(buffer.copyOf())
                fill = 0
            }
        }
    }

    /** Same as `push`, one sample at a time, without allocating a single-element array per call. */
    fun pushOne(sample: Float) {
        buffer[fill] = sample
        fill += 1
        if (fill == windowSize) {
            onWindow(buffer.copyOf())
            fill = 0
        }
    }

    /** Flushes a final, shorter-than-`windowSize` window if any samples are buffered. */
    fun finish() {
        if (fill > 0) onWindow(buffer.copyOf(fill))
        fill = 0
    }
}
