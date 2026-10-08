package xyz.tinycloud.exo.stt

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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
 * the next time `downloadNow` runs.
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
        val files = ModelManifest.DOWNLOADABLE[modelId]
        if (files == null) {
            onFinished(modelId, Result.failure(IllegalArgumentException("unsupported_model")))
            return
        }
        cancelled.set(false)
        store.setState(modelId, ModelState.QUEUED)
        executor.execute { runDownload(modelId, files, onProgress, onFinished) }
    }

    fun cancel() {
        cancelled.set(true)
        state = DownloadPolicyState.IDLE
    }

    private fun runDownload(modelId: String, files: List<ModelFile>, onProgress: (String, Long, Long) -> Unit,
                            onFinished: (String, Result<Unit>) -> Unit) {
        val total = files.sumOf { it.bytes }
        var done = 0L
        for (file in files) {
            while (!wifiAvailable() && !cancelled.get()) {
                state = DownloadPolicyState.WAITING_FOR_NETWORK
                Thread.sleep(2000)
            }
            if (cancelled.get()) { store.setState(modelId, ModelState.ABSENT, bytes = 0L); onFinished(modelId, Result.failure(InterruptedException())); return }
            state = DownloadPolicyState.RUNNING
            store.setState(modelId, ModelState.DOWNLOADING, bytes = done)
            try {
                downloadOneFile(modelId, file, done, total, onProgress)
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

    private fun downloadOneFile(modelId: String, file: ModelFile, doneBefore: Long, total: Long, onProgress: (String, Long, Long) -> Unit) {
        val staged = File(store.modelDir(modelId).apply { mkdirs() }, "${file.name}.download")
        val connection = (URL(file.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 30_000
            instanceFollowRedirects = true
        }
        val digest = MessageDigest.getInstance("SHA-256")
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
                        digest.update(buffer, 0, read)
                        written += read
                        onProgress(modelId, doneBefore + written, total)
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        if (hex != file.sha256 || written != file.bytes) {
            staged.delete()
            throw IllegalStateException("sha256_mismatch")
        }
        store.publish(modelId, file, staged)
    }
}
