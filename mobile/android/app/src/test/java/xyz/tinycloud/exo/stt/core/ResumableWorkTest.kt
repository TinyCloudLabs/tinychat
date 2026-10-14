package xyz.tinycloud.exo.stt.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResumableWorkTest {
    private fun note(transcriber: String, state: String, requested: Boolean? = null) = JSONObject()
        .put("options", JSONObject().put("transcriber", transcriber))
        .put("stt", JSONObject().put("state", state).also { if (requested != null) it.put("requested", requested) })

    @Test fun aNoteCommittedToOnDeviceIsOwedWhileUnfinished() {
        for (state in listOf("waiting_for_model", "queued", "running")) assertTrue(ResumableWork.owed(note("on-device", state)))
        for (state in listOf("done", "failed", "cancelled")) assertFalse(ResumableWork.owed(note("on-device", state)))
    }

    @Test fun aNoteCommittedElsewhereIsNotOwedUntilTheUserChoseLocal() {
        for (mode in listOf("off", "private-cloud")) {
            assertFalse(ResumableWork.owed(note(mode, "waiting_for_model")))
            assertFalse(ResumableWork.owed(note(mode, "running")))
        }
    }

    @Test fun aLocalChoiceOnAnOffOrPrivateNoteIsOwedThroughAMissingModelAndARunningAttempt() {
        for (mode in listOf("off", "private-cloud")) for (state in listOf("waiting_for_model", "queued", "running")) {
            assertTrue(ResumableWork.owed(note(mode, state, requested = true)))
        }
    }

    @Test fun aFinishedAttemptIsNeverOwedWhateverWasRequested() {
        for (state in listOf("done", "failed", "cancelled")) assertFalse(ResumableWork.owed(note("off", state, requested = true)))
    }

    @Test fun anEnqueueWritesAFreshAttemptAndTheChoice() {
        val stt = ResumableWork.requested(JSONObject().put("state", "failed").put("error", "decode_failed").put("attempts", 3))
        assertEquals("queued", stt.getString("state"))
        assertTrue(stt.isNull("error"))
        assertEquals(0, stt.getInt("attempts"))
        assertTrue(stt.getBoolean("requested"))
        assertTrue(ResumableWork.owed(JSONObject().put("options", JSONObject().put("transcriber", "off")).put("stt", stt)))
    }
    @Test fun anExplicitRerunIsNotResumedAfterRelaunch() {
        val stt = ResumableWork.rerun(JSONObject().put("state", "done"), 7, 6, "base-hash")
        assertEquals(7, stt.getInt("rerunRev"))
        assertEquals(6, stt.getInt("rerunBaseRev"))
        assertEquals("base-hash", stt.getString("rerunBaseHash"))
        assertFalse(ResumableWork.owed(JSONObject().put("options", JSONObject().put("transcriber", "on-device")).put("stt", stt)))
    }

    @Test fun interruptedRerunsAreCancelledAndTheirMarkerCleared() {
        for (state in listOf("queued", "running")) {
            val stt = ResumableWork.rerun(JSONObject().put("state", state), 7, 6, "base-hash")
            assertTrue(ResumableWork.cancelInterruptedRerun(stt))
            assertEquals("cancelled", stt.getString("state"))
            assertTrue(stt.isNull("rerunRev"))
            assertTrue(stt.isNull("rerunBaseRev"))
            assertTrue(stt.isNull("rerunBaseHash"))
        }
    }

    @Test fun rerunsWithoutAnInterruptedQueueStateAreLeftAlone() {
        val stt = ResumableWork.rerun(JSONObject().put("state", "done"), 7, 6, "base-hash")
        assertFalse(ResumableWork.cancelInterruptedRerun(stt))
        assertEquals(7, stt.getInt("rerunRev"))
    }
}
