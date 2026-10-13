package xyz.tinycloud.exo.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import xyz.tinycloud.exo.R
import java.util.concurrent.Executors

/** The service enters foreground before CaptureEngine can construct AudioRecord. */
class CaptureService : Service() {
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "ExoCaptureService") }
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var observing = false
    private val pauseTick = object : Runnable {
        override fun run() {
            if (!observing) return
            CaptureEngine.get(this@CaptureService).enforcePauseIdleLimit()
            main.postDelayed(this, 1000)
        }
    }
    @Volatile private var foregroundStarted = false
    private val stateListener = object : CaptureEngine.Listener {
        override fun event(name: String, data: org.json.JSONObject) {
            if (name == "micState" && !data.isNull("id")) main.post {
                if (observing && !CaptureEngine.get(this@CaptureService).status().isNull("id")) update()
            }
        }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        if (observing) CaptureEngine.get(this).removeListener(stateListener)
        main.removeCallbacks(pauseTick)
        observing = false
        foregroundStarted = false
        worker.shutdown()
        super.onDestroy()
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: return START_NOT_STICKY
        val engine = CaptureEngine.get(this)
        try {
            ensureChannel()
            if (!observing) { observing = true; engine.addListener(stateListener); main.postDelayed(pauseTick, 1000) }
            if (!foregroundStarted) {
                val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
                foregroundStarted = true
            }
            worker.execute {
                try {
                    val status = engine.status()
                    val recordingAction = action in listOf(ACTION_PAUSE, ACTION_RESUME, ACTION_STOP, ACTION_DISCARD)
                    val idMatches = intent.getStringExtra("id") == status.optString("id") && !status.isNull("id")
                    val epochMatches = intent.hasExtra("epoch") && intent.getLongExtra("epoch", -1) == status.optLong("epoch")
                    if (recordingAction && (!idMatches ||
                            (action in listOf(ACTION_PAUSE, ACTION_RESUME) && !epochMatches))) {
                        if (status.isNull("id")) stopNow(startId)
                        else update()
                        return@execute
                    }
                    // gen is diagnostic; a valid tap remains usable after an automatic retry.
                    when (action) {
                        ACTION_START -> {
                            if (!status.isNull("id")) engine.presentRecorder(intent.getStringExtra("commandId"))
                            else engine.start(intent.getLongExtra("maxDurationMs", 0).takeIf { it > 0 },
                                intent.getStringExtra("options")?.let { org.json.JSONObject(it) },
                                intent.getStringExtra("source") ?: "in_app", intent.getStringExtra("commandId"))
                            update()
                        }
                        ACTION_PAUSE -> { engine.pause(); update() }
                        ACTION_RESUME -> { engine.resume(); update() }
                        ACTION_STOP -> { engine.stop(); stopNow(startId) }
                        ACTION_DISCARD -> { engine.discard(); stopNow(startId) }
                    }
                } catch (e: Exception) {
                    Log.e("ExoCapture", "Service action $action failed", e)
                    if (action == ACTION_START) engine.startFailed(intent.getStringExtra("commandId"), e)
                    if (engine.status().isNull("id")) stopNow(startId)
                    else update()
                }
            }
        } catch (e: Exception) {
            Log.e("ExoCapture", "Service action $action failed", e)
            if (action == ACTION_START) engine.startFailed(intent.getStringExtra("commandId"), e)
            if (engine.status().isNull("id")) stopNow(startId)
        }
        return START_NOT_STICKY
    }
    private fun update() { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification()) }
    private fun stopNow(startId: Int) {
        foregroundStarted = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
    }
    private fun notification(): Notification = CaptureNotifications.foreground(this, CaptureEngine.get(this).status())
    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) manager.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.capture_channel), NotificationManager.IMPORTANCE_LOW))
    }
    companion object {
        const val ACTION_START = "xyz.tinycloud.exo.capture.START"
        const val ACTION_PAUSE = "xyz.tinycloud.exo.capture.PAUSE"
        const val ACTION_RESUME = "xyz.tinycloud.exo.capture.RESUME"
        const val ACTION_STOP = "xyz.tinycloud.exo.capture.STOP"
        const val ACTION_DISCARD = "xyz.tinycloud.exo.capture.DISCARD"
        const val RECORD = "xyz.tinycloud.exo.capture.RECORD"
        const val SHOW_RECORDER = "xyz.tinycloud.exo.capture.SHOW_RECORDER"
        private const val CHANNEL = "voice-notes"
        private const val NOTIFICATION_ID = 7201
        @JvmStatic fun startFromVisibleActivity(context: Context, commandId: String, source: String) {
            val intent = Intent(context, CaptureService::class.java).setAction(ACTION_START)
                .putExtra("commandId", commandId).putExtra("source", source)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
        @JvmStatic fun startFromPlugin(context: Context, maxMs: Long, commandId: String, options: org.json.JSONObject?) {
            val intent = Intent(context, CaptureService::class.java).setAction(ACTION_START)
                .putExtra("maxDurationMs", maxMs).putExtra("source", "in_app").putExtra("commandId", commandId)
                .putExtra("options", options?.toString())
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
        @JvmStatic fun send(context: Context, action: String) {
            val status = CaptureEngine.get(context).status()
            val intent = Intent(context, CaptureService::class.java).setAction(action)
                .putExtra("id", status.optString("id")).putExtra("epoch", status.optLong("epoch"))
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
    }
}
