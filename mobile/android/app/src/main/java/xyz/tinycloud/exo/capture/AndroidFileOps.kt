package xyz.tinycloud.exo.capture

import android.system.Os
import android.system.OsConstants
import xyz.tinycloud.exo.capture.core.FileOps
import java.io.File
import java.io.IOException

/** API 24 compatible directory fsync; java.nio.file isn't available at the API floor. */
class AndroidFileOps : FileOps() {
    override fun syncDir(dir: File) {
        val fd = try { Os.open(dir.absolutePath, OsConstants.O_RDONLY, 0) }
        catch (e: Exception) { throw IOException("Could not open directory $dir", e) }
        try { Os.fsync(fd) } catch (e: Exception) { throw IOException("Could not sync directory $dir", e) }
        finally { Os.close(fd) }
    }
}
