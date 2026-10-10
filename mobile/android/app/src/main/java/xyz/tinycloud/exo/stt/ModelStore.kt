package xyz.tinycloud.exo.stt

import android.content.Context
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

enum class ModelState { ABSENT, QUEUED, DOWNLOADING, VERIFYING, READY, FAILED;
    fun wire(): String = name.lowercase()
}

/**
 * On-disk state for the downloadable models (plan §2.9), under `files/models/` (not backed up:
 * Android only auto-backs up what the app explicitly includes, and this app does not list it).
 * One model = one subdirectory; a model is `READY` only once every one of its files exists and
 * matches its pinned sha256.
 */
class ModelStore(val root: File) {
    companion object {
        @Volatile private var instance: ModelStore? = null
        fun get(context: Context): ModelStore = instance ?: synchronized(this) {
            instance ?: ModelStore(File(context.applicationContext.filesDir, "models")).also { instance = it }
        }
    }

    private val lock = ReentrantLock()
    private val states = HashMap<String, ModelState>().apply { ModelManifest.ALL_IDS.forEach { put(it, ModelState.ABSENT) } }
    private val bytesDone = HashMap<String, Long>().apply { ModelManifest.ALL_IDS.forEach { put(it, 0L) } }
    private val errors = HashMap<String, String?>()

    init {
        root.mkdirs()
        rescan()
    }

    fun modelDir(id: String) = File(root, id)
    fun fileFor(id: String, file: ModelFile) = File(modelDir(id), file.name)

    /** Re-derives each downloadable model's state from what is actually on disk (sha256-verified),
     * so a relaunch never trusts stale in-memory state. */
    fun rescan() = lock.withLock {
        for (id in ModelManifest.ALL_IDS) {
            val files = ModelManifest.filesFor(id) ?: continue
            val allPresent = files.all { fileFor(id, it).let { f -> f.isFile && f.length() == it.bytes } }
            if (allPresent && files.all { verify(fileFor(id, it), it.sha256) }) {
                states[id] = ModelState.READY
                bytesDone[id] = files.sumOf { it.bytes }
                errors[id] = null
            } else if (states[id] != ModelState.DOWNLOADING && states[id] != ModelState.QUEUED && states[id] != ModelState.VERIFYING) {
                states[id] = ModelState.ABSENT
                bytesDone[id] = 0L
            }
        }
    }

    private fun verify(file: File, sha256: String): Boolean {
        if (!file.isFile) return false
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) } == sha256
    }

    fun status(id: String): Triple<ModelState, Long, String?> = lock.withLock {
        Triple(states[id] ?: ModelState.ABSENT, bytesDone[id] ?: 0L, errors[id])
    }

    fun isReady(id: String): Boolean = lock.withLock { states[id] == ModelState.READY }

    fun setState(id: String, state: ModelState, bytes: Long? = null, error: String? = null) = lock.withLock {
        states[id] = state
        if (bytes != null) bytesDone[id] = bytes
        errors[id] = error
    }

    /** Moves a verified download into place, replacing any previous copy. */
    fun publish(id: String, file: ModelFile, staged: File) {
        val dir = modelDir(id)
        dir.mkdirs()
        val final = fileFor(id, file)
        if (final.exists()) final.delete()
        if (!staged.renameTo(final)) throw java.io.IOException("Cannot move $staged to $final")
    }

    fun delete(id: String) {
        modelDir(id).deleteRecursively()
        setState(id, ModelState.ABSENT, bytes = 0L, error = null)
    }
}
