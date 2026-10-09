package xyz.tinycloud.exo.stt.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File

class Wav16Test {
    private fun fixture(rate: Int, channels: Int = 1, sample: Int = 16384): File {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            fun ascii(value: String) = out.write(value.toByteArray(Charsets.US_ASCII))
            fun u16(value: Int) { out.writeByte(value); out.writeByte(value shr 8) }
            fun u32(value: Int) { u16(value); u16(value shr 16) }
            ascii("RIFF"); u32(48); ascii("WAVE")
            ascii("JUNK"); u32(1); out.writeByte(7); out.writeByte(0)
            ascii("fmt "); u32(16); u16(1); u16(channels); u32(rate); u32(rate * channels * 2); u16(channels * 2); u16(16)
            ascii("data"); u32(2); u16(sample)
        }
        return File.createTempFile("stt-wav", ".wav").also { it.writeBytes(bytes.toByteArray()); it.deleteOnExit() }
    }

    @Test fun oddSizedChunkIsSkipped() {
        assertEquals(.5f, Wav16.read(fixture(16_000))[0], .00001f)
    }

    @Test fun rejectsNon16kAudio() {
        assertThrows(IllegalArgumentException::class.java) { Wav16.read(fixture(8_000)) }
    }

    @Test fun preservesSignedPcm16ScaleAndRejectsStereo() {
        assertEquals(-1f, Wav16.read(fixture(16_000, sample = -32768))[0], 0f)
        assertEquals(32767f / 32768f, Wav16.read(fixture(16_000, sample = 32767))[0], 0f)
        assertThrows(IllegalArgumentException::class.java) { Wav16.read(fixture(16_000, channels = 2)) }
    }
}
