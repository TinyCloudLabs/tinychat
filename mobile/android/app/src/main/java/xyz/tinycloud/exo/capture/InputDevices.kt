package xyz.tinycloud.exo.capture

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/** Input ids are stable across a plug cycle; Android's numeric device id is not. */
class InputDevices(private val context: Context) {
    private val manager = context.getSystemService(AudioManager::class.java)
    private val prefs = context.getSharedPreferences("exo.capture.inputs", Context.MODE_PRIVATE)
    @Volatile private var communicationOwner: android.media.AudioRecord? = null
    var selectedId: String?
        get() = prefs.getString("selectedId", null)
        private set(value) { check(prefs.edit().putString("selectedId", value).commit()) { "input_preference_write_failed" } }

    fun devices(): List<AudioDeviceInfo> = manager.getDevices(AudioManager.GET_DEVICES_INPUTS)
        .filter { it.isSource && kind(it) != null }.distinctBy(::id)
    fun id(device: AudioDeviceInfo): String = "${device.type}:${device.productName}"
    fun activeId(record: android.media.AudioRecord?): String? = record?.routedDevice?.let(::id)
    fun activeInput(record: android.media.AudioRecord?): JSONObject? = record?.routedDevice?.let { device ->
        JSONObject().put("id", id(device)).put("name", device.productName.toString())
            .put("kind", kind(device) ?: "other")
    }

    fun list(activeId: String?): JSONObject = JSONObject().put("inputs", JSONArray().also { array ->
        devices().forEach { device -> array.put(JSONObject().put("id", id(device))
            .put("name", device.productName.toString()).put("kind", kind(device))) }
    }).put("selectedId", selectedId ?: JSONObject.NULL).put("activeId", activeId ?: JSONObject.NULL)

    fun select(value: String?) {
        if (value != null) {
            val device = devices().firstOrNull { id(it) == value } ?: throw IllegalArgumentException("input_unavailable")
            if (kind(device) == "bluetooth" && Build.VERSION.SDK_INT >= 31 &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                throw SecurityException("bluetooth_permission_required")
        }
        selectedId = value
    }

    fun preferred(): AudioDeviceInfo? = selectedId?.let { selected ->
        devices().firstOrNull { id(it) == selected }
    }

    @Synchronized fun apply(record: android.media.AudioRecord) {
        val device = preferred() ?: return
        if (kind(device) == "bluetooth" && Build.VERSION.SDK_INT >= 31) {
            if (!manager.setCommunicationDevice(device)) {
                Log.w("ExoCapture", "Could not set communication input ${id(device)}; using system route")
                return
            }
            communicationOwner = record
        }
        if (!record.setPreferredDevice(device)) {
            Log.w("ExoCapture", "Could not apply preferred input ${id(device)}; using system route")
            clearCommunicationDevice(record)
        }
    }

    @Synchronized fun clearCommunicationDevice(record: android.media.AudioRecord) {
        if (communicationOwner !== record) return
        communicationOwner = null
        if (Build.VERSION.SDK_INT >= 31) manager.clearCommunicationDevice()
    }

    private fun kind(device: AudioDeviceInfo): String? = when (device.type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "built_in"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY -> "usb"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> if (Build.VERSION.SDK_INT >= 31) "bluetooth" else null
        AudioDeviceInfo.TYPE_BUS -> "car"
        else -> if (Build.VERSION.SDK_INT >= 31 && device.type == AudioDeviceInfo.TYPE_BLE_HEADSET) "bluetooth" else null
    }
}
