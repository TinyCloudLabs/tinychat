package xyz.tinycloud.exo.stt.core

import java.io.File
import java.io.RandomAccessFile

/** Fixture reader. Refuses resampling or format guesses so timestamps retain the scorer's origin. */
internal object Wav16 {
    fun read(file: File): FloatArray = RandomAccessFile(file, "r").use { input ->
        fun ascii(count: Int): String = ByteArray(count).also(input::readFully).toString(Charsets.US_ASCII)
        fun u16(): Int = input.readUnsignedByte() or (input.readUnsignedByte() shl 8)
        fun u32(): Long = (u16().toLong() or (u16().toLong() shl 16))
        require(ascii(4) == "RIFF") { "Not a RIFF WAV: $file" }
        input.skipBytes(4)
        require(ascii(4) == "WAVE") { "Not a WAVE file: $file" }
        var format = false
        var dataOffset = -1L
        var dataBytes = -1L
        while (input.filePointer + 8 <= input.length()) {
            val kind = ascii(4)
            val size = u32()
            val start = input.filePointer
            require(size <= input.length() - start) { "Truncated WAV chunk: $file" }
            when (kind) {
                "fmt " -> {
                    require(size >= 16) { "Short WAV fmt: $file" }
                    val encoding = u16()
                    val channels = u16()
                    val rate = u32()
                    input.skipBytes(6)
                    val bits = u16()
                    require(encoding == 1 && channels == 1 && rate == 16_000L && bits == 16) {
                        "Expected 16 kHz mono PCM16: $file"
                    }
                    format = true
                }
                "data" -> { dataOffset = start; dataBytes = size }
            }
            input.seek(start + size + size % 2)
        }
        require(format && dataOffset >= 0 && dataBytes >= 0 && dataBytes % 2 == 0L) {
            "Missing WAV format or samples: $file"
        }
        require(dataBytes / 2 <= Int.MAX_VALUE) { "WAV too large: $file" }
        input.seek(dataOffset)
        FloatArray((dataBytes / 2).toInt()) { u16().toShort() / 32768f }
    }
}
