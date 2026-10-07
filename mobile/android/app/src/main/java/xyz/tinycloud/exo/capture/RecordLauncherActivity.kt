package xyz.tinycloud.exo.capture

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import xyz.tinycloud.exo.MainActivity
import org.json.JSONObject

/** Visible tile trampoline. Permission requests always happen in MainActivity. */
class RecordLauncherActivity : Activity(), CaptureEngine.Listener {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var store: LaunchCommandStore
    private var pending: LaunchCommandStore.Command? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = LaunchCommandStore(this)
        pending = store.put("RECORD", "tile")
        intent = Intent(intent).setAction(null)
        CaptureEngine.get(this).addListener(this)
    }
    override fun onResume() {
        super.onResume()
        val command = pending ?: return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            startActivity(Intent(this, MainActivity::class.java))
            finish(); return
        }
        CaptureService.startFromVisibleActivity(this, command.id, command.source)
        handler.postDelayed({ if (!isFinishing) showApp() }, 3000)
    }
    override fun event(name: String, data: JSONObject) {
        if (name == "started" && data.optString("commandId") == pending?.id) {
            store.clear(pending!!.id); showApp()
        }
    }
    private fun showApp() {
        startActivity(Intent(this, MainActivity::class.java).setAction(CaptureService.SHOW_RECORDER))
        finish()
    }
    override fun onDestroy() { CaptureEngine.get(this).removeListener(this); super.onDestroy() }
}
