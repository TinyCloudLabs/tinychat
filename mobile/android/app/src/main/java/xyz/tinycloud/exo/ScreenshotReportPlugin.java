package xyz.tinycloud.exo;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.PixelCopy;
import android.view.View;
import android.view.Window;
import androidx.annotation.ChecksSdkIntAtLeast;
import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The native half of "Report a bug" after a screenshot (TC-3716). Android 14+ tells a started activity that the user
 * captured it but gives no image, so this copies the activity window at that moment, encodes a small JPEG and holds
 * it in memory for the web app (frontend/src/lib/reportBug/nativeScreenshot.ts) to take. Nothing is written to disk.
 * Older versions have no signal: isSupported is false and start does nothing. All state lives on the main thread.
 */
@CapacitorPlugin(name = "ScreenshotReport")
public class ScreenshotReportPlugin extends Plugin {
    private static final long COALESCE_MS = 1500;
    private static final long HOLD_MS = 60_000;
    private static final int MAX_EDGE = 1280;
    private static final int MAX_BYTES = 400 * 1024;
    private static final int[] QUALITIES = { 60, 50, 40, 30 };

    private static final class Snapshot {
        final String id;
        final byte[] jpeg;
        final int width;
        final int height;

        Snapshot(String id, byte[] jpeg, int width, int height) {
            this.id = id;
            this.jpeg = jpeg;
            this.width = width;
            this.height = height;
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService encoder = Executors.newSingleThreadExecutor();
    private final Runnable expire = this::drop;
    private boolean started;
    /** An Activity.ScreenCaptureCallback while registered; typed Object so the class loads below API 34. */
    private Object callback;
    private long lastSignal = -COALESCE_MS;
    private Snapshot held;
    /** Bumped by stop(), so an encode still running then is neither held nor announced. */
    private int generation;

    @ChecksSdkIntAtLeast(api = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private static boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE;
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", supported());
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        main.post(() -> {
            if (supported()) {
                started = true;
                if (getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) register();
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            started = false;
            if (supported()) unregister();
            generation++;
            lastSignal = -COALESCE_MS;
            drop();
            call.resolve();
        });
    }

    /**
     * Resolves {@code { jpegBase64, width, height, bytes }} and forgets the image; rejects "no_snapshot" when the held
     * image has another id, expired, failed to render, or was already taken.
     */
    @PluginMethod
    public void takeSnapshot(PluginCall call) {
        String id = call.getString("id");
        main.post(() -> {
            Snapshot snapshot = held;
            if (snapshot == null || !snapshot.id.equals(id)) {
                call.reject("no_snapshot", "no_snapshot");
                return;
            }
            drop();
            JSObject result = new JSObject();
            result.put("jpegBase64", Base64.encodeToString(snapshot.jpeg, Base64.NO_WRAP));
            result.put("width", snapshot.width);
            result.put("height", snapshot.height);
            result.put("bytes", snapshot.jpeg.length);
            call.resolve(result);
        });
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (started && supported()) register();
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        if (supported()) unregister();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        main.removeCallbacksAndMessages(null);
        encoder.shutdownNow();
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private void register() {
        if (callback != null) return;
        Activity.ScreenCaptureCallback screenCaptured = this::screenshotTaken;
        getActivity().registerScreenCaptureCallback(ContextCompat.getMainExecutor(getContext()), screenCaptured);
        callback = screenCaptured;
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private void unregister() {
        if (callback == null) return;
        getActivity().unregisterScreenCaptureCallback((Activity.ScreenCaptureCallback) callback);
        callback = null;
    }

    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    private void screenshotTaken() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastSignal < COALESCE_MS) return;
        lastSignal = now;
        drop();
        String id = UUID.randomUUID().toString();
        long at = System.currentTimeMillis();
        int expected = generation;
        Runnable announce = () -> {
            if (expected != generation) return;
            JSObject data = new JSObject();
            data.put("id", id);
            data.put("at", at);
            notifyListeners("screenshot", data);
        };
        Window window = getActivity().getWindow();
        View decor = window.getDecorView();
        int width = decor.getWidth();
        int height = decor.getHeight();
        if (width <= 0 || height <= 0) {
            announce.run();
            return;
        }
        float scale = Math.min(1f, (float) MAX_EDGE / Math.max(width, height));
        int scaledWidth = Math.max(1, Math.round(width * scale));
        int scaledHeight = Math.max(1, Math.round(height * scale));
        Bitmap bitmap = Bitmap.createBitmap(scaledWidth, scaledHeight, Bitmap.Config.ARGB_8888);
        try {
            // PixelCopy scales the window's surface to fit the bitmap.
            PixelCopy.request(window, bitmap, result -> {
                if (result != PixelCopy.SUCCESS) {
                    bitmap.recycle();
                    announce.run();
                    return;
                }
                encoder.execute(() -> {
                    byte[] jpeg = encode(bitmap);
                    bitmap.recycle();
                    main.post(() -> {
                        if (jpeg != null && expected == generation) hold(new Snapshot(id, jpeg, scaledWidth, scaledHeight));
                        announce.run();
                    });
                });
            }, main);
        } catch (IllegalArgumentException noSurface) {
            bitmap.recycle();
            announce.run();
        }
    }

    private static byte[] encode(Bitmap bitmap) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int quality : QUALITIES) {
            out.reset();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) return null;
            if (out.size() <= MAX_BYTES) return out.toByteArray();
        }
        return null;
    }

    private void hold(Snapshot snapshot) {
        drop();
        held = snapshot;
        main.postDelayed(expire, HOLD_MS);
    }

    private void drop() {
        main.removeCallbacks(expire);
        held = null;
    }
}
