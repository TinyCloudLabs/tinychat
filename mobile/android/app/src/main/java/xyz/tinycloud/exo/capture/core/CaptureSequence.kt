package xyz.tinycloud.exo.capture.core

import org.json.JSONObject

/** Durable journal order for the native recorder. Input and encoder lifetimes stay with the platform layer. */
class CaptureSequence(
    private val library: RecordingLibrary,
    val id: String,
    private val clock: () -> Long = System::currentTimeMillis
) {
    var frames = 0L
        private set
    var segment = 0
        private set
    var segmentFrames = 0L
        private set
    @Volatile var durableAudioMs = 0L
        private set
    var segmentOpen = false
        private set
    private var lastHeartbeatAt = 0L
    private var closing = false

    val audioMs: Long get() = frames * 1024L * 1000 / SAMPLE_RATE

    fun start(source: String, owner: String?, transitionGen: Long, options: JSONObject, maxMs: Long,
              at: Long = clock()) {
        library.start(id, source, owner, transitionGen, options, maxMs, at)
    }

    fun firstInput(gen: Long) {
        val at = clock()
        library.openFirstSegment(id, 0, gen, at)
        segmentOpen = true
        lastHeartbeatAt = at
    }

    fun frame(adts: ByteArray) {
        check(segmentOpen) { "no_open_segment" }
        library.append(id, segment, adts)
        frames++
        segmentFrames++
        if (closing) return
        val at = clock()
        if (segmentFrames * 1024L / SAMPLE_RATE >= 60) {
            closeSegment(at)
            openNextSegment(at)
        } else if (at - lastHeartbeatAt >= 2000) {
            library.checkpoint(id, segment, audioMs, "recording", "available", at = at)
            durableAudioMs = audioMs
            lastHeartbeatAt = at
        }
    }

    fun closeSegment(at: Long = clock()) {
        if (!segmentOpen) return
        library.checkpoint(id, segment, audioMs, "recording", "available", close = true, at = at)
        durableAudioMs = audioMs
        segmentOpen = false
        closing = false
    }

    fun beginClose() { closing = true }
    fun cancelClose() { closing = false }

    fun pause(at: Long = clock()) {
        closeSegment(at)
        library.transition(id, "intent", audioMs, JSONObject().put("value", "paused").put("by", "user"), at)
    }

    fun resumeIntent(at: Long = clock()) {
        library.transition(id, "intent", audioMs, JSONObject().put("value", "recording").put("by", "user"), at)
    }

    fun resumeAcquired(gen: Long, at: Long = clock()) {
        library.transition(id, "avail", audioMs, JSONObject().put("value", "available")
            .put("reason", JSONObject.NULL).put("gen", gen), at)
        openNextSegment(at)
    }

    fun resumeFailed(gen: Long, at: Long = clock()) {
        library.transition(id, "avail", audioMs, JSONObject().put("value", "blocked")
            .put("reason", "resume_blocked").put("gen", gen), at)
    }

    fun interrupt(reason: String, availabilityReason: String, gen: Long, at: Long = clock()) {
        closeSegment(at)
        library.transition(id, "span_open", audioMs, JSONObject().put("kind", "omitted")
            .put("reason", reason), at)
        library.transition(id, "avail", audioMs, JSONObject().put("value", "interrupted")
            .put("reason", availabilityReason).put("gen", gen), at)
    }

    fun restartAfterInterruption(reason: String, gen: Long, at: Long = clock()) {
        library.transition(id, "span_close", audioMs, JSONObject().put("kind", "omitted")
            .put("reason", reason), at)
        resumeAcquired(gen, at)
    }

    fun stop(reason: String, at: Long = clock()) {
        closeSegment(at)
        library.stopJournal(id, audioMs, reason, at)
    }

    fun transition(name: String, extra: JSONObject, at: Long = clock()) {
        if (segmentOpen) {
            library.syncAudio(id, segment)
            durableAudioMs = audioMs
        }
        library.transition(id, name, durableAudioMs, extra, at)
    }

    private fun openNextSegment(at: Long) {
        segment++
        segmentFrames = 0
        library.roll(id, segment, audioMs, at)
        segmentOpen = true
        closing = false
        lastHeartbeatAt = at
    }
}
