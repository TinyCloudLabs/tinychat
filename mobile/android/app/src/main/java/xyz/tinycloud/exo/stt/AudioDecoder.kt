package xyz.tinycloud.exo.stt

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import xyz.tinycloud.exo.stt.core.StreamResampler
import xyz.tinycloud.exo.stt.core.WindowAccumulator
import java.io.File
import java.nio.ByteOrder

/**
 * Decodes a committed note's `.m4a` to 16 kHz mono Float32 windows (plan §2.5 step 1), the format
 * sherpa-onnx's VAD and recognizer both expect. Android's own capture is already mono (§1.2), so
 * this only resamples; it does not down-mix channels beyond that. Unlike an earlier version of
 * this file, it never materializes the whole note in memory: each MediaCodec output buffer is
 * mixed down, resampled (carrying state across buffer boundaries) and handed to `onWindow` as
 * fixed-size windows, so memory stays bounded by one window and one codec buffer regardless of
 * note length (TC-836: a note left recording for a long time OOM'd the old whole-file decode).
 */
object AudioDecoder {
    private const val TARGET_RATE = 16_000

    fun decodeWindows(file: File, windowSize: Int, onWindow: (FloatArray) -> Unit) {
        val extractor = MediaExtractor()
        extractor.setDataSource(file.path)
        var trackIndex = -1
        var format: MediaFormat? = null
        for (i in 0 until extractor.trackCount) {
            val candidate = extractor.getTrackFormat(i)
            val mime = candidate.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("audio/")) { trackIndex = i; format = candidate; break }
        }
        if (trackIndex < 0 || format == null) { extractor.release(); return }
        extractor.selectTrack(trackIndex)
        val sourceRate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val channelCount = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT, 1)
        val mime = format.getString(MediaFormat.KEY_MIME)!!
        val codec = MediaCodec.createDecoderByType(mime)
        codec.configure(format, null, null, 0)
        codec.start()

        val windows = WindowAccumulator(windowSize, onWindow)
        val resampler = StreamResampler(sourceRate, TARGET_RATE)
        var frameCarry = ShortArray(0) // leftover channel samples (< channelCount) from the previous buffer

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
                        val pcm = ShortArray(shortBuffer.remaining())
                        shortBuffer.get(pcm)
                        val combined = if (frameCarry.isEmpty()) pcm else frameCarry + pcm
                        val usableFrames = combined.size / channelCount
                        val usableSamples = usableFrames * channelCount
                        val mono = FloatArray(usableFrames)
                        if (channelCount <= 1) {
                            for (f in 0 until usableFrames) mono[f] = combined[f] / 32_768f
                        } else {
                            for (f in 0 until usableFrames) {
                                var sum = 0f
                                for (c in 0 until channelCount) sum += combined[f * channelCount + c] / 32_768f
                                mono[f] = sum / channelCount
                            }
                        }
                        resampler.push(mono, windows::pushOne)
                        frameCarry = combined.copyOfRange(usableSamples, combined.size)
                    }
                    codec.releaseOutputBuffer(outputIndex, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEos = true
                }
            }
        } finally {
            codec.stop(); codec.release(); extractor.release()
        }
        windows.finish()
    }
}
