package xyz.tinycloud.exo.voicenotes;

import android.Manifest;
import android.util.Base64;
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
import java.io.IOException;

/**
 * JS bridge for native voice notes. Contract (shared with iOS and the TS
 * definitions in frontend/src/lib/voiceNotes/nativeVoiceNotes.ts):
 *
 *   start()              → { id, startedAt }
 *   stop()               → { id, startedAt, durationMs, mimeType, sizeBytes,
 *                            silencedMs, silencedEvents, noSignalMs }
 *   status()             → { state, reason, id?, elapsedMs }
 *   readAudio({ id })    → { id, mimeType, base64 }
 *   deleteAudio({ id })  → {}
 *   events: "micState" { state, reason, at }, "level" { level }
 */
@CapacitorPlugin(
    name = "VoiceNotes",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class VoiceNotesPlugin extends Plugin {

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
        startRecording(call);
    }

    @PermissionCallback
    private void afterMicPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            startRecording(call);
        } else {
            call.reject("Microphone permission denied", "permission_denied");
        }
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
        byte[] bytes = new byte[(int) file.length()];
        try (FileInputStream in = new FileInputStream(file)) {
            int read = 0;
            while (read < bytes.length) {
                int n = in.read(bytes, read, bytes.length - read);
                if (n < 0) break;
                read += n;
            }
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
        if (id != null) VoiceRecorder.fileFor(getContext(), id).delete();
        call.resolve();
    }
}
