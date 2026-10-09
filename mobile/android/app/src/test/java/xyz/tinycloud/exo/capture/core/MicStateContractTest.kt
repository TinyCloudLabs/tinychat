package xyz.tinycloud.exo.capture.core

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class MicStateContractTest {
    private fun source(name: String): String {
        var dir = File(System.getProperty("user.dir") ?: error("Missing test working directory"))
        while (true) {
            val candidate = File(dir, "mobile/android/app/src/main/java/xyz/tinycloud/exo/capture/$name")
            if (candidate.isFile) return candidate.readText()
            dir = dir.parentFile ?: error("Capture source is missing: $name")
        }
    }

    @Test fun everyEmittedReasonMustBeAContractLiteral() {
        val literals = setOf("no_signal", "os_silenced", "input_muted", "call", "user", "interruption",
            "route_change", "media_services_reset", "read_error", "stalled", "app_suspended",
            "writer_stalled", "resume_blocked", "resume_not_allowed", "mic_unavailable",
            "max_duration", "pause_timeout", "disk_full", "write_failed", "permission_revoked")
        assertEquals(literals, MicStateContract.reasons)
        val audio = source("AudioCapture.kt")
        val engine = source("CaptureEngine.kt")
        val audioReasons = Regex("""onError\(MicStateContract\.([A-Z_]+)""").findAll(audio)
            .map { it.groupValues[1] }.toSet()
        assertEquals(setOf("WRITE_FAILED", "READ_ERROR", "WRITER_STALLED", "STALLED"), audioReasons)
        assertEquals(setOf("writer_resumed"), Regex("""onError\("([^"]+)"""").findAll(audio)
            .map { it.groupValues[1] }.toSet()) // Control signal; it publishes null.
        val engineReasons = Regex("""MicStateContract\.([A-Z_]+)""").findAll(engine)
            .map { it.groupValues[1] }.toSet()
        for (name in audioReasons + engineReasons) {
            val value = MicStateContract::class.java.getField(name).get(null) as String
            assertTrue("$name emits an undeclared reason: $value", value in literals)
        }
        assertFalse(Regex("""setMicReason\(\s*"[^"]+"""").containsMatchIn(engine))
        assertFalse(Regex("""setMicState\(\s*[^,]+,\s*"[^"]+"""").containsMatchIn(engine))
        assertNull(MicStateContract.snapshot("idle", null).reason)
        val emittedSnapshots = mutableListOf<MicStateContract.Snapshot>()
        for ((error, detail) in listOf(
            "write_failed" to "codec failed", "writer_stalled" to null,
            "writer_resumed" to null, "stalled" to null,
        )) {
            MicStateContract.dispatchCaptureError(error, detail,
                publish = { reason, extra -> emittedSnapshots += MicStateContract.snapshot("recording", reason, extra) },
                interrupt = { fail("Non-read error requested a read interruption") })
        }
        assertTrue(emittedSnapshots.all { it.reason == null || it.reason in MicStateContract.reasons })
        assertEquals("codec failed", emittedSnapshots.first().detail)
        assertNull(emittedSnapshots[2].reason)
    }

    @Test fun invalidReasonIsLoggedAndClampedWithoutThrowing() {
        val violations = mutableListOf<String>()
        val readError = MicStateContract.snapshot("recording", MicStateContract.READ_ERROR,
            "AudioRecord.read returned -2", violations::add)
        assertEquals(MicStateContract.Snapshot("recording", null, null), readError)
        val unknown = MicStateContract.snapshot("interrupted", "read_failed:-2",
            "AudioRecord.read returned -2", violations::add)
        assertEquals(MicStateContract.Snapshot("interrupted", null, null), unknown)
        assertEquals(2, violations.size)
        assertTrue(violations[0].contains("read_error"))
        assertTrue(violations[1].contains("read_failed:-2"))

        var published: Pair<String?, String?>? = null
        MicStateContract.dispatchCaptureError("read_failed:-2", "raw detail",
            publish = { reason, detail -> published = reason to detail },
            interrupt = { fail("Unknown error requested a read interruption") },
            onViolation = violations::add)
        assertEquals(null to null, published)
        assertEquals(3, violations.size)
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
