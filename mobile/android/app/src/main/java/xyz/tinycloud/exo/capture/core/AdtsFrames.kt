package xyz.tinycloud.exo.capture.core

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

data class AdtsScan(val frames: Long, val bytes: Long) {
    val audioMs: Long get() = frames * 1024L * 1000 / SAMPLE_RATE
}

/** Stops before a torn last frame. A complete invalid header is a file error. */
fun scanAdts(file: File): AdtsScan {
    if (!file.isFile) return AdtsScan(0, 0)
    RandomAccessFile(file, "r").use { input ->
        val size = input.length()
        var offset = 0L
        var frames = 0L
        while (size - offset >= 7) {
            input.seek(offset)
            val b = ByteArray(7)
            input.readFully(b)
            val h = b.map { it.toInt() and 0xff }
            if (h[0] != 0xff || h[1] != 0xf1 || (h[2] shr 6) != 1 ||
                ((h[2] shr 2) and 0xf) != 4 || ((h[2] and 1) shl 2 or (h[3] shr 6)) != 1 ||
                h[6] != 0xfc) throw IOException("Invalid ADTS header at $offset in ${file.name}")
            val length = ((h[3] and 3) shl 11) or (h[4] shl 3) or (h[5] shr 5)
            if (length < 7) throw IOException("Invalid ADTS length at $offset in ${file.name}")
            if (offset + length > size) break
            offset += length
            frames++
        }
        return AdtsScan(frames, offset)
    }
}
