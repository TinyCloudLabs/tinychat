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
        JSONArray().also { result -> for (file in outbox.listFiles().orEmpty()) {
            val entry = try { JSONObject(file.readText()) } catch (_: Exception) { continue }
            if (entry.optString("did") == did) result.put(entry)
        } }
    }
    fun completeOutbox(entryId: String, done: Boolean) = lock.withLock {
        requireId(entryId)
        val file = File(outbox, "$entryId.json")
        if (!file.isFile) throw IllegalStateException("not_found")
        if (done) { ops.unlink(file, "outbox.complete"); ops.syncDir(outbox) }
        else {
            val entry = JSONObject(file.readText()).put("attempts", JSONObject(file.readText()).optInt("attempts") + 1)
            val tmp = File(outbox, "$entryId.json.tmp")
            ops.write(tmp, jsonLine(entry), false, "outbox.retry")
            ops.rename(tmp, file, "outbox.retry")
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
    fun recoverOnce(mux: (String, File) -> Unit, probe: (File) -> JSONObject?, exitReason: String? = null) = recoveryLock.withLock {
        val failures = mutableListOf<String>()
        // This lock makes later plugin calls await bootstrap recovery. It is separate
        // from the short publication lock, so mux and probe still run outside it.
        for (file in root.listFiles().orEmpty().filter { it.name.endsWith(".json") && it.name.removeSuffix(".json").isNoteId() }) {
            try { JSONObject(file.readText()) } catch (_: Exception) {
                val id = file.name.removeSuffix(".json")
                try { lock.withLock {
                    if (!tombstone(id).exists()) ops.rename(file, File(quarantine, "$id.sidecar.json"), "import.sidecar")
                } } catch (e: Exception) { failures.add("$id: ${e.message}") }
            }
        }
        for (dir in sessions.listFiles().orEmpty().filter { it.isDirectory && it.name.isNoteId() }) {
            val id = dir.name
            try {
                if (lock.withLock { id in openSessions }) continue
                if (tombstone(id).exists()) { lock.withLock { enqueueOutbox(id); gcArtifacts(id); retire(id) }; continue }
                if (sidecar(id).exists()) { gcSession(id); continue }
                val segments = dir.listFiles().orEmpty().filter { it.name.endsWith(".aac") }
                if (segments.all { it.length() == 0L }) {
                    gcSession(id); continue
                }
                // A complete but invalid journal line makes this session unrecoverable.
                // Reject it before scanning or muxing a long segment on every retry.
                if (events(id).none { it.optString("e") == "session" }) throw IOException("Missing session")
                if (segments.sumOf { scanAdts(it).frames } == 0L) {
                    gcSession(id); continue
                }
                commit(id, { mux(id, it) }, recovered = true, exitReason = exitReason)
            }
            catch (e: Exception) { failures.add("$id: ${e.message}") /* session remains durable for retry */ }
        }
        for (file in root.listFiles().orEmpty().filter { it.name.endsWith(".m4a") && it.name.removeSuffix(".m4a").isNoteId() }) {
            val id = file.name.removeSuffix(".m4a")
            if (sidecar(id).exists() || tombstone(id).exists() || session(id).exists()) continue
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
            } catch (e: Exception) { failures.add("$id: ${e.message}") }
            finally { end(id) }
        }
        for (marker in tombstones.listFiles().orEmpty()) if (marker.name.isNoteId()) lock.withLock {
            try { enqueueOutbox(marker.name); gcArtifacts(marker.name); retire(marker.name) }
            catch (e: IOException) { failures.add("${marker.name}: ${e.message}") }
        }
        if (failures.isNotEmpty()) throw IOException("Recovery needs retry: ${failures.joinToString()}")
    }
}
