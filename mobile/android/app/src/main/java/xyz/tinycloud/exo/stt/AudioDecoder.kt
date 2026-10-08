package xyz.tinycloud.exo.stt

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes a committed note's `.m4a` to 16 kHz mono Float32 (plan §2.5 step 1), the format
 * sherpa-onnx's VAD and recognizer both expect. Android's own capture is already mono (§1.2), so
 * this only resamples; it does not down-mix channels. The whole note is decoded into memory at
 * once, as the T8 benchmark already does for its fixtures: correct for the recordings this slice
 * was verified against, but a multi-hour note can use several hundred MB doing this; T24 moves to
 * a blockwise decode to bound that.
 */
object AudioDecoder {
    private const val TARGET_RATE = 16_000

    fun decode16kMono(file: File): FloatArray {
        val extractor = MediaExtractor()
        extractor.setDataSource(file.path)
        var trackIndex = -1
        var format: MediaFormat? = null
        for (i in 0 until extractor.trackCount) {
            val candidate = extractor.getTrackFormat(i)
            val mime = candidate.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("audio/")) { trackIndex = i; format = candidate; break }
        }
        if (trackIndex < 0 || format == null) { extractor.release(); return FloatArray(0) }
        extractor.selectTrack(trackIndex)
        val sourceRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val mime = format.getString(MediaFormat.KEY_MIME)!!
        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(format, null, null, 0)
        codec.start()
        val pcm = ArrayList<Short>(sourceRate * 60) // typical note is tens of seconds to minutes
        try {
            val bufferInfo = MediaCodec.BufferInfo()
            var sawInputEos = false
            var sawOutputEos = false
            while (!sawOutputEos) {
                if (!sawInputEos) {
                    val inputIndex = codec.dequeueInputBuffer(10_000)
                    if (inputIndex >= 0) {
                        val inputBuffer = codec.getInputBuffer(inputIndex)!!
                        val sampleSize = extractor.readSampleData(inputBuffer, 0)
                        if (sampleSize < 0) {
                            codec.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            sawInputEos = true
                        } else {
                            codec.queueInputBuffer(inputIndex, 0, sampleSize, extractor.sampleTime, 0)
                            extractor.advance()
                        }
                    }
                }
                val outputIndex = codec.dequeueOutputBuffer(bufferInfo, 10_000)
                if (outputIndex >= 0) {
                    if (bufferInfo.size > 0) {
                        val outputBuffer = codec.getOutputBuffer(outputIndex)!!
                        outputBuffer.position(bufferInfo.offset)
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size)
                        val shortBuffer = outputBuffer.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                        while (shortBuffer.hasRemaining()) pcm.add(shortBuffer.get())
                    }
                    codec.releaseOutputBuffer(outputIndex, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEos = true
                }
            }
        } finally {
            codec.stop(); codec.release(); extractor.release()
        }
        val channelCount = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT, 1)
        val mono = if (channelCount <= 1) {
            FloatArray(pcm.size) { pcm[it] / 32_768f }
        } else {
            val frames = pcm.size / channelCount
            FloatArray(frames) { frame ->
                var sum = 0f
                for (c in 0 until channelCount) sum += pcm[frame * channelCount + c] / 32_768f
                sum / channelCount
            }
        }
        return if (sourceRate == TARGET_RATE) mono else resample(mono, sourceRate, TARGET_RATE)
    }

    private fun resample(input: FloatArray, sourceRate: Int, targetRate: Int): FloatArray {
        if (input.isEmpty()) return input
        val ratio = sourceRate.toDouble() / targetRate
        val outCount = (input.size / ratio).toInt()
        return FloatArray(outCount) { i ->
            val position = i * ratio
            val low = position.toInt()
            val high = minOf(low + 1, input.size - 1)
            val fraction = (position - low).toFloat()
            input[low] * (1 - fraction) + input[high] * fraction
        }
    }
}
