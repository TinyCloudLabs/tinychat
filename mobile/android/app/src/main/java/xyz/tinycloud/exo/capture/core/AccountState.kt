package xyz.tinycloud.exo.capture.core

import org.json.JSONObject
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** The account record is the only source of ownership for a new capture. */
class AccountState(private val root: File, private val ops: FileOps, private val legacy: () -> JSONObject) {
    private val lock = ReentrantLock()
    private val file = File(root, "account-state.json")

    fun read(): JSONObject = lock.withLock {
        if (!file.exists()) {
            // A SharedPreferences acknowledgement predates the durable file. Fail closed until ready reasserts it.
            val old = legacy()
            write(JSONObject().put("status", if (old.optBoolean("hadLegacy", old.has("accountDid"))) "transitioning" else "signed_out")
                .put("accountDid", old.opt("accountDid") ?: JSONObject.NULL)
                .put("transitionGen", old.optLong("transitionGen"))
                .put("options", JSONObject().put("transcriber", "on-device")
                    .put("identifySpeakers", old.optBoolean("identifySpeakers"))))
        }
        JSONObject(file.readText())
    }

    fun write(next: JSONObject) = lock.withLock {
        require(next.optString("status") in setOf("signed_in", "transitioning", "signed_out")) { "invalid_account_state" }
        val old = if (file.exists()) JSONObject(file.readText()) else null
        if (old != null && next.optLong("transitionGen") < old.optLong("transitionGen"))
            throw IllegalStateException("stale_transition")
        val tmp = File(root, "account-state.json.tmp")
        ops.write(tmp, CanonicalJson.line(next), false, "account.tmp")
        ops.rename(tmp, file, "account.rename")
    }
}
