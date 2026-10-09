package xyz.tinycloud.exo.capture

import java.io.File
import java.io.RandomAccessFile

/**
 * Debug-only PCM16 mono WAV reader at [SAMPLE_RATE][xyz.tinycloud.exo.capture.core.SAMPLE_RATE],
 * used by [AudioCapture] to feed known speech into the real capture pipeline for verification
 * (TC-836), without touching a device microphone or any host audio routing. Only ever consulted
 * when `BuildConfig.DEBUG` is true and the file exists; see `AudioCapture.debugSourceFile`.
 */
internal class DebugWavSource(file: File) {
    private val pcm: ByteArray

    init {
        RandomAccessFile(file, "r").use { input ->
            fun ascii(count: Int): String = ByteArray(count).also(input::readFully).toString(Charsets.US_ASCII)
            fun u16(): Int = input.readUnsignedByte() or (input.readUnsignedByte() shl 8)
            fun u32(): Long = (u16().toLong() or (u16().toLong() shl 16))
            require(ascii(4) == "RIFF") { "Not a RIFF WAV: $file" }
            input.skipBytes(4)
            require(ascii(4) == "WAVE") { "Not a WAVE file: $file" }
            var dataOffset = -1L
            var dataBytes = -1L
            while (input.filePointer + 8 <= input.length()) {
                val kind = ascii(4)
                val size = u32()
                val start = input.filePointer
                if (kind == "data") { dataOffset = start; dataBytes = size }
                input.seek(start + size + size % 2)
            }
            require(dataOffset >= 0 && dataBytes >= 0) { "Missing WAV data chunk: $file" }
            input.seek(dataOffset)
            pcm = ByteArray(dataBytes.toInt())
            input.readFully(pcm)
        }
        require(pcm.isNotEmpty()) { "Empty WAV data: $file" }
    }

    /** Fills `dst` from `position` (bytes into the clip), looping so a debug session can run
     * arbitrarily long without the source running dry. Returns the next read position. */
    fun read(dst: ByteArray, position: Int): Int {
        for (i in dst.indices) dst[i] = pcm[(position + i) % pcm.size]
        return (position + dst.size) % pcm.size
    }
}
