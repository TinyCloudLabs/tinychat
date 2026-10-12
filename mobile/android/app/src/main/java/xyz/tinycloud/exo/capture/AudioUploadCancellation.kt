package xyz.tinycloud.exo.capture

/** Remembers cancellation that arrives while the upload call is still being set up. */
internal class AudioUploadCancellation {
    private val cancelled = mutableSetOf<String>()

    @Synchronized fun cancel(uploadId: String) { cancelled.add(uploadId) }
    @Synchronized fun consume(uploadId: String): Boolean = cancelled.remove(uploadId)
    @Synchronized fun clear(uploadId: String) { cancelled.remove(uploadId) }
}
