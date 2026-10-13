package xyz.tinycloud.exo.capture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import xyz.tinycloud.exo.MainActivity
import xyz.tinycloud.exo.R

object CaptureNotifications {
    private const val ALERT_CHANNEL = "capture-alerts"
    private const val ALERT_ID = 7202
    private const val RECOVERED_ID = 7203
    private const val PARKED_ID = 7204
    private fun alertChannel(context: Context): NotificationManager {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26)
            manager.createNotificationChannel(NotificationChannel(ALERT_CHANNEL, context.getString(R.string.capture_alert_channel),
                NotificationManager.IMPORTANCE_HIGH))
        return manager
    }
    fun showRecovered(context: Context, id: String) {
        val open = PendingIntent.getActivity(context, 6,
            Intent(context, MainActivity::class.java).setAction(CaptureService.RECORD)
                .setData(Uri.parse("exo://capture/recovered/$id")),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        alertChannel(context).notify(RECOVERED_ID, NotificationCompat.Builder(context, ALERT_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("Recording recovered")
            .setContentText("Your recording was saved. Record again")
            .setContentIntent(open).setAutoCancel(true).build())
    }
    fun showParked(context: Context, id: String) {
        val open = PendingIntent.getActivity(context, 7,
            Intent(context, MainActivity::class.java).setAction(CaptureService.SHOW_RECORDER)
                .setData(Uri.parse("exo://capture/paused/$id")),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        alertChannel(context).notify(PARKED_ID, NotificationCompat.Builder(context, ALERT_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Recording paused — open Exo to resume")
            .setContentIntent(open).setAutoCancel(true).build())
    }

    fun action(context: Context, value: String, request: Int, status: JSONObject): PendingIntent {
        val id = status.optString("id")
        val epoch = status.optLong("epoch")
        val intent = Intent(context, CaptureService::class.java).setAction(value)
            .setData(Uri.parse("exo://capture/$id/$epoch/$value"))
            .putExtra("id", id).putExtra("epoch", epoch)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return if (Build.VERSION.SDK_INT >= 26) PendingIntent.getForegroundService(context, request, intent, flags)
            else PendingIntent.getService(context, request, intent, flags)
    }

    fun foreground(context: Context, status: JSONObject): Notification {
        val paused = status.optString("state") == "paused"
        val elapsedSeconds = status.optLong("audioMs") / 1000
        val pausedText = if (elapsedSeconds >= 3600) context.getString(R.string.capture_paused_recorded_hours,
            elapsedSeconds / 3600, elapsedSeconds / 60 % 60, elapsedSeconds % 60)
            else context.getString(R.string.capture_paused_recorded, elapsedSeconds / 60, elapsedSeconds % 60)
        val open = PendingIntent.getActivity(context, 1,
            Intent(context, MainActivity::class.java).setAction(CaptureService.SHOW_RECORDER),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(context, "voice-notes")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(if (paused) context.getString(R.string.capture_paused) else context.getString(R.string.capture_recording))
            .setContentText(if (paused) pausedText else context.getString(R.string.capture_running_hint))
            .setContentIntent(open).setOngoing(true).setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setUsesChronometer(!paused).setWhen(System.currentTimeMillis() - status.optLong("elapsedMs"))
            .addAction(0, context.getString(if (paused) R.string.capture_resume else R.string.capture_pause),
                action(context, if (paused) CaptureService.ACTION_RESUME else CaptureService.ACTION_PAUSE, 2, status))
            .addAction(0, context.getString(R.string.capture_stop), action(context, CaptureService.ACTION_STOP, 3, status))
            .build()
    }

    fun showResumeAlert(context: Context, status: JSONObject) {
        if (status.isNull("id") || status.optString("intent") != "recording") return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26)
            manager.createNotificationChannel(NotificationChannel(ALERT_CHANNEL, context.getString(R.string.capture_alert_channel),
                NotificationManager.IMPORTANCE_HIGH))
        val open = PendingIntent.getActivity(context, 4,
            Intent(context, MainActivity::class.java).setAction(CaptureService.SHOW_RECORDER),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        manager.notify(ALERT_ID, NotificationCompat.Builder(context, ALERT_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(context.getString(R.string.capture_tap_to_resume))
            .setContentText(context.getString(when (status.optString("reason")) {
                "resume_not_allowed" -> R.string.capture_resume_not_allowed
                "mic_unavailable" -> R.string.capture_mic_unavailable
                else -> R.string.capture_resume_blocked
            }))
            .setContentIntent(open).setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .addAction(0, context.getString(R.string.capture_resume),
                action(context, CaptureService.ACTION_RESUME, 5, status)).build())
    }

    fun cancelAlert(context: Context) = context.getSystemService(NotificationManager::class.java).cancel(ALERT_ID)
}
