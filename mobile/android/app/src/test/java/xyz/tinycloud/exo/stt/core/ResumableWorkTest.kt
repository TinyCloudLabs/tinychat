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
}
