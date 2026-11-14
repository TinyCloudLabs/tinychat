package xyz.tinycloud.exo;

import android.app.KeyguardManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The native half of the app lock (TC-2738): BiometricPrompt with the device PIN, pattern or password as fallback,
 * how long the app spent in the background, and a cover over the window from the background until the web app has
 * decided. Recents shows no screenshot on Android 13+; earlier versions snapshot before onStop, and FLAG_SECURE would
 * also block the user's own screenshots. The web app (frontend/src/lib/appLock.ts) owns every lock decision.
 */
@CapacitorPlugin(name = "AppLock")
public class AppLockPlugin extends Plugin {
    private static final int AUTHENTICATORS =
        BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    private boolean coverEnabled;
    private View cover;
    /** elapsedRealtime keeps counting through deep sleep. */
    private Long backgroundedAt;
    private boolean authenticating;
    /** The stop came from the unlock UI itself (a separate PIN activity on some devices): not time away. */
    private boolean stoppedForPrompt;
    /** Asked for while the activity couldn't show a prompt (BiometricPrompt silently drops those); shown on resume. */
    private Runnable pendingPrompt;

    @PluginMethod
    public void status(PluginCall call) {
        int biometric = BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK);
        boolean hardware = biometric == BiometricManager.BIOMETRIC_SUCCESS
            || biometric == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED
            || biometric == BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED;
        JSObject result = new JSObject();
        result.put("biometry", hardware ? "biometric" : "none");
        result.put("biometryEnrolled", biometric == BiometricManager.BIOMETRIC_SUCCESS);
        result.put("deviceSecure", deviceSecure());
        call.resolve(result);
    }

    /** Resolves {@code { result }}: "success", "cancelled", "failed", or "unavailable" (no screen lock set). */
    @PluginMethod
    public void authenticate(PluginCall call) {
        String reason = call.getString("reason", "Unlock TinyCloud One");
        getActivity().runOnUiThread(() -> {
            if (authenticating) { resolve(call, "cancelled"); return; }
            if (!deviceSecure()) { resolve(call, "unavailable"); return; }
            authenticating = true;
            Runnable show = () -> {
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(reason)
                    .setAllowedAuthenticators(AUTHENTICATORS)
                    .build();
                BiometricPrompt prompt = new BiometricPrompt((FragmentActivity) getActivity(),
                    ContextCompat.getMainExecutor(getContext()), new BiometricPrompt.AuthenticationCallback() {
                        @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            authenticating = false;
                            resolve(call, "success");
                        }
                        @Override public void onAuthenticationError(int code, CharSequence message) {
                            authenticating = false;
                            resolve(call, resultFor(code));
                        }
                        // onAuthenticationFailed is one rejected attempt; the prompt stays up for another.
                    });
                try {
                    prompt.authenticate(info);
                } catch (RuntimeException error) {
                    // The activity can't show the prompt; the lock screen offers Retry.
                    authenticating = false;
                    resolve(call, "cancelled");
                }
            };
            FragmentActivity activity = (FragmentActivity) getActivity();
            if (activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)
                && !activity.getSupportFragmentManager().isStateSaved()) show.run();
            else pendingPrompt = show;
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        Runnable show = pendingPrompt;
        pendingPrompt = null;
        if (show != null) show.run();
    }

    @PluginMethod
    public void setCover(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        getActivity().runOnUiThread(() -> {
            coverEnabled = enabled;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) getActivity().setRecentsScreenshotEnabled(!enabled);
            if (!enabled) removeCover();
            call.resolve();
        });
    }

    /** The web app has rendered its decision (the lock screen, or the unlocked app): drop the background cover. */
    @PluginMethod
    public void reveal(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            removeCover();
            call.resolve();
        });
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        backgroundedAt = SystemClock.elapsedRealtime();
        stoppedForPrompt = authenticating && pendingPrompt == null;
        if (!coverEnabled || cover != null) return;
        ViewGroup content = getActivity().findViewById(android.R.id.content);
        if (content == null) return;
        View view = new View(getContext());
        Drawable background = getActivity().getWindow().getDecorView().getBackground();
        view.setBackgroundColor(background instanceof ColorDrawable ? ((ColorDrawable) background).getColor() : Color.BLACK);
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        content.addView(view, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        cover = view;
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (backgroundedAt == null) return;
        JSObject data = new JSObject();
        data.put("backgroundMs", stoppedForPrompt ? 0 : SystemClock.elapsedRealtime() - backgroundedAt);
        backgroundedAt = null;
        notifyListeners("foreground", data);
    }

    private boolean deviceSecure() {
        KeyguardManager keyguard = ContextCompat.getSystemService(getContext(), KeyguardManager.class);
        return keyguard != null && keyguard.isDeviceSecure();
    }

    private void removeCover() {
        if (cover == null) return;
        ViewGroup parent = (ViewGroup) cover.getParent();
        if (parent != null) parent.removeView(cover);
        cover = null;
    }

    static String resultFor(int code) {
        switch (code) {
            case BiometricPrompt.ERROR_USER_CANCELED:
            case BiometricPrompt.ERROR_NEGATIVE_BUTTON:
            case BiometricPrompt.ERROR_CANCELED:
                return "cancelled";
            case BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL:
                return "unavailable";
            default:
                return "failed";
        }
    }

    private static void resolve(PluginCall call, String result) {
        JSObject data = new JSObject();
        data.put("result", result);
        call.resolve(data);
    }
}
