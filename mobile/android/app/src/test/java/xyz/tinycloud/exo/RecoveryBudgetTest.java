package xyz.tinycloud.exo;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RecoveryBudgetTest {
    @Test public void stopsAutomaticRecoveryAfterRepeatedDeathsInTheWindow() {
        RecoveryBudget budget = new RecoveryBudget();
        assertTrue(budget.recordDeath(0));
        assertTrue(budget.recordDeath(1_000));
        assertFalse(budget.recordDeath(2_000));
        assertFalse(budget.recordDeath(3_000));
    }

    @Test public void deathsOutsideTheWindowDoNotCount() {
        RecoveryBudget budget = new RecoveryBudget();
        assertTrue(budget.recordDeath(0));
        assertTrue(budget.recordDeath(1_000));
        assertTrue(budget.recordDeath(RecoveryBudget.WINDOW_MS + 1_000));
    }

    @Test public void aManualReloadStartsTheBudgetOver() {
        RecoveryBudget budget = new RecoveryBudget();
        budget.recordDeath(0);
        budget.recordDeath(1);
        assertFalse(budget.recordDeath(2));
        budget.reset();
        assertTrue(budget.recordDeath(3));
    }
}
