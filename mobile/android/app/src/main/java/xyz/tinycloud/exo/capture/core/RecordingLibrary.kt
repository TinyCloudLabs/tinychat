package xyz.tinycloud.exo.capture.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** The sidecar rename is the commit point. All mutations use one synchronous lock. */
class RecordingLibrary(val root: File, val ops: FileOps = FileOps()) {
    private val lock = ReentrantLock()
    private val recoveryLock = ReentrantLock()
    private val generation = HashMap<String, Int>()
    private val active = HashMap<String, Int>()
    // Sessions opened in this process still have a writer. Recovery must never
    // inspect or collect them, even when another broken session forces a retry.
    private val openSessions = HashSet<String>()
    private val gates = ConcurrentHashMap<String, () -> Unit>()
    val sessions = File(root, "sessions")
    val staging = File(root, "staging")
    val tombstones = File(root, "tombstones")
    val outbox = File(root, "outbox")
    val quarantine = File(root, "quarantine")

    init {
        for (dir in listOf(root, sessions, staging, tombstones, outbox, quarantine)) ops.mkdir(dir, "init.mkdir")
    }
    fun audio(id: String) = File(root, "$id.m4a")
    fun sidecar(id: String) = File(root, "$id.json")
    fun session(id: String) = File(sessions, id)
    fun tombstone(id: String) = File(tombstones, id)
    fun requireId(id: String) { require(id.isNoteId()) { "invalid_argument" } }
    fun gate(name: String, block: () -> Unit) { gates[name] = block }
    fun clearGate(name: String) { gates.remove(name) }
    private fun awaitGate(name: String) { gates[name]?.invoke() }
    private fun ensureAlive(id: String) { if (tombstone(id).exists()) throw IllegalStateException("tombstoned") }
    private fun jsonLine(value: JSONObject) = CanonicalJson.line(value)
    private fun event(name: String, audioMs: Long, extras: JSONObject = JSONObject(), at: Long = System.currentTimeMillis()) = extras.put("e", name)
        .put("t", at).put("a", audioMs)
    private fun journal(id: String) = File(session(id), "journal.jsonl")
    private fun appendJournal(id: String, event: JSONObject, point: String) = ops.write(journal(id), jsonLine(event), true, point)

