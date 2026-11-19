package xyz.tinycloud.exo.replica

import android.os.StatFs
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** TC-2862 bridge over [ReplicaStoreCore]; see the S1 contract for argument and error semantics. */
@CapacitorPlugin(name = "TinyCloudReplicaStore")
class ReplicaStorePlugin : Plugin() {
    private lateinit var core: ReplicaStoreCore

    override fun load() {
        val dir = File(context.noBackupFilesDir, "tinycloud-replica")
        core = ReplicaStoreCore(dir, KeystoreSecretStore(context), AndroidReplicaDb::open) {
            runCatching { StatFs(dir.apply { mkdirs() }.path).availableBytes }.getOrNull()
        }
    }

    private class BadArgument(message: String) : Exception(message)

    private fun respond(call: PluginCall, block: () -> JSObject) {
        try {
            call.resolve(block())
        } catch (e: ReplicaStoreException) {
            call.reject(e.message, e.code)
        } catch (e: BadArgument) {
            call.reject(e.message, "INVALID_ARGUMENT")
        } catch (e: Exception) {
            call.reject(e.message ?: e.toString(), "IO")
        }
    }

    private fun string(obj: JSONObject, name: String): String? = obj.opt(name) as? String
    private fun requireString(obj: JSONObject, name: String): String = string(obj, name) ?: throw BadArgument("$name must be a string")
    private fun optNumber(obj: JSONObject, name: String): Number? = when (val v = obj.opt(name)) {
        null, JSONObject.NULL -> null
        is Number -> v
        else -> throw BadArgument("$name must be a number")
    }

    @PluginMethod
    fun open(call: PluginCall) = respond(call) {
        val result = core.open(requireString(call.data, "account"), optNumber(call.data, "maxBytes")?.toLong())
        JSObject().put("schemaVersion", result.schemaVersion).put("created", result.created)
    }

    @PluginMethod
    fun close(call: PluginCall) = respond(call) { core.close(); JSObject() }

    @PluginMethod
    fun get(call: PluginCall) = respond(call) {
        JSObject().put("value", core.get(requireString(call.data, "store"), requireString(call.data, "key")) ?: JSObject.NULL)
    }

    @PluginMethod
    fun getMany(call: PluginCall) = respond(call) {
        val array = call.data.opt("keys") as? JSONArray ?: throw BadArgument("keys must be an array")
        val keys = (0 until array.length()).map { array.opt(it) as? String ?: throw BadArgument("keys[$it] must be a string") }
        val values = JSArray()
        for (value in core.getMany(requireString(call.data, "store"), keys)) values.put(value ?: JSObject.NULL)
        JSObject().put("values", values)
    }

    @PluginMethod
    fun list(call: PluginCall) = respond(call) {
        val prefix = when (val p = call.data.opt("prefix")) {
            null, JSONObject.NULL -> null
            is String -> p
            else -> throw BadArgument("prefix must be a string")
        }
        val entries = JSArray()
        for ((key, value) in core.list(requireString(call.data, "store"), prefix, optNumber(call.data, "limit")?.toInt())) {
            entries.put(JSObject().put("key", key).put("value", value))
        }
        JSObject().put("entries", entries)
    }

    @PluginMethod
    fun write(call: PluginCall) = respond(call) {
        val array = call.data.opt("ops") as? JSONArray ?: throw BadArgument("ops must be an array")
        val ops = (0 until array.length()).map { i ->
            val op = array.opt(i) as? JSONObject ?: throw BadArgument("ops[$i] must be an object")
            WriteOp(string(op, "op"), string(op, "store"), string(op, "key"), string(op, "value"))
        }
        core.write(ops)
        JSObject()
    }

    @PluginMethod
    fun estimate(call: PluginCall) = respond(call) {
        val estimate = core.estimate()
        JSObject().put("usedBytes", estimate.usedBytes).put("freeBytes", estimate.freeBytes ?: JSObject.NULL)
    }

    @PluginMethod
    fun wipe(call: PluginCall) = respond(call) { core.wipe(requireString(call.data, "account")); JSObject() }

    @PluginMethod
    fun wipeAll(call: PluginCall) = respond(call) { core.wipeAll(); JSObject() }
}
