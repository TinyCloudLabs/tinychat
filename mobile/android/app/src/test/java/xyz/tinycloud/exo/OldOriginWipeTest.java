package xyz.tinycloud.exo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

public class OldOriginWipeTest {
    private static final String NEW_HOST = "app.tinycloud.one";

    /** The persisted state, which outlives each simulated launch. */
    private static final class FakeStore implements OldOriginWipe.Store {
        boolean done;
        int attempts;
        @Override public boolean done() { return done; }
        @Override public void markDone() { done = true; }
        @Override public int attempts() { return attempts; }
        @Override public void setAttempts(int attempts) { this.attempts = attempts; }
    }

    private static final class FakeWiper implements OldOriginWipe.Wiper {
        boolean supported = true;
        RuntimeException failure;
        final List<String> sites = new ArrayList<>();
        Runnable pending;
        @Override public boolean supported() { return supported; }
        @Override public void wipe(String site, Runnable onDone) {
            if (failure != null) throw failure;
            sites.add(site);
            pending = onDone;
        }
    }

    private static final class FakeScheduler implements OldOriginWipe.Scheduler {
        final List<Long> delays = new ArrayList<>();
        Runnable timeout;
        @Override public void after(long delayMs, Runnable task) {
            delays.add(delayMs);
            timeout = task;
        }
    }

    private static final class FakeEvents implements OldOriginWipe.Events {
        int wiped;
        final List<String> failures = new ArrayList<>();
        int gaveUp;
        @Override public void wiped() { wiped++; }
        @Override public void failed(String reason) { failures.add(reason); }
        @Override public void gaveUp() { gaveUp++; }
    }

    private final FakeStore store = new FakeStore();
    private final FakeWiper wiper = new FakeWiper();
    private final FakeScheduler scheduler = new FakeScheduler();
    private final FakeEvents events = new FakeEvents();

    private OldOriginWipe.Result launch() {
        return launch(NEW_HOST);
    }

    private OldOriginWipe.Result launch(String appHost) {
        return OldOriginWipe.start(store, wiper, scheduler, events, appHost);
    }

    @Test public void wipesTheOldSiteAndMarksDoneOnlyWhenTheWebViewFinishes() {
        assertEquals(OldOriginWipe.Result.STARTED, launch());
        assertEquals(Collections.singletonList("localhost"), wiper.sites);
        assertEquals(Collections.singletonList(OldOriginWipe.TIMEOUT_MS), scheduler.delays);
        assertFalse(store.done);
        wiper.pending.run();
        assertTrue(store.done);
        assertEquals(1, events.wiped);
    }

    @Test public void neverWipesAgainOnceDone() {
        launch();
        wiper.pending.run();
        assertEquals(OldOriginWipe.Result.ALREADY_DONE, launch());
        assertEquals(1, wiper.sites.size());
    }

    @Test public void countsTheAttemptBeforeStartingIt() {
        wiper.failure = new IllegalStateException("crash mid-attempt");
        launch();
        assertEquals(1, store.attempts);
    }

    @Test public void aTimedOutAttemptFailsAndALateCallbackIsIgnored() {
        launch();
        scheduler.timeout.run();
        assertEquals(Collections.singletonList("timed out"), events.failures);
        wiper.pending.run();
        assertFalse(store.done);
        assertEquals(0, events.wiped);
    }

    @Test public void aWipeThatNeverSettledIsRetriedNextLaunch() {
        launch();
        assertEquals(OldOriginWipe.Result.STARTED, launch());
        assertEquals(2, wiper.sites.size());
        assertEquals(2, store.attempts);
        assertFalse(store.done);
    }

    @Test public void aFailedWipeIsNotMarked() {
        wiper.failure = new IllegalArgumentException("boom");
        assertEquals(OldOriginWipe.Result.FAILED, launch());
        assertFalse(store.done);
        assertEquals(Collections.singletonList("IllegalArgumentException"), events.failures);
    }

    @Test public void aDevBuildServedFromLocalhostIsLeftAlone() {
        assertEquals(OldOriginWipe.Result.OLD_SITE_IN_USE, launch("localhost"));
        assertTrue(wiper.sites.isEmpty());
        assertEquals(0, store.attempts);
        assertFalse(store.done);
    }

    @Test public void threeFailuresThenNoFourthAttemptAndTheGiveUpLineOnce() {
        for (int i = 0; i < 3; i++) {
            assertEquals(OldOriginWipe.Result.STARTED, launch());
            scheduler.timeout.run();
        }
        assertEquals(3, wiper.sites.size());
        assertEquals(1, events.gaveUp);
        assertEquals(OldOriginWipe.Result.GAVE_UP, launch());
        assertEquals(OldOriginWipe.Result.GAVE_UP, launch());
        assertEquals(3, wiper.sites.size());
        assertEquals(1, events.gaveUp);
        assertFalse(store.done);
    }

    @Test public void aThirdAttemptThatNeverSettledGivesUpOnTheNextLaunchOnce() {
        for (int i = 0; i < 3; i++) launch();
        assertEquals(0, events.gaveUp);
        assertEquals(OldOriginWipe.Result.GAVE_UP, launch());
        assertEquals(OldOriginWipe.Result.GAVE_UP, launch());
        assertEquals(3, wiper.sites.size());
        assertEquals(1, events.gaveUp);
    }

    @Test public void successOnTheSecondAttemptSetsDoneAndStops() {
        launch();
        scheduler.timeout.run();
        launch();
        wiper.pending.run();
        scheduler.timeout.run();
        assertTrue(store.done);
        assertEquals(Collections.singletonList("timed out"), events.failures);
        assertEquals(OldOriginWipe.Result.ALREADY_DONE, launch());
        assertEquals(2, wiper.sites.size());
        assertEquals(0, events.gaveUp);
    }

    @Test public void unsupportedLaunchesDoNotConsumeAttempts() {
        wiper.supported = false;
        for (int i = 0; i < 5; i++) assertEquals(OldOriginWipe.Result.UNSUPPORTED, launch());
        assertEquals(0, store.attempts);
        assertTrue(wiper.sites.isEmpty());
        assertFalse(store.done);
        wiper.supported = true;
        assertEquals(OldOriginWipe.Result.STARTED, launch());
        wiper.pending.run();
        assertTrue(store.done);
        assertEquals(1, store.attempts);
    }
}
