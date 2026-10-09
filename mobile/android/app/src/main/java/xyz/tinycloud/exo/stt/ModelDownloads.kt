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

/** Wi-Fi dropped mid-transfer: retryable (pause for "Waiting for Wi-Fi", then start the file over),
 * unlike every other failure here, which is terminal. Resuming from a byte offset is T13/T17. */
private class WifiLostDuringTransferException : Exception()

private const val WIFI_CHECK_INTERVAL_MS = 2_000L

/**
 * Downloads the models this build supports (plan §2.9), Wi-Fi only: the slice uses a plain
 * `HttpURLConnection` on a background thread rather than `DownloadManager` (T17 adds that), so a
 * download pauses -- never silently fails -- while the app is backgrounded or killed, and resumes
 * the next time `downloadNow` runs. The small pack's `.tar.bz2` release asset is downloaded and
 * sha256-verified whole, then extracted (Apache Commons Compress) and each file verified again.
 * The Wi-Fi gate is enforced for the whole transfer, not just before it starts: a drop mid-transfer
 * pauses to `WAITING_FOR_NETWORK` ("Waiting for Wi-Fi") and retries the current file from scratch
 * once Wi-Fi returns, rather than failing the download outright. Resuming from a byte offset instead
 * of restarting the file is deferred (T13/T17).
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
            // Wi-Fi dropping mid-transfer retries the whole file (no byte-range resume: T13/T17)
            // instead of failing the download outright; anything else is terminal.
            while (true) {
                try {
                    val staged = File(store.modelDir(modelId).apply { mkdirs() }, "${file.name}.download")
                    downloadToFile(file.url, staged) { written -> onProgress(modelId, done + written, total) }
                    verifyAndPublish(modelId, file, staged)
                    break
                } catch (wifiLost: WifiLostDuringTransferException) {
                    if (!awaitWifi(modelId)) { onFinished(modelId, Result.failure(InterruptedException())); return }
                    store.setState(modelId, ModelState.DOWNLOADING, bytes = done)
                } catch (error: Exception) {
                    state = DownloadPolicyState.FAILED
                    store.setState(modelId, ModelState.FAILED, error = error.message ?: "download_failed")
                    onFinished(modelId, Result.failure(error))
                    return
                }
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
        // Wi-Fi dropping mid-transfer retries the whole archive (no byte-range resume: T13/T17)
        // instead of failing the download outright; anything else is terminal.
        while (true) {
            try {
                downloadToFile(archive.url, stagedArchive) { written -> onProgress(modelId, written, archive.bytes) }
                val archiveDigest = sha256(stagedArchive)
                check(stagedArchive.length() == archive.bytes && archiveDigest == archive.sha256) { "sha256_mismatch:archive" }
                store.setState(modelId, ModelState.VERIFYING, bytes = archive.bytes)
                extractArchive(modelId, stagedArchive, archive.entries)
                break
            } catch (wifiLost: WifiLostDuringTransferException) {
                stagedArchive.delete()
                if (!awaitWifi(modelId)) { onFinished(modelId, Result.failure(InterruptedException())); return }
                store.setState(modelId, ModelState.DOWNLOADING, bytes = 0L)
            } catch (error: Exception) {
                stagedArchive.delete()
                state = DownloadPolicyState.FAILED
                store.setState(modelId, ModelState.FAILED, error = error.message ?: "download_failed")
                onFinished(modelId, Result.failure(error))
                return
            }
        }
        stagedArchive.delete()
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
            try {
                connection.inputStream.use { input ->
                    FileOutputStream(staged).use { output ->
                        val buffer = ByteArray(1 shl 16)
                        var lastWifiCheck = System.currentTimeMillis()
                        while (true) {
                            if (cancelled.get()) throw InterruptedException()
                            val now = System.currentTimeMillis()
                            if (now - lastWifiCheck >= WIFI_CHECK_INTERVAL_MS) {
                                if (!wifiAvailable()) throw WifiLostDuringTransferException()
                                lastWifiCheck = now
                            }
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            written += read
                            onProgress(written)
                        }
                    }
                }
            } catch (io: java.io.IOException) {
                // The periodic check above catches Wi-Fi dropping between reads; this catches the
                // connection dying from a drop that happened mid-read, before the next check fired.
                if (!wifiAvailable()) throw WifiLostDuringTransferException() else throw io
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
