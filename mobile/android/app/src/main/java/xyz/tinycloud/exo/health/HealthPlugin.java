package xyz.tinycloud.exo.health;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.health.connect.client.HealthConnectClient;
import androidx.health.connect.client.HealthConnectFeatures;
import androidx.health.connect.client.PermissionController;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import kotlinx.coroutines.CoroutineScope;
import kotlinx.coroutines.CoroutineScopeKt;
import kotlinx.coroutines.Dispatchers;
import kotlinx.coroutines.SupervisorKt;

/**
 * Health spike (TC-525): read health data from Health Connect. Off by default: the web UI exists only in builds with
 * VITE_EXO_HEALTH_SPIKE=true, and only debug builds declare the health permissions (src/debug/AndroidManifest.xml),
 * so a release build cannot be granted anything. Contract shared with iOS (HealthPlugin.swift) and the TS
 * definitions in frontend/src/lib/health/nativeHealth.ts:
 *
 *   availability()                          → { platform, status, reason, sdkInt, permissionsDeclared,
 *                                               backgroundRead, historyRead }
 *   authorizationStatus({ types? })         → { readStateKnowable: true, types: { steps: ... }, background,
 *                                               sampleWrite }
 *   requestAuthorization({ types?, background?, sampleWrite? })  → same as authorizationStatus, after the
 *                                               Health Connect permission screen closes
 *   readDailySummaries({ days?, types? })   → { platform, source, timeZone, readAt, notGranted, days: [...] }
 *   insertSampleData()                      → { inserted } (development: sample steps, sleep, heart rate)
 *   openSettings()                          → {} (Health Connect's page for this app, or the Play Store when
 *                                               Health Connect needs an update)
 *
 * Health Connect tells the app exactly which permissions it holds (getGrantedPermissions), unlike HealthKit. It
 * does not say whether a missing one was refused or never asked for, so the plugin remembers what it asked for.
 */
@CapacitorPlugin(name = "Health")
public class HealthPlugin extends Plugin {

    static final String STEPS = "steps";
    static final String SLEEP = "sleep";
    static final String HEART_RATE = "heartRate";
    static final List<String> TYPES = Collections.unmodifiableList(Arrays.asList(STEPS, SLEEP, HEART_RATE));

    static final String BACKGROUND_PERMISSION = "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND";
    /** The Health Connect app on Android 9-13 (HealthConnectClient's own constant is library-private). */
    static final String PROVIDER_PACKAGE = "com.google.android.apps.healthdata";

    private static final String PREFS = "xyz.tinycloud.exo.health";
    private static final String PREF_REQUESTED = "requestedPermissions";
    private static final int MAX_DAYS = 30;

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final CoroutineScope scope = CoroutineScopeKt.CoroutineScope(SupervisorKt.SupervisorJob(null).plus(Dispatchers.getIO()));

    static String readPermission(String type) {
        switch (type) {
            case STEPS:
                return "android.permission.health.READ_STEPS";
            case SLEEP:
                return "android.permission.health.READ_SLEEP";
            case HEART_RATE:
                return "android.permission.health.READ_HEART_RATE";
            default:
                throw new IllegalArgumentException(type);
        }
    }

    static String writePermission(String type) {
        switch (type) {
            case STEPS:
                return "android.permission.health.WRITE_STEPS";
            case SLEEP:
                return "android.permission.health.WRITE_SLEEP";
            case HEART_RATE:
                return "android.permission.health.WRITE_HEART_RATE";
            default:
                throw new IllegalArgumentException(type);
        }
    }

    @Override
    protected void handleOnDestroy() {
        CoroutineScopeKt.cancel(scope, (CancellationException) null);
        worker.shutdownNow();
    }

    // MARK: - Availability

    @PluginMethod
    public void availability(PluginCall call) {
        String status = sdkStatus();
        JSObject ret = new JSObject();
        ret.put("platform", "android");
        ret.put("status", status);
        ret.put("reason", unavailableReason(status));
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("permissionsDeclared", declaredPermissions().contains(readPermission(STEPS)));
        String background = "unknown";
        String history = "unknown";
        if ("available".equals(status)) {
            try {
                HealthConnectFeatures features = client().getFeatures();
                background = featureState(features, HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND);
                history = featureState(features, HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY);
            } catch (RuntimeException e) {
                // An old Health Connect without the features API: leave both unknown.
            }
        }
        ret.put("backgroundRead", background);
        ret.put("historyRead", history);
        call.resolve(ret);
    }

