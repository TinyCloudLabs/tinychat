package xyz.tinycloud.exo;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebStorage;
import androidx.annotation.UiThread;
import androidx.webkit.WebStorageCompat;
import androidx.webkit.WebViewFeature;

/**
 * TC-3045: the shell's WebView origin moved from https://localhost to https://app.tinycloud.one, so what the web app
 * stored at the old origin (localStorage, IndexedDB, Cache Storage, cookies; including held answers and drafts whose
 * 7-day expiry is only enforced when they are read) is never read again. This deletes the WebView's data for the site
 * "localhost" once, on the first launch at the new origin.
 *
 * <p>The done flag is set only when the WebView reports the deletion complete, so a launch that dies first, a failure,
 * or a WebView too old for DELETE_BROWSING_DATA tries again on the next launch. Not WebStorage.deleteOrigin (it leaves
 * localStorage) and not WebStorageCompat.deleteBrowsingData (it would wipe the new origin too).
 */
final class OldOriginWipe {
    static final String OLD_SITE = "localhost";
    private static final String PREFS = "exo.webview";
    private static final String DONE_KEY = "xyz.tinycloud.home.oldOriginWiped.v1";
    private static final String TAG = "ExoWebView";

    enum Result { ALREADY_DONE, OLD_SITE_IN_USE, UNSUPPORTED, STARTED, FAILED }

    interface Flag {
        boolean isSet();
        void set();
    }

    interface Wiper {
        /** Starts deleting the site's data and calls {@code onDone} once it is gone; false if this WebView cannot. */
        boolean wipe(String site, Runnable onDone);
    }

    private OldOriginWipe() {}

    /**
     * Starts the wipe unless it already ran. {@code appHost} is the host the WebView serves the app from: a dev build
     * pointed at http://localhost:5186 (EXO_DEV_SERVER_URL) still lives on the old site, so it is left alone.
     */
    static Result start(Flag done, Wiper wiper, String appHost) {
        if (done.isSet()) return Result.ALREADY_DONE;
        if (OLD_SITE.equalsIgnoreCase(appHost)) return Result.OLD_SITE_IN_USE;
        try {
            return wiper.wipe(OLD_SITE, done::set) ? Result.STARTED : Result.UNSUPPORTED;
        } catch (RuntimeException e) {
            return Result.FAILED;
        }
    }

    /** From MainActivity.onCreate once the bridge exists. Never blocks: the WebView deletes in the background. */
    @UiThread
    static void onLaunch(Context context, String appUrl) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Flag done = new Flag() {
            @Override public boolean isSet() { return prefs.getBoolean(DONE_KEY, false); }
            @Override public void set() {
                prefs.edit().putBoolean(DONE_KEY, true).apply();
                Log.i(TAG, "Deleted the old origin's WebView data");
            }
        };
        Wiper wiper = (site, onDone) -> {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) return false;
            WebStorageCompat.deleteBrowsingDataForSite(WebStorage.getInstance(), site, onDone);
            return true;
        };
        Result result = start(done, wiper, Uri.parse(appUrl).getHost());
        if (result == Result.UNSUPPORTED) {
            Log.i(TAG, "This WebView cannot delete a site's data; the old origin's data stays until a WebView update");
        } else if (result == Result.FAILED) {
            Log.w(TAG, "Deleting the old origin's WebView data failed; retrying next launch");
        }
    }
}
