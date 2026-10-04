package xyz.tinycloud.exo.voicenotes;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;

/**
 * JS bridge for native voice notes. Contract (shared with iOS and the TS
 * definitions in frontend/src/lib/voiceNotes/nativeVoiceNotes.ts):
 *
 *   start()              → { id, startedAt }
 *   stop()               → { id, startedAt, durationMs, mimeType, sizeBytes,
 *                            silencedMs, silencedEvents, noSignalMs }
 *   status()             → { state, reason, id?, elapsedMs, androidSdkInt }
 *   readAudio({ id })    → { id, mimeType, base64 }
 *   deleteAudio({ id })  → {}
 *   listPending()        → { recordings: [stop() result, ...] } still on the device
 *   events: "micState" { state, reason, at }, "level" { level }
 */
@CapacitorPlugin(
    name = "VoiceNotes",
    permissions = {
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class VoiceNotesPlugin extends Plugin {

    private static final String PREFS = "xyz.tinycloud.exo.voicenotes";
    private static final String PREF_NOTIFICATIONS_ASKED = "notificationPermissionAsked";

    private VoiceRecorder recorder;

    @Override
    public void load() {
        recorder = VoiceRecorder.get(getContext());
        recorder.setListener(new VoiceRecorder.Listener() {
            @Override
            public void onStateChanged(String state, String reason) {
                JSObject event = new JSObject();
                event.put("state", state);
                event.put("reason", reason);
                event.put("at", System.currentTimeMillis());
                notifyListeners("micState", event, true);
            }

            @Override
            public void onLevel(double level) {
                JSObject event = new JSObject();
                event.put("level", level);
                notifyListeners("level", event);
            }
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "afterMicPermission");
            return;
        }
        startWithMic(call);
    }

    @PermissionCallback
    private void afterMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startWithMic(call);
        } else {
            call.reject("Microphone permission denied", "permission_denied");
        }
    }

    /**
     * Android 13+ hides the recording notification until the app holds
     * POST_NOTIFICATIONS. Ask once, at the first Record after the mic is
     * granted. The answer never blocks recording: denied, the foreground
     * service still runs (listed in the Task Manager) and the OS mic indicator
     * still shows; only the notification is hidden.
     */
    private void startWithMic(PluginCall call) {
        if (shouldAskForNotifications()) {
            preferences().edit().putBoolean(PREF_NOTIFICATIONS_ASKED, true).apply();
            requestPermissionForAlias("notifications", call, "afterNotificationPermission");
            return;
        }
        startRecording(call);
    }

    @PermissionCallback
    private void afterNotificationPermission(PluginCall call) {
        startRecording(call);
    }

    private boolean shouldAskForNotifications() {
        return (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != PermissionState.GRANTED &&
            !preferences().getBoolean(PREF_NOTIFICATIONS_ASKED, false)
        );
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void startRecording(PluginCall call) {
        try {
            // Foreground first: Android 14+ only lets a microphone-type service
            // start while the app is visible, which it is (the user just tapped).
            VoiceNoteService.start(getContext());
            recorder.start();
            JSObject ret = new JSObject();
            ret.put("id", recorder.getId());
            ret.put("startedAt", recorder.getStartedAtMs());
            call.resolve(ret);
        } catch (IllegalStateException e) {
            call.reject("A voice note is already recording", "already_recording");
        } catch (IOException | RuntimeException e) {
            VoiceNoteService.stop(getContext());
            call.reject("Could not start the microphone: " + e.getMessage(), "start_failed", e);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!recorder.isRecording()) {
            call.reject("No voice note is recording", "not_recording");
            return;
        }
        try {
            VoiceRecorder.Result result = recorder.stop();
            JSObject ret = new JSObject();
            ret.put("id", result.id);
            ret.put("startedAt", result.startedAtMs);
            ret.put("durationMs", result.durationMs);
            ret.put("mimeType", VoiceRecorder.MIME_TYPE);
            ret.put("sizeBytes", result.file.length());
            ret.put("silencedMs", result.silencedMs);
            ret.put("silencedEvents", result.silencedEvents);
            ret.put("noSignalMs", result.noSignalMs);
            // Until the web layer confirms the save (deleteAudio), the sidecar
            // lets listPending() hand the recording back after a failed upload
            // or an app restart.
            writeSidecar(result.id, ret);
            call.resolve(ret);
        } catch (IllegalStateException e) {
            call.reject("The recording captured no audio", e.getMessage());
        } finally {
            VoiceNoteService.stop(getContext());
        }
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("state", recorder.getState());
        ret.put("reason", recorder.getReason());
        ret.put("id", recorder.getId());
        ret.put("elapsedMs", recorder.elapsedMs());
        // The webview offers voice-note transcription only from API 26: below it Capacitor's
        // native HTTP cannot send a file body (it needs java.util.Base64).
        ret.put("androidSdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void readAudio(PluginCall call) {
        String id = call.getString("id");
        File file = id == null ? null : VoiceRecorder.fileFor(getContext(), id);
        if (file == null || !file.isFile()) {
            call.reject("Voice note audio not found", "not_found");
            return;
        }
        byte[] bytes;
        try {
            bytes = readAll(file);
        } catch (IOException e) {
            call.reject("Could not read voice note audio", "read_failed", e);
            return;
        }
        JSObject ret = new JSObject();
        ret.put("id", id);
        ret.put("mimeType", VoiceRecorder.MIME_TYPE);
        ret.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteAudio(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            VoiceRecorder.fileFor(getContext(), id).delete();
            sidecarFor(id).delete();
        }
        call.resolve();
    }

    @PluginMethod
    public void listPending(PluginCall call) {
        JSArray recordings = new JSArray();
        File[] sidecars = VoiceRecorder.directory(getContext()).listFiles((dir, name) -> name.endsWith(".json"));
        if (sidecars != null) {
            for (File sidecar : sidecars) {
                String id = sidecar.getName().substring(0, sidecar.getName().length() - ".json".length());
                if (id.equals(recorder.getId())) continue;
                if (!VoiceRecorder.fileFor(getContext(), id).isFile()) {
                    sidecar.delete();
                    continue;
                }
                try {
                    recordings.put(new JSObject(new String(readAll(sidecar), StandardCharsets.UTF_8)));
                } catch (IOException | JSONException e) {
                    // A torn sidecar cannot be described to the web layer; leave the audio for inspection.
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("recordings", recordings);
        call.resolve(ret);
    }

    private File sidecarFor(String id) {
        return new File(VoiceRecorder.directory(getContext()), id + ".json");
    }

    private void writeSidecar(String id, JSObject result) {
        try (FileOutputStream out = new FileOutputStream(sidecarFor(id))) {
            out.write(result.toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // Best effort: without it the note still saves now, it just cannot be retried later.
        }
    }

    private static byte[] readAll(File file) throws IOException {
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < bytes.length) {
                int n = in.read(bytes, read, bytes.length - read);
                if (n < 0) break;
                read += n;
            }
        }
        return bytes;
    }
}
