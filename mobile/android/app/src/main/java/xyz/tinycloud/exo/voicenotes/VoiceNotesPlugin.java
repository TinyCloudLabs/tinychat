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
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;

/**
 * JS bridge for native voice notes. Contract (shared with iOS and the TS
 * definitions in frontend/src/lib/voiceNotes/nativeVoiceNotes.ts):
 *
 *   start({ maxDurationMs? })  → { id, startedAt, maxDurationMs }
 *   stop()                     → { id, startedAt, durationMs, mimeType, sizeBytes,
 *                                  silencedMs, silencedEvents, noSignalMs }
 *   status()                   → { state, reason, id?, elapsedMs, maxDurationMs, androidSdkInt }
 *   readAudioChunk({ id, offset, length })
 *                              → { id, offset, base64, bytesRead, size, eof }
 *   deleteAudio({ id })        → {}
 *   listPending()              → { recordings: [stop() result, ...] } still on the device
 *   events: "micState" { state, reason, at }, "level" { level },
 *           "autoStopped" { reason: "max_duration", maxDurationMs, at, recording: stop() result | null }
 *
 * A recording stops itself at maxDurationMs (VoiceRecorder.MAX_DURATION_MS,
 * or less when start asks for less): micState goes idle with reason
 * "max_duration" and "autoStopped" carries the result, which is also pending
 * (listPending) until the web layer saves it, exactly like a manual stop.
 * Audio crosses the bridge one chunk at a time, never the whole file.
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

            @Override
            public void onAutoStopped(VoiceRecorder.Result result, long maxDurationMs) {
                JSObject event = new JSObject();
                event.put("reason", VoiceRecorder.REASON_MAX_DURATION);
                event.put("maxDurationMs", maxDurationMs);
                event.put("at", System.currentTimeMillis());
                event.put("recording", result == null ? JSObject.NULL : describe(result));
                // Retained until the webview listens: a reload mid-save still hears it (and
                // listPending() has the recording regardless).
                notifyListeners("autoStopped", event, true);
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
            recorder.start(VoiceRecorder.clampMaxDurationMs(number(call, "maxDurationMs")));
            JSObject ret = new JSObject();
            ret.put("id", recorder.getId());
            ret.put("startedAt", recorder.getStartedAtMs());
            ret.put("maxDurationMs", recorder.getMaxDurationMs());
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
            VoiceRecorder.writeSidecar(getContext(), result);
            call.resolve(describe(result));
        } catch (IllegalStateException e) {
            if ("not_recording".equals(e.getMessage())) {
                // The limit stopped it first; "autoStopped" carries that recording.
                call.reject("No voice note is recording", "not_recording");
            } else {
                call.reject("The recording captured no audio", e.getMessage());
            }
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
        ret.put("maxDurationMs", recorder.getMaxDurationMs());
        // The webview offers voice-note transcription only from API 26: below it Capacitor's
        // native HTTP cannot send a file body (it needs java.util.Base64).
        ret.put("androidSdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /** The most one readAudioChunk call returns, whatever it asks for (it crosses the bridge as base64). */
    private static final int MAX_CHUNK_BYTES = 4 * 1024 * 1024;

    /**
     * Up to `length` bytes of a recording from `offset`, as base64. The web layer
     * reads a note part by part (1 MiB, the size of one stored part) so neither
     * side ever holds the whole file as one string.
     */
    @PluginMethod
    public void readAudioChunk(PluginCall call) {
        String id = call.getString("id");
        Long offset = number(call, "offset");
        Long length = number(call, "length");
        if (id == null || offset == null || offset < 0 || length == null || length <= 0) {
            call.reject("readAudioChunk needs an id, an offset >= 0 and a length > 0", "invalid_argument");
            return;
        }
        File file = VoiceRecorder.fileFor(getContext(), id);
        if (id.contains("/") || !file.isFile()) {
            call.reject("Voice note audio not found", "not_found");
            return;
        }
        try (RandomAccessFile in = new RandomAccessFile(file, "r")) {
            long size = in.length();
            int want = (int) Math.max(0, Math.min(Math.min(length, MAX_CHUNK_BYTES), size - offset));
            byte[] bytes = new byte[want];
            int read = 0;
            if (want > 0) {
                in.seek(offset);
                while (read < want) {
                    int n = in.read(bytes, read, want - read);
                    if (n < 0) break;
                    read += n;
                }
            }
            JSObject ret = new JSObject();
            ret.put("id", id);
            ret.put("offset", offset);
            ret.put("base64", Base64.encodeToString(bytes, 0, read, Base64.NO_WRAP));
            ret.put("bytesRead", read);
            ret.put("size", size);
            ret.put("eof", offset + read >= size);
            call.resolve(ret);
        } catch (IOException e) {
            call.reject("Could not read voice note audio", "read_failed", e);
        }
    }

    @PluginMethod
    public void deleteAudio(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            VoiceRecorder.fileFor(getContext(), id).delete();
            VoiceRecorder.sidecarFor(getContext(), id).delete();
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

    /**
     * A numeric option as a long. PluginCall.getLong() answers only for values the JSON
     * parser made Longs, and a small number (an offset of 0, 3600000 ms) parses as an Integer.
     */
    private static Long number(PluginCall call, String name) {
        Object value = call.getData().opt(name);
        if (!(value instanceof Number)) return null;
        double d = ((Number) value).doubleValue();
        return Double.isNaN(d) || Double.isInfinite(d) ? null : ((Number) value).longValue();
    }

    private static JSObject describe(VoiceRecorder.Result result) {
        try {
            return JSObject.fromJSONObject(VoiceRecorder.describe(result));
        } catch (JSONException e) {
            // describe() holds only strings and numbers.
            return new JSObject();
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