    fun start(id: String, source: String, owner: String?, transitionGen: Long, options: JSONObject, maxMs: Long,
              at: Long = System.currentTimeMillis()) = lock.withLock {
        requireId(id); ensureAlive(id)
        val dir = session(id)
        ops.mkdir(dir, "start.mkdir"); ops.syncDir(sessions)
        val first = event("session", 0, JSONObject().put("v", 1).put("id", id).put("platform", "android")
            .put("codec", "aac-lc").put("container", "adts").put("rate", SAMPLE_RATE).put("channels", 1)
            .put("bitrate", BITRATE).put("maxDurationMs", maxMs).put("source", source)
            .put("owner", owner ?: JSONObject.NULL).put("transitionGen", transitionGen).put("options", options))
        first.put("t", at)
        ops.write(journal(id), jsonLine(first), false, "start.journal"); ops.syncDir(dir)
        openSessions.add(id)
    }
    fun closeSession(id: String) = lock.withLock { openSessions.remove(id) }
    fun adoptSession(id: String) = lock.withLock { requireId(id); openSessions.add(id) }
    /** Adoption uses the same durable attempt budget as mux recovery. */
    fun beginParkedAdoption(id: String): Boolean = lock.withLock {
        requireId(id)
        if (quarantineIfExhausted(id)) return@withLock false
        beginRecoveryAttempt(id)
        true
    }
    fun completeParkedAdoption(id: String) = adoptSession(id)
    fun acknowledgeParkedAdoption(id: String) = clearRecoveryFailure(id)
    fun failParkedAdoption(id: String, error: Exception) = lock.withLock {
        closeSession(id)
        recordRecoveryFailure(id, error)
    }
    fun prepareRetryRecovery(id: String) = lock.withLock {
        requireId(id)
        val parked = File(quarantine, "$id.session")
        if (parked.isDirectory) {
            if (session(id).exists()) throw IllegalStateException("recovery_conflict")
            ops.rename(parked, session(id), "recovery.retry")
        }
        if (!session(id).isDirectory) throw IllegalStateException("not_found")
        val marker = recoveryMarker(id)
        if (marker.isFile) {
            val item = JSONObject(marker.readText()).put("retryAuthorized", true)
            saveRecoveryMarker(id, item, "recovery.retry")
        }
    }
    fun discardFailedRecording(id: String) = lock.withLock {
        requireId(id)
        if (id in openSessions || sidecar(id).exists()) throw IllegalStateException("recording_in_progress")
        if (!recoveryMarker(id).isFile) throw IllegalStateException(
            if (session(id).exists() || File(quarantine, "$id.session").exists()) "not_failed_recording" else "not_found")
        val dirs = listOf(session(id), File(quarantine, "$id.session"))
        if (dirs.none { it.exists() } && !File(quarantine, "$id.failure.json").exists())
            throw IllegalStateException("not_found")
        ops.write(tombstone(id), byteArrayOf(), false, "recovery.discard")
        ops.syncDir(tombstones)
        for (dir in dirs) {
            dir.listFiles()?.forEach { ops.unlink(it, "recovery.discard") }
            ops.rmdir(dir, "recovery.discard")
        }
        gcArtifacts(id)
        File(quarantine, "$id.failure.json").takeIf { it.exists() }?.let { ops.unlink(it, "recovery.discard") }
        ops.syncDir(sessions); ops.syncDir(quarantine)
        retire(id)
    }
    fun failedRecoveryItems(): JSONArray = lock.withLock {
        JSONArray().also { result ->
            for (file in quarantine.listFiles().orEmpty().filter { it.name.endsWith(".failure.json") }) {
                val item = try { JSONObject(file.readText()) } catch (_: Exception) { continue }
                result.put(item)
            }
        }
    }
    private fun recoveryMarker(id: String) = File(quarantine, "$id.failure.json")
    private fun saveRecoveryMarker(id: String, item: JSONObject, point: String) {
        val tmp = File(quarantine, "$id.failure.json.tmp")
        ops.write(tmp, jsonLine(item), false, point)
        ops.rename(tmp, recoveryMarker(id), point)
    }
    /** This write precedes journal parsing, ADTS scanning and muxing, so a process crash counts. */
    internal fun beginRecoveryAttempt(id: String) = lock.withLock {
        requireId(id)
        val marker = recoveryMarker(id)
        val item = marker.takeIf { it.isFile }?.let { JSONObject(it.readText()) } ?: JSONObject()
        item.put("id", id).put("attempts", item.optInt("attempts") + 1)
            .put("inFlight", true).put("retryAuthorized", false)
            .put("sizeBytes", session(id).listFiles().orEmpty().sumOf { it.length() })
            .put("reason", item.optString("reason", "recovery_incomplete"))
        saveRecoveryMarker(id, item, "recovery.attempt")
    }
    private fun quarantineIfExhausted(id: String): Boolean = lock.withLock {
        val marker = recoveryMarker(id)
        if (!marker.isFile) return@withLock false
        val item = JSONObject(marker.readText())
        if (item.optInt("attempts") < 3 || item.optBoolean("retryAuthorized")) return@withLock false
        val dir = session(id)
        if (dir.isDirectory) {
            ops.rename(dir, File(quarantine, "$id.session"), "recovery.quarantine")
            ops.syncDir(sessions)
        }
        true
    }
    private fun recordRecoveryFailure(id: String, error: Exception) = lock.withLock {
        val marker = recoveryMarker(id)
        val item = marker.takeIf { it.isFile }?.let { JSONObject(it.readText()) } ?: JSONObject().put("id", id)
        item.put("reason", error.message ?: "recovery_failed").put("inFlight", false)
        saveRecoveryMarker(id, item, "recovery.failure")
        if (item.optInt("attempts") >= 3 && session(id).isDirectory) {
            ops.rename(session(id), File(quarantine, "$id.session"), "recovery.quarantine")
            ops.syncDir(sessions)
        }
    }
    fun openFirstSegment(id: String, audioMs: Long, gen: Long, at: Long = System.currentTimeMillis()) = lock.withLock {
        appendJournal(id, event("avail", audioMs, JSONObject().put("value", "available")
            .put("reason", JSONObject.NULL).put("gen", gen), at), "start.avail")
        appendJournal(id, event("input", audioMs, JSONObject().put("id", "built-in")
            .put("name", "Built-in microphone").put("kind", "built_in"), at), "start.input")
        val dir = session(id)
        val segment = File(dir, "seg-00000.aac")
        ops.write(segment, byteArrayOf(), false, "roll.create"); ops.syncDir(dir)
        appendJournal(id, event("segment", audioMs, JSONObject().put("index", 0).put("file", segment.name), at), "start.segment")
    }
    fun append(id: String, index: Int, frame: ByteArray) = lock.withLock {
        ensureAlive(id)
        ops.write(File(session(id), "seg-%05d.aac".format(index)), frame, true, "seg.write", false)
    }
    fun syncAudio(id: String, index: Int) = lock.withLock {
        ops.sync(File(session(id), "seg-%05d.aac".format(index)), false, "seg.sync")
    }
    fun checkpoint(id: String, index: Int, audioMs: Long, intent: String, availability: String,
                   close: Boolean = false, at: Long = System.currentTimeMillis()) = lock.withLock {
        val segment = File(session(id), "seg-%05d.aac".format(index))
        ops.sync(segment, close, "seg.sync")
        appendJournal(id, event("hb", audioMs, JSONObject().put("seg", index).put("segBytes", scanAdts(segment).bytes)
            .put("intent", intent).put("availability", availability), at), "seg.heartbeat")
    }
    fun transition(id: String, name: String, audioMs: Long, extra: JSONObject, at: Long = System.currentTimeMillis()) = lock.withLock {
        appendJournal(id, event(name, audioMs, extra, at), "transition.$name")
    }
    fun roll(id: String, index: Int, audioMs: Long, at: Long = System.currentTimeMillis()) = lock.withLock {
        val dir = session(id)
        ops.sync(File(dir, "seg-%05d.aac".format(index - 1)), true, "roll.sync")
        val next = File(dir, "seg-%05d.aac".format(index))
        ops.write(next, byteArrayOf(), false, "roll.create"); ops.syncDir(dir)
        appendJournal(id, event("segment", audioMs, JSONObject().put("index", index).put("file", next.name), at), "roll.journal")
    }
    fun stopJournal(id: String, audioMs: Long, reason: String, at: Long = System.currentTimeMillis()) = lock.withLock {
        val by = when (reason) { "max_duration" -> "limit"; "disk_full" -> "disk";
            "permission_revoked" -> "write_failed"; else -> reason }
        appendJournal(id, event("intent", audioMs, JSONObject().put("value", "stopped").put("by", by), at), "stop.intent")
        appendJournal(id, event("stop", audioMs, JSONObject().put("reason", reason), at), "stop.journal")
    }
    fun events(id: String): List<JSONObject> {
        val file = journal(id).takeIf { it.isFile } ?: return emptyList()
        val bytes = file.readBytes()
        val complete = bytes.lastIndexOf('\n'.code.toByte())
        if (complete < 0) return emptyList() // a torn final record is ignored
        return String(bytes, 0, complete + 1, Charsets.UTF_8).split('\n').dropLast(1).map { JSONObject(it) }
    }
    fun parkedSessions(): List<Pair<String, List<JSONObject>>> = lock.withLock {
        sessions.listFiles().orEmpty().filter { it.isDirectory && it.name.isNoteId() }
            .mapNotNull { dir ->
                if (dir.name in openSessions || tombstone(dir.name).exists() || sidecar(dir.name).exists()) return@mapNotNull null
                val history = try { events(dir.name) } catch (_: Exception) { return@mapNotNull null }
                if (dir.listFiles().orEmpty().none { it.name.endsWith(".aac") && it.length() > 0L })
                    return@mapNotNull null
                if (history.any { it.optString("e") == "stop" } ||
                    history.lastOrNull { it.optString("e") == "intent" }?.optString("value") != "paused") null
                else dir.name to history
            }
    }
    private fun begin(id: String): Int = lock.withLock {
        ensureAlive(id)
        active[id] = (active[id] ?: 0) + 1
        generation[id] ?: 0
    }
    private fun end(id: String) = lock.withLock { active[id] = (active[id] ?: 1) - 1 }

