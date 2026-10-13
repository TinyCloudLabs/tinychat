package xyz.tinycloud.exo.capture

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import xyz.tinycloud.exo.capture.core.SAMPLE_RATE
import java.io.File
import java.nio.ByteBuffer

/** MediaExtractor reads each ADTS segment; MediaMuxer writes one monotonic AAC track. */
object RecordingFinalizer {
    fun mux(session: File, output: File) {
        val segments = session.listFiles { f -> f.name.matches(Regex("seg-\\d{5}\\.aac")) }
            ?.sortedBy { it.name }.orEmpty().filter { it.length() > 7 }
        require(segments.isNotEmpty()) { "No AAC frames" }
        val muxer = MediaMuxer(output.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var started = false
        try {
            var track = -1
            var packet = 0L
            for (segment in segments) {
                val extractor = MediaExtractor()
                try {
                    extractor.setDataSource(segment.absolutePath)
                    val audioTrack = (0 until extractor.trackCount).firstOrNull {
                        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
                    } ?: throw IllegalArgumentException("No audio in ${segment.name}")
                    val format = extractor.getTrackFormat(audioTrack)
                    if (!started) { track = muxer.addTrack(format); muxer.start(); started = true }
                    extractor.selectTrack(audioTrack)
                    val buffer = ByteBuffer.allocateDirect(64 * 1024)
                    val info = MediaCodec.BufferInfo()
                    while (true) {
                        buffer.clear()
                        val bytes = extractor.readSampleData(buffer, 0)
                        if (bytes < 0) break
                        info.set(0, bytes, packet * 1024L * 1_000_000L / SAMPLE_RATE, 0)
                        muxer.writeSampleData(track, buffer, info)
                        packet++
                        extractor.advance()
                    }
                } finally { extractor.release() }
            }
            require(packet > 0) { "No full AAC frames" }
        } finally {
            if (started) muxer.stop()
            muxer.release()
        }
    }
}
