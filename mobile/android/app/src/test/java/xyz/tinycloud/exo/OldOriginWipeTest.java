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

    private static final class FakeFlag implements OldOriginWipe.Flag {
        boolean set;
        @Override public boolean isSet() { return set; }
        @Override public void set() { set = true; }
    }

    private static final class FakeWiper implements OldOriginWipe.Wiper {
        boolean supported = true;
        RuntimeException failure;
        final List<String> sites = new ArrayList<>();
        Runnable pending;
        @Override public boolean wipe(String site, Runnable onDone) {
            if (!supported) return false;
            if (failure != null) throw failure;
            sites.add(site);
            pending = onDone;
            return true;
        }
    }

    @Test public void wipesTheOldSiteAndMarksDoneOnlyWhenTheWebViewFinishes() {
        FakeFlag done = new FakeFlag();
        FakeWiper wiper = new FakeWiper();
        assertEquals(OldOriginWipe.Result.STARTED, OldOriginWipe.start(done, wiper, NEW_HOST));
        assertEquals(Collections.singletonList("localhost"), wiper.sites);
        assertFalse(done.set);
        wiper.pending.run();
        assertTrue(done.set);
    }

    @Test public void neverWipesAgainOnceDone() {
        FakeFlag done = new FakeFlag();
        FakeWiper wiper = new FakeWiper();
        OldOriginWipe.start(done, wiper, NEW_HOST);
        wiper.pending.run();
        assertEquals(OldOriginWipe.Result.ALREADY_DONE, OldOriginWipe.start(done, wiper, NEW_HOST));
        assertEquals(1, wiper.sites.size());
    }

    @Test public void aWipeThatNeverFinishesIsRetriedNextLaunch() {
        FakeFlag done = new FakeFlag();
        FakeWiper wiper = new FakeWiper();
        OldOriginWipe.start(done, wiper, NEW_HOST);
        assertEquals(OldOriginWipe.Result.STARTED, OldOriginWipe.start(done, wiper, NEW_HOST));
        assertEquals(2, wiper.sites.size());
        assertFalse(done.set);
    }

    @Test public void aWebViewWithoutTheFeatureIsSkippedWithoutMarkingAndRetriedLater() {
        FakeFlag done = new FakeFlag();
        FakeWiper wiper = new FakeWiper();
        wiper.supported = false;
        assertEquals(OldOriginWipe.Result.UNSUPPORTED, OldOriginWipe.start(done, wiper, NEW_HOST));
        assertFalse(done.set);
        wiper.supported = true;
        assertEquals(OldOriginWipe.Result.STARTED, OldOriginWipe.start(done, wiper, NEW_HOST));
        wiper.pending.run();
        assertTrue(done.set);
    }

    @Test public void aFailedWipeIsNotMarked() {
        FakeFlag done = new FakeFlag();
        FakeWiper wiper = new FakeWiper();
        wiper.failure = new IllegalArgumentException("boom");
        assertEquals(OldOriginWipe.Result.FAILED, OldOriginWipe.start(done, wiper, NEW_HOST));
        assertFalse(done.set);
    }

    @Test public void aDevBuildServedFromLocalhostIsLeftAlone() {
        FakeFlag done = new FakeFlag();
        FakeWiper wiper = new FakeWiper();
        assertEquals(OldOriginWipe.Result.OLD_SITE_IN_USE, OldOriginWipe.start(done, wiper, "localhost"));
        assertTrue(wiper.sites.isEmpty());
        assertFalse(done.set);
    }
}
