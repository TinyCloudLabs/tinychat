package xyz.tinycloud.exo;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.WebViewListener;
import java.net.URI;

/**
 * Android can kill the WebView's renderer while Exo is backgrounded. With no listener claiming that, the whole app
 * process is killed. This claims it, remembers the address the user was on, and recreates the activity (a WebView
 * whose renderer is gone cannot be reused); MainActivity loads the remembered address into the new WebView.
 */
final class WebViewRecovery extends WebViewListener {
    private static final String TAG = "ExoWebView";
    private static String pendingUrl;

    private final Activity activity;
    private final String appUrl;

    WebViewRecovery(Activity activity, String appUrl) {
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
        Log.w(TAG, "WebView renderer gone (crashed=" + detail.didCrash() + "); recreating the activity");
        pendingUrl = restorableUrl(view.getUrl(), appUrl);
        new Handler(Looper.getMainLooper()).post(activity::recreate);
        return true;
    }
}
