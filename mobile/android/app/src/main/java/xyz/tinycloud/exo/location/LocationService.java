package xyz.tinycloud.exo.location;

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
 * Foreground service of type "location" (TC-524 spike), held while a
 * background capture runs. Declared only in the debug manifest
 * (app/src/debug/AndroidManifest.xml), with the location permissions, so a
 * release build has neither.
 *
 * Started while the app is visible, it keeps "while in use" location access
 * after the user leaves the app: a capture with only the foreground
 * permission keeps receiving fixes, with this notification and the OS
 * location indicator on screen. ACCESS_BACKGROUND_LOCATION is needed only for
 * access without such a service, or for a service the OS (re)starts while the
 * app is not visible (START_STICKY after the process was killed).
 */
public class LocationService extends Service {

    static final String ACTION_STOP = "xyz.tinycloud.exo.location.STOP";
    static final String ACTION_DISMISSED = "xyz.tinycloud.exo.location.DISMISSED";

    private static final String CHANNEL_ID = "location";
    private static final int NOTIFICATION_ID = 7202;

    public static void start(Context context) {
        Intent intent = new Intent(context, LocationService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, LocationService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        LocationTracker tracker = LocationTracker.get(this);
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            tracker.stop("stopped_from_notification");
            return START_NOT_STICKY;
        }
        if (ACTION_DISMISSED.equals(action)) {
            // Android 13+ lets the user swipe a foreground service's notification away (14+ even an ongoing one,
            // except on the lock screen); the service keeps running and stays in the Task Manager. Recorded, not
            // re-posted: hiding it was the user's choice.
            tracker.onNotificationDismissed();
            return START_STICKY;
        }
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
        } catch (RuntimeException e) {
            // Android 12+: ForegroundServiceStartNotAllowedException when (re)started from the background;
            // Android 14+: SecurityException when the location permission the "location" type requires is gone.
            tracker.onServiceRefused(e.getClass().getSimpleName() + ": " + e.getMessage());
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent == null) {
            tracker.resumeAfterRestart();
        } else {
            tracker.onServiceForeground();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        LocationTracker.get(this).onServiceDestroyed();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification() {
        ensureChannel();
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stopIntent = PendingIntent.getService(
            this,
            1,
            new Intent(this, LocationService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent dismissedIntent = PendingIntent.getService(
            this,
            2,
            new Intent(this, LocationService.class).setAction(ACTION_DISMISSED),
            PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Exo is recording your location")
            .setContentText("Saved to your TinyCloud space. Tap Stop to end it.")
            .setContentIntent(contentIntent)
            .setDeleteIntent(dismissedIntent)
            .addAction(0, "Stop", stopIntent)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Location", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Exo is recording your location");
        manager.createNotificationChannel(channel);
    }
}