    /** Staging may block on MediaMuxer. The publish transaction rechecks deletion and generation. */
    fun commit(id: String, mux: (File) -> Unit, recovered: Boolean = false, exitReason: String? = null,
               metrics: JSONObject = JSONObject()): JSONObject = recoveryLock.withLock {
        requireId(id)
        if (!recovered) closeSession(id) // Input was stopped before a normal commit.
        val opGen = begin(id)
        val staged = File(staging, "$id.$opGen.m4a")
        try {
            awaitGate("stage.begin")
            mux(staged)
            awaitGate("stage.afterMux")
            ops.sync(staged, true, "stage.write")
            val history = events(id)
            val first = history.firstOrNull { it.optString("e") == "session" } ?: throw IOException("Missing session")
            val last = history.lastOrNull()
            val frameCount = session(id).listFiles { f -> f.name.matches(Regex("seg-\\d{5}\\.aac")) }
                .orEmpty().sumOf { scanAdts(it).frames }
            val audioMs = frameCount * 1024L * 1000 / SAMPLE_RATE
            val startedAt = first.getLong("t")
            val pausedMs = pausedDuration(history)
            val owner = history.lastOrNull { it.optString("e") == "owner" }?.optString("did")
                ?: first.optString("owner").takeUnless { it == "null" || it.isEmpty() }
            val optionEvent = history.lastOrNull { it.optString("e") == "options" } ?: first.optJSONObject("options") ?: defaultOptions()
            val finalOptions = JSONObject().put("transcriber", optionEvent.optString("transcriber", "on-device"))
                .put("identifySpeakers", optionEvent.optBoolean("identifySpeakers"))
            val inputEvent = history.lastOrNull { it.optString("e") == "input" }
            val inputValue = inputEvent?.let { JSONObject().put("id", it.getString("id"))
                .put("name", it.getString("name")).put("kind", it.getString("kind")) } ?: JSONObject.NULL
            val result = JSONObject().put("id", id).put("startedAt", startedAt).put("durationMs", audioMs)
                .put("firstAudioAt", history.firstOrNull { it.optString("e") == "first_audio" }?.optLong("t") ?: JSONObject.NULL)
                .put("captureStoppedAt", history.lastOrNull { it.optString("e") == "capture_stopped" }?.optLong("t") ?: JSONObject.NULL)
                .put("mimeType", "audio/mp4").put("sizeBytes", staged.length())
                .put("silencedMs", metrics.optLong("silencedMs"))
                .put("silencedEvents", metrics.optInt("silencedEvents"))
                .put("noSignalMs", metrics.optLong("noSignalMs")).put("version", 2).put("rev", 1)
                .put("wallMs", (last?.optLong("t") ?: System.currentTimeMillis()) - startedAt)
                .put("pausedMs", pausedMs).put("spans", spans(history))
                .put("recovered", recovered).put("endedUnexpectedly", history.none { it.optString("e") == "stop" })
                .put("lastHeartbeatAt", history.lastOrNull { it.optString("e") == "hb" }?.optLong("t") ?: JSONObject.NULL)
                .put("exitReason", exitReason ?: JSONObject.NULL).put("legacyImport", false).put("ownerUnknown", false)
                .put("source", first.optString("source", "in_app")).put("owner", owner ?: JSONObject.NULL)
                .put("transitionGen", first.optLong("transitionGen")).put("options", finalOptions)
                .put("input", inputValue)
                .put("sampleRate", SAMPLE_RATE).put("bitrate", BITRATE)
                .put("ledger", defaultLedger()).put("stt", defaultStt())
            lock.withLock {
                ensureAlive(id)
                if (recovered && id in openSessions) throw IllegalStateException("live_session")
                if ((generation[id] ?: 0) != opGen) throw IllegalStateException("stale_operation")
                // Do not regenerate a sidecar, including one with a newer rev.
                if (sidecar(id).exists()) return JSONObject(sidecar(id).readText())
                ops.rename(staged, audio(id), "publish.m4aRename")
                val tmp = File(root, "$id.json.tmp")
                ops.write(tmp, jsonLine(result), false, "publish.sidecarTmp")
                ops.rename(tmp, sidecar(id), "publish.sidecarRename")
            }
            gcSession(id)
            return result
        } finally {
            if (staged.exists()) staged.delete()
            end(id)
        }
    }
    private fun pausedDuration(history: List<JSONObject>): Long {
        var pausedAt: Long? = null; var total = 0L
        for (e in history) if (e.optString("e") == "intent") {
            if (e.optString("value") == "paused") pausedAt = e.optLong("t")
            else if (pausedAt != null) { total += e.optLong("t") - pausedAt; pausedAt = null }
        }
        if (pausedAt != null) total += (history.lastOrNull()?.optLong("t") ?: pausedAt) - pausedAt
        return total
    }
    private fun spans(history: List<JSONObject>): JSONArray {
        val result = JSONArray()
        var open: JSONObject? = null
        for (entry in history) when (entry.optString("e")) {
            "span_open" -> open = JSONObject().put("kind", entry.optString("kind"))
                .put("reason", entry.optString("reason")).put("startedAt", entry.optLong("t"))
                .put("endedAt", JSONObject.NULL).put("atAudioMs", entry.optLong("a")).put("audioMs", 0)
            "span_close" -> if (open != null) {
                open.put("endedAt", entry.optLong("t"))
                open.put("audioMs", if (open.optString("kind") == "silenced") entry.optLong("a") - open.optLong("atAudioMs") else 0)
                result.put(open); open = null
            }
        }
        if (open != null) result.put(open)
        return result
    }
    fun gcSession(id: String) = lock.withLock {
        val dir = session(id)
        dir.listFiles()?.forEach { ops.unlink(it, "publish.gc") }
        ops.rmdir(dir, "publish.gc"); ops.syncDir(sessions)
    }
    fun read(id: String): JSONObject? = lock.withLock {
        requireId(id); ensureAlive(id)
        val file = sidecar(id)
        if (!file.exists()) return null
        val note = JSONObject(file.readText())
        if (note.optInt("version") < 2) note.put("ownerUnknown", true)
        note
    }
    fun list(): List<JSONObject> = lock.withLock {
        root.listFiles { f -> f.name.endsWith(".json") && f.name.removeSuffix(".json").isNoteId() }
            .orEmpty().mapNotNull { file ->
                val id = file.name.removeSuffix(".json")
                if (tombstone(id).exists()) null
                else try { read(id) } catch (_: Exception) { null } // Recovery quarantines malformed sidecars.
            }
    }
    fun mutate(id: String, point: String, block: (JSONObject) -> Unit): JSONObject = lock.withLock {
        ensureAlive(id)
        val note = read(id) ?: throw IllegalStateException("not_found")
        block(note)
        note.put("rev", note.optInt("rev", 0) + 1)
        val tmp = File(root, "$id.json.tmp")
        ops.write(tmp, jsonLine(note), false, point)
        ops.rename(tmp, sidecar(id), point)
        note
    }
    fun claim(id: String, did: String, evidence: String, rowId: String? = null): JSONObject = mutate(id, "claim.write") { note ->
        val legacy = note.optBoolean("ownerUnknown", false)
        if (legacy && evidence !in listOf("space_row", "user_choice")) throw IllegalStateException("owner_unknown")
        if (!legacy && evidence != "signed_out_v2") throw IllegalStateException("claim_evidence_invalid")
        val owner = note.optString("owner")
        if (owner != "null" && owner.isNotEmpty() && owner != did) throw IllegalStateException("owner_mismatch")
        if (note.optInt("version") < 2) note.put("version", 2).put("legacyImport", false)
            .put("ledger", defaultLedger()).put("stt", defaultStt())
        note.put("owner", did).put("ownerUnknown", false)
        if (evidence == "space_row") {
            require(!rowId.isNullOrBlank()) { "row_id_required" }
            note.getJSONObject("ledger").put("audio", JSONObject().put("state", "saved")
                .put("rowId", rowId).put("at", System.currentTimeMillis()))
        }
    }
    fun putTranscript(id: String, transcript: JSONObject) {
        requireId(id)
        val opGen = begin(id)
        val tmp = File(staging, "$id.$opGen.transcript.json")
        try {
            ops.write(tmp, jsonLine(transcript), false, "stt.stage")
            awaitGate("stt.beforePublish")
            lock.withLock {
                ensureAlive(id)
                if ((generation[id] ?: 0) != opGen) throw IllegalStateException("stale_operation")
                if (!sidecar(id).isFile) throw IllegalStateException("not_found")
                ops.rename(tmp, File(root, "$id.transcript.json"), "stt.publish")
            }
        } finally { if (tmp.exists()) tmp.delete(); end(id) }
    }
    fun getTranscript(id: String): JSONObject? = lock.withLock {
        requireId(id); ensureAlive(id)
        File(root, "$id.transcript.json").takeIf { it.isFile }?.let { JSONObject(it.readText()) }
    }
    fun listOutbox(did: String): JSONArray = lock.withLock {
        JSONArray().also { result -> for (file in outbox.listFiles().orEmpty().filter { it.name.endsWith(".json") }) {
            val entry = try { JSONObject(file.readText()) } catch (_: Exception) { continue }
            if (entry.optString("did") == did) result.put(entry)
        } }
    }
    fun completeOutbox(entryId: String, result: String) = lock.withLock {
        require(entryId.matches(Regex("[a-zA-Z0-9_:.\\-]+"))) { "invalid_argument" }
        require(result in setOf("done", "retry", "lookup", "unknown", "authority_expired")) { "invalid_argument" }
        val file = File(outbox, "$entryId.json")
        if (!file.isFile) throw IllegalStateException("not_found")
        if (result == "done") { ops.unlink(file, "outbox.complete"); ops.syncDir(outbox) }
        else {
            val entry = JSONObject(file.readText())
            entry.put("attempts", entry.optInt("attempts") + 1)
                .put("state", if (result == "retry") "pending" else result)
            val tmp = File(outbox, "$entryId.json.tmp")
            ops.write(tmp, jsonLine(entry), false, "outbox.retry")
            ops.rename(tmp, file, "outbox.retry")
        }
    }
    private fun receiptEntry(id: String, opId: String) = "$id:$opId"
    private fun receiptFile(id: String, opId: String) = File(outbox, "${receiptEntry(id, opId)}.json")
    private fun receiptStage(kind: String, outcome: String): String = when {
        outcome != "created" -> if (kind == "hosted_submit") "submit_unknown" else "create_unknown"
        kind == "hosted_create" -> "uploading"
        kind == "own_upload" -> "uploaded"
        else -> "submitted"
    }
    private fun stringValue(value: JSONObject?, key: String): String? = value?.optString(key)
        ?.takeUnless { it.isEmpty() || it == "null" }
    private fun outboxReceipt(id: String, did: String, receipt: JSONObject, result: JSONObject? = null): JSONObject {
        val kind = receipt.getString("kind")
        val direct = stringValue(result, "handle") ?: stringValue(receipt, "handle")
        val job = stringValue(result, "jobId") ?: stringValue(receipt, "jobId")
        val upload = stringValue(result, "uploadId") ?: stringValue(receipt, "uploadId")
        val url = stringValue(result, "uploadUrl") ?: stringValue(receipt, "uploadUrl")
        val (outKind, handle, state) = when (kind) {
            "hosted_create" -> Triple("hosted_upload", upload ?: direct,
                if (upload != null || direct != null) "pending" else "unknown")
            "hosted_submit" -> when {
                job != null || direct != null -> Triple("transcript", job ?: direct, "pending")
                upload != null -> Triple("hosted_submit", upload, "lookup")
                else -> Triple("unknown", null, "unknown")
            }
            "own_upload" -> Triple("own_upload_lookup", url ?: direct,
                if (url != null || direct != null) "lookup" else "unknown")
            "own_create" -> when {
                job != null || direct != null -> Triple("transcript", job ?: direct, "pending")
                url != null -> Triple("own_upload_lookup", url, "lookup")
                else -> Triple("unknown", null, "unknown")
            }
            else -> Triple("ptx_job", job ?: direct, if (job != null || direct != null) "pending" else "unknown")
        }
        return JSONObject().put("entryId", receiptEntry(id, receipt.getString("opId"))).put("did", did)
            .put("provider", receipt.getString("provider")).put("mode", receipt.opt("mode") ?: JSONObject.NULL)
            .put("kind", outKind).put("handle", handle ?: JSONObject.NULL)
            .put("handleExpiresAt", result?.opt("handleExpiresAt") ?: receipt.opt("handleExpiresAt") ?: JSONObject.NULL)
            .put("state", state).put("createdAt", receipt.optLong("startedAt", System.currentTimeMillis()))
            .put("attempts", 0)
    }
    private fun saveOutbox(entry: JSONObject, point: String) {
        val file = File(outbox, "${entry.getString("entryId")}.json")
        val tmp = File(outbox, "${entry.getString("entryId")}.json.tmp")
        ops.write(tmp, jsonLine(entry), false, point); ops.rename(tmp, file, point)
    }
    fun beginRemoteOp(receipt: JSONObject, forceOutbox: Boolean = false) = lock.withLock {
        val id = receipt.getString("id"); requireId(id)
        val opId = receipt.getString("opId")
        require(opId.matches(Regex("[a-zA-Z0-9_.\\-]+"))) { "invalid_argument" }
        require(receipt.optString("did").isNotBlank()) { "invalid_argument" }
        require(receipt.optString("kind") in setOf("hosted_create", "hosted_submit", "own_upload", "own_create", "ptx_create")) { "invalid_argument" }
        val note = sidecar(id).takeIf { it.isFile && !tombstone(id).exists() }?.let { JSONObject(it.readText()) }
        if (!forceOutbox && note?.optString("owner") == receipt.getString("did")) {
            val prior = note.optJSONObject("ledger")?.optJSONArray("remote")
            val old = (0 until (prior?.length() ?: 0)).firstOrNull { prior!!.getJSONObject(it).optString("opId") == opId }
            if (old != null) {
                if (prior!!.getJSONObject(old).optString("fingerprint") != receipt.optString("fingerprint"))
                    throw IllegalStateException("receipt_conflict")
                return@withLock
            }
            mutate(id, "receipt.begin") { side ->
                val remote = side.optJSONObject("ledger")?.optJSONArray("remote") ?: JSONArray()
                remote.put(JSONObject().put("opId", opId).put("provider", receipt.getString("provider"))
                    .put("mode", receipt.opt("mode") ?: JSONObject.NULL).put("kind", receipt.getString("kind"))
                    .put("fingerprint", receipt.optString("fingerprint"))
                    .put("startedAt", receipt.optLong("startedAt", System.currentTimeMillis()))
                    .put("stage", receiptStage(receipt.getString("kind"), "unknown"))
                    .put("uploadId", JSONObject.NULL).put("uploadUrl", JSONObject.NULL).put("jobId", JSONObject.NULL)
                    .put("handleExpiresAt", JSONObject.NULL).put("cleanup", "none"))
                val ledger = side.optJSONObject("ledger") ?: defaultLedger()
                ledger.put("remote", remote); side.put("ledger", ledger)
            }
        } else {
            val file = receiptFile(id, opId)
            if (file.exists()) {
                val prior = JSONObject(file.readText())
                if (prior.optString("did") != receipt.optString("did") ||
                    prior.optString("provider") != receipt.optString("provider"))
                    throw IllegalStateException("receipt_conflict")
            } else saveOutbox(outboxReceipt(id, receipt.getString("did"), receipt), "receipt.begin")
        }
    }
    fun recordRemoteResult(id: String, did: String, opId: String, result: JSONObject): String = lock.withLock {
        requireId(id)
        require(opId.matches(Regex("[a-zA-Z0-9_.\\-]+")) && did.isNotBlank()) { "invalid_argument" }
        val outcome = result.optString("outcome")
        require(outcome in setOf("created", "failed", "unknown")) { "invalid_argument" }
        if (tombstone(id).exists() && sidecar(id).isFile) enqueueOutbox(id)
        val note = sidecar(id).takeIf { it.isFile && !tombstone(id).exists() }?.let { JSONObject(it.readText()) }
        val remote = note?.optJSONObject("ledger")?.optJSONArray("remote")
        val index = (0 until (remote?.length() ?: 0)).firstOrNull { remote!!.getJSONObject(it).optString("opId") == opId }
        if (note?.optString("owner") == did && index != null) {
            mutate(id, "receipt.result") { side ->
                val entries = side.getJSONObject("ledger").getJSONArray("remote")
                if (outcome == "failed") entries.remove(index)
                else {
                    val item = entries.getJSONObject(index)
                    item.put("stage", receiptStage(item.optString("kind"), outcome))
                    for (key in listOf("uploadId", "uploadUrl", "jobId", "handleExpiresAt"))
                        if (result.has(key)) item.put(key, result.get(key))
                    stringValue(result, "handle")?.let { handle ->
                        val key = when (item.optString("kind")) {
                            "hosted_create" -> "uploadId"
                            "own_upload" -> "uploadUrl"
                            else -> "jobId"
                        }
                        item.put(key, handle)
                    }
                }
            }
            "ledger"
        } else {
            val file = receiptFile(id, opId)
            val previous = file.takeIf { it.isFile }?.let { JSONObject(it.readText()) }
            if (previous == null) throw IllegalStateException("not_found")
            if (previous.optString("did") != did) throw IllegalStateException("receipt_not_found")
            if (outcome == "failed") {
                ops.unlink(file, "receipt.result"); ops.syncDir(outbox)
                return@withLock "outbox"
            }
            val originalKind = when (previous.optString("kind")) {
                "hosted_upload" -> "hosted_create"
                "hosted_submit" -> "hosted_submit"
                // The table's begin row gives own_upload_lookup for own_upload,
                // while an own_create with no job starts as unknown.
                "own_upload_lookup" -> "own_upload"
                "ptx_job" -> "ptx_create"
                "unknown" -> if (previous.optString("mode") == "hosted") "hosted_submit" else "own_create"
                else -> "own_create"
            }
            val receipt = JSONObject().put("opId", opId).put("provider", previous.getString("provider"))
                .put("mode", previous.opt("mode") ?: JSONObject.NULL).put("kind", originalKind)
                .put("startedAt", previous.optLong("createdAt"))
                .put("handleExpiresAt", previous.opt("handleExpiresAt") ?: JSONObject.NULL)
            val oldHandle = stringValue(previous, "handle")
            if (oldHandle != null) receipt.put(when (previous.optString("kind")) {
                "hosted_upload", "hosted_submit" -> "uploadId"
                "own_upload_lookup" -> "uploadUrl"
                else -> "jobId"
            }, oldHandle)
            val next = outboxReceipt(id, did, receipt, result)
            next.put("attempts", previous.optInt("attempts"))
            if (previous.optString("handle") == next.optString("handle") &&
                previous.optString("state") == "authority_expired") next.put("state", "authority_expired")
            if (previous.toString() != next.toString()) saveOutbox(next, "receipt.result")
            "outbox"
        }
    }
    fun delete(id: String) = lock.withLock {
        requireId(id)
        generation[id] = (generation[id] ?: 0) + 1
        ops.write(tombstone(id), byteArrayOf(), false, "delete.tombstone")
        ops.syncDir(tombstones)
        openSessions.remove(id)
        enqueueOutbox(id)
        gcArtifacts(id)
        retire(id)
    }
    /** Discard applies only to an unpublished session; saved notes use explicit deleteAudio. */
    fun discardUncommitted(id: String) = lock.withLock {
        requireId(id)
        if (sidecar(id).exists()) throw IllegalStateException("already_committed")
        delete(id)
    }
    /** Retryable after a tombstone: stable entry ids prevent duplicate cleanup jobs. */
    private fun enqueueOutbox(id: String) {
        val note = sidecar(id).takeIf { it.exists() }?.let { JSONObject(it.readText()) }
        val remote = note?.optJSONObject("ledger")?.optJSONArray("remote") ?: JSONArray()
        for (i in 0 until remote.length()) {
            val item = remote.getJSONObject(i)
            if (item.optString("cleanup") == "done") continue
            if (item.has("opId")) {
                val target = receiptFile(id, item.getString("opId"))
                if (!target.exists()) saveOutbox(outboxReceipt(id, note?.optString("owner") ?: "", item), "delete.outbox")
                continue
            }
            val provider = item.optString("provider")
            val mode = item.optString("mode").takeUnless { it == "null" || it.isEmpty() }
            val handles = mutableListOf<Pair<String, String>>()
            val jobId = item.optString("jobId").takeUnless { it == "null" || it.isEmpty() }
            val uploadId = item.optString("uploadId").takeUnless { it == "null" || it.isEmpty() }
            val uploadUrl = item.optString("uploadUrl").takeUnless { it == "null" || it.isEmpty() }
            if (jobId != null) handles += (if (provider == "ptx") "ptx_job" else "transcript") to jobId
            if (provider == "assemblyai" && mode == "hosted" && uploadId != null)
                handles += "hosted_upload" to uploadId
            if (provider == "assemblyai" && mode == "own" && item.optString("stage") == "submit_unknown" &&
                jobId == null && uploadUrl != null) handles += "own_upload_lookup" to uploadUrl
            // Older ledgers may already carry one explicit cleanup handle.
            val oldHandle = item.optString("handle").takeUnless { it == "null" || it.isEmpty() }
            if (handles.isEmpty() && oldHandle != null) handles += item.optString("kind") to oldHandle
            for ((kind, handle) in handles) {
                val did = note?.opt("owner")?.takeUnless { it == JSONObject.NULL } ?: JSONObject.NULL
                val entryId = UUID.nameUUIDFromBytes("$id:$provider:$kind:$handle".toByteArray(Charsets.UTF_8)).toString()
                val target = File(outbox, "$entryId.json")
                if (target.exists()) continue
                val entry = JSONObject().put("entryId", entryId).put("did", did)
                    .put("provider", provider).put("mode", mode ?: JSONObject.NULL).put("kind", kind)
                    .put("handle", handle).put("createdAt", System.currentTimeMillis()).put("attempts", 0)
                ops.write(target, jsonLine(entry), false, "delete.outbox")
            }
        }
        ops.syncDir(outbox)
    }
    private fun gcArtifacts(id: String) {
        for (file in root.listFiles().orEmpty()) if (file.name.startsWith("$id.")) ops.unlink(file, "delete.unlink")
        for (file in staging.listFiles().orEmpty()) if (file.name.startsWith("$id.")) ops.unlink(file, "delete.unlink")
        session(id).listFiles()?.forEach { ops.unlink(it, "delete.unlink") }
        ops.rmdir(session(id), "delete.unlink")
        ops.syncDir(root); ops.syncDir(staging); ops.syncDir(sessions)
    }
    private fun retire(id: String) {
        if ((active[id] ?: 0) != 0) return
        if (root.listFiles().orEmpty().any { it.name.startsWith("$id.") } || session(id).exists() ||
            staging.listFiles().orEmpty().any { it.name.startsWith("$id.") }) return
        ops.unlink(tombstone(id), "tombstone.retire"); ops.syncDir(tombstones)
    }
    fun recoverOnce(mux: (String, File) -> Unit, probe: (File) -> JSONObject?, exitReason: String? = null,
                    onFailure: (String, String) -> Unit = { _, _ -> }) = recoveryLock.withLock {
        val failures = mutableListOf<String>()
        fun failed(id: String, error: Exception) {
            val detail = error.message ?: "recovery_failed"
            failures.add("$id: $detail")
            onFailure(id, detail)
        }
        // This lock makes later plugin calls await bootstrap recovery. It is separate
        // from the short publication lock, so mux and probe still run outside it.
        for (file in root.listFiles().orEmpty().filter { it.name.endsWith(".json") && it.name.removeSuffix(".json").isNoteId() }) {
            try { JSONObject(file.readText()) } catch (_: Exception) {
                val id = file.name.removeSuffix(".json")
                try { lock.withLock {
                    if (!tombstone(id).exists()) ops.rename(file, File(quarantine, "$id.sidecar.json"), "import.sidecar")
                } } catch (e: Exception) { failed(id, e) }
            }
        }
        for (dir in sessions.listFiles().orEmpty().filter { it.isDirectory && it.name.isNoteId() }) {
            val id = dir.name
            try {
                if (lock.withLock { id in openSessions }) continue
                if (parkedSessions().any { it.first == id }) continue
                if (tombstone(id).exists()) { lock.withLock { enqueueOutbox(id); gcArtifacts(id); retire(id) }; continue }
                if (sidecar(id).exists()) { gcSession(id); clearRecoveryFailure(id); continue }
                if (quarantineIfExhausted(id)) continue
                val segments = dir.listFiles().orEmpty().filter { it.name.endsWith(".aac") }
                if (segments.all { it.length() == 0L }) {
                    gcSession(id); clearRecoveryFailure(id); continue
                }
                beginRecoveryAttempt(id)
                // A complete but invalid journal line makes this session unrecoverable.
                // Reject it before scanning or muxing a long segment on every retry.
                if (events(id).none { it.optString("e") == "session" }) throw IOException("Missing session")
                if (segments.sumOf { scanAdts(it).frames } == 0L) {
                    gcSession(id); clearRecoveryFailure(id); continue
                }
                commit(id, { mux(id, it) }, recovered = true, exitReason = exitReason)
                clearRecoveryFailure(id)
            }
            catch (e: Exception) {
                failed(id, e)
                // A prior in-flight attempt also counts if the process died during muxing.
                try { recordRecoveryFailure(id, e) } catch (writeError: Exception) { failed(id, writeError) }
            }
        }
        for (file in root.listFiles().orEmpty().filter { it.name.endsWith(".m4a") && it.name.removeSuffix(".m4a").isNoteId() }) {
            val id = file.name.removeSuffix(".m4a")
            if (sidecar(id).exists() || tombstone(id).exists() || session(id).exists() ||
                File(quarantine, "$id.session").exists() || recoveryMarker(id).isFile) continue
            val opGen = try { begin(id) } catch (_: Exception) { continue }
            try {
                val note = probe(file)
                awaitGate("probe.afterLoad")
                lock.withLock {
                    if (tombstone(id).exists() || (generation[id] ?: 0) != opGen) return@withLock
                    if (note == null) {
                        val size = file.length()
                        ops.rename(file, File(quarantine, file.name), "import.quarantine")
                        ops.write(File(quarantine, "$id.json"), jsonLine(JSONObject().put("id", id)
                            .put("reason", "no_audio_track").put("sizeBytes", size)), false, "import.quarantine")
                    } else if (!sidecar(id).exists()) {
                        val startedAt = note.optLong("startedAt", file.lastModified())
                        val durationMs = note.optLong("durationMs")
                        note.put("id", id).put("version", 2).put("rev", 1).put("legacyImport", true)
                            .put("recovered", true).put("ownerUnknown", true).put("owner", JSONObject.NULL)
                            .put("wallMs", durationMs).put("pausedMs", 0).put("spans", JSONArray())
                            .put("endedUnexpectedly", false).put("lastHeartbeatAt", JSONObject.NULL)
                            .put("exitReason", JSONObject.NULL).put("source", "in_app")
                            .put("firstAudioAt", JSONObject.NULL).put("captureStoppedAt", JSONObject.NULL)
                            .put("transitionGen", 0).put("options", defaultOptions())
                            .put("input", JSONObject.NULL)
                            .put("sampleRate", note.opt("sampleRate") ?: JSONObject.NULL)
                            .put("bitrate", note.opt("bitrate") ?: JSONObject.NULL)
                            .put("startedAt", startedAt)
                            .put("silencedMs", note.optLong("silencedMs"))
                            .put("silencedEvents", note.optInt("silencedEvents"))
                            .put("noSignalMs", note.optLong("noSignalMs"))
                            .put("ledger", defaultLedger()).put("stt", defaultStt())
                        val tmp = File(root, "$id.json.tmp")
                        ops.write(tmp, jsonLine(note), false, "import.sidecar")
                        ops.rename(tmp, sidecar(id), "import.sidecar")
                    }
                }
            } catch (e: Exception) { failed(id, e) }
            finally { end(id) }
        }
        for (marker in tombstones.listFiles().orEmpty()) if (marker.name.isNoteId()) lock.withLock {
            try { enqueueOutbox(marker.name); gcArtifacts(marker.name); retire(marker.name) }
            catch (e: IOException) { failed(marker.name, e) }
        }
        if (failures.isNotEmpty()) throw IOException("Recovery needs retry: ${failures.joinToString()}")
    }
    private fun clearRecoveryFailure(id: String) = lock.withLock {
        val file = File(quarantine, "$id.failure.json")
        if (file.exists()) { ops.unlink(file, "recovery.clear"); ops.syncDir(quarantine) }
    }
}
