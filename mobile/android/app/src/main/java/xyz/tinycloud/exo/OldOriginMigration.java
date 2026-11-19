package xyz.tinycloud.exo;

import androidx.annotation.Nullable;
import java.io.IOException;

/**
 * TC-3045: before the old origin (https://localhost) is wiped, the web app's work and settings that live only there are
 * copied to the new one. The web app sends its allowlist ({@code frontend/src/lib/oldOriginImport.ts}); a hidden
 * WebView at the old origin exports those localStorage keys and IndexedDB rows to an app-private file (no backup); the
 * web app at the new origin imports the file's contents, writes its marker after them, and acks.
 *
 * <p>The ack wipes nothing: the WebView writes localStorage to disk seconds later, so an app killed right after the
 * import could lose the copy. On a later launch the web app finds its marker on disk (written after every copied item,
 * so they are on disk too) and confirms; only the confirm deletes the file and lets the wipe run ({@link OldOriginWipe}).
 * Without the marker the web app imports again from the same file, keeping what the new origin has, and acks again.
 * Every launch retries; the old origin's data is never wiped on an unconfirmed copy.
 *
 * <p>From launch {@link #SCRUB_FROM_LAUNCH} on (counted once per process from the first launch with work to do), while
 * the copy is still unconfirmed, the old origin's sign-in token and session keys are removed first, by the web app's
 * scrub script in the same hidden WebView; the old origin's other data stays until a confirmed copy.
 */
final class OldOriginMigration {
    static final String EXPORT_FILE = "old-origin-export.json";
    static final int SCRUB_FROM_LAUNCH = 3;

    interface Store {
        /** Whether the web app has acked an import. */
        boolean imported();
        void markImported();
        /** Whether the web app has confirmed the import is on disk at the new origin. */
        boolean confirmed();
        /** Durable before it returns: the wipe that follows depends on it. */
        void markConfirmed();
        /** Counts this launch (once per process, durably) and returns the launches counted so far. */
        int countLaunch();
    }

    interface ExportFile {
        @Nullable String read() throws IOException;
        void write(String json) throws IOException;
        void delete();
    }

    interface Exporter {
        /**
         * Runs {@code script}, the body of an async function of {@code allow}, at the old origin with the web app's
         * allowlist ({@code allowJson}); calls back once with the JSON it resolves.
         */
        void export(String allowJson, String script, Exported done);
    }

    interface Exported {
        void exported(String json);
        void failed(String reason);
    }

    interface Scrubbed {
        void scrubbed(String json);
        void failed(String reason);
    }

    interface Taken {
        /**
         * {@code state}: "done", "skip", "export" (import, then ack) or "verify" (an earlier launch acked: confirm if
         * the marker is there, else import again and ack), the last two with the export's JSON as {@code data}.
         */
        void resolve(String state, @Nullable String data);
        void reject(String reason);
    }

    private OldOriginMigration() {}

    /**
     * What the web app should do. "skip" for a dev build still served from the old site (it keeps its data, and the
     * wipe leaves it alone too). "done" once confirmed. Otherwise the export: the file from an earlier launch, or a
     * fresh one, written to the file before it is handed over; from launch {@link #SCRUB_FROM_LAUNCH} on, after the
     * scrub has run (its failure is reported and doesn't hold up the export).
     */
    static void take(Store store, ExportFile file, Exporter exporter, @Nullable String appHost, String allowJson,
                     String script, String scrubScript, Scrubbed scrubbed, Taken taken) {
        if (OldOriginWipe.OLD_SITE.equalsIgnoreCase(appHost)) {
            taken.resolve("skip", null);
            return;
        }
        if (store.confirmed()) {
            // Left behind if the app died between the confirm's flag and the file's deletion.
            file.delete();
            taken.resolve("done", null);
            return;
        }
        String state = store.imported() ? "verify" : "export";
        Runnable handOver = () -> handOver(state, file, exporter, allowJson, script, taken);
        if (store.countLaunch() < SCRUB_FROM_LAUNCH) {
            handOver.run();
            return;
        }
        exporter.export("{}", scrubScript, new Exported() {
            @Override public void exported(String json) {
                scrubbed.scrubbed(json);
                handOver.run();
            }
            @Override public void failed(String reason) {
                scrubbed.failed(reason);
                handOver.run();
            }
        });
    }

    private static void handOver(String state, ExportFile file, Exporter exporter, String allowJson, String script,
                                 Taken taken) {
        try {
            String existing = file.read();
            if (existing != null) {
                taken.resolve(state, existing);
                return;
            }
        } catch (IOException e) {
            taken.reject("Could not read the old origin's export (" + e.getClass().getSimpleName() + ")");
            return;
        }
        exporter.export(allowJson, script, new Exported() {
            @Override public void exported(String json) {
                try {
                    file.write(json);
                } catch (IOException e) {
                    taken.reject("Could not save the old origin's export (" + e.getClass().getSimpleName() + ")");
                    return;
                }
                taken.resolve(state, json);
            }
            @Override public void failed(String reason) {
                taken.reject("Could not export the old origin's data (" + reason + ")");
            }
        });
    }

    /** The web app has imported the export: mark it. The file stays for a re-import until the copy is confirmed. */
    static void ack(Store store) {
        store.markImported();
    }

    /** The import is on disk at the new origin: mark it, delete the file, and only then start the wipe. */
    static void confirm(Store store, ExportFile file, Runnable startWipe) {
        store.markConfirmed();
        file.delete();
        startWipe.run();
    }
}
