package xyz.tinycloud.exo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** TC-3045: the old origin's export, the web app's ack, and the wipe that waits for it. */
public class OldOriginMigrationTest {
    private static final String NEW_HOST = "app.tinycloud.one";
    private static final String ALLOW = "{\"exact\":[\"exo.voiceNotes.transcriber\"],\"prefixes\":[],\"databases\":[]}";
    private static final String SCRIPT = "return JSON.stringify({version: 1});";
    private static final String EXPORT = "{\"version\":1,\"localStorage\":[[\"exo.voiceNotes.transcriber\",\"private-cloud\"]]}";

    /** Persisted across simulated launches: the imported flag (migration) and the wipe's done flag and attempts. */
    private final List<String> events = new ArrayList<>();
    private boolean imported;
    private String file;
    private boolean failWrite;

    private final OldOriginMigration.Store store = new OldOriginMigration.Store() {
        @Override public boolean imported() { return imported; }
        @Override public void markImported() { imported = true; events.add("imported"); }
    };

    private final OldOriginMigration.ExportFile exportFile = new OldOriginMigration.ExportFile() {
        @Override public String read() { return file; }
        @Override public void write(String json) throws IOException {
            if (failWrite) throw new IOException("disk full");
            file = json;
            events.add("file written");
        }
        @Override public void delete() {
            if (file != null) events.add("file deleted");
            file = null;
        }
    };

    private static final class FakeExporter implements OldOriginMigration.Exporter {
        int runs;
        String allow;
        String script;
        OldOriginMigration.Exported pending;
        @Override public void export(String allowJson, String script, OldOriginMigration.Exported done) {
            runs++;
            this.allow = allowJson;
            this.script = script;
            pending = done;
        }
    }

    private static final class Answer implements OldOriginMigration.Taken {
        String state;
        String data;
        String rejected;
        @Override public void resolve(String state, String data) { this.state = state; this.data = data; }
        @Override public void reject(String reason) { rejected = reason; }
    }

    private final FakeExporter exporter = new FakeExporter();

    private Answer take(String appHost) {
        Answer answer = new Answer();
        OldOriginMigration.take(store, exportFile, exporter, appHost, ALLOW, SCRIPT, answer);
        return answer;
    }

    @Test public void exportsWithTheWebAppsAllowlistAndSavesTheFileBeforeHandingItOver() {
        Answer answer = take(NEW_HOST);
        assertEquals(1, exporter.runs);
        assertEquals(ALLOW, exporter.allow);
        assertEquals(SCRIPT, exporter.script);
        assertNull("nothing handed over before the export answers", answer.state);

        exporter.pending.exported(EXPORT);

        assertEquals("export", answer.state);
        assertEquals(EXPORT, answer.data);
        assertEquals(EXPORT, file);
        assertFalse(imported);
    }

    @Test public void aLaterLaunchBeforeTheAckReusesTheSavedExport() {
        file = EXPORT;
        Answer answer = take(NEW_HOST);
        assertEquals(0, exporter.runs);
        assertEquals("export", answer.state);
        assertEquals(EXPORT, answer.data);
    }

    @Test public void aFailedExportIsRejectedAndLeavesNoFileAndNoImport() {
        Answer answer = take(NEW_HOST);
        exporter.pending.failed("timed out");
        assertTrue(answer.rejected.contains("timed out"));
        assertNull(file);
        assertFalse(imported);
    }

    @Test public void anExportThatCannotBeSavedIsRejected() {
        failWrite = true;
        Answer answer = take(NEW_HOST);
        exporter.pending.exported(EXPORT);
        assertNull(answer.state);
        assertTrue(answer.rejected.contains("save"));
        assertFalse(imported);
    }

    @Test public void theAckMarksTheImportThenDeletesTheFileThenStartsTheWipe() {
        file = EXPORT;
        OldOriginMigration.ack(store, exportFile, () -> events.add("wipe"));
        assertEquals(List.of("imported", "file deleted", "wipe"), events);
        assertTrue(imported);
        assertNull(file);
    }

