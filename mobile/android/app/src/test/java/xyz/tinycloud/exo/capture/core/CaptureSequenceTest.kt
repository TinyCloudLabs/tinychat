package xyz.tinycloud.exo.capture.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CaptureSequenceTest {
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
        assertArrayEquals(fixture("sidecar-v2-android.json"), library.sidecar(noteId).readBytes())
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
}
