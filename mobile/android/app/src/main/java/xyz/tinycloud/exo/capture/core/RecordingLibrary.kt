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
    private val gates = ConcurrentHashMap<String, () -> Unit>()
    private var recovered = false
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

    fun start(id: String, source: String, owner: String?, transitionGen: Long, options: JSONObject, maxMs: Long) = lock.withLock {
        requireId(id); ensureAlive(id)
        val dir = session(id)
        ops.mkdir(dir, "start.mkdir"); ops.syncDir(sessions)
        val now = System.currentTimeMillis()
        val first = event("session", 0, JSONObject().put("v", 1).put("id", id).put("platform", "android")
            .put("codec", "aac-lc").put("container", "adts").put("rate", SAMPLE_RATE).put("channels", 1)
            .put("bitrate", BITRATE).put("maxDurationMs", maxMs).put("source", source)
            .put("owner", owner ?: JSONObject.NULL).put("transitionGen", transitionGen).put("options", options))
        first.put("t", now)
        ops.write(journal(id), jsonLine(first), false, "start.journal"); ops.syncDir(dir)
        val segment = File(dir, "seg-00000.aac")
        ops.write(segment, byteArrayOf(), false, "roll.create"); ops.syncDir(dir)
        appendJournal(id, event("segment", 0, JSONObject().put("index", 0).put("file", segment.name)), "start.segment")
    }
    fun append(id: String, index: Int, frame: ByteArray) = lock.withLock {
        ensureAlive(id)
        ops.write(File(session(id), "seg-%05d.aac".format(index)), frame, true, "seg.write", false)
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
    fun roll(id: String, index: Int, audioMs: Long) = lock.withLock {
        val dir = session(id)
        ops.sync(File(dir, "seg-%05d.aac".format(index - 1)), true, "roll.sync")
        val next = File(dir, "seg-%05d.aac".format(index))
        ops.write(next, byteArrayOf(), false, "roll.create"); ops.syncDir(dir)
        appendJournal(id, event("segment", audioMs, JSONObject().put("index", index).put("file", next.name)), "roll.journal")
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
    fun commit(id: String, mux: (File) -> Unit, recovered: Boolean = false, exitReason: String? = null): JSONObject {
        requireId(id)
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
            val result = JSONObject().put("id", id).put("startedAt", startedAt).put("durationMs", audioMs)
                .put("mimeType", "audio/mp4").put("sizeBytes", staged.length()).put("silencedMs", 0)
                .put("silencedEvents", 0).put("noSignalMs", 0).put("version", 2).put("rev", 1)
                .put("wallMs", (last?.optLong("t") ?: System.currentTimeMillis()) - startedAt)
                .put("pausedMs", pausedMs).put("spans", spans(history))
                .put("recovered", recovered).put("endedUnexpectedly", history.none { it.optString("e") == "stop" })
                .put("lastHeartbeatAt", history.lastOrNull { it.optString("e") == "hb" }?.optLong("t") ?: JSONObject.NULL)
                .put("exitReason", exitReason ?: JSONObject.NULL).put("legacyImport", false).put("ownerUnknown", false)
                .put("source", first.optString("source", "in_app")).put("owner", owner ?: JSONObject.NULL)
                .put("transitionGen", first.optLong("transitionGen")).put("options", finalOptions)
                .put("input", JSONObject().put("id", "built-in").put("name", "Built-in microphone").put("kind", "built_in"))
                .put("sampleRate", SAMPLE_RATE).put("bitrate", BITRATE)
                .put("ledger", defaultLedger()).put("stt", defaultStt())
            lock.withLock {
                ensureAlive(id)
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
            ?.map { file -> read(file.name.removeSuffix(".json")) ?: throw IOException("Missing ${file.name}") } ?: emptyList()
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
        if (!legacy && evidence != "signed_out_v2" && evidence != "space_row") throw IllegalStateException("invalid_evidence")
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
                val entry = JSONObject().put("entryId", UUID.randomUUID().toString()).put("did", note?.optString("owner"))
                    .put("provider", provider).put("mode", mode ?: JSONObject.NULL).put("kind", kind)
                    .put("handle", handle).put("createdAt", System.currentTimeMillis()).put("attempts", 0)
                ops.write(File(outbox, "${entry.getString("entryId")}.json"), jsonLine(entry), false, "delete.outbox")
            }
        }
        ops.syncDir(outbox)
        gcArtifacts(id)
        retire(id)
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
        if (recovered) return@withLock
        val failures = mutableListOf<String>()
        // This lock makes later plugin calls await bootstrap recovery. It is separate
        // from the short publication lock, so mux and probe still run outside it.
        for (file in root.listFiles().orEmpty().filter { it.name.endsWith(".json") && it.name.removeSuffix(".json").isNoteId() }) {
            try { JSONObject(file.readText()) } catch (_: Exception) {
                val id = file.name.removeSuffix(".json")
                lock.withLock {
                    if (!tombstone(id).exists()) ops.rename(file, File(quarantine, "$id.sidecar.json"), "import.sidecar")
                }
            }
        }
        for (dir in sessions.listFiles().orEmpty().filter { it.isDirectory && it.name.isNoteId() }) {
            val id = dir.name
            if (tombstone(id).exists()) { lock.withLock { gcArtifacts(id); retire(id) }; continue }
            if (sidecar(id).exists()) { gcSession(id); continue }
            if (dir.listFiles().orEmpty().filter { it.name.endsWith(".aac") }.sumOf { scanAdts(it).frames } == 0L) {
                gcSession(id); continue
            }
            try { commit(id, { mux(id, it) }, recovered = true, exitReason = exitReason) }
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
                        ops.rename(file, File(quarantine, file.name), "import.quarantine")
                        ops.write(File(quarantine, "$id.json"), jsonLine(JSONObject().put("id", id)
                            .put("reason", "no_audio_track").put("sizeBytes", file.length())), false, "import.quarantine")
                    } else if (!sidecar(id).exists()) {
                        note.put("id", id).put("version", 2).put("rev", 1).put("legacyImport", true)
                            .put("recovered", true).put("ownerUnknown", true).put("owner", JSONObject.NULL)
                            .put("ledger", defaultLedger()).put("stt", defaultStt())
                        val tmp = File(root, "$id.json.tmp")
                        ops.write(tmp, jsonLine(note), false, "import.sidecar")
                        ops.rename(tmp, sidecar(id), "import.sidecar")
                    }
                }
            } finally { end(id) }
        }
        for (marker in tombstones.listFiles().orEmpty()) if (marker.name.isNoteId()) lock.withLock {
            try { gcArtifacts(marker.name); retire(marker.name) }
            catch (e: IOException) { failures.add("${marker.name}: ${e.message}") }
        }
        if (failures.isNotEmpty()) throw IOException("Recovery needs retry: ${failures.joinToString()}")
        recovered = true
    }
}
