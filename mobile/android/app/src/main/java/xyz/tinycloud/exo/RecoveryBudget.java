package xyz.tinycloud.exo;

import java.util.ArrayDeque;

/** Allows a few automatic recoveries in a short window, so a renderer that keeps dying cannot loop forever. */
final class RecoveryBudget {
    static final int MAX_AUTOMATIC = 2;
    static final long WINDOW_MS = 60_000L;

    private final ArrayDeque<Long> deaths = new ArrayDeque<>();

    /** Records a death; true while it is still within the automatic budget. */
    synchronized boolean recordDeath(long nowMs) {
        while (!deaths.isEmpty() && nowMs - deaths.peekFirst() >= WINDOW_MS) deaths.removeFirst();
        deaths.addLast(nowMs);
        return deaths.size() <= MAX_AUTOMATIC;
    }

    synchronized void reset() {
        deaths.clear();
    }
}
