package xyz.tinycloud.exo.voicenotes;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import xyz.tinycloud.exo.MainActivity;

/**
 * Foreground service of type "microphone" held for the length of a recording,
 * so capture continues with the screen off or the app in the background. The
 * OS requires the persistent notification and shows its own mic indicator; the
 * app cannot hide either, which is the point.
 */
public class VoiceNoteService extends Service {

    private static final String CHANNEL_ID = "voice-notes";
    private static final int NOTIFICATION_ID = 7201;

    public static void start(Context context) {
        Intent intent = new Intent(context, VoiceNoteService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, VoiceNoteService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel();
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Recording a voice note")
            .setContentText("Exo is using the microphone. Open Exo to stop.")
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Voice notes", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Exo is recording a voice note");
        manager.createNotificationChannel(channel);
    }
}
