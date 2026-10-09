package xyz.tinycloud.exo.stt

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import xyz.tinycloud.exo.stt.core.ArchiveEntry
import xyz.tinycloud.exo.stt.core.ArchiveExtractor
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

enum class DownloadPolicyState { IDLE, RUNNING, WAITING_FOR_NETWORK, FAILED;
    fun wire(): String = when (this) {
        WAITING_FOR_NETWORK -> "waiting_for_network"
        else -> name.lowercase()
    }
}

/**
 * Downloads the models this build supports (plan §2.9), Wi-Fi only: the slice uses a plain
 * `HttpURLConnection` on a background thread rather than `DownloadManager` (T17 adds that), so a
 * download pauses -- never silently fails -- while the app is backgrounded or killed, and resumes
 * the next time `downloadNow` runs. The small pack's `.tar.bz2` release asset is downloaded and
 * sha256-verified whole, then extracted (Apache Commons Compress) and each file verified again.
 */
class ModelDownloads(private val context: Context, val store: ModelStore) {
    companion object {
        @Volatile private var instance: ModelDownloads? = null
        fun get(context: Context): ModelDownloads = instance ?: synchronized(this) {
            instance ?: ModelDownloads(context.applicationContext, ModelStore.get(context)).also { instance = it }
        }
        fun sharedStore(context: Context): ModelStore = ModelStore.get(context)
    }

    @Volatile private var state = DownloadPolicyState.IDLE
    private val cancelled = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "exo-stt-download").apply { isDaemon = true } }

    fun downloadState(): DownloadPolicyState = state

    private fun wifiAvailable(): Boolean {
        val manager = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    fun start(modelId: String, onProgress: (String, Long, Long) -> Unit, onFinished: (String, Result<Unit>) -> Unit) {
        val archive = ModelManifest.ARCHIVES[modelId]
        val files = ModelManifest.DOWNLOADABLE[modelId]
        if (archive == null && files == null) {
            onFinished(modelId, Result.failure(IllegalArgumentException("unsupported_model")))
            return
        }
        cancelled.set(false)
        store.setState(modelId, ModelState.QUEUED)
        executor.execute {
            if (archive != null) runArchiveDownload(modelId, archive, onProgress, onFinished)
            else runDownload(modelId, files!!, onProgress, onFinished)
        }
    }

    fun cancel() {
        cancelled.set(true)
        state = DownloadPolicyState.IDLE
    }

    private fun awaitWifi(modelId: String): Boolean {
        while (!wifiAvailable() && !cancelled.get()) {
            state = DownloadPolicyState.WAITING_FOR_NETWORK
            Thread.sleep(2000)
        }
        if (cancelled.get()) {
            store.setState(modelId, ModelState.ABSENT, bytes = 0L)
            return false
        }
        state = DownloadPolicyState.RUNNING
        return true
    }

    private fun runDownload(modelId: String, files: List<ModelFile>, onProgress: (String, Long, Long) -> Unit,
                            onFinished: (String, Result<Unit>) -> Unit) {
        val total = files.sumOf { it.bytes }
        var done = 0L
        for (file in files) {
            if (!awaitWifi(modelId)) { onFinished(modelId, Result.failure(InterruptedException())); return }
            store.setState(modelId, ModelState.DOWNLOADING, bytes = done)
            try {
                val staged = File(store.modelDir(modelId).apply { mkdirs() }, "${file.name}.download")
                downloadToFile(file.url, staged) { written -> onProgress(modelId, done + written, total) }
                verifyAndPublish(modelId, file, staged)
            } catch (error: Exception) {
                state = DownloadPolicyState.FAILED
                store.setState(modelId, ModelState.FAILED, error = error.message ?: "download_failed")
                onFinished(modelId, Result.failure(error))
                return
            }
            done += file.bytes
            store.setState(modelId, ModelState.DOWNLOADING, bytes = done)
        }
        store.rescan()
        state = DownloadPolicyState.IDLE
        onFinished(modelId, if (store.isReady(modelId)) Result.success(Unit) else Result.failure(IllegalStateException("verification_failed")))
    }

    private fun runArchiveDownload(modelId: String, archive: ModelArchive, onProgress: (String, Long, Long) -> Unit,
                                   onFinished: (String, Result<Unit>) -> Unit) {
        if (!awaitWifi(modelId)) { onFinished(modelId, Result.failure(InterruptedException())); return }
        store.setState(modelId, ModelState.DOWNLOADING, bytes = 0L)
        val dir = store.modelDir(modelId).apply { mkdirs() }
        val stagedArchive = File(dir, "archive.tar.bz2.download")
        try {
            downloadToFile(archive.url, stagedArchive) { written -> onProgress(modelId, written, archive.bytes) }
            val archiveDigest = sha256(stagedArchive)
            check(stagedArchive.length() == archive.bytes && archiveDigest == archive.sha256) { "sha256_mismatch:archive" }
            store.setState(modelId, ModelState.VERIFYING, bytes = archive.bytes)
            extractArchive(modelId, stagedArchive, archive.entries)
        } catch (error: Exception) {
            state = DownloadPolicyState.FAILED
            store.setState(modelId, ModelState.FAILED, error = error.message ?: "download_failed")
            onFinished(modelId, Result.failure(error))
            return
        } finally {
            stagedArchive.delete()
        }
        store.rescan()
        state = DownloadPolicyState.IDLE
        onFinished(modelId, if (store.isReady(modelId)) Result.success(Unit) else Result.failure(IllegalStateException("verification_failed")))
    }

    /** Extracts every wanted entry out of the tar.bz2 (`ArchiveExtractor`, unit-tested on the
     * JVM), then publishes each one into the model directory once its own sha256 matches. */
    private fun extractArchive(modelId: String, archiveFile: File, wanted: Map<String, ModelFile>) {
        val entries = wanted.mapValues { (_, file) -> ArchiveEntry(file.name, file.sha256, file.bytes) }
        val dir = store.modelDir(modelId)
        val extracted = ArchiveExtractor.extract(archiveFile, entries) { name -> File(dir, "${wanted.getValue(name).name}.download") }
        check(extracted.size == wanted.size) { "archive_entries_missing:${(wanted.keys - extracted).joinToString(",")}" }
        for (file in wanted.values) store.publish(modelId, file, File(dir, "${file.name}.download"))
    }

    private fun downloadToFile(url: String, staged: File, onProgress: (Long) -> Unit) {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 30_000
            instanceFollowRedirects = true
        }
        var written = 0L
        try {
            connection.connect()
            check(connection.responseCode in 200..299) { "http_${connection.responseCode}" }
            connection.inputStream.use { input ->
                FileOutputStream(staged).use { output ->
                    val buffer = ByteArray(1 shl 16)
                    while (true) {
                        if (cancelled.get()) throw InterruptedException()
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        written += read
                        onProgress(written)
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 16)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun verifyAndPublish(modelId: String, file: ModelFile, staged: File) {
        val hex = sha256(staged)
        if (hex != file.sha256 || staged.length() != file.bytes) {
            staged.delete()
            throw IllegalStateException("sha256_mismatch:${file.name}")
        }
        store.publish(modelId, file, staged)
    }
}
