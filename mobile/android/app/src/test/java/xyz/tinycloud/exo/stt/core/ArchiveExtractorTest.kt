package xyz.tinycloud.exo.stt.core

import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

class ArchiveExtractorTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun writeArchive(dest: File, entries: Map<String, ByteArray>, directories: List<String> = emptyList()) {
        FileOutputStream(dest).use { fos ->
            BZip2CompressorOutputStream(fos).use { bz ->
                TarArchiveOutputStream(bz).use { tar ->
                    for (dir in directories) {
                        val entry = TarArchiveEntry("./$dir/")
                        tar.putArchiveEntry(entry)
                        tar.closeArchiveEntry()
                    }
                    for ((name, bytes) in entries) {
                        // Real release assets prefix entries with "./", as k2-fsa's do.
                        val entry = TarArchiveEntry("./$name")
                        entry.size = bytes.size.toLong()
                        tar.putArchiveEntry(entry)
                        tar.write(bytes)
                        tar.closeArchiveEntry()
                    }
                }
            }
        }
    }

    @Test fun extractsEveryWantedEntryAndVerifiesItsSha256() {
        val a = "a content".toByteArray()
        val b = "b content, a little longer this time".toByteArray()
        val archive = tmp.newFile("archive.tar.bz2")
        writeArchive(archive, mapOf("pack/a.bin" to a, "pack/b.bin" to b), directories = listOf("pack"))

        val outDir = tmp.newFolder("out")
        val wanted = mapOf(
            "pack/a.bin" to ArchiveEntry("a.bin", sha256(a), a.size.toLong()),
            "pack/b.bin" to ArchiveEntry("b.bin", sha256(b), b.size.toLong()),
        )
        val extracted = ArchiveExtractor.extract(archive, wanted) { name -> File(outDir, wanted.getValue(name).name) }

        assertEquals(setOf("pack/a.bin", "pack/b.bin"), extracted)
        assertEquals("a content", File(outDir, "a.bin").readText())
        assertEquals(b.toString(Charsets.UTF_8), File(outDir, "b.bin").readText())
    }

    @Test fun ignoresEntriesNobodyAskedFor() {
        val wantedBytes = "keep me".toByteArray()
        val archive = tmp.newFile("archive.tar.bz2")
        writeArchive(archive, mapOf("keep.bin" to wantedBytes, "skip.bin" to "skip me".toByteArray()))

        val outDir = tmp.newFolder("out")
        val wanted = mapOf("keep.bin" to ArchiveEntry("keep.bin", sha256(wantedBytes), wantedBytes.size.toLong()))
        val extracted = ArchiveExtractor.extract(archive, wanted) { File(outDir, "keep.bin") }

        assertEquals(setOf("keep.bin"), extracted)
        assertEquals(1, outDir.listFiles()?.size)
    }

    @Test fun throwsAndDeletesThePartialFileWhenContentDoesNotMatchThePinnedSha256() {
        val archive = tmp.newFile("archive.tar.bz2")
        writeArchive(archive, mapOf("corrupt.bin" to "actual content".toByteArray()))

        val outDir = tmp.newFolder("out")
        val wanted = mapOf("corrupt.bin" to ArchiveEntry("corrupt.bin", sha256("expected content".toByteArray()), 14L))
        val outputFile = File(outDir, "corrupt.bin")

        assertThrows(ArchiveMismatchException::class.java) {
            ArchiveExtractor.extract(archive, wanted) { outputFile }
        }
        assert(!outputFile.exists()) { "a mismatched extraction must not leave a file behind" }
    }

    @Test fun roundTripsAFileLargeEnoughToNeedMultiple64kBufferFills() {
        val big = ByteArray(300_000) { (it % 251).toByte() }
        val archive = tmp.newFile("archive.tar.bz2")
        writeArchive(archive, mapOf("big.bin" to big))

        val outDir = tmp.newFolder("out")
        val wanted = mapOf("big.bin" to ArchiveEntry("big.bin", sha256(big), big.size.toLong()))
        val extracted = ArchiveExtractor.extract(archive, wanted) { File(outDir, "big.bin") }

        assertEquals(setOf("big.bin"), extracted)
        assertEquals(sha256(big), sha256(File(outDir, "big.bin").readBytes()))
    }
}
