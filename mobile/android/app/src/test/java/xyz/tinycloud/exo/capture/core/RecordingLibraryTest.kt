package xyz.tinycloud.exo.capture.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RecordingLibraryTest {
    @get:Rule val temp = TemporaryFolder()
    private fun id() = UUID.randomUUID().toString()
    private fun library() = RecordingLibrary(temp.newFolder())
    private fun begin(lib: RecordingLibrary, id: String) {
        lib.start(id, "in_app", null, 1, defaultOptions(), MAX_DURATION_MS)
        lib.openFirstSegment(id, 0, 1)
        lib.append(id, 0, byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x50, 0x40, 0x01, 0x1f, 0xfc.toByte(), 0))
        lib.checkpoint(id, 0, 1000, "recording", "available")
        lib.stopJournal(id, 1000, "user")
    }
    private fun commit(lib: RecordingLibrary, id: String) = lib.commit(id, { it.writeBytes(byteArrayOf(1, 2, 3)) })

    @Test fun canonicalJsonUsesSortedKeysEscapesAndOneLf() {
        val data = JSONObject().put("z", JSONArray().put(JSONObject().put("b", 2).put("a", "é/\u0001")))
            .put("a", JSONObject.NULL)
        assertEquals("{\"a\":null,\"z\":[{\"a\":\"é/\\u0001\",\"b\":2}]}\n",
            String(CanonicalJson.line(data), Charsets.UTF_8))
    }

    @Test fun sidecarIsCommitPointAndRecoveryDoesNotOverwriteNewerRevision() {
        val lib = library(); val note = id(); begin(lib, note)
        assertFalse(lib.sidecar(note).exists())
        commit(lib, note)
        assertTrue(lib.sidecar(note).exists())
        assertFalse(lib.session(note).exists())
        lib.mutate(note, "ledger.write") { it.put("marker", "new") }
        lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(9)) }, { null })
        assertEquals("new", lib.read(note)!!.getString("marker"))
        assertEquals(2, lib.read(note)!!.getInt("rev"))
    }
    @Test fun successfulInputIsJournaledBeforeFirstSegment() {
        val lib = library(); val note = id()
        lib.start(note, "in_app", null, 1, defaultOptions(), MAX_DURATION_MS)
        assertEquals(listOf("session"), lib.events(note).map { it.getString("e") })
        lib.openFirstSegment(note, 0, 7)
        val events = lib.events(note)
        assertEquals(listOf("session", "avail", "input", "segment"), events.map { it.getString("e") })
        assertEquals(7, events[1].getInt("gen"))
        assertEquals("built_in", events[2].getString("kind"))
    }
    @Test fun failedSidecarRenameRecoversWithoutPublishingPartialCommit() {
        val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops); val note = id(); begin(lib, note)
        ops.failOnce("publish.sidecarRename")
        try { commit(lib, note); fail("expected injected failure") } catch (_: IOException) { }
        assertFalse(lib.sidecar(note).exists())
        // The journal is authoritative until a sidecar is published.
        lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1, 2, 3)) }, { null })
        assertTrue(lib.sidecar(note).exists())
        assertEquals(1024L * 1000 / SAMPLE_RATE, lib.read(note)!!.getLong("durationMs"))
    }
    @Test fun deleteDuringStagedCommitCannotResurrectTheNote() {
        val lib = library(); val note = id(); begin(lib, note)
        val entering = CountDownLatch(1); val release = CountDownLatch(1)
        val worker = Thread {
            try { lib.commit(note, { out -> entering.countDown(); release.await(5, TimeUnit.SECONDS); out.writeBytes(byteArrayOf(1)) }) }
            catch (_: IllegalStateException) { }
        }
        worker.start(); assertTrue(entering.await(5, TimeUnit.SECONDS))
        lib.delete(note); release.countDown(); worker.join(5000)
        assertFalse(lib.sidecar(note).exists()); assertFalse(lib.audio(note).exists())
        assertTrue(lib.tombstone(note).exists())
    }
    @Test fun failedUnlinkAndEightDayRelaunchNeverResurrects() {
        val ops = FileOps(); val dir = temp.newFolder(); val lib = RecordingLibrary(dir, ops)
        val note = id(); begin(lib, note); commit(lib, note)
        ops.failOnce("delete.unlink")
        try { lib.delete(note); fail("expected injected failure") } catch (_: IOException) { }
        assertTrue(lib.tombstone(note).exists())
        lib.tombstone(note).setLastModified(System.currentTimeMillis() - 8L * 24 * 3_600_000)
        val relaunched = RecordingLibrary(dir)
        relaunched.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null })
        assertFalse(relaunched.audio(note).exists()); assertFalse(relaunched.sidecar(note).exists())
        relaunched.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null })
        assertTrue(relaunched.list().isEmpty())
    }
    @Test fun legacyPairIsNeverAutomaticallyClaimedAndOrphanIsUnknown() {
        val lib = library(); val paired = id(); val orphan = id()
        lib.audio(paired).writeBytes(byteArrayOf(1))
        lib.sidecar(paired).writeText(JSONObject().put("id", paired).put("durationMs", 1000).toString())
        lib.audio(orphan).writeBytes(byteArrayOf(1))
        lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { file ->
            JSONObject().put("startedAt", file.lastModified()).put("durationMs", 1000)
                .put("mimeType", "audio/mp4").put("sizeBytes", file.length())
        })
        assertTrue(lib.read(paired)!!.getBoolean("ownerUnknown"))
        assertTrue(lib.read(orphan)!!.getBoolean("ownerUnknown"))
        try { lib.claim(orphan, "did:a", "signed_out_v2"); fail("legacy claim must need evidence") }
        catch (_: IllegalStateException) { }
        assertEquals("did:a", lib.claim(orphan, "did:a", "user_choice").getString("owner"))
        assertEquals("saved", lib.claim(paired, "did:a", "space_row", "legacy-row-a")
            .getJSONObject("ledger").getJSONObject("audio").getString("state"))
    }
    @Test fun remoteResourceSurvivesDeleteInOutbox() {
        val lib = library(); val note = id(); begin(lib, note); commit(lib, note)
        lib.mutate(note, "ledger.write") { side ->
            side.put("owner", "did:a")
            side.getJSONObject("ledger").getJSONArray("remote").put(JSONObject().put("provider", "assemblyai")
                .put("mode", "hosted").put("kind", "hosted_upload").put("handle", "u1").put("cleanup", "pending"))
        }
        lib.delete(note)
        assertEquals(1, lib.listOutbox("did:a").length())
        assertFalse(lib.sidecar(note).exists())
    }
    @Test fun spaceRowEvidenceCannotMarkAV2NoteSaved() {
        val lib = library(); val note = id(); begin(lib, note); commit(lib, note)
        lib.mutate(note, "ledger.write") { it.put("owner", "did:a") }
        val before = lib.read(note)!!.getInt("rev")
        try { lib.claim(note, "did:a", "space_row", "another-row"); fail("v2 association must reject") }
        catch (_: IllegalStateException) { }
        assertEquals(before, lib.read(note)!!.getInt("rev"))
        assertEquals("pending", lib.read(note)!!.getJSONObject("ledger").getJSONObject("audio").getString("state"))
    }
    @Test fun hostedTranscriptAndUploadBothReachOutbox() {
        val lib = library(); val note = id(); begin(lib, note); commit(lib, note)
        lib.mutate(note, "ledger.write") { side ->
            side.put("owner", "did:a")
            side.getJSONObject("ledger").getJSONArray("remote").put(JSONObject().put("provider", "assemblyai")
                .put("mode", "hosted").put("stage", "submitted").put("jobId", "job-1")
                .put("uploadId", "upload-1").put("cleanup", "pending"))
        }
        lib.delete(note)
        val entries = lib.listOutbox("did:a")
        assertEquals(2, entries.length())
        assertEquals(setOf("transcript", "hosted_upload"), (0 until entries.length())
            .map { entries.getJSONObject(it).getString("kind") }.toSet())
    }
    @Test fun silencedSpanAndLatestOptionsReachCommittedSidecar() {
        val lib = library(); val note = id()
        lib.start(note, "app_shortcut", null, 3, defaultOptions(), MAX_DURATION_MS)
        lib.openFirstSegment(note, 0, 1)
        lib.append(note, 0, byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x50, 0x40, 0x01, 0x1f, 0xfc.toByte(), 0))
        lib.transition(note, "span_open", 100, JSONObject().put("kind", "silenced").put("reason", "os_silenced"))
        lib.transition(note, "span_close", 500, JSONObject().put("kind", "silenced").put("reason", "os_silenced"))
        lib.transition(note, "options", 500, JSONObject().put("transcriber", "assemblyai").put("identifySpeakers", true))
        lib.stopJournal(note, 1000, "user")
        val saved = commit(lib, note)
        assertEquals(400, saved.getJSONArray("spans").getJSONObject(0).getLong("audioMs"))
        assertEquals("assemblyai", saved.getJSONObject("options").getString("transcriber"))
        assertTrue(saved.getJSONObject("options").getBoolean("identifySpeakers"))
    }
    @Test fun malformedLegacySidecarIsQuarantinedBeforeAudioProbe() {
        val lib = library(); val note = id()
        lib.audio(note).writeBytes(byteArrayOf(1, 2, 3))
        lib.sidecar(note).writeText("{broken")
        lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { file ->
            JSONObject().put("startedAt", file.lastModified()).put("durationMs", 600)
                .put("mimeType", "audio/mp4").put("sizeBytes", file.length())
        })
        assertTrue(File(lib.quarantine, "$note.sidecar.json").isFile)
        assertTrue(lib.read(note)!!.getBoolean("ownerUnknown"))
    }
    @Test fun deleteDuringGatedTranscriptWritePublishesNothing() {
        val lib = library(); val note = id(); begin(lib, note); commit(lib, note)
        val entering = CountDownLatch(1); val release = CountDownLatch(1)
        lib.gate("stt.beforePublish") { entering.countDown(); release.await(5, TimeUnit.SECONDS) }
        val worker = Thread {
            try { lib.putTranscript(note, JSONObject().put("text", "private")) }
            catch (_: IllegalStateException) { }
        }
        worker.start(); assertTrue(entering.await(5, TimeUnit.SECONDS))
        lib.delete(note); release.countDown(); worker.join(5000)
        assertFalse(File(lib.root, "$note.transcript.json").exists())
        assertFalse(lib.sidecar(note).exists())
    }
    @Test fun discardDuringGatedLegacyProbeCannotImport() {
        val lib = library(); val note = id(); lib.audio(note).writeBytes(byteArrayOf(1))
        val entering = CountDownLatch(1); val release = CountDownLatch(1)
        lib.gate("probe.afterLoad") { entering.countDown(); release.await(5, TimeUnit.SECONDS) }
        val worker = Thread { lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, {
            JSONObject().put("startedAt", 1).put("durationMs", 1000).put("mimeType", "audio/mp4").put("sizeBytes", 1)
        }) }
        worker.start(); assertTrue(entering.await(5, TimeUnit.SECONDS))
        lib.delete(note); release.countDown(); worker.join(5000)
        assertFalse(lib.sidecar(note).exists()); assertFalse(lib.audio(note).exists())
    }
}
