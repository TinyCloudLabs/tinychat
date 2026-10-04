package xyz.tinycloud.exo.voicenotes;

import android.content.Context;
import android.media.AudioManager;
import android.media.AudioRecordingConfiguration;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One voice note at a time, captured with MediaRecorder to AAC in an MPEG-4
 * container (.m4a) under the app's private files dir.
 *
 * Mic state comes from the OS, not from guessing: on Android 10+ the recorder's
 * own AudioRecordingCallback reports when the system silences this capture
 * (a phone call or another app took priority, the global mic privacy toggle is
 * off, or the app lost its foreground right to the mic). A second, weaker
 * signal is the input level: sustained zero amplitude means no signal is
 * arriving even though the OS says we are live (e.g. a hardware mute).
 *
 * A recording is capped at {@link #MAX_DURATION_MS} (or a shorter limit the
 * caller asks for): the level tick stops it through the same path as a manual
 * stop, so the file is finalized normally, the sidecar is written (the note is
 * pending until the web layer saves it), and the listener hears onAutoStopped.
 * MediaRecorder's own max duration, a little later, is only a backstop.
 */
public final class VoiceRecorder {

    public interface Listener {
        void onStateChanged(String state, String reason);

        void onLevel(double level);

        /**
         * The recording reached its limit and was stopped (and its sidecar written).
         * `result` is null when it captured no audio.
         */
        void onAutoStopped(Result result, long maxDurationMs);
    }

    public static final class Result {
        public final String id;
        public final File file;
        public final long startedAtMs;
        public final long durationMs;
        public final long silencedMs;
        public final long noSignalMs;
        public final int silencedEvents;

        Result(String id, File file, long startedAtMs, long durationMs, long silencedMs, long noSignalMs, int silencedEvents) {
            this.id = id;
            this.file = file;
            this.startedAtMs = startedAtMs;
            this.durationMs = durationMs;
            this.silencedMs = silencedMs;
            this.noSignalMs = noSignalMs;
            this.silencedEvents = silencedEvents;
        }
    }

    public static final String MIME_TYPE = "audio/mp4";
    public static final String STATE_IDLE = "idle";
    public static final String STATE_RECORDING = "recording";
    public static final String STATE_SILENCED = "silenced";
    /** micState reason after a recording was stopped at its length limit. */
    public static final String REASON_MAX_DURATION = "max_duration";

    /**
     * The longest voice note (60 min). At 64 kbps AAC that is about 29 MB: 29
     * one-MiB parts in the user's space, one Blob in the webview to play back.
     * An unattended recording (6 h was 188 MB) can no longer outgrow that.
     */
    public static final long MAX_DURATION_MS = 60L * 60 * 1000;
    /** The shortest limit a caller may ask for (tests ask for seconds). */
    public static final long MIN_DURATION_LIMIT_MS = 1000;
    /** MediaRecorder's own limit sits this far past ours, in case the level tick never ran. */
    private static final long BACKSTOP_GRACE_MS = 10_000;

    private static final long LEVEL_INTERVAL_MS = 200;
    /** Zero amplitude for this long while "recording" counts as no signal. */
    private static final long NO_SIGNAL_AFTER_MS = 2000;

    private static VoiceRecorder instance;

