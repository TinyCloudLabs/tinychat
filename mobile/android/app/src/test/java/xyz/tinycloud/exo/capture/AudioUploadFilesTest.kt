package xyz.tinycloud.exo.capture

import java.io.File
import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Test

class AudioUploadFilesTest {
    @Test fun hashesFilesWithoutChangingTheirLength() {
        val file = File.createTempFile("exo-upload", ".m4a")
        try {
            val bytes = ByteArray(2 * 1024 * 1024 + 17) { (it % 251).toByte() }
            file.writeBytes(bytes)
            val expected = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
            assertEquals(expected, AudioUploadFiles.sha256(file))
            assertEquals(bytes.size.toLong(), file.length())
        } finally { file.delete() }
    }
}
