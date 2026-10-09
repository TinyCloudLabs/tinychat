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
    private val frame = byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x50, 0x40, 0x01, 0x1f, 0xfc.toByte(), 0)
    private fun recoverTwice(lib: RecordingLibrary) {
        fun recover() = lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1, 2, 3)) }, { file ->
            JSONObject().put("startedAt", file.lastModified()).put("durationMs", 1000)
                .put("mimeType", "audio/mp4").put("sizeBytes", file.length())
        })
        fun snapshot() = lib.root.walkTopDown().filter { it.isFile }
            .associate { it.relativeTo(lib.root).path to it.readBytes() }
        recover()
        val first = snapshot()
        recover()
        val second = snapshot()
        assertEquals("Recovery changed the file set on its second pass", first.keys, second.keys)
        for ((path, bytes) in first) assertArrayEquals("Recovery rewrote $path", bytes, second[path])
    }
    private inline fun expectFailure(point: String, action: () -> Unit) {
        try { action(); fail("$point did not fail") } catch (e: IOException) {
            assertTrue(e.message.orEmpty().contains(point))
        }
    }

    @Test fun failedStopThenRecoveryReturnsSavedNoteAndDiscardCannotDeleteIt() {
        val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops); val note = id()
        begin(lib, note)
        ops.failOnce("publish.sidecarTmp")
        expectFailure("publish.sidecarTmp") { commit(lib, note) }
        assertNull(lib.read(note))
        recoverTwice(lib)
        val saved = lib.read(note) ?: error("Recovery did not save the stopped note")
        assertEquals(note, saved.getString("id"))
        assertTrue(saved.getBoolean("recovered"))
        assertEquals(1, saved.getInt("rev"))
        assertFalse("Recovery should have collected the old journal", lib.session(note).exists())
        val sidecar = lib.sidecar(note).readBytes()
        val audio = lib.audio(note).readBytes()
        try { lib.discardUncommitted(note); fail("Discard must reject a saved note") }
        catch (e: IllegalStateException) { assertEquals("already_committed", e.message) }
        assertArrayEquals(sidecar, lib.sidecar(note).readBytes())
        assertArrayEquals(audio, lib.audio(note).readBytes())
        assertFalse(lib.tombstone(note).exists())
    }

    @Test fun corruptCompleteJournalIsQuarantinedAfterThreeFailuresWithoutMuxing() {
        val lib = library(); val note = id(); begin(lib, note)
        File(lib.session(note), "journal.jsonl").appendText("{invalid complete line}\n")
        lib.closeSession(note)
        var muxCalls = 0
        repeat(3) {
            expectFailure("Recovery needs retry") {
                lib.recoverOnce({ _, out -> muxCalls++; out.writeBytes(byteArrayOf(1)) }, { null })
            }
            assertEquals("Corrupt journal was muxed on recovery pass ${it + 1}", 0, muxCalls)
            assertFalse(lib.sidecar(note).exists())
        }
        assertFalse(lib.session(note).exists())
        assertTrue(File(lib.quarantine, "$note.session").isDirectory)
        assertEquals(3, lib.failedRecoveryItems().getJSONObject(0).getInt("attempts"))
        lib.prepareRetryRecovery(note)
        assertTrue(lib.session(note).isDirectory)
        lib.discardFailedRecording(note)
        assertFalse(lib.session(note).exists())
    }

    @Test fun retriedRecoveryLeavesLiveSequenceUntouchedWhileBrokenSessionPersists() {
        val lib = library(); val broken = id(); val live = id()
        begin(lib, broken)
        File(lib.session(broken), "journal.jsonl").appendText("{invalid complete line}\n")
        lib.closeSession(broken) // Simulate the previous process dying.
        expectFailure("Recovery needs retry") { lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null }) }
        val sequence = CaptureSequence(lib, live)
        sequence.start("in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        sequence.firstInput(1)
        repeat(50) { sequence.frame(frame) }
        val journalBefore = File(lib.session(live), "journal.jsonl").readBytes()
        val segmentBefore = File(lib.session(live), "seg-00000.aac").readBytes()
        repeat(2) {
            expectFailure("Recovery needs retry") {
                lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1, 2, 3)) }, { null })
            }
            assertTrue(lib.session(live).isDirectory)
            assertArrayEquals(journalBefore, File(lib.session(live), "journal.jsonl").readBytes())
            assertArrayEquals(segmentBefore, File(lib.session(live), "seg-00000.aac").readBytes())
            assertFalse(lib.sidecar(live).exists())
        }
        sequence.frame(frame)
        assertEquals(segmentBefore.size + frame.size.toLong(), File(lib.session(live), "seg-00000.aac").length())
    }
    @Test fun receiptSurvivesDeleteAndLateResult() {
        val lib = library(); val note = id(); begin(lib, note); commit(lib, note)
        lib.mutate(note, "claim.write") { it.put("owner", "did:a") }
        val receipt = JSONObject().put("id", note).put("did", "did:a").put("opId", "op-1")
            .put("provider", "assemblyai").put("mode", "hosted").put("kind", "hosted_submit")
            .put("fingerprint", "sha256").put("startedAt", 1000)
        lib.beginRemoteOp(receipt)
        lib.delete(note)
        assertEquals(1, lib.listOutbox("did:a").length())
        assertEquals("outbox", lib.recordRemoteResult(note, "did:a", "op-1",
            JSONObject().put("uploadId", "upload-1").put("outcome", "created")))
        val entry = lib.listOutbox("did:a").getJSONObject(0)
        assertEquals("upload-1", entry.getString("handle"))
        lib.completeOutbox(entry.getString("entryId"), "authority_expired")
        assertEquals("authority_expired", lib.listOutbox("did:a").getJSONObject(0).getString("state"))
        lib.recordRemoteResult(note, "did:a", "op-1", JSONObject().put("uploadId", "upload-1").put("outcome", "created"))
        assertEquals("authority_expired", lib.listOutbox("did:a").getJSONObject(0).getString("state"))
    }
    @Test fun receiptStagesAndOutboxKindsFollowTheSharedTable() {
        val cases = listOf(
            Triple("hosted_create", "uploadId", "hosted_upload"),
            Triple("hosted_submit", "jobId", "transcript"),
            Triple("own_upload", "uploadUrl", "own_upload_lookup"),
            Triple("own_create", "jobId", "transcript"),
            Triple("ptx_create", "jobId", "ptx_job"),
        )
        for ((kind, field, outKind) in cases) {
            val lib = library(); val note = id(); begin(lib, note); commit(lib, note)
            lib.mutate(note, "claim.write") { it.put("owner", "did:a") }
            val receipt = JSONObject().put("id", note).put("did", "did:a").put("opId", "op-1")
                .put("provider", if (kind == "ptx_create") "ptx" else "assemblyai")
                .put("mode", if (kind.startsWith("hosted")) "hosted" else if (kind.startsWith("own")) "own" else JSONObject.NULL)
                .put("kind", kind).put("fingerprint", "sha256").put("startedAt", 1000)
            lib.beginRemoteOp(receipt)
            val opened = lib.read(note)!!.getJSONObject("ledger").getJSONArray("remote").getJSONObject(0)
            assertEquals(if (kind == "hosted_submit") "submit_unknown" else "create_unknown", opened.getString("stage"))
            assertEquals("none", opened.getString("cleanup"))
            assertEquals(setOf("opId", "provider", "mode", "kind", "fingerprint", "startedAt", "stage",
                "uploadId", "uploadUrl", "jobId", "handleExpiresAt", "cleanup"), opened.keys().asSequence().toSet())
            lib.recordRemoteResult(note, "did:a", "op-1", JSONObject().put(field, "handle-1").put("outcome", "created"))
            val updated = lib.read(note)!!.getJSONObject("ledger").getJSONArray("remote").getJSONObject(0)
            assertEquals(when (kind) { "hosted_create" -> "uploading"; "own_upload" -> "uploaded"; else -> "submitted" },
                updated.getString("stage"))
            lib.delete(note)
            val entry = lib.listOutbox("did:a").getJSONObject(0)
            assertEquals(outKind, entry.getString("kind"))
            assertEquals(if (kind == "own_upload") "lookup" else "pending", entry.getString("state"))
            assertEquals("handle-1", entry.getString("handle"))
            assertEquals(setOf("entryId", "did", "provider", "mode", "kind", "handle", "handleExpiresAt",
                "state", "createdAt", "attempts"), entry.keys().asSequence().toSet())
        }
    }
    @Test fun failedRemoteRequestRemovesItsOpenReceipt() {
        val lib = library(); val note = id(); begin(lib, note); commit(lib, note)
        lib.mutate(note, "claim.write") { it.put("owner", "did:a") }
        val receipt = JSONObject().put("id", note).put("did", "did:a").put("opId", "op-1")
            .put("provider", "ptx").put("mode", JSONObject.NULL).put("kind", "ptx_create")
            .put("fingerprint", "sha256").put("startedAt", 1000)
        lib.beginRemoteOp(receipt)
        assertEquals("ledger", lib.recordRemoteResult(note, "did:a", "op-1", JSONObject().put("outcome", "failed")))
        assertEquals(0, lib.read(note)!!.getJSONObject("ledger").getJSONArray("remote").length())
        lib.delete(note)
        assertEquals(0, lib.listOutbox("did:a").length())
        lib.beginRemoteOp(receipt)
        assertEquals(1, lib.listOutbox("did:a").length())
        assertEquals("outbox", lib.recordRemoteResult(note, "did:a", "op-1", JSONObject().put("outcome", "failed")))
        assertEquals(0, lib.listOutbox("did:a").length())
    }
    @Test fun outboxPathGenericHandlesKeepTheOriginalResourceKind() {
        val cases = listOf(
            Triple("hosted_create", "hosted_upload", "pending"),
            Triple("hosted_submit", "transcript", "pending"),
            Triple("own_upload", "own_upload_lookup", "lookup"),
            Triple("own_create", "transcript", "pending"),
            Triple("ptx_create", "ptx_job", "pending"),
        )
        for ((kind, expectedKind, expectedState) in cases) {
            val lib = library(); val note = id()
            val receipt = JSONObject().put("id", note).put("did", "did:a").put("opId", "op-1")
                .put("provider", if (kind == "ptx_create") "ptx" else "assemblyai")
                .put("mode", if (kind.startsWith("hosted")) "hosted" else if (kind.startsWith("own")) "own" else JSONObject.NULL)
                .put("kind", kind).put("fingerprint", "sha256").put("startedAt", 1000)
            lib.beginRemoteOp(receipt) // No local sidecar: receipt begins directly in the outbox.
            lib.recordRemoteResult(note, "did:a", "op-1",
                JSONObject().put("outcome", "created").put("handle", "remote-handle"))
            val entry = lib.listOutbox("did:a").getJSONObject(0)
            assertEquals(kind, expectedKind, entry.getString("kind"))
            assertEquals(kind, expectedState, entry.getString("state"))
            assertEquals("remote-handle", entry.getString("handle"))
        }
    }
    @Test fun receiptFailpointsAndInterruptedOutboxTransferKeepAnAuthority() {
        val ops = FileOps(); val dir = temp.newFolder(); val lib = RecordingLibrary(dir, ops)
        val note = id(); begin(lib, note); commit(lib, note)
        lib.mutate(note, "claim.write") { it.put("owner", "did:a") }
        val receipt = JSONObject().put("id", note).put("did", "did:a").put("opId", "create-1")
            .put("provider", "ptx").put("mode", JSONObject.NULL).put("kind", "ptx_create")
            .put("fingerprint", "hash").put("startedAt", 1)
        ops.failOnce("receipt.begin")
        expectFailure("receipt.begin") { lib.beginRemoteOp(receipt) }
        assertEquals(0, lib.read(note)!!.getJSONObject("ledger").getJSONArray("remote").length())
        lib.beginRemoteOp(receipt)
        ops.failOnce("receipt.result")
        expectFailure("receipt.result") { lib.recordRemoteResult(note, "did:a", "create-1",
            JSONObject().put("jobId", "job-1").put("outcome", "created")) }
        assertEquals(0, lib.listOutbox("did:a").length())
        ops.failOnce("delete.outbox")
        expectFailure("delete.outbox") { lib.delete(note) }
        assertTrue(lib.tombstone(note).exists())
        val relaunched = RecordingLibrary(dir)
        relaunched.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null })
        assertEquals("unknown", relaunched.listOutbox("did:a").getJSONObject(0).getString("state"))
        assertEquals("outbox", relaunched.recordRemoteResult(note, "did:a", "create-1",
            JSONObject().put("jobId", "job-1").put("outcome", "created")))
        assertEquals("job-1", relaunched.listOutbox("did:a").getJSONObject(0).getString("handle"))
    }
    @Test fun pausedSessionIsParkedUntilTimeoutStopIsJournaled() {
        val lib = library(); val note = id()
        lib.start(note, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS, at = 1_000)
        lib.openFirstSegment(note, 0, 1, at = 1_100)
        lib.append(note, 0, frame)
        lib.checkpoint(note, 0, 23, "recording", "available", close = true, at = 2_000)
        lib.transition(note, "intent", 23, JSONObject().put("value", "paused"), at = 2_000)
        lib.closeSession(note)
        assertEquals(note, lib.parkedSessions().single().first)
        lib.adoptSession(note)
        assertTrue(lib.parkedSessions().isEmpty())
        lib.closeSession(note)
        lib.stopJournal(note, 23, "pause_timeout", at = 3_600_000)
        assertTrue(lib.parkedSessions().isEmpty())
        val committed = lib.commit(note, { it.writeBytes(byteArrayOf(1)) }, recovered = true)
        assertFalse(committed.getBoolean("endedUnexpectedly"))
    }

    @Test fun failedParkedAdoptionCountsCrashesAndDoesNotBlockOtherRecovery() {
        val dir = temp.newFolder(); val parked = id(); val other = id()
        val setup = RecordingLibrary(dir)
        setup.start(parked, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        setup.openFirstSegment(parked, 0, 1)
        setup.append(parked, 0, ByteArray(8) { 0 }) // nonempty but invalid ADTS
        setup.transition(parked, "intent", 0, JSONObject().put("value", "paused"))
        setup.closeSession(parked)
        begin(setup, other); setup.closeSession(other)
        repeat(3) { attempt ->
            val lib = RecordingLibrary(dir)
            assertEquals(parked, lib.parkedSessions().single().first)
            assertTrue(lib.beginParkedAdoption(parked))
            try { CaptureSequence(lib, parked).adoptPaused(); fail("invalid segment was adopted") }
            catch (error: IOException) { lib.failParkedAdoption(parked, error) }
            assertEquals(attempt + 1, lib.failedRecoveryItems().getJSONObject(0).getInt("attempts"))
            lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1, 2, 3)) }, { null })
            assertNotNull("Another orphan must still commit", lib.read(other))
            assertEquals("Failed adoption must not retain a live mark", attempt < 2,
                lib.parkedSessions().isNotEmpty())
        }
        val relaunched = RecordingLibrary(dir)
        assertTrue(relaunched.parkedSessions().isEmpty())
        assertTrue(File(relaunched.quarantine, "$parked.session").isDirectory)
        assertEquals(3, relaunched.failedRecoveryItems().getJSONObject(0).getInt("attempts"))
    }
    @Test fun processDeathDuringParkedAdoptionQuarantinesBeforeAFourthScan() {
        val dir = temp.newFolder(); val parked = id(); val setup = RecordingLibrary(dir)
        setup.start(parked, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        setup.openFirstSegment(parked, 0, 1); setup.append(parked, 0, frame)
        setup.transition(parked, "intent", 23, JSONObject().put("value", "paused"))
        setup.closeSession(parked)
        repeat(3) { attempt ->
            val process = RecordingLibrary(dir)
            assertTrue(process.beginParkedAdoption(parked))
            assertEquals(attempt + 1, RecordingLibrary(dir).failedRecoveryItems()
                .getJSONObject(0).getInt("attempts"))
            // Simulated process death: no acknowledgement or caught exception.
        }
        val nextProcess = RecordingLibrary(dir)
        assertFalse(nextProcess.beginParkedAdoption(parked))
        assertTrue(File(nextProcess.quarantine, "$parked.session").isDirectory)
    }
    @Test fun failedRecordingDiscardRejectsHealthySessionsAndPreventsLegacyResurrection() {
        val lib = library(); val healthy = id()
        lib.start(healthy, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        lib.openFirstSegment(healthy, 0, 1); lib.append(healthy, 0, frame)
        lib.transition(healthy, "intent", 23, JSONObject().put("value", "paused"))
        lib.closeSession(healthy)
        try { lib.discardFailedRecording(healthy); fail("healthy paused session was discarded") }
        catch (error: IllegalStateException) { assertEquals("not_failed_recording", error.message) }
        assertTrue(lib.session(healthy).isDirectory)

        val failed = id(); begin(lib, failed); lib.closeSession(failed)
        repeat(3) {
            expectFailure("Recovery needs retry") {
                lib.recoverOnce({ _, _ -> throw IOException("bad mux") }, { null })
            }
        }
        assertTrue(File(lib.quarantine, "$failed.session").isDirectory)
        lib.audio(failed).writeBytes(byteArrayOf(1, 2, 3)) // crash after m4a rename
        var probes = 0
        lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { probes++; null })
        assertEquals(0, probes)
        lib.discardFailedRecording(failed)
        assertFalse(lib.audio(failed).exists())
        lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { probes++; null })
        assertEquals(0, probes)
    }

    @Test fun startAndRollAndStopFailuresRecoverTwice() {
        for (point in listOf("start.mkdir", "start.journal", "roll.create", "stop.journal")) {
            val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops); val note = id()
            if (point.startsWith("start")) {
                ops.failOnce(point)
                expectFailure(point) { lib.start(note, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS) }
                recoverTwice(lib)
                assertFalse(lib.sidecar(note).exists())
                assertFalse(lib.session(note).exists())
            } else {
                lib.start(note, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
                lib.openFirstSegment(note, 0, 1)
                lib.append(note, 0, frame)
                ops.failOnce(point)
                if (point == "roll.create") expectFailure(point) { lib.roll(note, 1, 100) }
                else expectFailure(point) { lib.stopJournal(note, 100, "user") }
                lib.closeSession(note) // A crashed input no longer owns the session.
                recoverTwice(lib)
                assertEquals(1, lib.read(note)!!.getInt("rev"))
                assertTrue(lib.audio(note).isFile)
            }
        }
    }
    @Test fun segmentWriteAndSyncFailuresRecoverTwiceWithOnlyDurableFrames() {
        for (point in listOf("seg.write", "seg.sync")) {
            val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops); val note = id()
            lib.start(note, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
            lib.openFirstSegment(note, 0, 1)
            lib.append(note, 0, frame)
            ops.failOnce(point)
            if (point == "seg.write") expectFailure(point) { lib.append(note, 0, frame) }
            else expectFailure(point) { lib.checkpoint(note, 0, 100, "recording", "available") }
            lib.closeSession(note)
            recoverTwice(lib)
            assertEquals(1024L * 1000 / SAMPLE_RATE, lib.read(note)!!.getLong("durationMs"))
            assertEquals(1, lib.read(note)!!.getInt("rev"))
        }
    }

    @Test fun mutationAndImportFailuresRecoverTwiceWithoutRevisingPublishedNote() {
        for (point in listOf("claim.write", "ledger.write")) {
            val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops); val note = id()
            begin(lib, note); commit(lib, note)
            val before = lib.sidecar(note).readBytes()
            ops.failOnce(point)
            if (point == "claim.write") expectFailure(point) { lib.claim(note, "did:a", "signed_out_v2") }
            else expectFailure(point) { lib.mutate(note, point) { it.put("marker", true) } }
            recoverTwice(lib)
            assertArrayEquals(before, lib.sidecar(note).readBytes())
            assertTrue(lib.audio(note).isFile)
        }
        val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops); val orphan = id()
        lib.audio(orphan).writeBytes(byteArrayOf(1, 2, 3))
        ops.failOnce("import.sidecar")
        expectFailure("import.sidecar") { lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { file ->
            JSONObject().put("startedAt", 1).put("durationMs", 100).put("mimeType", "audio/mp4").put("sizeBytes", file.length())
        }) }
        recoverTwice(lib)
        assertEquals(1, lib.read(orphan)!!.getInt("rev"))
        assertTrue(lib.audio(orphan).isFile)
    }

    @Test fun tombstoneAndOutboxAndRetireFailuresRecoverTwiceWithoutLosingRemoteHandle() {
        for (point in listOf("delete.tombstone", "delete.outbox", "tombstone.retire")) {
            val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops); val note = id()
            begin(lib, note); commit(lib, note)
            lib.mutate(note, "ledger.write") { side ->
                side.put("owner", "did:a")
                side.getJSONObject("ledger").getJSONArray("remote").put(JSONObject()
                    .put("provider", "assemblyai").put("mode", "hosted")
                    .put("uploadId", "upload-a").put("cleanup", "pending"))
            }
            ops.failOnce(point)
            expectFailure(point) { lib.delete(note) }
            if (point == "delete.tombstone") {
                assertEquals("upload-a", lib.read(note)!!.getJSONObject("ledger")
                    .getJSONArray("remote").getJSONObject(0).getString("uploadId"))
            } else assertTrue(lib.tombstone(note).exists())
            recoverTwice(lib)
            if (point == "delete.tombstone") assertNotNull(lib.read(note))
            else {
                assertFalse(lib.sidecar(note).exists())
                assertFalse(lib.audio(note).exists())
                assertEquals("upload-a", lib.listOutbox("did:a").getJSONObject(0).getString("handle"))
                assertEquals(1, lib.listOutbox("did:a").length())
            }
        }
    }

    @Test fun deletionAtBothStageGatesCannotPublishAndRecoveryTwiceDoesNotResurrect() {
        for (gate in listOf("stage.begin", "stage.afterMux")) {
            val lib = library(); val note = id(); begin(lib, note)
            val entered = CountDownLatch(1); val release = CountDownLatch(1)
            lib.gate(gate) { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
            val worker = Thread { runCatching { commit(lib, note) } }
            worker.start(); assertTrue("$gate not reached", entered.await(5, TimeUnit.SECONDS))
            lib.delete(note); release.countDown(); worker.join(5000)
            assertFalse("$gate commit did not finish", worker.isAlive)
            recoverTwice(lib)
            assertFalse(lib.sidecar(note).exists())
            assertFalse(lib.audio(note).exists())
        }
    }

    @Test fun recoveryCannotRaceANormalCommitForTheSameStagingFile() {
        val lib = library(); val note = id(); begin(lib, note)
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val recovered = CountDownLatch(1)
        lib.gate("stage.begin") { entered.countDown(); release.await(5, TimeUnit.SECONDS) }
        val committing = Thread { commit(lib, note) }
        val recovering = Thread {
            lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(9)) }, { null })
            recovered.countDown()
        }
        committing.start(); assertTrue(entered.await(5, TimeUnit.SECONDS))
        recovering.start()
        assertFalse("recovery raced a live normal commit", recovered.await(100, TimeUnit.MILLISECONDS))
        release.countDown(); committing.join(5000); recovering.join(5000)
        assertFalse(committing.isAlive); assertFalse(recovering.isAlive)
        assertEquals(1, lib.read(note)!!.getInt("rev"))
        assertArrayEquals(byteArrayOf(1, 2, 3), lib.audio(note).readBytes())
        recoverTwice(lib)
    }

    @Test fun modeledPowerLossDropsOnlyUnsyncedFramesWithinHeartbeatBound() {
        class PowerLossOps : FileOps() {
            val durable = HashMap<File, ByteArray>()
            override fun sync(file: File, metadata: Boolean, point: String) {
                super.sync(file, metadata, point)
                if (file.name.endsWith(".aac")) durable[file] = file.readBytes()
            }
            fun crash() { for ((file, bytes) in durable) if (file.exists()) file.writeBytes(bytes) }
        }
        val ops = PowerLossOps(); val dir = temp.newFolder(); val lib = RecordingLibrary(dir, ops); val note = id()
        lib.start(note, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        lib.openFirstSegment(note, 0, 1)
        repeat(90) { lib.append(note, 0, frame) }
        lib.checkpoint(note, 0, 90L * 1024 * 1000 / SAMPLE_RATE, "recording", "available")
        repeat(80) { lib.append(note, 0, frame) } // 1.86 s since the last durable checkpoint.
        ops.crash()
        val relaunched = RecordingLibrary(dir)
        recoverTwice(relaunched)
        assertEquals(90L * 1024 * 1000 / SAMPLE_RATE, relaunched.read(note)!!.getLong("durationMs"))
        assertTrue(80L * 1024 * 1000 / SAMPLE_RATE < 2000)
    }

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
        assertTrue("tombstoned sidecar must not poison list", lib.list().isEmpty())
        lib.tombstone(note).setLastModified(System.currentTimeMillis() - 8L * 24 * 3_600_000)
        val relaunched = RecordingLibrary(dir)
        relaunched.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null })
        assertFalse(relaunched.audio(note).exists()); assertFalse(relaunched.sidecar(note).exists())
        relaunched.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null })
        assertTrue(relaunched.list().isEmpty())
    }
    @Test fun unrecoverableSessionDoesNotHideCommittedNotesOrPreventANewStart() {
        val dir = temp.newFolder(); val lib = RecordingLibrary(dir)
        val saved = id(); begin(lib, saved); commit(lib, saved)
        val broken = id(); begin(lib, broken)
        File(lib.session(broken), "journal.jsonl").appendText("{invalid complete line}\n")
        lib.closeSession(broken) // Simulate the previous process dying.
        repeat(3) {
            val failedIds = mutableListOf<String>()
            try { lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { null },
                onFailure = { failedId, _ -> failedIds.add(failedId) }); fail("recovery must surface the broken session") }
            catch (e: IOException) { assertTrue(e.message!!.contains(broken)) }
            assertEquals(listOf(broken), failedIds)
            assertEquals(saved, lib.list().single().getString("id"))
        }
        val fresh = id()
        lib.start(fresh, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        assertTrue(lib.session(fresh).isDirectory)
        assertTrue(File(lib.quarantine, "$broken.session").isDirectory)
    }
    @Test fun crashDuringRecoveryCountsBeforeTheNextLaunchAndEventuallyQuarantines() {
        val dir = temp.newFolder()
        val first = RecordingLibrary(dir); val note = id(); begin(first, note)
        first.closeSession(note)
        repeat(3) { attempt ->
            // A new process dies after the durable attempt marker, before mux returns.
            RecordingLibrary(dir).beginRecoveryAttempt(note)
            assertEquals(attempt + 1, RecordingLibrary(dir).failedRecoveryItems()
                .getJSONObject(0).getInt("attempts"))
        }
        val relaunched = RecordingLibrary(dir)
        var muxCalls = 0
        relaunched.recoverOnce({ _, out -> muxCalls++; out.writeBytes(byteArrayOf(1)) }, { null })
        assertEquals(0, muxCalls)
        assertFalse(relaunched.session(note).exists())
        assertTrue(File(relaunched.quarantine, "$note.session").isDirectory)
    }
    @Test fun invalidLegacyOrphanIsQuarantinedAndValidImportHasEveryV2Key() {
        val lib = library(); val invalid = id(); val valid = id()
        lib.audio(invalid).writeBytes(byteArrayOf(1, 2, 3))
        lib.audio(valid).writeBytes(byteArrayOf(4, 5, 6))
        lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1)) }, { file ->
            if (file.name.startsWith(invalid)) null else JSONObject().put("startedAt", 10_000)
                .put("durationMs", 800).put("mimeType", "audio/mp4").put("sizeBytes", 3)
        })
        assertTrue(File(lib.quarantine, "$invalid.m4a").isFile)
        val imported = lib.read(valid)!!
        assertTrue(imported.getBoolean("legacyImport"))
        assertTrue(imported.getBoolean("ownerUnknown"))
        assertEquals(1, imported.getInt("rev"))
        for (key in listOf("wallMs", "pausedMs", "spans", "endedUnexpectedly", "lastHeartbeatAt",
            "exitReason", "source", "transitionGen", "options", "input", "sampleRate", "bitrate"))
            assertTrue("missing v2 field $key", imported.has(key))
        assertTrue(lib.sidecar(valid).readText().endsWith("\n"))
    }
    @Test fun sidecarMetricsArePublishedAtRevisionOne() {
        val lib = library(); val note = id(); begin(lib, note)
        lib.commit(note, { it.writeBytes(byteArrayOf(1, 2, 3)) }, metrics = JSONObject()
            .put("silencedMs", 501).put("silencedEvents", 2).put("noSignalMs", 2001))
        val sidecar = lib.read(note)!!
        assertEquals(1, sidecar.getInt("rev"))
        assertEquals(501, sidecar.getInt("silencedMs"))
        assertEquals(2, sidecar.getInt("silencedEvents"))
        assertEquals(2001, sidecar.getInt("noSignalMs"))
    }
    @Test fun everyPublicationBoundaryRecoversTwiceWithoutLosingOrRevisingTheNote() {
        for (point in listOf("stage.write", "publish.m4aRename", "publish.sidecarTmp",
            "publish.sidecarRename", "publish.gc")) {
            val ops = FileOps(); val lib = RecordingLibrary(temp.newFolder(), ops)
            val note = id(); begin(lib, note)
            ops.failOnce(point)
            try { commit(lib, note); fail("$point did not fail") } catch (_: IOException) { }
            lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(1, 2, 3)) }, { null })
            val first = lib.sidecar(note).readBytes()
            assertEquals("$point must publish rev 1", 1, lib.read(note)!!.getInt("rev"))
            lib.recoverOnce({ _, out -> out.writeBytes(byteArrayOf(9)) }, { null })
            assertArrayEquals("$point recovery must be idempotent", first, lib.sidecar(note).readBytes())
            assertTrue("$point lost the committed audio", lib.audio(note).isFile)
        }
    }
    @Test fun tornAdtsTailDoesNotAdvanceAudioTimeOrCheckpointBytes() {
        val lib = library(); val note = id()
        lib.start(note, "in_app", null, 0, defaultOptions(), MAX_DURATION_MS)
        lib.openFirstSegment(note, 0, 1)
        val full = byteArrayOf(0xff.toByte(), 0xf1.toByte(), 0x50, 0x40, 0x01, 0x1f, 0xfc.toByte(), 0)
        lib.append(note, 0, full)
        File(lib.session(note), "seg-00000.aac").appendBytes(full.copyOfRange(0, 5))
        lib.checkpoint(note, 0, 1024L * 1000 / SAMPLE_RATE, "recording", "available")
        assertEquals(full.size.toLong(), lib.events(note).last().getLong("segBytes"))
        lib.stopJournal(note, 1024L * 1000 / SAMPLE_RATE, "user")
        assertEquals(1024L * 1000 / SAMPLE_RATE, commit(lib, note).getLong("durationMs"))
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
        recoverTwice(lib)
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
        recoverTwice(lib)
        assertFalse(lib.sidecar(note).exists()); assertFalse(lib.audio(note).exists())
    }
}
