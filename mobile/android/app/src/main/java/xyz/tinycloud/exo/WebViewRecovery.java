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
 * process is killed. This claims it, remembers the address the user was on, disposes of the dead WebView, and
 * recreates the activity (a WebView whose renderer is gone cannot be reused); MainActivity loads the remembered
 * address into the new WebView. Repeated deaths in a short window stop recreating and ask the user to reload.
 */
final class WebViewRecovery extends WebViewListener {
    private static final String TAG = "ExoWebView";
    private static final RecoveryBudget BUDGET = new RecoveryBudget();
    private static String pendingUrl;

    private final AppCompatActivity activity;
    private AlertDialog prompt;
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

    @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        Log.w(TAG, "WebView renderer gone (crashed=" + detail.didCrash() + ")");
        pendingUrl = restorableUrl(view.getUrl(), appUrl);
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        view.destroy();
        boolean automatic = BUDGET.recordDeath(SystemClock.elapsedRealtime());
        new Handler(Looper.getMainLooper()).post(automatic ? activity::recreate : this::askToReload);
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
