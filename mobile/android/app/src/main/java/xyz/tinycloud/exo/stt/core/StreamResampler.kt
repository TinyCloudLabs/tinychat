package xyz.tinycloud.exo.stt.core

/**
 * Linear resampling that stays correct across chunk boundaries, so a decoder can feed it one
 * MediaCodec output buffer at a time instead of resampling a whole note in one pass (TC-836's
 * crash: a multi-hour note decoded whole ran the process out of memory). Each call continues
 * exactly where the previous one left off, carrying the fractional source position and the one
 * unconsumed source sample interpolation needs.
 */
internal class StreamResampler(sourceRate: Int, private val targetRate: Int) {
    private val ratio = sourceRate.toDouble() / targetRate
    private var position = 0.0
    private var carry = FloatArray(0)

    fun push(input: FloatArray, onSample: (Float) -> Unit) {
        if (input.isEmpty()) return
        if (ratio == 1.0) { input.forEach(onSample); return }
        val buffer = if (carry.isEmpty()) input else carry + input
        var pos = position
        while (true) {
            val low = pos.toInt()
            val high = low + 1
            if (high >= buffer.size) break
            val fraction = (pos - low).toFloat()
            onSample(buffer[low] * (1 - fraction) + buffer[high] * fraction)
            pos += ratio
        }
        // Downsampling (ratio > 1) can jump `pos` past the end of `buffer` in one step, since the
        // last successful sample only guarantees room for one more low/high pair, not a whole
        // `ratio`-sized stride: clamp what we claim to have consumed, and let the remainder (> 1
        // when it happens) carry over as the starting offset into the next buffer.
        val consumedWhole = minOf(pos.toInt(), buffer.size)
        carry = buffer.copyOfRange(consumedWhole, buffer.size)
        position = pos - consumedWhole
    }
}
