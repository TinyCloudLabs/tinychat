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
    init {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1)
        format.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
        format.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 8192)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }
    fun offer(pcm: ByteArray, size: Int) {
        var offset = 0
        while (offset < size) {
            val slot = codec.dequeueInputBuffer(10_000)
            if (slot < 0) { drain(false); continue }
            val input = codec.getInputBuffer(slot)!!
            input.clear()
            // Some platform AAC encoders emit only one 1024-sample access unit per
            // queued buffer, even when the buffer has room for more PCM.
            val count = minOf(input.remaining() and -2, 1024 * 2, size - offset)
            if (count == 0) throw IllegalStateException("AAC input buffer cannot hold a sample")
            input.put(pcm, offset, count)
            codec.queueInputBuffer(slot, 0, count, samples * 1_000_000L / SAMPLE_RATE, 0)
            samples += count / 2
            offset += count
            drain(false)
        }
    }
    fun finish() {
        val slot = codec.dequeueInputBuffer(1_000_000)
        if (slot >= 0) codec.queueInputBuffer(slot, 0, 0, samples * 1_000_000L / SAMPLE_RATE, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        drain(true)
        codec.stop(); codec.release()
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