    public static synchronized VoiceRecorder get(Context context) {
        if (instance == null) instance = new VoiceRecorder(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Listener listener;

    private MediaRecorder recorder;
    private String id;
    private File file;
    private long startedAtMs;
    private long startedElapsed;
    private long maxDurationMs = MAX_DURATION_MS;
    /** MediaRecorder stopped itself at its backstop limit; its stop() may then throw on a valid file. */
    private boolean recorderSelfStopped;
    private String state = STATE_IDLE;
    private String reason;

    private long silencedSince = -1;
    private long silencedTotal;
    private int silencedEvents;
    private long zeroSince = -1;
    private long noSignalTotal;
    private boolean noSignal;

    private VoiceRecorder(Context context) {
        this.context = context;
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public boolean isRecording() {
        return recorder != null;
    }

    public String getState() {
        return state;
    }

    public String getReason() {
        return reason;
    }

    public String getId() {
        return id;
    }

    public long getStartedAtMs() {
        return startedAtMs;
    }

    public long elapsedMs() {
        return recorder == null ? 0 : SystemClock.elapsedRealtime() - startedElapsed;
    }

    /** The current recording's limit, or the default when idle. */
    public long getMaxDurationMs() {
        return recorder == null ? MAX_DURATION_MS : maxDurationMs;
    }

    /** A requested limit clamped to [MIN_DURATION_LIMIT_MS, MAX_DURATION_MS]; null or <= 0 means the default. */
    public static long clampMaxDurationMs(Long requested) {
        if (requested == null || requested <= 0) return MAX_DURATION_MS;
        return Math.max(MIN_DURATION_LIMIT_MS, Math.min(MAX_DURATION_MS, requested));
    }

    public static File directory(Context context) {
        File dir = new File(context.getFilesDir(), "voice-notes");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    public static File fileFor(Context context, String id) {
        return new File(directory(context), id + ".m4a");
    }

    public synchronized void start(long limitMs) throws IOException {
        if (recorder != null) throw new IllegalStateException("already_recording");
        long limit = clampMaxDurationMs(limitMs);

        id = UUID.randomUUID().toString();
        file = fileFor(context, id);

        MediaRecorder r = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? new MediaRecorder(context) : new MediaRecorder();
        r.setAudioSource(MediaRecorder.AudioSource.MIC);
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        r.setAudioChannels(1);
        r.setAudioSamplingRate(44100);
        r.setAudioEncodingBitRate(64000);
        r.setOutputFile(file.getAbsolutePath());
        r.setMaxDuration((int) Math.min(Integer.MAX_VALUE, limit + BACKSTOP_GRACE_MS));
        r.setOnInfoListener((mr, what, extra) -> {
            if (what == MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED) {
                handler.post(() -> autoStop(mr, true));
            }
        });
        try {
            r.prepare();
            r.start();
        } catch (IOException | RuntimeException e) {
            r.release();
            file.delete();
            id = null;
            file = null;
            throw e;
        }

        recorder = r;
        maxDurationMs = limit;
        recorderSelfStopped = false;
        startedAtMs = System.currentTimeMillis();
        startedElapsed = SystemClock.elapsedRealtime();
        silencedSince = -1;
        silencedTotal = 0;
        silencedEvents = 0;
        zeroSince = -1;
        noSignalTotal = 0;
        noSignal = false;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            r.registerAudioRecordingCallback(context.getMainExecutor(), recordingCallback);
        }
        setState(STATE_RECORDING, null);
        handler.postDelayed(levelTick, LEVEL_INTERVAL_MS);
    }

    /** A manual stop. */
    public synchronized Result stop() {
        return stop(null);
    }

    /** Stops and finalizes the file; the state goes idle with `idleReason`. */
    private Result stop(String idleReason) {
        if (recorder == null) throw new IllegalStateException("not_recording");
        handler.removeCallbacks(levelTick);
        long now = SystemClock.elapsedRealtime();
        if (silencedSince >= 0) silencedTotal += now - silencedSince;
        if (zeroSince >= 0 && noSignal) noSignalTotal += now - zeroSince;

        MediaRecorder r = recorder;
        recorder = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            r.unregisterAudioRecordingCallback(recordingCallback);
        }
        boolean stoppedCleanly = true;
        try {
            r.stop();
        } catch (RuntimeException e) {
            // MediaRecorder throws when no valid audio was captured (e.g. stop
            // right after start); the file is unusable. After it stopped itself
            // at its max duration the file is already finalized, so keep it.
            stoppedCleanly = recorderSelfStopped && file.length() > 0;
        }
        r.release();

        Result result = new Result(id, file, startedAtMs, now - startedElapsed, silencedTotal, noSignalTotal, silencedEvents);
        id = null;
        file = null;
        setState(STATE_IDLE, idleReason);
        if (!stoppedCleanly) {
            result.file.delete();
            throw new IllegalStateException("no_audio_captured");
        }
        return result;
    }

    /**
     * The limit was reached: stop through the same path as a manual stop, write
     * the sidecar so the note is pending until saved, and tell the listener.
     * `expected` guards against a late backstop callback for an older recording.
     */
    private synchronized void autoStop(MediaRecorder expected, boolean selfStopped) {
        if (recorder == null || (expected != null && recorder != expected)) return;
        if (selfStopped) recorderSelfStopped = true;
        long limit = maxDurationMs;
        Result result;
        try {
            result = stop(REASON_MAX_DURATION);
        } catch (IllegalStateException e) {
            result = null;
        }
        if (result != null) writeSidecar(context, result);
        VoiceNoteService.stop(context);
        if (listener != null) listener.onAutoStopped(result, limit);
    }

    /** What stop() hands the web layer, and what the sidecar keeps for listPending(). */
    public static JSONObject describe(Result result) {
        JSONObject out = new JSONObject();
        try {
            out.put("id", result.id);
            out.put("startedAt", result.startedAtMs);
            out.put("durationMs", result.durationMs);
            out.put("mimeType", MIME_TYPE);
            out.put("sizeBytes", result.file.length());
            out.put("silencedMs", result.silencedMs);
            out.put("silencedEvents", result.silencedEvents);
            out.put("noSignalMs", result.noSignalMs);
        } catch (JSONException e) {
            // put() throws only for non-finite numbers; none of these are.
        }
        return out;
    }

    public static File sidecarFor(Context context, String id) {
        return new File(directory(context), id + ".json");
    }

    /**
     * Until the web layer confirms the save (deleteAudio), the sidecar lets
     * listPending() hand the recording back after a failed upload, an app
     * restart, or an auto-stop nobody was listening for.
     */
    public static void writeSidecar(Context context, Result result) {
        try (FileOutputStream out = new FileOutputStream(sidecarFor(context, result.id))) {
            out.write(describe(result).toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            // Best effort: without it the note still saves now, it just cannot be retried later.
        }
    }

    private void setState(String next, String why) {
        boolean changed = !next.equals(state) || (why == null ? reason != null : !why.equals(reason));
        state = next;
        reason = why;
        if (changed && listener != null) listener.onStateChanged(next, why);
    }

    private final Runnable levelTick = new Runnable() {
        @Override
        public void run() {
            MediaRecorder r = recorder;
            if (r == null) return;
            int amplitude;
            try {
                amplitude = r.getMaxAmplitude();
            } catch (RuntimeException e) {
                amplitude = 0;
            }
            long now = SystemClock.elapsedRealtime();
            if (amplitude == 0) {
                if (zeroSince < 0) zeroSince = now;
                if (!noSignal && now - zeroSince >= NO_SIGNAL_AFTER_MS && STATE_RECORDING.equals(state)) {
                    noSignal = true;
                    setState(STATE_RECORDING, "no_signal");
                }
            } else {
                if (noSignal) {
                    noSignalTotal += now - zeroSince;
                    noSignal = false;
                    if (STATE_RECORDING.equals(state)) setState(STATE_RECORDING, null);
                }
                zeroSince = -1;
            }
            if (listener != null) listener.onLevel(Math.min(1.0, amplitude / 32767.0));
            if (now - startedElapsed >= maxDurationMs) {
                autoStop(r, false);
                return;
            }
            handler.postDelayed(this, LEVEL_INTERVAL_MS);
        }
    };

    private final AudioManager.AudioRecordingCallback recordingCallback = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        ? new AudioManager.AudioRecordingCallback() {
            @Override
            public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                MediaRecorder r = recorder;
                if (r == null) return;
                AudioRecordingConfiguration config = r.getActiveRecordingConfiguration();
                if (config == null) return;
                long now = SystemClock.elapsedRealtime();
                if (config.isClientSilenced()) {
                    if (silencedSince < 0) {
                        silencedSince = now;
                        silencedEvents++;
                    }
                    setState(STATE_SILENCED, "os_silenced");
                } else {
                    if (silencedSince >= 0) {
                        silencedTotal += now - silencedSince;
                        silencedSince = -1;
                    }
                    setState(STATE_RECORDING, noSignal ? "no_signal" : null);
                }
            }
        }
        : null;
}
