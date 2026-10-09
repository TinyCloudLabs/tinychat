package xyz.tinycloud.exo;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;
import xyz.tinycloud.exo.capture.CaptureEngine;
import xyz.tinycloud.exo.capture.CaptureService;
import xyz.tinycloud.exo.capture.LaunchCommandStore;
import xyz.tinycloud.exo.capture.MicShortcutRecovery;
import xyz.tinycloud.exo.capture.VoiceNotesPlugin;
import xyz.tinycloud.exo.health.HealthPlugin;
import xyz.tinycloud.exo.location.LocationPlugin;
import xyz.tinycloud.exo.stt.OnDeviceSttPlugin;

public class MainActivity extends BridgeActivity implements CaptureEngine.Listener {
    private LaunchCommandStore commands;
    private String consumedCommandId;
    private boolean askingPermission;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ActivityResultLauncher<String> requestNotifications = registerForActivityResult(
        new ActivityResultContracts.RequestPermission(), granted -> main.post(this::handlePending));
    private final ActivityResultLauncher<String> requestMic = registerForActivityResult(
        new ActivityResultContracts.RequestPermission(), granted -> {
            askingPermission = false;
            if (granted) main.post(this::handlePending);
            else {
                consumedCommandId = null;
                MicShortcutRecovery.markDenied(this, true);
                CaptureEngine.get(this).presentRecorder(null, "permission_denied");
            }
        });

    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceNotesPlugin.class);
        registerPlugin(OnDeviceSttPlugin.class);
        registerPlugin(HealthPlugin.class);
        // TC-524 location spike. Registered in every build, but only the debug manifest declares
        // location permissions and the location foreground service; release cannot capture location.
        registerPlugin(LocationPlugin.class);
        commands = new LaunchCommandStore(this);
        if (savedInstanceState != null) consumedCommandId = savedInstanceState.getString("consumedCommandId");
        consumeIntent(getIntent());
        super.onCreate(savedInstanceState);
        CaptureEngine.get(this).addListener(this);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        consumeIntent(intent);
        main.post(this::handlePending);
    }
    private void consumeIntent(Intent intent) {
        String action = intent.getAction();
        if (CaptureService.RECORD.equals(action)) {
            MicShortcutRecovery.newShortcut(this);
            commands.put("RECORD", "app_shortcut");
        }
        else if (CaptureService.SHOW_RECORDER.equals(action)) commands.put("SHOW_RECORDER", "notification");
        setIntent(new Intent(intent).setAction(null));
    }
    @Override public void onResume() {
        super.onResume();
        // Lifecycle reaches RESUMED after onResume returns.
        main.post(() -> {
            if (MicShortcutRecovery.denied(this)) {
                if (MicShortcutRecovery.permissionGranted(this)) {
                    MicShortcutRecovery.markGranted(this);
                    CaptureEngine.get(this).presentRecorder(null, "permission_granted");
                } else if (MicShortcutRecovery.takeSettingsReturn(this)) {
                    CaptureEngine.get(this).presentRecorder(null, "permission_denied");
                }
            }
            handlePending();
        });
    }
    private void handlePending() {
        if (!getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) return;
        LaunchCommandStore.Command command = commands.pending();
        if (command == null) return;
        if (command.getId().equals(consumedCommandId)) return;
        CaptureEngine engine = CaptureEngine.get(this);
        if ("SHOW_RECORDER".equals(command.getAction()) || !engine.status().isNull("id")) {
            commands.clear(command.getId());
            engine.presentRecorder();
            return;
        }
        // A denied shortcut remains an offer. Only an explicit new shortcut asks again;
        // returning from Settings shows Record instead of starting the mic unseen.
        if (MicShortcutRecovery.recordPending(this)) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            if (!askingPermission) { askingPermission = true; requestMic.launch(Manifest.permission.RECORD_AUDIO); }
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !getSharedPreferences("exo.capture", MODE_PRIVATE).getBoolean("notificationAsked", false)) {
            getSharedPreferences("exo.capture", MODE_PRIVATE).edit().putBoolean("notificationAsked", true).apply();
            requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS);
            return;
        }
        consumedCommandId = command.getId();
        CaptureService.startFromVisibleActivity(this, command.getId(), command.getSource());
    }
    @Override public void event(String name, JSONObject data) {
        if ("started".equals(name) && data.optString("commandId").equals(consumedCommandId)) {
            commands.clear(consumedCommandId);
        } else if ("startFailed".equals(name) && data.optString("commandId").equals(consumedCommandId)) {
            commands.clear(consumedCommandId);
            consumedCommandId = null;
            CaptureEngine.get(this).presentRecorder(null, data.optString("code", "start_failed"));
        }
    }
    @Override public void onSaveInstanceState(Bundle out) {
        out.putString("consumedCommandId", consumedCommandId);
        super.onSaveInstanceState(out);
    }
    @Override public void onDestroy() {
        CaptureEngine.get(this).removeListener(this);
        super.onDestroy();
    }
}
