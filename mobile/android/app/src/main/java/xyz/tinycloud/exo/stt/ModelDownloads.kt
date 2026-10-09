package xyz.tinycloud.exo.stt

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import xyz.tinycloud.exo.stt.core.ArchiveEntry
import xyz.tinycloud.exo.stt.core.ArchiveExtractor
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

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
 * Binds a whole download session to one specific Wi-Fi network (round-2 finding 4), rather than
 * trusting the device's current default network: `request()` asks for a validated Wi-Fi network
 * and every connection in the session opens on the one it gets back, via `Network.openConnection`.
 * If Android drops that exact network -- Wi-Fi turning off, the OS handing the device to cellular
 * -- [network] goes back to null the instant `onLost` fires, so the next periodic check in the
 * read loop (or the next `connect()`) sees it and pauses to "Waiting for Wi-Fi" instead of letting
 * the transfer continue, unnoticed, on cellular.
 */
private class WifiNetworkBinding(context: Context) {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val current = AtomicReference<Network?>(null)
    private var callback: ConnectivityManager.NetworkCallback? = null

    /** (Re-)requests a validated Wi-Fi network; safe to call again after a loss. */
    fun request() {
        release()
        val manager = manager ?: return
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(net: Network) { current.set(net) }
            override fun onLost(net: Network) { current.compareAndSet(net, null) }
            override fun onUnavailable() { current.set(null) }
        }
        callback = cb
        manager.requestNetwork(request, cb)
    }

    fun network(): Network? = current.get()

    fun release() {
        val cb = callback ?: return
        callback = null
        current.set(null)
        try { manager?.unregisterNetworkCallback(cb) } catch (_: IllegalArgumentException) { /* already unregistered */ }
    }
}

/**
 * Downloads the models this build supports (plan §2.9), Wi-Fi only: the slice uses a plain
 * `HttpURLConnection` on a background thread rather than `DownloadManager` (T17 adds that), so a
 * download pauses -- never silently fails -- while the app is backgrounded or killed, and resumes
 * the next time `downloadNow` runs. The small pack's `.tar.bz2` release asset is downloaded and
 * sha256-verified whole, then extracted (Apache Commons Compress) and each file verified again.
 * The Wi-Fi gate is enforced for the whole transfer, not just before it starts, and bound to a
 * specific identified Wi-Fi network (`WifiNetworkBinding`) rather than the device's current
 * default network, so a switch to cellular mid-transfer can never carry the GET along with it: a
 * drop pauses to `WAITING_FOR_NETWORK` ("Waiting for Wi-Fi") and retries the current file from
 * scratch once Wi-Fi returns, rather than failing the download outright. Resuming from a byte
 * offset instead of restarting the file is deferred (T13/T17).
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
            val binding = WifiNetworkBinding(context)
            try {
                if (archive != null) runArchiveDownload(modelId, archive, binding, onProgress, onFinished)
                else runDownload(modelId, files!!, binding, onProgress, onFinished)
            } finally { binding.release() }
        }
    }

    fun cancel() {
        cancelled.set(true)
        state = DownloadPolicyState.IDLE
    }

    private fun awaitWifi(modelId: String, binding: WifiNetworkBinding): Boolean {
        binding.request()
        while (binding.network() == null && !cancelled.get()) {
            state = DownloadPolicyState.WAITING_FOR_NETWORK
            Thread.sleep(2000)
        }
        if (cancelled.get()) {
            binding.release()
            store.setState(modelId, ModelState.ABSENT, bytes = 0L)
            return false
        }
        state = DownloadPolicyState.RUNNING
        return true
    }

    private fun runDownload(modelId: String, files: List<ModelFile>, binding: WifiNetworkBinding,
                            onProgress: (String, Long, Long) -> Unit, onFinished: (String, Result<Unit>) -> Unit) {
        val total = files.sumOf { it.bytes }
        var done = 0L
        for (file in files) {
            if (!awaitWifi(modelId, binding)) { onFinished(modelId, Result.failure(InterruptedException())); return }
            store.setState(modelId, ModelState.DOWNLOADING, bytes = done)
            // Wi-Fi dropping mid-transfer retries the whole file (no byte-range resume: T13/T17)
            // instead of failing the download outright; anything else is terminal.
            while (true) {
                try {
                    val staged = File(store.modelDir(modelId).apply { mkdirs() }, "${file.name}.download")
                    downloadToFile(file.url, staged, binding) { written -> onProgress(modelId, done + written, total) }
                    verifyAndPublish(modelId, file, staged)
                    break
                } catch (wifiLost: WifiLostDuringTransferException) {
                    if (!awaitWifi(modelId, binding)) { onFinished(modelId, Result.failure(InterruptedException())); return }
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

    private fun runArchiveDownload(modelId: String, archive: ModelArchive, binding: WifiNetworkBinding,
                                   onProgress: (String, Long, Long) -> Unit, onFinished: (String, Result<Unit>) -> Unit) {
        if (!awaitWifi(modelId, binding)) { onFinished(modelId, Result.failure(InterruptedException())); return }
        store.setState(modelId, ModelState.DOWNLOADING, bytes = 0L)
        val dir = store.modelDir(modelId).apply { mkdirs() }
        val stagedArchive = File(dir, "archive.tar.bz2.download")
        // Wi-Fi dropping mid-transfer retries the whole archive (no byte-range resume: T13/T17)
        // instead of failing the download outright; anything else is terminal.
        while (true) {
            try {
                downloadToFile(archive.url, stagedArchive, binding) { written -> onProgress(modelId, written, archive.bytes) }
                val archiveDigest = sha256(stagedArchive)
                check(stagedArchive.length() == archive.bytes && archiveDigest == archive.sha256) { "sha256_mismatch:archive" }
                store.setState(modelId, ModelState.VERIFYING, bytes = archive.bytes)
                extractArchive(modelId, stagedArchive, archive.entries)
                break
            } catch (wifiLost: WifiLostDuringTransferException) {
                stagedArchive.delete()
                if (!awaitWifi(modelId, binding)) { onFinished(modelId, Result.failure(InterruptedException())); return }
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

    private fun downloadToFile(url: String, staged: File, binding: WifiNetworkBinding, onProgress: (Long) -> Unit) {
        // Opened on the identified Wi-Fi network itself (round-2 finding 4), not the device's
        // current default network: if that one network drops, this connection drops with it,
        // instead of the GET silently continuing on whatever the OS switches the default to.
        val network = binding.network() ?: throw WifiLostDuringTransferException()
        val connection = (network.openConnection(URL(url)) as HttpURLConnection).apply {
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
                                if (binding.network() == null) throw WifiLostDuringTransferException()
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
                if (binding.network() == null) throw WifiLostDuringTransferException() else throw io
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
