package xyz.tinycloud.exo.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import xyz.tinycloud.exo.MainActivity
import xyz.tinycloud.exo.R
import java.util.concurrent.Executors

/** The service enters foreground before CaptureEngine can construct AudioRecord. */
class CaptureService : Service() {
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "ExoCaptureService") }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() { worker.shutdown(); super.onDestroy() }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: return START_NOT_STICKY
        val engine = CaptureEngine.get(this)
        try {
            ensureChannel()
            val type = if (Build.VERSION.SDK_INT >= 30) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
            worker.execute {
                try {
                    val status = engine.status()
                    if (action in listOf(ACTION_PAUSE, ACTION_RESUME, ACTION_STOP, ACTION_DISCARD) &&
                        intent.getStringExtra("id")?.let { it != status.optString("id") } == true) {
                        if (status.isNull("id")) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId) }
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
                        ACTION_STOP -> { engine.stop(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId) }
                        ACTION_DISCARD -> { engine.discard(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId) }
                    }
                } catch (e: Exception) {
                    Log.e("ExoCapture", "Service action $action failed", e)
                    if (action == ACTION_START) engine.startFailed(intent.getStringExtra("commandId"), e)
                    if (engine.status().isNull("id")) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId) }
                    else update()
                }
            }
        } catch (e: Exception) {
            Log.e("ExoCapture", "Service action $action failed", e)
            if (action == ACTION_START) engine.startFailed(intent.getStringExtra("commandId"), e)
            if (engine.status().isNull("id")) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId) }
        }
        return START_NOT_STICKY
    }
    private fun update() { getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification()) }
    private fun notification(): Notification {
        val status = CaptureEngine.get(this).status()
        val paused = status.optString("state") == "paused"
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java).setAction(SHOW_RECORDER),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val toggle = action(if (paused) ACTION_RESUME else ACTION_PAUSE, 2)
        val stop = action(ACTION_STOP, 3)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(if (paused) getString(R.string.capture_paused) else getString(R.string.capture_recording))
            .setContentText(if (paused) getString(R.string.capture_resume_hint) else getString(R.string.capture_running_hint))
            .setContentIntent(open).setOngoing(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setUsesChronometer(!paused).setWhen(System.currentTimeMillis() - status.optLong("elapsedMs"))
            .addAction(0, if (paused) getString(R.string.capture_resume) else getString(R.string.capture_pause), toggle)
            .addAction(0, getString(R.string.capture_stop), stop).build()
    }
    private fun action(value: String, request: Int): PendingIntent {
        val status = CaptureEngine.get(this).status()
        val intent = Intent(this, CaptureService::class.java).setAction(value)
            .putExtra("id", status.optString("id")).putExtra("gen", status.optLong("gen"))
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return if (Build.VERSION.SDK_INT >= 26) PendingIntent.getForegroundService(this, request, intent, flags)
            else PendingIntent.getService(this, request, intent, flags)
    }
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
            val intent = Intent(context, CaptureService::class.java).setAction(action)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
    }
}
