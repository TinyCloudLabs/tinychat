package xyz.tinycloud.exo.capture.core

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.util.concurrent.ConcurrentHashMap

/** All durable filesystem operations go through this seam so crash tests can fail each boundary. */
open class FileOps {
    private val failures = ConcurrentHashMap<String, Int>()
    fun failOnce(name: String) { failures[name] = 1 }
    protected fun check(name: String) {
        if (failures.remove(name) != null) throw IOException("failpoint: $name")
    }
    open fun mkdir(dir: File, point: String) {
        check(point)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("Could not create $dir")
    }
    open fun write(file: File, bytes: ByteArray, append: Boolean, point: String, metadata: Boolean = true) {
        check(point)
        FileOutputStream(file, append).use { output ->
            output.write(bytes)
            if (point != "seg.write") output.channel.force(metadata)
        }
    }
    open fun sync(file: File, metadata: Boolean, point: String) {
        check(point)
        FileOutputStream(file, true).use { it.channel.force(metadata) }
    }
    open fun syncDir(dir: File) {
        FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
    }
    open fun rename(source: File, target: File, point: String) {
        check(point)
        if (!source.renameTo(target)) throw IOException("Could not rename $source to $target")
        syncDir(target.parentFile ?: throw IOException("No parent directory for $target"))
    }
    open fun unlink(file: File, point: String) {
        check(point)
        if (file.exists() && !file.delete()) throw IOException("Could not delete $file")
    }
    open fun rmdir(dir: File, point: String) {
        check(point)
        if (dir.exists() && !dir.delete()) throw IOException("Could not remove $dir")
    }
}
