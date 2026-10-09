package xyz.tinycloud.exo.capture

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import xyz.tinycloud.exo.capture.core.BITRATE
import xyz.tinycloud.exo.capture.core.SAMPLE_RATE
import xyz.tinycloud.exo.capture.core.Adts

/** A single AAC-LC encoder; output is raw access units with ADTS headers. */
class AacAdtsEncoder(private val onFrame: (ByteArray) -> Unit) {
    private val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    private val info = MediaCodec.BufferInfo()
    private var samples = 0L
    private val frame = ByteArray(1024 * 2)
    private var frameBytes = 0
    init {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1)
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 8192)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }
    fun offer(pcm: ByteArray, size: Int) {
        require(size in 0..pcm.size && size % 2 == 0) { "AAC PCM must contain whole samples" }
        var offset = 0
        while (offset < size) {
            val count = minOf(frame.size - frameBytes, size - offset)
            pcm.copyInto(frame, frameBytes, offset, offset + count)
            frameBytes += count
            offset += count
            if (frameBytes == frame.size) {
                queueFrame(frame.size)
                frameBytes = 0
            }
        }
    }
    fun finish() {
        if (frameBytes > 0) { queueFrame(frameBytes); frameBytes = 0 }
        var slot = codec.dequeueInputBuffer(1_000_000)
        while (slot < 0) { drain(false); slot = codec.dequeueInputBuffer(1_000_000) }
        codec.queueInputBuffer(slot, 0, 0, samples * 1_000_000L / SAMPLE_RATE, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        drain(true)
        codec.stop(); codec.release()
    }
    private fun queueFrame(count: Int) {
        var slot = codec.dequeueInputBuffer(10_000)
        while (slot < 0) { drain(false); slot = codec.dequeueInputBuffer(10_000) }
        val input = codec.getInputBuffer(slot)!!
        input.clear()
        check(input.remaining() >= count) { "AAC input buffer cannot hold an access unit" }
        input.put(frame, 0, count)
        codec.queueInputBuffer(slot, 0, count, samples * 1_000_000L / SAMPLE_RATE, 0)
        samples += count / 2
        drain(false)
    }
    fun abort() { codec.stop(); codec.release() }
    private fun drain(final: Boolean) {
        var tries = 0
        while (true) {
            val index = codec.dequeueOutputBuffer(info, if (final) 100_000 else 0)
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!final) return
                if (++tries >= 20) throw IllegalStateException("AAC encoder did not finish")
                continue
            }
            if (index < 0) continue
            val end = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                val buffer = codec.getOutputBuffer(index)!!
                buffer.position(info.offset); buffer.limit(info.offset + info.size)
                val payload = ByteArray(info.size)
                buffer.get(payload)
                onFrame(Adts.wrap(payload))
            }
            codec.releaseOutputBuffer(index, false)
            if (end) return
        }
    }
}