    /** available | needs_update | unavailable (Health Connect needs Android 9+; the client library needs 8+). */
    private String sdkStatus() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return "unavailable";
        int status = HealthConnectClient.getSdkStatus(getContext());
        if (status == HealthConnectClient.SDK_AVAILABLE) return "available";
        if (status == HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) return "needs_update";
        return "unavailable";
    }

    private static String unavailableReason(String status) {
        if ("available".equals(status)) return null;
        if ("needs_update".equals(status)) return "provider_update_required";
        // Android 14+ ships Health Connect in the platform; on 9-13 it is the Play Store app.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return "os_too_old";
        return "not_installed";
    }

    private static String featureState(HealthConnectFeatures features, int feature) {
        return features.getFeatureStatus(feature) == HealthConnectFeatures.FEATURE_STATUS_AVAILABLE ? "available" : "unavailable";
    }

    private HealthConnectClient client() {
        return HealthConnectClient.getOrCreate(getContext());
    }

    /** What this build's manifest declares: release builds declare no health permission at all. */
    @SuppressWarnings("deprecation")
    private Set<String> declaredPermissions() {
        Context context = getContext();
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), PackageManager.GET_PERMISSIONS);
            if (info.requestedPermissions != null) return new HashSet<>(Arrays.asList(info.requestedPermissions));
        } catch (PackageManager.NameNotFoundException e) {
            // Our own package: cannot happen.
        }
        return Collections.emptySet();
    }

    // MARK: - Authorization

    @PluginMethod
    public void authorizationStatus(PluginCall call) {
        List<String> types = typesFrom(call);
        if (types == null) return;
        if (!"available".equals(sdkStatus())) {
            call.resolve(unavailableAuthorization(types));
            return;
        }
        worker.execute(() -> resolveAuthorization(call, types));
    }

    @PluginMethod
    public void requestAuthorization(PluginCall call) {
        List<String> types = typesFrom(call);
        if (types == null) return;
        String status = sdkStatus();
        if (!"available".equals(status)) {
            call.reject("Health Connect is not available (" + unavailableReason(status) + ")", "unavailable");
            return;
        }
        Set<String> permissions = new HashSet<>();
        for (String type : types) permissions.add(readPermission(type));
        if (Boolean.TRUE.equals(call.getBoolean("background", false))) permissions.add(BACKGROUND_PERMISSION);
        if (Boolean.TRUE.equals(call.getBoolean("sampleWrite", false))) {
            for (String type : types) permissions.add(writePermission(type));
        }
        // Health Connect closes its screen at once, granting nothing, for a permission the manifest lacks.
        Set<String> undeclared = new TreeSet<>(permissions);
        undeclared.removeAll(declaredPermissions());
        if (!undeclared.isEmpty()) {
            call.reject("This build does not declare " + undeclared + " (health permissions are declared in debug builds only)", "not_declared");
            return;
        }
        rememberRequested(permissions);
        Intent intent = PermissionController.createRequestPermissionResultContract().createIntent(getContext(), permissions);
        startActivityForResult(call, intent, "afterPermissionRequest");
    }

    /** The contract's parseResult lists only what this screen granted; report Health Connect's full state instead. */
    @ActivityCallback
    private void afterPermissionRequest(PluginCall call, ActivityResult result) {
        if (call == null) return;
        List<String> types = typesFrom(call);
        if (types == null) return;
        worker.execute(() -> resolveAuthorization(call, types));
    }

    private void resolveAuthorization(PluginCall call, List<String> types) {
        try {
            Set<String> granted = grantedPermissions();
            Set<String> requested = requestedPermissions();
            JSObject states = new JSObject();
            for (String type : types) states.put(type, permissionState(readPermission(type), granted, requested));
            JSObject ret = new JSObject();
            ret.put("readStateKnowable", true);
            ret.put("types", states);
            String background = "unavailable";
            try {
                if (
                    client().getFeatures().getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
                    HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
                ) {
                    background = permissionState(BACKGROUND_PERMISSION, granted, requested);
                }
            } catch (RuntimeException e) {
                // No features API: background reads are not available.
            }
            ret.put("background", background);
            boolean allWrites = true;
            for (String type : types) allWrites &= granted.contains(writePermission(type));
            ret.put("sampleWrite", allWrites ? "granted" : "not_granted");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Could not read Health Connect permissions: " + e.getMessage(), "permission_check_failed", e);
        }
    }

    private static String permissionState(String permission, Set<String> granted, Set<String> requested) {
        if (granted.contains(permission)) return "granted";
        return requested.contains(permission) ? "denied" : "not_determined";
    }

    private JSObject unavailableAuthorization(List<String> types) {
        JSObject states = new JSObject();
        for (String type : types) states.put(type, "unavailable");
        JSObject ret = new JSObject();
        ret.put("readStateKnowable", true);
        ret.put("types", states);
        ret.put("background", "unavailable");
        ret.put("sampleWrite", "not_granted");
        return ret;
    }

    private Set<String> grantedPermissions() throws Exception {
        HealthConnectClient client = client();
        return Suspend.await(scope, continuation -> client.getPermissionController().getGrantedPermissions(continuation));
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private Set<String> requestedPermissions() {
        return new HashSet<>(preferences().getStringSet(PREF_REQUESTED, Collections.emptySet()));
    }

    private void rememberRequested(Set<String> permissions) {
        Set<String> all = requestedPermissions();
        all.addAll(permissions);
        preferences().edit().putStringSet(PREF_REQUESTED, all).apply();
    }

    // MARK: - Reading

    /**
     * One summary per local calendar day, oldest first, for the last `days` days including today. The reading lives
     * in HealthConnectReader, which is only loaded on Android 8+: Capacitor reflects over every method this class
     * declares, so no java.time type may appear in one of its signatures (API 24-25 lack java.time).
     */
    @PluginMethod
    public void readDailySummaries(PluginCall call) {
        List<String> types = typesFrom(call);
        if (types == null) return;
        String status = sdkStatus();
        if (!"available".equals(status)) {
            call.reject("Health Connect is not available (" + unavailableReason(status) + ")", "unavailable");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Unreachable ("available" implies Android 9+); spelled out for lint's API check.
            call.reject("Health Connect needs Android 9 or later", "unavailable");
            return;
        }
        int days = Math.max(1, Math.min(MAX_DAYS, call.getInt("days", 7)));
        worker.execute(() -> {
            try {
                call.resolve(new HealthConnectReader(scope, client()).readDays(grantedPermissions(), types, days));
            } catch (SecurityException e) {
                // A permission revoked between the check and the read, or a read while the app is in the background.
                call.reject("Health Connect refused the read: " + e.getMessage(), "not_authorized", e);
            } catch (Exception e) {
                call.reject("Could not read Health Connect: " + e.getMessage(), "read_failed", e);
            }
        });
    }

    // MARK: - Development helpers

    /**
     * Writes a week of made-up steps, sleep and heart rate as Exo, for testing on an emulator or a phone with no
     * tracker. Needs the write permissions (requestAuthorization with sampleWrite: true; debug builds only). Each
     * record has a fixed client record id, so running it twice replaces rather than duplicates. Health Connect lets
     * the user delete them under Exo's data in its settings.
     */
    @PluginMethod
    public void insertSampleData(PluginCall call) {
        String status = sdkStatus();
        if (!"available".equals(status)) {
            call.reject("Health Connect is not available (" + unavailableReason(status) + ")", "unavailable");
            return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Unreachable ("available" implies Android 9+); spelled out for lint's API check.
            call.reject("Health Connect needs Android 9 or later", "unavailable");
            return;
        }
        worker.execute(() -> {
            try {
                int inserted = new HealthConnectReader(scope, client()).insertSampleData(grantedPermissions());
                if (inserted == 0) {
                    call.reject("No write permission: request authorization with sampleWrite first", "not_authorized");
                    return;
                }
                JSObject ret = new JSObject();
                ret.put("inserted", inserted);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Could not write sample data: " + e.getMessage(), "write_failed", e);
            }
        });
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Context context = getContext();
        String status = sdkStatus();
        Intent intent;
        if ("needs_update".equals(status)) {
            // Health Connect's documented "update me" deep link into the Play Store.
            intent = new Intent(
                Intent.ACTION_VIEW,
                Uri.parse("market://details?id=" + PROVIDER_PACKAGE + "&url=healthconnect%3A%2F%2Fonboarding")
            );
            intent.setPackage("com.android.vending");
            intent.putExtra("overlay", true);
            intent.putExtra("callerId", context.getPackageName());
        } else if ("available".equals(status)) {
            intent = HealthConnectClient.getHealthConnectManageDataIntent(context);
        } else {
            call.reject("Health Connect is not available (" + unavailableReason(status) + ")", "unavailable");
            return;
        }
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Nothing can open Health Connect settings on this device", "unavailable", e);
        }
    }

    /** iOS-only (HKObserverQuery). Health Connect has no push: background sync polls the Changes API from WorkManager. */
    @PluginMethod
    public void enableBackgroundDelivery(PluginCall call) {
        call.reject(
            "Health Connect has no observer callbacks; background sync would be a WorkManager job polling getChanges (see mobile/docs/health-spike.md)",
            "not_supported"
        );
    }

    // MARK: - Arguments

    /** `types` from the call, default all; rejects the call (and returns null) on an unknown type. */
    private static List<String> typesFrom(PluginCall call) {
        JSArray array = call.getArray("types", null);
        if (array == null) return TYPES;
        List<String> types = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            String type = array.optString(i, "");
            if (!TYPES.contains(type)) {
                call.reject("Unknown health data type: " + type, "invalid_type");
                return null;
            }
            if (!types.contains(type)) types.add(type);
        }
        if (types.isEmpty()) {
            call.reject("No health data type requested", "invalid_type");
            return null;
        }
        return types;
    }
}
