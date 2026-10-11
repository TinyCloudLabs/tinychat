package xyz.tinycloud.exo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class WebViewRecoveryTest {
    private static final String APP = "https://localhost/";

    @Test public void restoresTheAddressTheUserWasOn() {
        assertEquals("https://localhost/chat/capture/library?x=1",
            WebViewRecovery.restorableUrl("https://localhost/chat/capture/library?x=1", APP));
    }

    @Test public void dropsAddressesFromOtherOrigins() {
        assertNull(WebViewRecovery.restorableUrl("https://example.com/chat", APP));
        assertNull(WebViewRecovery.restorableUrl("http://localhost/chat", APP));
        assertNull(WebViewRecovery.restorableUrl("https://localhost:8443/chat", APP));
    }

    @Test public void dropsMissingOrMalformedAddresses() {
        assertNull(WebViewRecovery.restorableUrl(null, APP));
        assertNull(WebViewRecovery.restorableUrl("about:blank", APP));
        assertNull(WebViewRecovery.restorableUrl("https://localhost/a b", APP));
    }

    @Test public void takingThePendingAddressClearsIt() {
        assertNull(WebViewRecovery.takePendingUrl());
    }

    @Test public void aHeldPageDeathNeverRecreatesOrSpendsBudget() {
        RecoveryBudget budget = new RecoveryBudget();
        for (int i = 0; i < 10; i++) {
            assertEquals(WebViewRecovery.Death.DETACH_ONLY, WebViewRecovery.onDeath(true, budget, i));
        }
        assertEquals(WebViewRecovery.Death.RECREATE, WebViewRecovery.onDeath(false, budget, 20));
    }

    @Test public void exhaustingTheBudgetRecreatesOnceAndHolds() {
        RecoveryBudget budget = new RecoveryBudget();
        assertEquals(WebViewRecovery.Death.RECREATE, WebViewRecovery.onDeath(false, budget, 0));
        assertEquals(WebViewRecovery.Death.RECREATE, WebViewRecovery.onDeath(false, budget, 1));
        assertEquals(WebViewRecovery.Death.RECREATE_AND_HOLD, WebViewRecovery.onDeath(false, budget, 2));
    }
}
