package xyz.tinycloud.exo.capture.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class AccountStateTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun freshInstallStartsSignedOut() {
        val state = AccountState(temp.newFolder(), FileOps()) { JSONObject().put("hadLegacy", false) }
        assertEquals("signed_out", state.read().getString("status"))
        assertTrue(state.read().isNull("accountDid"))
    }

    @Test fun migrationAndFailedWritesRemainClosed() {
        val dir = temp.newFolder(); val ops = FileOps()
        val state = AccountState(dir, ops) { JSONObject().put("accountDid", "did:old").put("transitionGen", 3) }
        assertEquals("transitioning", state.read().getString("status"))
        val signedIn = JSONObject().put("status", "signed_in").put("accountDid", "did:new")
            .put("transitionGen", 4).put("options", defaultOptions())
        for (point in listOf("account.tmp", "account.rename")) {
            ops.failOnce(point)
            try { state.write(signedIn); fail("expected $point failure") }
            catch (_: java.io.IOException) { }
            assertEquals("transitioning", AccountState(dir, FileOps()) { JSONObject() }.read().getString("status"))
        }
        state.write(signedIn)
        assertEquals("did:new", AccountState(dir, FileOps()) { JSONObject() }.read().getString("accountDid"))
    }

    @Test fun compensationFailpointLeavesTheDurableAccountTransitioning() {
        val dir = temp.newFolder()
        val state = AccountState(dir, FileOps()) { JSONObject().put("hadLegacy", false) }
        fun write(status: String, generation: Long, failure: String?) {
            AccountStateDebugFailure.check(failure, status, state.read().getString("status"))
            state.write(JSONObject().put("status", status).put("accountDid", "did:test")
                .put("transitionGen", generation).put("options", defaultOptions()))
        }
        write("signed_in", 1, null)
        write("transitioning", 2, "compensation")
        for (status in listOf("signed_out", "signed_in")) {
            try { write(status, 3, "compensation"); fail("$status write succeeded") }
            catch (error: IllegalStateException) { assertEquals("account_state_write_failed", error.message) }
            assertEquals("transitioning", AccountState(dir, FileOps()) { JSONObject() }.read().getString("status"))
        }
        // The isolated step-3 hook still permits compensation.
        try { write("signed_out", 3, "3"); fail("step 3 write succeeded") }
        catch (error: IllegalStateException) { assertEquals("account_state_write_failed", error.message) }
        write("signed_in", 4, "3")
        assertEquals("signed_in", state.read().getString("status"))
    }
}
