package xyz.tinycloud.exo.capture.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.UUID

class CaptureSequenceTest {
    @Test fun audioBoundariesSurviveTheCommit() {
        val lib = RecordingLibrary(temp.newFolder())
        val sequence = CaptureSequence(lib, noteId)
        sequence.start("in_app", null, 0, defaultOptions(), MAX_DURATION_MS, base)
        sequence.firstInput(1)
        sequence.firstAudio(base + 387)
        sequence.frame(frame)
        sequence.captureStopped(base + 1000)
        sequence.stop("user", base + 1100)
        val note = lib.commit(noteId, { it.writeBytes(byteArrayOf(1, 2, 3)) })
        assertEquals(base + 387, note.getLong("firstAudioAt"))
        assertEquals(base + 1000, note.getLong("captureStoppedAt"))
    }
    @get:Rule val temp = TemporaryFolder()
    private val noteId = "11111111-1111-4111-8111-111111111111"
    private val base = 1_759_800_000_000L
    private val frame = byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x50, 0x40, 0x0d, 0x7f, 0xfc.toByte()) + ByteArray(100)

    private fun fixture(name: String): ByteArray {
        var dir = File(System.getProperty("user.dir") ?: error("Missing test working directory"))
        while (true) {
            val candidate = File(dir, "mobile/fixtures/capture/$name")
            if (candidate.isFile) return candidate.readBytes()
            dir = dir.parentFile ?: error("Required T1 golden fixture is missing: $name")
        }
    }

    @Test fun adtsHeaderMatchesTheMergedGoldenBytes() {
        val line = String(fixture("adts-headers.hex"), Charsets.UTF_8).lineSequence()
            .first { it.startsWith("44k1-android:") }.substringAfter(':').trim()
        val golden = line.split(Regex("\\s+")).map { it.toInt(16).toByte() }.toByteArray()
        assertArrayEquals(golden, Adts.wrap(ByteArray(100)).copyOfRange(0, 7))
    }

    @Test fun androidJournalAndSidecarMatchTheContractBytes() {
        val library = RecordingLibrary(temp.newFolder())
        var now = base
        val sequence = CaptureSequence(library, noteId) { now }
        sequence.start("in_app", null, 12, defaultOptions(), MAX_DURATION_MS)
        sequence.firstInput(1)
        now = base + 1999
        repeat(85) { sequence.frame(frame) }
        now = base + 2000
        sequence.frame(frame)
        now = base + 2499
        repeat(21) { sequence.frame(frame) }
        now = base + 2500
        sequence.interrupt("interruption", "call", 2)
        now = base + 4500
        sequence.restartAfterInterruption("interruption", 3)
        now = base + 4999
        repeat(21) { sequence.frame(frame) }
        now = base + 5000
        sequence.pause()
        now = base + 10000
        sequence.resumeIntent()
        sequence.resumeAcquired(5)
        now = base + 10999
        repeat(43) { sequence.frame(frame) }
        now = base + 11000
        sequence.stop("user")
        assertArrayEquals(fixture("journal-android.jsonl"),
            File(library.session(noteId), "journal.jsonl").readBytes())
        library.commit(noteId, { it.writeBytes(ByteArray(19_000)) })
        val sidecar = JSONObject(library.sidecar(noteId).readText())
        assertTrue(sidecar.isNull("firstAudioAt"))
        assertTrue(sidecar.isNull("captureStoppedAt"))
        sidecar.remove("firstAudioAt"); sidecar.remove("captureStoppedAt")
        assertArrayEquals(fixture("sidecar-v2-android.json"), CanonicalJson.line(sidecar))
        assertEquals(3970, sequence.durableAudioMs)
    }

    @Test fun failedResumeWritesIntentThenBlockedWithoutOpeningASegment() {
        val library = RecordingLibrary(temp.newFolder())
        var now = base
        val sequence = CaptureSequence(library, noteId) { now }
        sequence.start("in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        sequence.firstInput(1)
        sequence.frame(frame)
        now++
        sequence.pause()
        now++
        sequence.resumeIntent()
        sequence.resumeFailed(3)
        val events = library.events(noteId)
        assertEquals(listOf("intent", "avail"), events.takeLast(2).map { it.getString("e") })
        assertEquals("recording", events[events.lastIndex - 1].getString("value"))
        assertEquals("blocked", events.last().getString("value"))
        assertEquals(1, events.count { it.optString("e") == "segment" })
    }
    @Test fun heartbeatDueAtStopIsReplacedByOneFinalHeartbeat() {
        val library = RecordingLibrary(temp.newFolder())
        var now = base
        val sequence = CaptureSequence(library, noteId) { now }
        sequence.start("in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        sequence.firstInput(1)
        sequence.beginClose()
        now += 2000
        sequence.frame(frame)
        sequence.stop("user")
        val heartbeats = library.events(noteId).filter { it.optString("e") == "hb" }
        assertEquals(1, heartbeats.size)
        assertEquals(base + 2000, heartbeats.single().getLong("t"))
        assertEquals("recording", heartbeats.single().getString("intent"))
        assertEquals("available", heartbeats.single().getString("availability"))
    }
    @Test fun quarantineAndOutboxGoldenRecordsAndTornJournalAreCanonical() {
        val library = RecordingLibrary(temp.newFolder())
        library.audio(noteId).writeBytes(ByteArray(12_288))
        library.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null })
        assertArrayEquals(fixture("quarantine-record.json"),
            File(library.quarantine, "$noteId.json").readBytes())
        for ((name, remote) in listOf(
            "outbox-entry.json" to JSONObject().put("provider", "assemblyai").put("mode", "hosted")
                .put("uploadId", "upload-1").put("cleanup", "pending"),
            "outbox-own-lookup.json" to JSONObject().put("provider", "assemblyai").put("mode", "own")
                .put("stage", "submit_unknown").put("uploadUrl", "https://cdn.example.test/uploads/x")
                .put("cleanup", "pending"))) {
            val id = UUID.randomUUID().toString()
            library.start(id, "in_app", "did:pkh:eip155:1:0x1234", 0, defaultOptions(), MAX_DURATION_MS)
            library.openFirstSegment(id, 0, 1)
            library.append(id, 0, frame)
            library.stopJournal(id, 100, "user")
            library.commit(id, { it.writeBytes(byteArrayOf(1)) })
            library.mutate(id, "ledger.write") { it.getJSONObject("ledger").getJSONArray("remote").put(remote) }
            library.delete(id)
            val actualFile = library.outbox.listFiles()!!.first { file ->
                JSONObject(file.readText()).optString("handle") ==
                    if (name == "outbox-entry.json") "upload-1" else "https://cdn.example.test/uploads/x"
            }
            val actual = JSONObject(actualFile.readText())
            val expected = JSONObject(String(fixture(name), Charsets.UTF_8))
                .put("entryId", actual.getString("entryId"))
                .put("createdAt", actual.getLong("createdAt"))
                .put("attempts", actual.getInt("attempts"))
            assertArrayEquals(name, CanonicalJson.line(expected), actualFile.readBytes())
        }
        val torn = fixture("journal-torn.jsonl")
        val dir = library.session(noteId)
        dir.mkdirs()
        File(dir, "journal.jsonl").writeBytes(torn)
        val complete = torn.copyOfRange(0, torn.lastIndexOf('\n'.code.toByte()) + 1)
        val parsed = library.events(noteId).flatMap { CanonicalJson.line(it).asIterable() }.toByteArray()
        assertArrayEquals(complete, parsed)
        assertEquals(3, library.events(noteId).size)
    }
}
