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
}
