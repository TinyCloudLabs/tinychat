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
import xyz.tinycloud.exo.capture.VoiceNotesPlugin;
import xyz.tinycloud.exo.health.HealthPlugin;
import xyz.tinycloud.exo.location.LocationPlugin;

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
            // Denial leaves the command until expiry; the recorder UI can show the permission error.
        });

    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoiceNotesPlugin.class);
        registerPlugin(HealthPlugin.class);
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
        if (CaptureService.RECORD.equals(action)) commands.put("RECORD", "app_shortcut");
        else if (CaptureService.SHOW_RECORDER.equals(action)) commands.put("SHOW_RECORDER", "notification");
        setIntent(new Intent(intent).setAction(null));
    }
    @Override public void onResume() {
        super.onResume();
        // Lifecycle reaches RESUMED after onResume returns.
        main.post(this::handlePending);
    }
    private void handlePending() {
        if (!getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) return;
        LaunchCommandStore.Command command = commands.pending();
        if (command == null) return;
        if (command.getId().equals(consumedCommandId)) return;
        if ("SHOW_RECORDER".equals(command.getAction())) { commands.clear(command.getId()); return; }
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
        main.postDelayed(() -> {
            if (command.getId().equals(consumedCommandId) && commands.pending() != null) {
                consumedCommandId = null; // a failed foreground start can be retried while still visible
            }
        }, 3000);
    }
    @Override public void event(String name, JSONObject data) {
        if ("started".equals(name) && data.optString("commandId").equals(consumedCommandId)) {
            commands.clear(consumedCommandId);
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
