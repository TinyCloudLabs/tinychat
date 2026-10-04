package xyz.tinycloud.exo.location;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.ActivityManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.PowerManager;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationListenerCompat;
import androidx.core.location.LocationManagerCompat;
import androidx.core.location.LocationRequestCompat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Process-wide owner of location capture (TC-524 spike). The plugin and the
 * foreground service both talk to this one instance, so capture outlives the
 * WebView and survives the activity being destroyed while the service runs.
 *
 * Platform {@link LocationManager} only, through androidx.core's compat
 * wrappers: no Google Play services dependency. On API 31+ the platform
 * "fused" provider is used when the device has one (on Google devices it is
 * backed by Play services' fused location anyway); below that, or without it,
 * GPS (precise permission only) plus network.
 *
 * What the OS lets the app observe, all reported in {@link #snapshot()} and as
 * "state" events: permission level (none / while-in-use / all the time),
 * precise vs approximate, location services on/off and per-provider
 * enable/disable, battery saver and its location mode, Doze, background
 * restriction, notification permission (the FGS notification's visibility),
 * and the app's own visibility. Every change while capture is wanted is also
 * appended to the queue, so the stored trail says why it has gaps.
 */
public final class LocationTracker {

    public interface Listener {
        void onSample(JSONObject sample);

        void onState(JSONObject event);
    }

    static final String MODE_CONTINUOUS = "continuous";
    static final String MODE_LOW_POWER = "low_power";

    private static final String PREFS = "xyz.tinycloud.exo.location";
    private static final String PREF_INSTALL_ID = "installId";
    private static final String PREF_DESIRED = "desired";
    private static final String PREF_MODE = "mode";
    private static final String PREF_BACKGROUND = "background";
    private static final String PREF_PROVIDER = "provider";
    private static final String PREF_INTERVAL = "intervalMs";
    private static final String PREF_DISTANCE = "distanceM";
    private static final String PREF_STARTED_AT = "startedAt";
    private static final String PREF_LAST_SAMPLE_AT = "lastSampleAt";
    private static final String PREF_LAST_STOP_REASON = "lastStopReason";

    @SuppressLint("StaticFieldLeak") // application context only
    private static LocationTracker instance;

    public static synchronized LocationTracker get(Context context) {
        if (instance == null) instance = new LocationTracker(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final LocationManager locationManager;
    private final LocationQueue queue;
    private final Map<String, LocationListenerCompat> listeners = new HashMap<>();
    private Listener listener;
    private JSONObject lastSummary;
    private boolean appVisible;
    private boolean serviceRunning;
    private long sessionSamples;

    /** What an ungranted permission should read as; the plugin knows (Capacitor tracks "don't ask again"). */
    volatile String ungrantedForeground = "prompt";

    private LocationTracker(Context context) {
        this.context = context;
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.locationManager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        this.queue = new LocationQueue(context);
        if (prefs.getString(PREF_INSTALL_ID, null) == null) {
            prefs.edit().putString(PREF_INSTALL_ID, UUID.randomUUID().toString()).apply();
        }
        lastSummary = summary();
        registerOsReceivers();
        if (prefs.getBoolean(PREF_DESIRED, false)) {
            // Capture was on when this process died (killed for memory, a permission revoked in Settings, a
            // crash, an update). Nothing was delivered in between; say so in the trail. A background capture's
            // service resumes through resumeAfterRestart() if the OS restarts it (START_STICKY); a
            // foreground-only capture died with the activity and is over.
            recordEvent("tracking", "process_restarted", null);
            if (!prefs.getBoolean(PREF_BACKGROUND, true)) {
                prefs.edit().putBoolean(PREF_DESIRED, false).putString(PREF_LAST_STOP_REASON, "process_restarted").apply();
            }
        }
    }

    // ── Control ─────────────────────────────────────────────────────────────

    public synchronized void setListener(Listener listener) {
        this.listener = listener;
    }

    /** Start capture; the caller has checked the foreground permission. */
    synchronized void start(String mode, boolean background, String provider, long intervalMs, float distanceM) {
        stopUpdates();
        prefs
            .edit()
            .putBoolean(PREF_DESIRED, true)
            .putString(PREF_MODE, mode)
            .putBoolean(PREF_BACKGROUND, background)
            .putString(PREF_PROVIDER, provider)
            .putLong(PREF_INTERVAL, intervalMs)
            .putFloat(PREF_DISTANCE, distanceM)
            .putLong(PREF_STARTED_AT, System.currentTimeMillis())
            .remove(PREF_LAST_STOP_REASON)
            .apply();
        sessionSamples = 0;
        recordEvent("tracking", "started", null);
        if (background) {
            // Updates begin once the service is in the foreground (onServiceForeground): Android 14+ requires the
            // FGS to be started while the app is visible, which it is (the user just tapped Start).
            LocationService.start(context);
        } else {
            LocationService.stop(context);
            requestUpdates();
        }
    }

    synchronized void stop(String reason) {
        boolean wasDesired = prefs.getBoolean(PREF_DESIRED, false);
        prefs.edit().putBoolean(PREF_DESIRED, false).putString(PREF_LAST_STOP_REASON, reason).apply();
        stopUpdates();
        LocationService.stop(context);
        if (wasDesired) recordEvent("tracking", reason, null);
    }

    synchronized void onServiceForeground() {
        serviceRunning = true;
        if (prefs.getBoolean(PREF_DESIRED, false)) {
            requestUpdates();
        } else {
            // Stopped between startForegroundService() and the service reaching the foreground.
            LocationService.stop(context);
        }
    }

    /** START_STICKY restart after the OS killed the process: try to carry on, and record that it happened. */
    synchronized void resumeAfterRestart() {
        serviceRunning = true;
        if (!prefs.getBoolean(PREF_DESIRED, false)) {
            LocationService.stop(context);
            return;
        }
        recordEvent("tracking", "restarted_by_os", null);
        requestUpdates();
    }

    /** The FGS could not enter the foreground (Android 12+ background-start or 14+ type preconditions). */
    synchronized void onServiceRefused(String message) {
        serviceRunning = false;
        prefs.edit().putBoolean(PREF_DESIRED, false).putString(PREF_LAST_STOP_REASON, "fgs_start_denied").apply();
        stopUpdates();
        recordEvent("tracking", "fgs_start_denied", message);
    }

    synchronized void onServiceDestroyed() {
        serviceRunning = false;
        if (prefs.getBoolean(PREF_DESIRED, false) && prefs.getBoolean(PREF_BACKGROUND, false)) {
            // Not stopped by us: the service went away under a capture that should still be running.
            prefs.edit().putBoolean(PREF_DESIRED, false).putString(PREF_LAST_STOP_REASON, "service_destroyed").apply();
            stopUpdates();
            recordEvent("tracking", "service_destroyed", null);
        }
    }

    synchronized void onNotificationDismissed() {
        recordEvent("notifications", "notification_dismissed", null);
    }

    synchronized void setAppVisible(boolean visible) {
        appVisible = visible;
        checkOsState();
    }

    /** Re-read everything the OS reports and emit a "state" event if any of it changed. */
    synchronized void checkOsState() {
        JSONObject now = summary();
        List<String> changed = diff(lastSummary, now);
        if (changed.isEmpty()) return;
        lastSummary = now;
        recordEvent(changeKind(changed), null, changed);
    }

    // ── Reading ─────────────────────────────────────────────────────────────

    List<JSONObject> pending(int limit) {
        return queue.read(limit);
    }

    int ack(long throughSeq) {
        return queue.ack(throughSeq);
    }

    String installId() {
        return prefs.getString(PREF_INSTALL_ID, "");
    }

    boolean hasForegroundPermission() {
        return granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    boolean hasBackgroundPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return hasForegroundPermission();
        return granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
    }

    /** Full status for JS: OS state, what this build declares, capture state and the queue. */
    synchronized JSONObject snapshot() {
        JSONObject s = summary();
        try {
            s.put("platform", "android");
            s.put("installId", installId());
            s.put("backgroundRequest", backgroundRequest());
            JSONObject declared = new JSONObject();
            declared.put("foreground", declares(Manifest.permission.ACCESS_COARSE_LOCATION));
            declared.put("precise", declares(Manifest.permission.ACCESS_FINE_LOCATION));
            declared.put("background", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || declares(Manifest.permission.ACCESS_BACKGROUND_LOCATION));
            declared.put("backgroundExecution", declaresService());
            s.put("declared", declared);

            JSONObject android = new JSONObject();
            android.put("sdkInt", Build.VERSION.SDK_INT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                CharSequence label = context.getPackageManager().getBackgroundPermissionOptionLabel();
                android.put("backgroundOptionLabel", label == null ? JSONObject.NULL : label.toString());
            }
            JSONObject providers = new JSONObject();
            for (String name : locationManager.getAllProviders()) {
                providers.put(name, locationManager.isProviderEnabled(name));
            }
            android.put("providers", providers);
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            android.put("ignoringBatteryOptimizations", pm.isIgnoringBatteryOptimizations(context.getPackageName()));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
                android.put("backgroundRestricted", am.isBackgroundRestricted());
            }
            s.put("android", android);

            JSONObject tracking = new JSONObject();
            tracking.put("desired", prefs.getBoolean(PREF_DESIRED, false));
            tracking.put("active", !listeners.isEmpty());
            tracking.put("mode", prefs.getString(PREF_MODE, MODE_CONTINUOUS));
            tracking.put("background", prefs.getBoolean(PREF_BACKGROUND, true));
            tracking.put("sources", new JSONArray(listeners.keySet()));
            tracking.put("intervalMs", prefs.getLong(PREF_INTERVAL, 0));
            tracking.put("distanceM", prefs.getFloat(PREF_DISTANCE, 0));
            tracking.put("startedAt", nullable(prefs.getLong(PREF_STARTED_AT, 0)));
            tracking.put("lastSampleAt", nullable(prefs.getLong(PREF_LAST_SAMPLE_AT, 0)));
            tracking.put("sessionSamples", sessionSamples);
            tracking.put("foregroundService", serviceRunning);
            tracking.put("pausedByOs", false);
            tracking.put("lastStopReason", prefs.getString(PREF_LAST_STOP_REASON, null) == null ? JSONObject.NULL : prefs.getString(PREF_LAST_STOP_REASON, null));
            s.put("tracking", tracking);

            JSONObject q = new JSONObject();
            q.put("pending", queue.size());
            q.put("dropped", queue.dropped());
            s.put("queue", q);
        } catch (JSONException e) {
            // Every value above is a plain JSON value; unreachable.
        }
        return s;
    }

    // ── Location updates ────────────────────────────────────────────────────

    @SuppressLint("MissingPermission") // checked by hasForegroundPermission(); SecurityException is caught per provider
    private void requestUpdates() {
        stopUpdates();
        if (!hasForegroundPermission()) {
            recordEvent("error", "no_permission", null);
            return;
        }
        String mode = prefs.getString(PREF_MODE, MODE_CONTINUOUS);
        long intervalMs = prefs.getLong(PREF_INTERVAL, 10_000);
        float distanceM = prefs.getFloat(PREF_DISTANCE, 0);
        boolean fine = granted(Manifest.permission.ACCESS_FINE_LOCATION);
        int quality = MODE_LOW_POWER.equals(mode)
            ? LocationRequestCompat.QUALITY_LOW_POWER
            : (fine ? LocationRequestCompat.QUALITY_HIGH_ACCURACY : LocationRequestCompat.QUALITY_BALANCED_POWER_ACCURACY);
        LocationRequestCompat request = new LocationRequestCompat.Builder(intervalMs)
            .setQuality(quality)
            .setMinUpdateDistanceMeters(distanceM)
            .setMinUpdateIntervalMillis(Math.min(intervalMs, 5_000))
            .build();
        for (String provider : resolveProviders(prefs.getString(PREF_PROVIDER, "auto"), mode, fine)) {
            LocationListenerCompat l = providerListener(provider);
            try {
                LocationManagerCompat.requestLocationUpdates(
                    locationManager,
                    provider,
                    request,
                    ContextCompat.getMainExecutor(context),
                    l
                );
                listeners.put(provider, l);
            } catch (SecurityException | IllegalArgumentException e) {
                recordEvent("error", "provider_refused:" + provider, e.getMessage());
            }
        }
        if (listeners.isEmpty()) recordEvent("error", "no_provider", null);
    }

    @SuppressLint("MissingPermission") // removing updates needs no permission; a revoked one must not crash Stop
    private void stopUpdates() {
        for (LocationListenerCompat l : listeners.values()) {
            try {
                LocationManagerCompat.removeUpdates(locationManager, l);
            } catch (SecurityException e) {
                // The permission was revoked; the OS has already dropped the registration.
            }
        }
        listeners.clear();
    }

    private List<String> resolveProviders(String requested, String mode, boolean fine) {
        List<String> all = locationManager.getAllProviders();
        List<String> out = new ArrayList<>();
        if (!"auto".equals(requested)) {
            if (all.contains(requested)) out.add(requested);
            return out;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && all.contains(LocationManager.FUSED_PROVIDER)) {
            out.add(LocationManager.FUSED_PROVIDER);
            return out;
        }
        if (MODE_CONTINUOUS.equals(mode) && fine && all.contains(LocationManager.GPS_PROVIDER)) out.add(LocationManager.GPS_PROVIDER);
        if (all.contains(LocationManager.NETWORK_PROVIDER)) out.add(LocationManager.NETWORK_PROVIDER);
        if (out.isEmpty() && all.contains(LocationManager.PASSIVE_PROVIDER)) out.add(LocationManager.PASSIVE_PROVIDER);
        return out;
    }

    private LocationListenerCompat providerListener(String provider) {
        return new LocationListenerCompat() {
            @Override
            public void onLocationChanged(@NonNull Location location) {
                onSample(location);
            }

            @Override
            public void onProviderEnabled(@NonNull String name) {
                recordEvent("provider", "provider_enabled:" + name, null);
            }

            @Override
            public void onProviderDisabled(@NonNull String name) {
                recordEvent("provider", "provider_disabled:" + name, null);
            }
        };
    }

    private synchronized void onSample(Location location) {
        JSONObject sample = new JSONObject();
        try {
            sample.put("kind", "sample");
            sample.put("at", location.getTime());
            sample.put("receivedAt", System.currentTimeMillis());
            sample.put("lat", location.getLatitude());
            sample.put("lon", location.getLongitude());
            sample.put("accuracyM", location.hasAccuracy() ? location.getAccuracy() : JSONObject.NULL);
            sample.put("altitudeM", location.hasAltitude() ? location.getAltitude() : JSONObject.NULL);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy()) {
                sample.put("verticalAccuracyM", location.getVerticalAccuracyMeters());
            }
            sample.put("speedMps", location.hasSpeed() ? location.getSpeed() : JSONObject.NULL);
            sample.put("bearingDeg", location.hasBearing() ? location.getBearing() : JSONObject.NULL);
            sample.put("provider", location.getProvider() == null ? JSONObject.NULL : location.getProvider());
            sample.put("mock", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? location.isMock() : location.isFromMockProvider());
            sample.put("accuracyAuthorization", granted(Manifest.permission.ACCESS_FINE_LOCATION) ? "precise" : "approximate");
            sample.put("mode", prefs.getString(PREF_MODE, MODE_CONTINUOUS));
            sample.put("appVisible", appVisible);
        } catch (JSONException e) {
            return;
        }
        queue.append(sample);
        sessionSamples++;
        prefs.edit().putLong(PREF_LAST_SAMPLE_AT, System.currentTimeMillis()).apply();
        if (listener != null) listener.onSample(sample);
    }

    // ── OS state ────────────────────────────────────────────────────────────

    private void registerOsReceivers() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(LocationManager.MODE_CHANGED_ACTION);
        filter.addAction(LocationManager.PROVIDERS_CHANGED_ACTION);
        filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        filter.addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                checkOsState();
            }
        };
        // System broadcasts still reach a not-exported receiver.
        ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    /** The fields whose changes are events; also the snapshot's top level. */
    private JSONObject summary() {
        JSONObject s = new JSONObject();
        try {
            s.put("permission", permissionLevel());
            s.put("accuracy", hasForegroundPermission() ? (granted(Manifest.permission.ACCESS_FINE_LOCATION) ? "precise" : "approximate") : JSONObject.NULL);
            s.put("servicesEnabled", LocationManagerCompat.isLocationEnabled(locationManager));
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            s.put("lowPowerMode", pm.isPowerSaveMode());
            s.put("locationPowerSaveMode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? locationPowerSaveMode(pm.getLocationPowerSaveMode()) : JSONObject.NULL);
            s.put("deviceIdle", pm.isDeviceIdleMode());
            s.put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled());
            s.put("appVisible", appVisible);
        } catch (JSONException e) {
            // unreachable
        }
        return s;
    }

    private String permissionLevel() {
        if (!hasForegroundPermission()) return ungrantedForeground;
        return hasBackgroundPermission() ? "background" : "foreground";
    }

    /** What asking for "all the time" would do right now. */
    private String backgroundRequest() {
        if (hasBackgroundPermission()) return "granted";
        if (!hasForegroundPermission()) return "foreground_first";
        // Android 10 offers "Allow all the time" in a dialog; 11+ only on the app's location page in Settings.
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? "settings" : "dialog";
    }

    private static String locationPowerSaveMode(int mode) {
        switch (mode) {
            case PowerManager.LOCATION_MODE_GPS_DISABLED_WHEN_SCREEN_OFF:
                return "gps_disabled_when_screen_off";
            case PowerManager.LOCATION_MODE_ALL_DISABLED_WHEN_SCREEN_OFF:
                return "all_disabled_when_screen_off";
            case PowerManager.LOCATION_MODE_FOREGROUND_ONLY:
                return "foreground_only";
            case PowerManager.LOCATION_MODE_THROTTLE_REQUESTS_WHEN_SCREEN_OFF:
                return "throttle_requests_when_screen_off";
            default:
                return "no_change";
        }
    }

    private static List<String> diff(JSONObject before, JSONObject after) {
        List<String> changed = new ArrayList<>();
        for (String key : Arrays.asList(
            "permission",
            "accuracy",
            "servicesEnabled",
            "lowPowerMode",
            "locationPowerSaveMode",
            "deviceIdle",
            "notificationsEnabled",
            "appVisible"
        )) {
            if (!String.valueOf(before.opt(key)).equals(String.valueOf(after.opt(key)))) changed.add(key);
        }
        return changed;
    }

    private static String changeKind(List<String> changed) {
        if (changed.contains("permission")) return "permission";
        if (changed.contains("accuracy")) return "accuracy";
        if (changed.contains("servicesEnabled")) return "services";
        if (changed.contains("notificationsEnabled")) return "notifications";
        if (changed.contains("appVisible")) return "visibility";
        return "power";
    }

    /**
     * One "state" event: always to JS (when listening), and into the queue while capture is wanted, so the
     * stored trail carries the reasons for its gaps.
     */
    private synchronized void recordEvent(String change, String reason, Object detail) {
        JSONObject event = new JSONObject();
        try {
            event.put("kind", "state");
            event.put("at", System.currentTimeMillis());
            event.put("change", change);
            event.put("reason", reason == null ? JSONObject.NULL : reason);
            if (detail instanceof List) {
                event.put("changed", new JSONArray((List<?>) detail));
            } else if (detail != null) {
                event.put("detail", String.valueOf(detail));
            }
            event.put("state", lastSummary = summary());
        } catch (JSONException e) {
            return;
        }
        boolean trackingEvent = "tracking".equals(change);
        if (prefs.getBoolean(PREF_DESIRED, false) || trackingEvent) queue.append(event);
        if (listener != null) listener.onState(event);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean declares(String permission) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
            return info.requestedPermissions != null && Arrays.asList(info.requestedPermissions).contains(permission);
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    /** The location FGS is declared only by the debug manifest (src/debug): release builds cannot capture. */
    private boolean declaresService() {
        try {
            context.getPackageManager().getServiceInfo(new ComponentName(context, LocationService.class), 0);
            return Build.VERSION.SDK_INT < 34 || declares("android.permission.FOREGROUND_SERVICE_LOCATION");
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    private static Object nullable(long value) {
        return value == 0 ? JSONObject.NULL : value;
    }
}