    @Test public void onceImportedTakeIsDoneAndClearsAFileLeftBehind() {
        imported = true;
        file = EXPORT;
        Answer answer = take(NEW_HOST);
        assertEquals("done", answer.state);
        assertNull(answer.data);
        assertNull(file);
        assertEquals(0, exporter.runs);
    }

    @Test public void aDevBuildOnTheOldSiteIsSkipped() {
        Answer answer = take("localhost");
        assertEquals("skip", answer.state);
        assertEquals(0, exporter.runs);
    }

    // The wipe's gate. Fakes for OldOriginWipe's seams, as in OldOriginWipeTest.

    private int attempts;
    private boolean wiped;
    private final List<String> wipedSites = new ArrayList<>();

    private final OldOriginWipe.Store wipeStore = new OldOriginWipe.Store() {
        @Override public boolean done() { return wiped; }
        @Override public void markDone() { wiped = true; }
        @Override public int attempts() { return attempts; }
        @Override public void setAttempts(int attempts) { OldOriginMigrationTest.this.attempts = attempts; }
    };

    private final OldOriginWipe.Wiper wiper = new OldOriginWipe.Wiper() {
        @Override public boolean supported() { return true; }
        @Override public void wipe(String site, Runnable onDone) { wipedSites.add(site); onDone.run(); }
    };

    private final OldOriginWipe.Events wipeEvents = new OldOriginWipe.Events() {
        @Override public void wiped() {}
        @Override public void failed(String reason) {}
        @Override public void gaveUp() {}
    };

    private OldOriginWipe.Result launchWipe() {
        return OldOriginWipe.startAfterImport(imported, wipeStore, wiper, (delayMs, task) -> {}, wipeEvents, NEW_HOST);
    }

    @Test public void beforeTheImportNoLaunchWipesOrSpendsAnAttempt() {
        for (int launch = 0; launch < OldOriginWipe.MAX_ATTEMPTS + 2; launch++) {
            assertEquals(OldOriginWipe.Result.NOT_IMPORTED, launchWipe());
        }
        assertEquals(0, attempts);
        assertTrue(wipedSites.isEmpty());
        assertFalse(wiped);
    }

    @Test public void exportThenAckThenTheWipeRunsOnceAndNeverAgain() {
        assertEquals(OldOriginWipe.Result.NOT_IMPORTED, launchWipe());
        Answer answer = take(NEW_HOST);
        exporter.pending.exported(EXPORT);
        assertEquals("export", answer.state);
        assertTrue("the old data is still there while the export waits for the ack", wipedSites.isEmpty());

        OldOriginMigration.ack(store, exportFile, () -> assertEquals(OldOriginWipe.Result.STARTED, launchWipe()));

        assertEquals(List.of(OldOriginWipe.OLD_SITE), wipedSites);
        assertTrue(wiped);
        assertEquals(OldOriginWipe.Result.ALREADY_DONE, launchWipe());
        assertEquals("done", take(NEW_HOST).state);
        assertEquals(1, wipedSites.size());
    }

    @Test public void aRepeatedAckAfterTheWipeWipesNothingAgain() {
        Answer answer = take(NEW_HOST);
        exporter.pending.exported(EXPORT);
        assertEquals("export", answer.state);
        OldOriginMigration.ack(store, exportFile, this::launchWipe);
        assertEquals(List.of(OldOriginWipe.OLD_SITE), wipedSites);

        // The web app's ack answered too late, so it imports and acks again: copy-if-absent, then this.
        OldOriginMigration.ack(store, exportFile, () -> assertEquals(OldOriginWipe.Result.ALREADY_DONE, launchWipe()));

        assertEquals(1, wipedSites.size());
        assertEquals(1, attempts);
        assertEquals(1, exporter.runs);
    }
}
