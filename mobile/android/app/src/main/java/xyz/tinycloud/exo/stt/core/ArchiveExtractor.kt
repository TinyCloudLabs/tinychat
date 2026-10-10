package xyz.tinycloud.exo.stt.core

import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest

/** One entry this extraction wants out of an archive, and what it must sha256-verify to. */
internal data class ArchiveEntry(val name: String, val sha256: String, val bytes: Long)

internal class ArchiveMismatchException(message: String) : Exception(message)

/**
 * Streams the wanted entries out of a `.tar.bz2`, verifying each against its own pinned sha256
 * before `destination` is trusted. Pure (no Android `Context`), so it is unit-testable on the
 * JVM: `ModelDownloads` only adds the network/`ModelStore` plumbing around this.
 */
internal object ArchiveExtractor {
    fun extract(archiveFile: File, wanted: Map<String, ArchiveEntry>, destination: (String) -> File): Set<String> {
        val remaining = wanted.keys.toMutableSet()
        val extracted = mutableSetOf<String>()
        // BZip2CompressorInputStream reads its underlying stream almost a byte at a time; without
        // a BufferedInputStream in front of it, extraction turns into millions of tiny read()
        // syscalls and becomes pathologically slow.
        BufferedInputStream(FileInputStream(archiveFile), 1 shl 16).use { fis ->
            BZip2CompressorInputStream(fis).use { bzIn ->
                TarArchiveInputStream(bzIn).use { tarIn ->
                    var entry = tarIn.nextEntry
                    while (entry != null && remaining.isNotEmpty()) {
                        // Release assets store entries as "./pack/file.onnx"; normalize before
                        // matching against `wanted`, which is keyed without the leading "./".
                        val name = entry.name.removePrefix("./")
                        val wantedEntry = wanted[name]
                        if (wantedEntry != null && !entry.isDirectory) {
                            val outputFile = destination(name)
                            val digest = MessageDigest.getInstance("SHA-256")
                            var total = 0L
                            BufferedOutputStream(FileOutputStream(outputFile), 1 shl 16).use { out ->
                                val buffer = ByteArray(1 shl 16)
                                while (true) {
                                    val read = tarIn.read(buffer)
                                    if (read < 0) break
                                    out.write(buffer, 0, read)
                                    digest.update(buffer, 0, read)
                                    total += read
                                }
                            }
                            val hex = digest.digest().joinToString("") { "%02x".format(it) }
                            if (total != wantedEntry.bytes || hex != wantedEntry.sha256) {
                                outputFile.delete()
                                throw ArchiveMismatchException("sha256_mismatch:${wantedEntry.name}")
                            }
                            remaining.remove(name)
                            extracted.add(name)
                        }
                        entry = tarIn.nextEntry
                    }
                }
            }
        }
        return extracted
    }
}
