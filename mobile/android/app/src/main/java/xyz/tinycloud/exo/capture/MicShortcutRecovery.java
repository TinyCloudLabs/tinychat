package xyz.tinycloud.exo.capture;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;

/** Durable intent to present a denied shortcut, then offer Record after Settings. */
public final class MicShortcutRecovery {
    private static final String PREFS = "exo.capture";
    private static final String DENIED = "micDeniedPresentation";
    private static final String RECORD = "micRecordIntentPending";
    private static final String SETTINGS = "micSettingsReturnExpected";

    private MicShortcutRecovery() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static boolean permissionGranted(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean denied(Context context) { return prefs(context).getBoolean(DENIED, false); }
    public static boolean recordPending(Context context) { return prefs(context).getBoolean(RECORD, false); }

    public static void markDenied(Context context, boolean fromShortcut) {
        SharedPreferences.Editor edit = prefs(context).edit().putBoolean(DENIED, true);
        if (fromShortcut) edit.putBoolean(RECORD, true);
        edit.commit();
    }

    public static void markSettingsOpened(Context context) { prefs(context).edit().putBoolean(SETTINGS, true).commit(); }

    public static boolean takeSettingsReturn(Context context) {
        boolean expected = prefs(context).getBoolean(SETTINGS, false);
        if (expected) prefs(context).edit().putBoolean(SETTINGS, false).commit();
        return expected;
    }

    public static void markGranted(Context context) {
        prefs(context).edit().putBoolean(DENIED, false).putBoolean(SETTINGS, false).commit();
    }

    public static void newShortcut(Context context) {
        prefs(context).edit().putBoolean(DENIED, false).putBoolean(RECORD, false)
            .putBoolean(SETTINGS, false).commit();
    }

    public static void consumeRecordOffer(Context context) {
        LaunchCommandStore commands = new LaunchCommandStore(context);
        LaunchCommandStore.Command command = commands.pending();
        if (command != null && "RECORD".equals(command.getAction())) commands.clear(command.getId());
        prefs(context).edit().putBoolean(RECORD, false).commit();
    }

    public static void dismiss(Context context) {
        consumeRecordOffer(context);
        prefs(context).edit().putBoolean(DENIED, false).putBoolean(SETTINGS, false).commit();
    }
}
