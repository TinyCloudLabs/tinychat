package xyz.tinycloud.exo;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

/** The web app's side of {@link OldOriginMigration} (frontend/src/lib/oldOriginImport.ts). */
@CapacitorPlugin(name = "OldOriginMigration")
public class OldOriginMigrationPlugin extends Plugin {
    private static final String TAG = "ExoWebView";
    private static final String OLD_ORIGIN_PAGE = "https://" + OldOriginWipe.OLD_SITE + "/";
    private static final long EXPORT_TIMEOUT_MS = 20_000L;

    /** Resolves {@code {state, data?}}; see {@link OldOriginMigration#take}. */
    @PluginMethod
    public void take(PluginCall call) {
        JSObject allow = call.getObject("allow");
        String script = call.getString("script");
        if (allow == null || script == null) {
            call.reject("allow and script are required");
            return;
        }
        OldOriginMigration.take(store(), exportFile(), this::export, appHost(), allow.toString(), script,
            new OldOriginMigration.Taken() {
                @Override public void resolve(String state, @Nullable String data) {
                    if (data != null) Log.i(TAG, "Handing the old origin's export to the web app (" + data.length() + " chars)");
                    JSObject result = new JSObject();
                    result.put("state", state);
                    if (data != null) result.put("data", data);
                    call.resolve(result);
                }
                @Override public void reject(String reason) {
                    Log.w(TAG, reason);
                    call.reject(reason);
                }
            });
    }

    @PluginMethod
    public void ack(PluginCall call) {
        OldOriginMigration.ack(store(), exportFile(), () -> OldOriginWipe.afterImport(getContext(), appHost()));
        Log.i(TAG, "The web app imported the old origin's export; deleted the export file");
        call.resolve();
    }

    private String appHost() {
        return Uri.parse(getBridge().getAppUrl()).getHost();
    }

    private OldOriginMigration.Store store() {
        SharedPreferences prefs = getContext().getSharedPreferences(OldOriginWipe.PREFS, Context.MODE_PRIVATE);
        return new OldOriginMigration.Store() {
            @Override public boolean imported() { return prefs.getBoolean(OldOriginWipe.IMPORTED_KEY, false); }
            // commit, not apply: the wipe that follows must find it on disk.
            @Override public void markImported() { prefs.edit().putBoolean(OldOriginWipe.IMPORTED_KEY, true).commit(); }
        };
    }

    private OldOriginMigration.ExportFile exportFile() {
        File dir = getContext().getNoBackupFilesDir();
        File file = new File(dir, OldOriginMigration.EXPORT_FILE);
        return new OldOriginMigration.ExportFile() {
            @Override public @Nullable String read() throws IOException {
                if (!file.exists()) return null;
                try (InputStream in = new FileInputStream(file)) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] buffer = new byte[64 * 1024];
                    for (int n; (n = in.read(buffer)) != -1; ) bytes.write(buffer, 0, n);
                    return bytes.toString(StandardCharsets.UTF_8.name());
                }
            }
            @Override public void write(String json) throws IOException {
                File partial = new File(dir, OldOriginMigration.EXPORT_FILE + ".partial");
                try (FileOutputStream out = new FileOutputStream(partial)) {
                    out.write(json.getBytes(StandardCharsets.UTF_8));
                    out.getFD().sync();
                }
                if (!partial.renameTo(file)) throw new IOException("rename failed");
            }
            @Override public void delete() {
                if (file.exists() && !file.delete()) Log.w(TAG, "Could not delete the old origin's export file");
            }
        };
    }

    /**
     * Runs the export in a hidden WebView at the old origin. It is served a blank page there and nothing else (every
     * other request gets a 404, so nothing leaves the device), and answers through a JavaScript interface because
     * evaluateJavascript doesn't wait for a promise.
     */
    private void export(String allowJson, String script, OldOriginMigration.Exported done) {
        Handler main = new Handler(Looper.getMainLooper());
        main.post(() -> {
            WebView view = new WebView(getContext());
            AtomicBoolean settled = new AtomicBoolean();
            OldOriginMigration.Exported once = new OldOriginMigration.Exported() {
                @Override public void exported(String json) {
                    if (!settled.compareAndSet(false, true)) return;
                    done.exported(json);
                    main.post(view::destroy);
                }
                @Override public void failed(String reason) {
                    if (!settled.compareAndSet(false, true)) return;
                    done.failed(reason);
                    main.post(view::destroy);
                }
            };
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(false);
            view.addJavascriptInterface(new ExportBridge(once), "ExoOldOriginExport");
            view.setWebViewClient(new WebViewClient() {
                private boolean ran;

                @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                    if (request.isForMainFrame() && OLD_ORIGIN_PAGE.equals(request.getUrl().toString())) {
                        return new WebResourceResponse("text/html", "utf-8",
                            new ByteArrayInputStream("<!doctype html><title></title>".getBytes(StandardCharsets.UTF_8)));
                    }
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null,
                        new ByteArrayInputStream(new byte[0]));
                }

                @Override public void onPageFinished(WebView v, String url) {
                    if (ran || !OLD_ORIGIN_PAGE.equals(url)) return;
                    ran = true;
                    v.evaluateJavascript("(async (allow) => {\n" + script + "\n})(" + allowJson + ").then("
                        + "(json) => ExoOldOriginExport.exported(json),"
                        + " (error) => ExoOldOriginExport.failed(String((error && error.message) || error)))", null);
                }

                @Override public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame()) once.failed("the old origin's page did not load (" + error.getErrorCode() + ")");
                }
            });
            main.postDelayed(() -> once.failed("timed out"), EXPORT_TIMEOUT_MS);
            view.loadUrl(OLD_ORIGIN_PAGE);
        });
    }

    /** Called from the WebView's JavaScript thread. */
    private static final class ExportBridge {
        private final OldOriginMigration.Exported done;

        ExportBridge(OldOriginMigration.Exported done) {
            this.done = done;
        }

        @JavascriptInterface public void exported(String json) { done.exported(json); }

        @JavascriptInterface public void failed(String reason) { done.failed(reason); }
    }
}
