package xyz.tinycloud.exo.capture.core

import org.junit.Assert.*
import org.junit.Test

class MicStateContractTest {
    @Test fun everyEmittedReasonMustBeAContractLiteral() {
        for (reason in MicStateContract.reasons) {
            val state = if (reason == "read_error") "interrupted" else "recording"
            assertEquals(reason, MicStateContract.snapshot(state, reason).reason)
        }
        assertNull(MicStateContract.snapshot("idle", null).reason)
        for (raw in listOf("read_failed:-2", "write_failed: disk full", "writer_resumed")) {
            try {
                MicStateContract.snapshot("recording", raw)
                fail("A raw error was accepted as a mic-state reason: $raw")
            } catch (_: IllegalArgumentException) { }
        }
        try {
            MicStateContract.snapshot("recording", "read_error")
            fail("A transient recording/read_error state was accepted")
        } catch (_: IllegalArgumentException) { }

        val emitted = mutableListOf<MicStateContract.Snapshot>()
        for ((error, detail) in listOf(
            "write_failed" to "codec failed", "writer_stalled" to null,
            "writer_resumed" to null, "stalled" to null,
        )) {
            MicStateContract.dispatchCaptureError(error, detail,
                publish = { reason, extra -> emitted += MicStateContract.snapshot("recording", reason, extra) },
                interrupt = { fail("Non-read error requested a read interruption") })
        }
        assertTrue(emitted.all { it.reason == null || it.reason in MicStateContract.reasons })
        assertEquals("codec failed", emitted.first().detail)
        assertNull(emitted[2].reason)
    }

    @Test fun readFailurePublishesOnlyTheInterruptedStateWithDetail() {
        val emitted = mutableListOf(MicStateContract.snapshot("recording", null))
        MicStateContract.dispatchCaptureError("read_error", "AudioRecord.read returned -2",
            publish = { reason, detail -> emitted += MicStateContract.snapshot("recording", reason, detail) },
            interrupt = { detail -> emitted += MicStateContract.readFailure(detail) })
        assertEquals(listOf(
            MicStateContract.Snapshot("recording", null, null),
            MicStateContract.Snapshot("interrupted", "read_error", "AudioRecord.read returned -2"),
        ), emitted)
    }
}
