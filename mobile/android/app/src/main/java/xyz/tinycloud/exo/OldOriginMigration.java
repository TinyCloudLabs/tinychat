package xyz.tinycloud.exo;

import androidx.annotation.Nullable;
import java.io.IOException;

/**
 * TC-3045: before the old origin (https://localhost) is wiped, the web app's work and settings that live only there are
 * copied to the new one. The web app sends its allowlist ({@code frontend/src/lib/oldOriginImport.ts}); a hidden
 * WebView at the old origin exports those localStorage keys and IndexedDB rows to an app-private file (no backup); the
 * web app at the new origin imports the file's contents and acks; this deletes the file, then lets the wipe run
 * ({@link OldOriginWipe}). Until the ack nothing is wiped, so a failed or abandoned import keeps the old data for the
 * next launch, which reuses the file if it was written.
 */
final class OldOriginMigration {
    static final String EXPORT_FILE = "old-origin-export.json";

    /** Whether the web app has acked the import. */
    interface Store {
        boolean imported();
        /** Durable before it returns: the wipe that follows depends on it. */
        void markImported();
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

    interface Taken {
        /** {@code state}: "done", "skip", or "export" with the export's JSON as {@code data}. */
        void resolve(String state, @Nullable String data);
        void reject(String reason);
    }

    private OldOriginMigration() {}

    /**
     * What the web app should import. "skip" for a dev build still served from the old site (it keeps its data, and
     * the wipe leaves it alone too). "done" once imported. Otherwise the export: the file from an earlier launch, or a
     * fresh one, written to the file before it is handed over.
     */
    static void take(Store store, ExportFile file, Exporter exporter, @Nullable String appHost, String allowJson,
                     String script, Taken taken) {
        if (OldOriginWipe.OLD_SITE.equalsIgnoreCase(appHost)) {
            taken.resolve("skip", null);
            return;
        }
        if (store.imported()) {
            // Left behind if the app died between the ack's flag and the file's deletion.
            file.delete();
            taken.resolve("done", null);
            return;
        }
        try {
            String existing = file.read();
            if (existing != null) {
                taken.resolve("export", existing);
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
                taken.resolve("export", json);
            }
            @Override public void failed(String reason) {
                taken.reject("Could not export the old origin's data (" + reason + ")");
            }
        });
    }

    /** The web app has imported the export: mark it, delete the file, and only then start the wipe. */
    static void ack(Store store, ExportFile file, Runnable startWipe) {
        store.markImported();
        file.delete();
        startWipe.run();
    }
}
