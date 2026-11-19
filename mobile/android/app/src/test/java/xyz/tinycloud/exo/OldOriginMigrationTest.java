package xyz.tinycloud.exo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

/** TC-3045: the old origin's export, the web app's ack and confirm, the scrub, and the wipe that waits for the confirm. */
public class OldOriginMigrationTest {
    private static final String NEW_HOST = "app.tinycloud.one";
    private static final String ALLOW = "{\"exact\":[\"exo.voiceNotes.transcriber\"],\"prefixes\":[],\"databases\":[]}";
    private static final String SCRIPT = "return JSON.stringify({version: 1});";
    private static final String SCRUB = "localStorage.removeItem(\"xyz.tinycloud.tinychat:session\"); return \"{}\";";
    private static final String EXPORT = "{\"version\":1,\"localStorage\":[[\"exo.voiceNotes.transcriber\",\"private-cloud\"]]}";

    /** Persisted across simulated launches: the migration's flags, launch count and file. */
    private final List<String> events = new ArrayList<>();
    private boolean imported;
    private boolean confirmed;
    private int launches;
    private boolean countedThisLaunch;
    private String file;
    private boolean failWrite;

    private final OldOriginMigration.Store store = new OldOriginMigration.Store() {
        @Override public boolean imported() { return imported; }
        @Override public void markImported() { imported = true; events.add("imported"); }
        @Override public boolean confirmed() { return confirmed; }
        @Override public void markConfirmed() { confirmed = true; events.add("confirmed"); }
        @Override public int countLaunch() {
            if (!countedThisLaunch) launches++;
            countedThisLaunch = true;
            return launches;
        }
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

    /** Runs at the old origin; the test answers each run through {@link #pending}. */
    private final class FakeExporter implements OldOriginMigration.Exporter {
        int runs;
        String allow;
        final List<String> scripts = new ArrayList<>();
        OldOriginMigration.Exported pending;
        @Override public void export(String allowJson, String script, OldOriginMigration.Exported done) {
            runs++;
            allow = allowJson;
            scripts.add(script);
            events.add(script.equals(SCRUB) ? "scrub" : "export");
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
    private final List<String> scrubResults = new ArrayList<>();

    private final OldOriginMigration.Scrubbed scrubbed = new OldOriginMigration.Scrubbed() {
        @Override public void scrubbed(String json) { scrubResults.add(json); }
        @Override public void failed(String reason) { scrubResults.add("failed: " + reason); }
    };

    private Answer take(String appHost) {
        Answer answer = new Answer();
        OldOriginMigration.take(store, exportFile, exporter, appHost, ALLOW, SCRIPT, SCRUB, scrubbed, answer);
        return answer;
    }

    /** A new process: the next take counts a launch. */
    private Answer launch() {
        countedThisLaunch = false;
        return take(NEW_HOST);
    }

    @Test public void exportsWithTheWebAppsAllowlistAndSavesTheFileBeforeHandingItOver() {
        Answer answer = launch();
        assertEquals(1, exporter.runs);
        assertEquals(ALLOW, exporter.allow);
        assertEquals(List.of(SCRIPT), exporter.scripts);
        assertNull("nothing handed over before the export answers", answer.state);

        exporter.pending.exported(EXPORT);

        assertEquals("export", answer.state);
        assertEquals(EXPORT, answer.data);
        assertEquals(EXPORT, file);
        assertFalse(imported);
    }

    @Test public void aLaterLaunchBeforeTheAckReusesTheSavedExport() {
        file = EXPORT;
        Answer answer = launch();
        assertEquals(0, exporter.runs);
        assertEquals("export", answer.state);
        assertEquals(EXPORT, answer.data);
    }

    @Test public void aFailedExportIsRejectedAndLeavesNoFileAndNoImport() {
        Answer answer = launch();
        exporter.pending.failed("timed out");
        assertTrue(answer.rejected.contains("timed out"));
        assertNull(file);
        assertFalse(imported);
    }

    @Test public void anExportThatCannotBeSavedIsRejected() {
        failWrite = true;
        Answer answer = launch();
        exporter.pending.exported(EXPORT);
        assertNull(answer.state);
        assertTrue(answer.rejected.contains("save"));
        assertFalse(imported);
    }

    @Test public void theAckMarksTheImportAndKeepsTheFile() {
        file = EXPORT;
        OldOriginMigration.ack(store);
        assertEquals(List.of("imported"), events);
        assertTrue(imported);
        assertFalse(confirmed);
        assertEquals("kept for a re-import until the copy is confirmed", EXPORT, file);
    }

    @Test public void aLaunchAfterTheAckVerifiesWithTheSameExport() {
        imported = true;
        file = EXPORT;
        Answer answer = launch();
        assertEquals("verify", answer.state);
        assertEquals(EXPORT, answer.data);
        assertEquals(0, exporter.runs);
    }

    @Test public void aLaunchAfterTheAckWithoutItsFileExportsAgainToVerify() {
        imported = true;
        Answer answer = launch();
        exporter.pending.exported(EXPORT);
        assertEquals("verify", answer.state);
        assertEquals(EXPORT, answer.data);
        assertEquals(EXPORT, file);
    }

    @Test public void theConfirmMarksItThenDeletesTheFileThenStartsTheWipe() {
        imported = true;
        file = EXPORT;
        OldOriginMigration.confirm(store, exportFile, () -> events.add("wipe"));
        assertEquals(List.of("confirmed", "file deleted", "wipe"), events);
        assertNull(file);
    }

    @Test public void onceConfirmedTakeIsDoneAndClearsAFileLeftBehind() {
        imported = true;
        confirmed = true;
        file = EXPORT;
        Answer answer = launch();
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

    @Test public void fromTheThirdUnconfirmedLaunchTheScrubRunsBeforeTheExportIsHandedOver() {
        launch();
        exporter.pending.exported(EXPORT);
        OldOriginMigration.ack(store);
        assertEquals("verify", launch().state);
        assertEquals("launches 1 and 2 don't scrub", List.of(SCRIPT), exporter.scripts);

        Answer third = launch();
        assertEquals(List.of(SCRIPT, SCRUB), exporter.scripts);
        assertEquals("the scrub sees no allowlist", "{}", exporter.allow);
        assertNull("handed over only after the scrub answers", third.state);

        exporter.pending.exported("{\"removed\":3}");

        assertEquals(List.of("{\"removed\":3}"), scrubResults);
        assertEquals("verify", third.state);
        assertEquals(EXPORT, third.data);
    }

    @Test public void aFailedScrubStillHandsOverTheExport() {
        launches = OldOriginMigration.SCRUB_FROM_LAUNCH - 1;
        imported = true;
        file = EXPORT;
        Answer answer = launch();
        exporter.pending.failed("timed out");
        assertEquals(List.of("failed: timed out"), scrubResults);
        assertEquals("verify", answer.state);
        assertEquals(EXPORT, answer.data);
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

    /** What MainActivity's first frame does: the wipe, gated on the confirm. */
    private OldOriginWipe.Result launchWipe() {
        return OldOriginWipe.startAfterConfirm(confirmed, wipeStore, wiper, (delayMs, task) -> {}, wipeEvents, NEW_HOST);
    }

    /** The web app's import at the new origin; the marker landed on disk or it didn't. */
    private void webAppImports(Answer taken, boolean markerOnDisk) {
        if (taken.state.equals("verify") && markerOnDisk) {
            OldOriginMigration.confirm(store, exportFile, () -> assertEquals(OldOriginWipe.Result.STARTED, launchWipe()));
            return;
        }
        OldOriginMigration.ack(store);
    }

    @Test public void theFirstLaunchImportsAndAcksButWipesNothing() {
        Answer first = launch();
        exporter.pending.exported(EXPORT);
        assertEquals("export", first.state);
        webAppImports(first, false);

        assertEquals(OldOriginWipe.Result.NOT_CONFIRMED, launchWipe());
        assertTrue(imported);
        assertTrue(wipedSites.isEmpty());
        assertEquals(0, attempts);
        assertEquals(EXPORT, file);
    }

    @Test public void theSecondLaunchWithTheCopyOnDiskConfirmsAndWipesOnce() {
        Answer first = launch();
        exporter.pending.exported(EXPORT);
        webAppImports(first, false);

        Answer second = launch();
        assertEquals("verify", second.state);
        webAppImports(second, true);

        assertEquals(List.of(OldOriginWipe.OLD_SITE), wipedSites);
        assertTrue(wiped);
        assertNull(file);
        assertEquals(OldOriginWipe.Result.ALREADY_DONE, launchWipe());
        assertEquals("done", launch().state);
        assertEquals(1, wipedSites.size());
        assertEquals(1, exporter.runs);
    }

    @Test public void theSecondLaunchWithoutTheCopyImportsAgainAndWipesNothing() {
        Answer first = launch();
        exporter.pending.exported(EXPORT);
        webAppImports(first, false);

        Answer second = launch();
        assertEquals("verify", second.state);
        assertEquals("the same export, for the re-import", EXPORT, second.data);
        webAppImports(second, false);

        assertFalse(confirmed);
        assertEquals(OldOriginWipe.Result.NOT_CONFIRMED, launchWipe());
        assertTrue(wipedSites.isEmpty());
        assertEquals(EXPORT, file);
    }

    @Test public void aCopyThatKeepsFailingScrubsTheSignInKeysFromTheThirdLaunchButNeverWipesTheData() {
        Answer first = launch();
        exporter.pending.exported(EXPORT);
        webAppImports(first, false);
        for (int launch = 2; launch <= OldOriginMigration.SCRUB_FROM_LAUNCH + 3; launch++) {
            Answer answer = launch();
            if (launch >= OldOriginMigration.SCRUB_FROM_LAUNCH) exporter.pending.exported("{\"removed\":0}");
            assertEquals("verify", answer.state);
            webAppImports(answer, false);
            assertEquals(OldOriginWipe.Result.NOT_CONFIRMED, launchWipe());
        }
        assertEquals("a scrub on every unconfirmed launch from the third", 4, scrubResults.size());
        assertTrue("the old origin's data is never wiped on an unconfirmed copy", wipedSites.isEmpty());
        assertEquals(0, attempts);
        assertEquals("the export itself ran once; the file serves every retry", 1, exporter.runs - scrubResults.size());

        // The copy lands at last: confirmed, then the full wipe, and no more scrubs.
        Answer last = launch();
        exporter.pending.exported("{\"removed\":0}");
        webAppImports(last, true);
        assertEquals(List.of(OldOriginWipe.OLD_SITE), wipedSites);
        assertEquals("done", launch().state);
        assertEquals(5, scrubResults.size());
    }

    @Test public void beforeTheConfirmNoLaunchWipesOrSpendsAnAttempt() {
        imported = true;
        for (int launch = 0; launch < OldOriginWipe.MAX_ATTEMPTS + 2; launch++) {
            assertEquals(OldOriginWipe.Result.NOT_CONFIRMED, launchWipe());
        }
        assertEquals(0, attempts);
        assertTrue(wipedSites.isEmpty());
        assertFalse(wiped);
    }

    @Test public void aRepeatedConfirmAfterTheWipeWipesNothingAgain() {
        imported = true;
        OldOriginMigration.confirm(store, exportFile, this::launchWipe);
        assertEquals(List.of(OldOriginWipe.OLD_SITE), wipedSites);

        OldOriginMigration.confirm(store, exportFile, () -> assertEquals(OldOriginWipe.Result.ALREADY_DONE, launchWipe()));

        assertEquals(1, wipedSites.size());
        assertEquals(1, attempts);
    }
}
