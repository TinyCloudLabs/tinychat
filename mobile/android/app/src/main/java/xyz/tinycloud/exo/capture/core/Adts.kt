package xyz.tinycloud.exo.capture.core

/** MPEG-4 AAC-LC, 44.1 kHz, mono, no CRC. */
object Adts {
    fun wrap(data: ByteArray): ByteArray {
        val length = data.size + 7
        require(length <= 8191) { "AAC frame too large" }
        val out = ByteArray(length)
        out[0] = 0xff.toByte(); out[1] = 0xf1.toByte()
        out[2] = ((1 shl 6) or (4 shl 2)).toByte()
        out[3] = ((1 shl 6) or (length shr 11)).toByte()
        out[4] = ((length shr 3) and 0xff).toByte()
        out[5] = (((length and 7) shl 5) or 0x1f).toByte()
        out[6] = 0xfc.toByte()
        System.arraycopy(data, 0, out, 7, data.size)
        return out
    }
}
