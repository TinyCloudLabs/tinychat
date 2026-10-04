package xyz.tinycloud.exo.location;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * JS bridge for the TC-524 location spike. Contract (shared with iOS and the TS
 * definitions in frontend/src/lib/location/nativeLocation.ts):
 *
 *   status()                                  → LocationStatus
 *   requestPermission({ level, precise? })    → LocationStatus after the OS prompt (or Settings) returns
 *   openSettings()                            → {} (the app's page in system Settings)
 *   start({ mode, background, provider?, intervalMs?, distanceM? }) → LocationStatus
 *   stop()                                    → LocationStatus
 *   pending({ limit? })                       → { entries: [sample | state event], pending }
 *   ack({ throughSeq })                       → { pending }
 *   events: "sample" (a fix), "state" (an OS-reported change, or capture starting/stopping)
 *
 * Nothing asks for location by itself: the web layer calls requestPermission
 * for each step, foreground first, then (separately) background. The
 * permissions exist only in the debug manifest; a release build reports
 * declared.foreground = false and refuses to start.
 */
@CapacitorPlugin(
    name = "Location",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "coarseLocation", strings = { Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "backgroundLocation", strings = { "android.permission.ACCESS_BACKGROUND_LOCATION" }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class LocationPlugin extends Plugin {

    private static final String PREFS = "xyz.tinycloud.exo.location.plugin";
    private static final String PREF_NOTIFICATIONS_ASKED = "notificationPermissionAsked";

    private LocationTracker tracker;

    @Override
    public void load() {
        tracker = LocationTracker.get(getContext());
        refreshUngrantedState();
        tracker.setListener(
            new LocationTracker.Listener() {
                @Override
                public void onSample(JSONObject sample) {
                    notifyListeners("sample", toJS(sample));
                }

                @Override
                public void onState(JSONObject event) {
                    notifyListeners("state", toJS(event), true);
                }
            }
        );
    }

    // The activity's visibility is part of what the trail records: Android stops delivering to an app with
    // only "while in use" access once it is not visible and holds no location foreground service.
    @Override
    protected void handleOnStart() {
        if (tracker != null) tracker.setAppVisible(true);
    }

    @Override
    protected void handleOnStop() {
        if (tracker != null) tracker.setAppVisible(false);
    }

    // Permissions changed in Settings show up here (a revoke kills the process instead).
    @Override
    protected void handleOnResume() {
        if (tracker == null) return;
        refreshUngrantedState();
        tracker.checkOsState();
    }

    @PluginMethod
    public void status(PluginCall call) {
        refreshUngrantedState();
        call.resolve(toJS(tracker.snapshot()));
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        String level = call.getString("level", "foreground");
        if (!tracker.snapshot().optJSONObject("declared").optBoolean("foreground")) {
            call.reject("This build does not declare location permissions (the spike is debug-only)", "not_declared");
            return;
        }
        if ("background".equals(level)) {
            if (!tracker.hasForegroundPermission()) {
                call.reject("Grant location while using the app first", "foreground_first");
                return;
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || tracker.hasBackgroundPermission()) {
                status(call);
                return;
            }
            // Android 11+: this opens the app's location page in Settings ("Allow all the time"); there is no
            // dialog. Android 10: a dialog with "Allow all the time".
            requestPermissionForAlias("backgroundLocation", call, "afterPermission");
            return;
        }
        boolean precise = Boolean.TRUE.equals(call.getBoolean("precise", true));
        // Requesting FINE + COARSE together is what makes Android 12+ show the precise/approximate choice.
        requestPermissionForAlias(precise ? "location" : "coarseLocation", call, "afterPermission");
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        refreshUngrantedState();
        tracker.checkOsState();
        call.resolve(toJS(tracker.snapshot()));
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!tracker.hasForegroundPermission()) {
            call.reject("Location permission is not granted", "permission_required");
            return;
        }
        boolean background = Boolean.TRUE.equals(call.getBoolean("background", true));
        if (background && !tracker.snapshot().optJSONObject("declared").optBoolean("backgroundExecution")) {
            call.reject("This build does not declare the location foreground service", "not_declared");
            return;
        }
        // The foreground service's notification is the user-visible half of the transparency story; on Android
        // 13+ it is hidden without POST_NOTIFICATIONS. Ask once, never block on the answer (the service still
        // shows in the Task Manager and the OS location indicator still shows).
        if (background && shouldAskForNotifications()) {
            preferences().edit().putBoolean(PREF_NOTIFICATIONS_ASKED, true).apply();
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        startCapture(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        startCapture(call);
    }

    private void startCapture(PluginCall call) {
        String mode = call.getString("mode", LocationTracker.MODE_CONTINUOUS);
        if (!LocationTracker.MODE_CONTINUOUS.equals(mode) && !LocationTracker.MODE_LOW_POWER.equals(mode)) {
            call.reject("Unknown mode " + mode, "bad_request");
            return;
        }
        boolean lowPower = LocationTracker.MODE_LOW_POWER.equals(mode);
        long intervalMs = (long) number(call, "intervalMs", lowPower ? 300_000 : 10_000);
        float distanceM = (float) number(call, "distanceM", lowPower ? 100 : 0);
        String provider = call.getString("provider", "auto");
        boolean background = Boolean.TRUE.equals(call.getBoolean("background", true));
        try {
            tracker.start(mode, background, provider, Math.max(1_000L, intervalMs), Math.max(0f, distanceM));
        } catch (RuntimeException e) {
            call.reject("Could not start location capture: " + e.getMessage(), "start_failed", e);
            return;
        }
        call.resolve(toJS(tracker.snapshot()));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        tracker.stop("stopped");
        call.resolve(toJS(tracker.snapshot()));
    }

    @PluginMethod
    public void pending(PluginCall call) {
        int limit = (int) Math.max(1, Math.min(1_000, number(call, "limit", 200)));
        List<JSONObject> entries = tracker.pending(limit);
        JSArray out = new JSArray();
        for (JSONObject entry : entries) out.put(entry);
        JSObject ret = new JSObject();
        ret.put("entries", out);
        ret.put("pending", tracker.snapshot().optJSONObject("queue").optInt("pending"));
        call.resolve(ret);
    }

    @PluginMethod
    public void ack(PluginCall call) {
        double throughSeq = number(call, "throughSeq", -1);
        if (throughSeq < 0) {
            call.reject("throughSeq is required", "bad_request");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("pending", tracker.ack((long) throughSeq));
        call.resolve(ret);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /** Capacitor remembers a "don't ask again" denial; an ungranted permission reads as "denied" then. */
    private void refreshUngrantedState() {
        PermissionState coarse = getPermissionState("coarseLocation");
        tracker.ungrantedForeground = coarse == PermissionState.DENIED ? "denied" : "prompt";
    }

    /** A JS number argument: JSON parses it as Integer, Long or Double, and PluginCall.getLong only takes Long. */
    private static double number(PluginCall call, String name, double fallback) {
        Object value = call.getData().opt(name);
        return value instanceof Number ? ((Number) value).doubleValue() : fallback;
    }

    private boolean shouldAskForNotifications() {
        return (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED &&
            !preferences().getBoolean(PREF_NOTIFICATIONS_ASKED, false)
        );
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static JSObject toJS(JSONObject object) {
        try {
            return JSObject.fromJSONObject(object);
        } catch (JSONException e) {
            return new JSObject();
        }
    }
}
