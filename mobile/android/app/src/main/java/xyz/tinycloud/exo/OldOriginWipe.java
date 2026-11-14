package xyz.tinycloud.exo;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebStorage;
import androidx.annotation.UiThread;
import androidx.core.view.OneShotPreDrawListener;
import androidx.webkit.WebStorageCompat;
import androidx.webkit.WebViewFeature;

/**
 * TC-3045: the shell's WebView origin moved from https://localhost to https://app.tinycloud.one, so what the web app
 * stored at the old origin (localStorage, IndexedDB, Cache Storage, cookies; including held answers and drafts whose
 * 7-day expiry is only enforced when they are read) is never read again. This deletes the WebView's data for the site
 * "localhost" once, after the switch.
 *
 * <p>The done flag is set only when the WebView reports the deletion complete within {@link #TIMEOUT_MS}. Every attempt
 * is counted before it starts, so a crash or hang mid-attempt counts too; after {@link #MAX_ATTEMPTS} the wipe stops for
 * good and says so once. A WebView too old for DELETE_BROWSING_DATA is checked first and costs no attempt, so the wipe
 * runs on a launch after a WebView update. Not WebStorage.deleteOrigin (it leaves localStorage) and not
 * WebStorageCompat.deleteBrowsingData (it would wipe the new origin too).
 */
final class OldOriginWipe {
    static final String OLD_SITE = "localhost";
    static final int MAX_ATTEMPTS = 3;
    static final long TIMEOUT_MS = 10_000L;
    private static final String PREFS = "exo.webview";
    private static final String DONE_KEY = "xyz.tinycloud.home.oldOriginWiped.v1";
    private static final String ATTEMPTS_KEY = "xyz.tinycloud.home.oldOriginWipe.attempts.v1";
    private static final String TAG = "ExoWebView";
    private static boolean ranThisProcess;

    enum Result { ALREADY_DONE, OLD_SITE_IN_USE, GAVE_UP, UNSUPPORTED, STARTED, FAILED }

    /** The persisted state: the done flag and the attempts started so far ({@code MAX_ATTEMPTS + 1} once given up). */
    interface Store {
        boolean done();
        void markDone();
        int attempts();
        void setAttempts(int attempts);
    }

    interface Wiper {
        boolean supported();
        /** Starts deleting the site's data and calls {@code onDone} once it is gone. */
        void wipe(String site, Runnable onDone);
    }

    interface Scheduler {
        void after(long delayMs, Runnable task);
    }

    interface Events {
        void wiped();
        void failed(String reason);
        void gaveUp();
    }

    private OldOriginWipe() {}

    /**
     * Starts an attempt unless the wipe is done or given up. {@code appHost} is the host the WebView serves the app
     * from: a dev build pointed at http://localhost:5186 (EXO_DEV_SERVER_URL) still lives on the old site, so it is left
     * alone. The attempt settles once: success, a failure, or the timeout, whichever comes first.
     */
    static Result start(Store store, Wiper wiper, Scheduler scheduler, Events events, String appHost) {
        if (store.done()) return Result.ALREADY_DONE;
        if (OLD_SITE.equalsIgnoreCase(appHost)) return Result.OLD_SITE_IN_USE;
        int attempts = store.attempts();
        if (attempts > MAX_ATTEMPTS) return Result.GAVE_UP;
        if (attempts == MAX_ATTEMPTS) {
            // The last attempt never settled (the app died or hung): give up now, and say so this once.
            giveUp(store, events);
            return Result.GAVE_UP;
        }
        if (!wiper.supported()) return Result.UNSUPPORTED;
        Attempt attempt = new Attempt(store, events, attempts + 1);
        store.setAttempts(attempt.number);
        scheduler.after(TIMEOUT_MS, () -> attempt.fail("timed out"));
        try {
            wiper.wipe(OLD_SITE, attempt::succeed);
        } catch (RuntimeException e) {
            attempt.fail(e.getClass().getSimpleName());
            return Result.FAILED;
        }
        return Result.STARTED;
    }

    private static void giveUp(Store store, Events events) {
        store.setAttempts(MAX_ATTEMPTS + 1);
        events.gaveUp();
    }

    private static final class Attempt {
        final Store store;
        final Events events;
        final int number;
        boolean settled;

        Attempt(Store store, Events events, int number) {
            this.store = store;
            this.events = events;
            this.number = number;
        }

        void succeed() {
            if (settled) return;
            settled = true;
            store.markDone();
            events.wiped();
        }

        void fail(String reason) {
            if (settled) return;
            settled = true;
            events.failed(reason);
            if (number >= MAX_ATTEMPTS) giveUp(store, events);
        }
    }

    /**
     * From MainActivity.onCreate once the bridge exists. Runs after the first frame is drawn and never blocks: the
     * WebView deletes in the background. Once per process, so recreating the activity does not spend an attempt.
     */
    @UiThread
    static void afterFirstFrame(Activity activity, String appUrl) {
        if (ranThisProcess) return;
        ranThisProcess = true;
        Handler main = new Handler(Looper.getMainLooper());
        String appHost = Uri.parse(appUrl).getHost();
        Context context = activity.getApplicationContext();
        OneShotPreDrawListener.add(activity.getWindow().getDecorView(), () -> main.post(() -> run(context, main, appHost)));
    }

    @UiThread
    private static void run(Context context, Handler main, String appHost) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Store store = new Store() {
            @Override public boolean done() { return prefs.getBoolean(DONE_KEY, false); }
            @Override public void markDone() { prefs.edit().putBoolean(DONE_KEY, true).apply(); }
            @Override public int attempts() { return prefs.getInt(ATTEMPTS_KEY, 0); }
            // commit, not apply: the count must be on disk before the attempt starts, in case it takes the app down.
            @Override public void setAttempts(int attempts) { prefs.edit().putInt(ATTEMPTS_KEY, attempts).commit(); }
        };
        Wiper wiper = new Wiper() {
            @Override public boolean supported() {
                return WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA);
            }
            @Override public void wipe(String site, Runnable onDone) {
                WebStorageCompat.deleteBrowsingDataForSite(WebStorage.getInstance(), site, onDone);
            }
        };
        Events events = new Events() {
            @Override public void wiped() { Log.i(TAG, "Deleted the old origin's WebView data"); }
            @Override public void failed(String reason) {
                Log.w(TAG, "Deleting the old origin's WebView data failed (" + reason + ")");
            }
            @Override public void gaveUp() {
                Log.w(TAG, "Gave up deleting the old origin's WebView data after " + MAX_ATTEMPTS + " attempts");
            }
        };
        Result result = start(store, wiper, (delayMs, task) -> main.postDelayed(task, delayMs), events, appHost);
        if (result == Result.UNSUPPORTED) {
            Log.i(TAG, "This WebView cannot delete a site's data; the old origin's data stays until a WebView update");
        }
    }
}
