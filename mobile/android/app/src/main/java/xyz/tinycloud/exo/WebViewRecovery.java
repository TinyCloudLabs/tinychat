package xyz.tinycloud.exo;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.WebViewListener;
import java.net.URI;

/**
 * Android can kill the WebView's renderer while Exo is backgrounded. With no listener claiming that, the whole app
 * process is killed. This claims it, remembers the address the user was on, detaches the dead WebView, and
 * recreates the activity (a WebView whose renderer is gone cannot be reused); MainActivity loads the remembered
 * address into the new WebView. Repeated deaths in a short window still recreate (so Capacitor releases the dead
 * WebView), but the new activity holds the page back and asks the user to reload instead of loading it.
 */
final class WebViewRecovery extends WebViewListener {
    private static final String TAG = "ExoWebView";
    private static final RecoveryBudget BUDGET = new RecoveryBudget();
    private static String pendingUrl;
    private static boolean holdNextPage;

    private final AppCompatActivity activity;
    private AlertDialog prompt;
    private boolean prompting;
    private final String appUrl;

    WebViewRecovery(AppCompatActivity activity, String appUrl) {
        this.activity = activity;
        this.appUrl = appUrl;
    }

    static String restorableUrl(String url, String appUrl) {
        if (url == null || appUrl == null) return null;
        try {
            URI target = URI.create(url);
            URI app = URI.create(appUrl);
            boolean sameOrigin = target.getScheme() != null && target.getScheme().equals(app.getScheme())
                && target.getRawAuthority() != null && target.getRawAuthority().equals(app.getRawAuthority());
            return sameOrigin ? url : null;
        } catch (IllegalArgumentException invalid) {
            return null;
        }
    }

    static String takePendingUrl() {
        String url = pendingUrl;
        pendingUrl = null;
        return url;
    }

    static boolean takeHoldNextPage() {
        boolean hold = holdNextPage;
        holdNextPage = false;
        return hold;
    }

    /** The budget ran out before this activity was made: keep its page from loading and ask the user first. */
    void holdForReload(WebView webView) {
        prompting = true;
        webView.stopLoading();
        new Handler(Looper.getMainLooper()).post(this::askToReload);
    }

    @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        Log.w(TAG, "WebView renderer gone (crashed=" + detail.didCrash() + ")");
        if (!prompting) pendingUrl = restorableUrl(view.getUrl(), appUrl);
        // Detach only: Capacitor's BridgeActivity.onDetachedFromWindow -> Bridge.onDetachedFromWindow destroys the
        // bridge's WebView when the activity is torn down, and WebView methods must not be called after destroy().
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        // A held page loads nothing, so this should not happen; if it does, release it the same way and keep holding.
        holdNextPage = prompting || !BUDGET.recordDeath(SystemClock.elapsedRealtime());
        new Handler(Looper.getMainLooper()).post(activity::recreate);
        return true;
    }

    void dismissPrompt() {
        if (prompt != null) prompt.dismiss();
        prompt = null;
    }

    private void askToReload() {
        if (activity.isFinishing() || activity.isDestroyed()) return;
        Log.w(TAG, "WebView renderer keeps dying; waiting for the user to reload");
        prompt = new AlertDialog.Builder(activity)
            .setTitle("Exo needs to reload")
            .setMessage("Something interrupted Exo while it was in the background. Reload to pick up where you left off.")
            .setCancelable(false)
            .setPositiveButton("Reload", (dialog, which) -> {
                BUDGET.reset();
                activity.recreate();
            })
            .show();
    }
}
