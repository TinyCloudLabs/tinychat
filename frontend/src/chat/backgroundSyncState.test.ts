// RED-first contract for the Settings background-notifications surface (FE3).
//
// Everything the surface DECIDES lives in `backgroundSyncState.ts`; the section
// component is a thin renderer over it. That split is what makes the honest
// Option-C rules testable without a DOM: "never say Live", "reveal exactly
// once", "a blocked queue is not an empty queue", "no unlock on mount".

import { describe, expect, test } from "bun:test";

import {
  BACKGROUND_SYNC_ENABLED_LABEL,
  applyEnableResult,
  backgroundSyncStatus,
  cancelHistoricalResync,
  confirmHistoricalResync,
  disableBackgroundSync,
  dismissReveal,
  enableBackgroundSync,
  initialBackgroundSyncState,
  loadOnMount,
  queueNotices,
  refreshQueue,
  requestHistoricalResync,
  rotateCredentials,
  syncQueuedMeetings,
  type BackgroundSyncDeps,
  type BackgroundSyncState,
} from "./backgroundSyncState";
import type {
  ConnectorWebhookConfigPoll,
  ConnectorWebhookEnabled,
  ConnectorWebhookPending,
  ConnectorWebhooksResult,
} from "@/lib/connectors/webhooksApi";
import type {
  TargetedIngestOutcome,
  TargetedIngestResult,
  TargetedQueueItem,
} from "@/lib/connectors/targetedSync";

// ── Fixtures ─────────────────────────────────────────────────────────

const DELIVERY_URL = "https://api.example.test/api/connectors/webhooks/fireflies/tok_abc";
// Not a real secret: a fixed 43-character base64url-shaped stand-in.
const DELIVERY_SECRET = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";

function okConfig(
  patch: Partial<ConnectorWebhookConfigPoll> = {},
): ConnectorWebhooksResult<ConnectorWebhookConfigPoll> {
  return {
    status: "ok",
    value: {
      enabled: false,
      disabledAt: null,
      source: "fireflies",
      url: null,
      secret: null,
      hasSecret: false,
      createdAt: null,
      ...patch,
    },
  };
}

function mintedValue(patch: Partial<ConnectorWebhookEnabled> = {}): ConnectorWebhookEnabled {
  return {
    status: "enabled",
    rotated: false,
    enabled: true,
    disabledAt: null,
    source: "fireflies",
    url: DELIVERY_URL,
    secret: DELIVERY_SECRET,
    hasSecret: true,
    createdAt: "2026-08-06T10:00:00.000Z",
    ...patch,
  };
}

function okEnabled(
  patch: Partial<ConnectorWebhookEnabled> = {},
): ConnectorWebhooksResult<ConnectorWebhookEnabled> {
  return { status: "ok", value: mintedValue(patch) };
}

function okPending(
  patch: Partial<ConnectorWebhookPending> = {},
): ConnectorWebhooksResult<ConnectorWebhookPending> {
  return {
    status: "ok",
    value: {
      enabled: true,
      disabledAt: null,
      source: "fireflies",
      deliveriesRateLimited: false,
      count: 0,
      pending: [],
      deadCount: 0,
      dead: [],
      ...patch,
    },
  };
}

function pendingItem(meetingId: string): ConnectorWebhookPending["pending"][number] {
  return {
    meetingId,
    kind: "transcript",
    receivedAt: "2026-08-06T09:00:00.000Z",
    attempts: 0,
    nextAttemptAt: "2026-08-06T09:00:00.000Z",
  };
}

function okIngest(patch: Partial<TargetedIngestOutcome> = {}): TargetedIngestResult {
  return {
    ok: true,
    data: {
      stored: 1,
      inserted: 1,
      updated: 0,
      acknowledged: 1,
      alreadySettled: 0,
      tombstoned: 0,
      failures: [],
      unacknowledged: [],
      ackError: null,
      blocked: null,
      itemCount: 12,
      ...patch,
    },
  };
}

interface Calls {
  getConfig: number;
  enable: { source?: string; rotate?: boolean }[];
  disable: number;
  getPending: number;
  drain: number;
  isUnlocked: number;
  unlock: number;
  ingest: TargetedQueueItem[][];
  /** The tripwire: `DELETE /purged` may fire ONLY from the confirmed action. */
  clearPurgeLedger: string[];
}

interface Harness {
  deps: BackgroundSyncDeps;
  calls: Calls;
  emit: (updater: (prev: BackgroundSyncState) => BackgroundSyncState) => void;
  state: () => BackgroundSyncState;
  seen: BackgroundSyncState[];
}

function harness(
  responses: {
    config?: ConnectorWebhooksResult<ConnectorWebhookConfigPoll>;
    enable?: ConnectorWebhooksResult<ConnectorWebhookEnabled>;
    disable?: ConnectorWebhooksResult<{ status: "disabled"; queueDropped: number }>;
    pending?: ConnectorWebhooksResult<ConnectorWebhookPending>;
    drain?: ConnectorWebhooksResult<ConnectorWebhookPending>;
    unlocked?: boolean;
    unlock?: { ok: true } | { ok: false; error?: { message?: string } };
    ingest?: TargetedIngestResult;
    clearPurgeLedger?: ConnectorWebhooksResult<null>;
  } = {},
): Harness {
  const calls: Calls = {
    getConfig: 0,
    enable: [],
    disable: 0,
    getPending: 0,
    drain: 0,
    isUnlocked: 0,
    unlock: 0,
    ingest: [],
    clearPurgeLedger: [],
  };
  let current = initialBackgroundSyncState();
  const seen: BackgroundSyncState[] = [];
  const emit = (updater: (prev: BackgroundSyncState) => BackgroundSyncState) => {
    current = updater(current);
    seen.push(current);
  };
  const deps: BackgroundSyncDeps = {
    source: "fireflies",
    webhooks: {
      getConfig: async () => {
        calls.getConfig += 1;
        return responses.config ?? okConfig();
      },
      enable: async (options = {}) => {
        calls.enable.push(options);
        return responses.enable ?? okEnabled();
      },
      disable: async () => {
        calls.disable += 1;
        return responses.disable ?? { status: "ok", value: { status: "disabled", queueDropped: 0 } };
      },
      getPending: async () => {
        calls.getPending += 1;
        return responses.pending ?? okPending();
      },
      drain: async () => {
        calls.drain += 1;
        return responses.drain ?? responses.pending ?? okPending();
      },
      clearPurgeLedger: async (source: string) => {
        calls.clearPurgeLedger.push(source);
        return responses.clearPurgeLedger ?? { status: "ok", value: null };
      },
    },
    secrets: {
      isUnlocked: () => {
        calls.isUnlocked += 1;
        return responses.unlocked ?? false;
      },
      unlock: async () => {
        calls.unlock += 1;
        return responses.unlock ?? { ok: true };
      },
    },
    ingest: async (items) => {
      calls.ingest.push([...items]);
      return responses.ingest ?? okIngest();
    },
  };
  return { deps, calls, emit, state: () => current, seen };
}

// ── Mount ────────────────────────────────────────────────────────────

describe("loadOnMount", () => {
  test("starts from a loading state that claims nothing", () => {
    const s = initialBackgroundSyncState();
    expect(s.phase).toBe("loading");
    expect(s.reveal).toBeNull();
    expect(s.hasSecret).toBe(false);
    expect(s.queue).toBeNull();
  });

  test("a route-disabled 404 is the DARK product state, not a broken control", async () => {
    const h = harness({ config: { status: "feature-dark" } });
    await loadOnMount(h.deps, h.emit);
    expect(h.state().phase).toBe("dark");
    expect(h.state().notice).toBeNull();
    // Nothing else is attempted, and nothing is retried, against a dark route.
    expect(h.calls.getPending).toBe(0);
    expect(h.calls.drain).toBe(0);
    expect(h.calls.unlock).toBe(0);
  });

  test("401 is a signed-out state, not an outage", async () => {
    const h = harness({ config: { status: "unauthenticated" } });
    await loadOnMount(h.deps, h.emit);
    expect(h.state().phase).toBe("signed-out");
  });

  test("a 503 shows unavailable + retry — never 'off' and never an empty queue", async () => {
    const h = harness({ config: { status: "retryable", httpStatus: 503, code: "unavailable" } });
    await loadOnMount(h.deps, h.emit);
    const s = h.state();
    expect(s.phase).toBe("unavailable");
    expect(s.notice?.retryable).toBe(true);
    expect(s.queue).toBeNull();
    expect(queueNotices(s).some((n) => n.kind === "empty")).toBe(false);
  });

  test("a network failure is unavailable, not off", async () => {
    const h = harness({ config: { status: "offline" } });
    await loadOnMount(h.deps, h.emit);
    expect(h.state().phase).toBe("unavailable");
    expect(h.state().notice?.retryable).toBe(true);
  });

  test("config read with enabled:false parks in 'off' and reads no queue", async () => {
    const h = harness({ config: okConfig({ enabled: false }) });
    await loadOnMount(h.deps, h.emit);
    expect(h.state().phase).toBe("off");
    expect(h.state().hasSecret).toBe(false);
    expect(h.calls.getPending).toBe(0);
  });

  test("enabled + LOCKED secrets: counts are polled, and nothing prompts", async () => {
    const h = harness({
      config: okConfig({ enabled: true, hasSecret: true, url: DELIVERY_URL }),
      unlocked: false,
      pending: okPending({ count: 2, pending: [pendingItem("m1"), pendingItem("m2")] }),
    });
    await loadOnMount(h.deps, h.emit);
    const s = h.state();
    expect(s.phase).toBe("enabled");
    expect(s.hasSecret).toBe(true);
    expect(s.queue?.pendingCount).toBe(2);
    // The whole point of §"no surprise unlock": mount never unlocks, never drains.
    expect(h.calls.unlock).toBe(0);
    expect(h.calls.drain).toBe(0);
    expect(h.calls.ingest.length).toBe(0);
    // …and the poll must not have leaked the delivery URL into the state.
    expect(JSON.stringify(s)).not.toContain(DELIVERY_URL);
  });

  test("enabled + ALREADY-unlocked secrets: next-visit processing runs by itself", async () => {
    const h = harness({
      config: okConfig({ enabled: true, hasSecret: true }),
      unlocked: true,
      drain: okPending({ count: 1, pending: [pendingItem("m1")] }),
      ingest: okIngest({ stored: 1, acknowledged: 1 }),
    });
    await loadOnMount(h.deps, h.emit);
    expect(h.calls.drain).toBe(1);
    expect(h.calls.ingest[0]).toEqual([{ meetingId: "m1", kind: "transcript" }]);
    // Automatic processing is allowed; an automatic UNLOCK is never allowed.
    expect(h.calls.unlock).toBe(0);
    expect(h.state().lastIngest?.stored).toBe(1);
  });

  test("an unlocked visit with an empty drain does not call the ingest engine", async () => {
    const h = harness({
      config: okConfig({ enabled: true, hasSecret: true }),
      unlocked: true,
      drain: okPending({ count: 0 }),
    });
    await loadOnMount(h.deps, h.emit);
    expect(h.calls.ingest.length).toBe(0);
    expect(h.state().queue?.pendingCount).toBe(0);
  });

  test("a fail-closed surfaceBlocked is its own state, never an empty queue", async () => {
    const h = harness({
      config: okConfig({ enabled: true, hasSecret: true }),
      unlocked: false,
      pending: okPending({ count: 0, surfaceBlocked: "ledger_unavailable" }),
    });
    await loadOnMount(h.deps, h.emit);
    const s = h.state();
    expect(s.queue?.blockedReason).toBe("ledger_unavailable");
    const kinds = queueNotices(s).map((n) => n.kind);
    expect(kinds).toContain("blocked");
    expect(kinds).not.toContain("empty");
  });

  test("an unknown future surfaceBlocked reason still reads as blocked", async () => {
    const h = harness({
      config: okConfig({ enabled: true, hasSecret: true }),
      pending: okPending({ count: 0, surfaceBlocked: "some_future_reason" }),
    });
    await loadOnMount(h.deps, h.emit);
    expect(h.state().queue?.blockedReason).toBe("unknown");
    expect(queueNotices(h.state()).map((n) => n.kind)).toContain("blocked");
  });

  test("a queue read outage is unavailable, not zero pending", async () => {
    const h = harness({
      config: okConfig({ enabled: true, hasSecret: true }),
      pending: { status: "retryable", httpStatus: 503, code: null },
    });
    await loadOnMount(h.deps, h.emit);
    const s = h.state();
    expect(s.phase).toBe("enabled");
    expect(s.queue).toBeNull();
    expect(s.queueUnavailable).toBe(true);
    const kinds = queueNotices(s).map((n) => n.kind);
    expect(kinds).toContain("queue-unavailable");
    expect(kinds).not.toContain("empty");
  });
});

// ── Mint, reveal, rotate ─────────────────────────────────────────────

describe("enable / reveal", () => {
  test("mint posts /config for the connector's source and reveals both values once", async () => {
    const h = harness({ enable: okEnabled() });
    await enableBackgroundSync(h.deps, h.emit);
    expect(h.calls.enable).toEqual([{ source: "fireflies" }]);
    const s = h.state();
    expect(s.phase).toBe("enabled");
    expect(s.hasSecret).toBe(true);
    expect(s.reveal).toEqual({
      url: DELIVERY_URL,
      secret: DELIVERY_SECRET,
      rotated: false,
    });
  });

  test("closing the reveal destroys it and marks the recovery path", () => {
    const minted = applyEnableResult(initialBackgroundSyncState(), mintedValue());
    expect(minted.reveal).not.toBeNull();
    const closed = dismissReveal(minted);
    expect(closed.reveal).toBeNull();
    expect(closed.revealClosed).toBe(true);
    expect(JSON.stringify(closed)).not.toContain(DELIVERY_SECRET);
    expect(JSON.stringify(closed)).not.toContain(DELIVERY_URL);
  });

  test("a reload can never bring the secret back", async () => {
    const h = harness({
      config: okConfig({ enabled: true, hasSecret: true, url: DELIVERY_URL }),
    });
    h.emit(() => dismissReveal(applyEnableResult(initialBackgroundSyncState(), mintedValue())));
    await loadOnMount(h.deps, h.emit);
    expect(h.state().reveal).toBeNull();
    expect(h.state().hasSecret).toBe(true);
  });

  test("a no-op POST that carries no secret never fakes a reveal", async () => {
    const h = harness({ enable: okEnabled({ secret: null, hasSecret: true }) });
    await enableBackgroundSync(h.deps, h.emit);
    expect(h.state().reveal).toBeNull();
    expect(h.state().phase).toBe("enabled");
    // The user still needs a way out — the rotate recovery path is offered.
    expect(h.state().revealClosed).toBe(true);
  });

  test("rotation asks for a rotate and reveals the replacement pair", async () => {
    const h = harness({ enable: okEnabled({ rotated: true }) });
    await rotateCredentials(h.deps, h.emit);
    expect(h.calls.enable).toEqual([{ source: "fireflies", rotate: true }]);
    expect(h.state().reveal?.rotated).toBe(true);
  });

  test("a failed rotation never claims success", async () => {
    const h = harness({ enable: { status: "retryable", httpStatus: 503, code: null } });
    await rotateCredentials(h.deps, h.emit);
    expect(h.state().reveal).toBeNull();
    expect(h.state().notice?.tone).toBe("error");
    expect(h.state().notice?.retryable).toBe(true);
    expect(h.state().busy).toBeNull();
  });

  test("a mint against a dark route flips the surface dark instead of erroring", async () => {
    const h = harness({ enable: { status: "feature-dark" } });
    await enableBackgroundSync(h.deps, h.emit);
    expect(h.state().phase).toBe("dark");
  });

  test("the surface is busy while a mint is in flight", async () => {
    const h = harness();
    const done = enableBackgroundSync(h.deps, h.emit);
    expect(h.state().busy).toBe("enabling");
    await done;
    expect(h.state().busy).toBeNull();
  });
});

// ── Disable ──────────────────────────────────────────────────────────

describe("disable", () => {
  test("teardown turns the surface off and drops every revealed value", async () => {
    const h = harness();
    h.emit(() => applyEnableResult(initialBackgroundSyncState(), mintedValue()));
    await disableBackgroundSync(h.deps, h.emit);
    const s = h.state();
    expect(h.calls.disable).toBe(1);
    expect(s.phase).toBe("off");
    expect(s.hasSecret).toBe(false);
    expect(s.reveal).toBeNull();
    expect(s.queue).toBeNull();
  });

  // A failed `DELETE /config` is specifically NOT "nothing happened": the route
  // writes the durable disabled marker FIRST and answers 503
  // `teardown_incomplete` when a later step fails, so the backend may already
  // report `enabled:false` / `surfaceBlocked:'revoked'` for this address. Saying
  // "Enabled in TinyChat" there tells the user notifications are on at the exact
  // moment the backend has classified them off. "We no longer know" is honest,
  // and the retry copy already says so.
  test("a failed teardown stops claiming enabled and asks for a retry", async () => {
    const h = harness({ disable: { status: "retryable", httpStatus: 503, code: null } });
    h.emit(() => applyEnableResult(initialBackgroundSyncState(), mintedValue()));
    await disableBackgroundSync(h.deps, h.emit);
    expect(h.state().phase).toBe("unavailable");
    expect(backgroundSyncStatus(h.state()).label).not.toBe(BACKGROUND_SYNC_ENABLED_LABEL);
    expect(h.state().notice?.retryable).toBe(true);
  });

  test("an offline teardown is also 'we don't know', never 'off'", async () => {
    const h = harness({ disable: { status: "offline" } });
    h.emit(() => applyEnableResult(initialBackgroundSyncState(), mintedValue()));
    await disableBackgroundSync(h.deps, h.emit);
    expect(h.state().phase).toBe("unavailable");
  });

  test("a dark or signed-out teardown keeps reporting the route/session state", async () => {
    for (const [result, phase] of [
      [{ status: "feature-dark" } as const, "dark"],
      [{ status: "unauthenticated" } as const, "signed-out"],
    ] as const) {
      const h = harness({ disable: result });
      h.emit(() => applyEnableResult(initialBackgroundSyncState(), mintedValue()));
      await disableBackgroundSync(h.deps, h.emit);
      expect(h.state().phase).toBe(phase);
    }
  });
});

// ── User-initiated processing ────────────────────────────────────────

describe("syncQueuedMeetings", () => {
  test("a locked vault is unlocked ONLY by this user-initiated action", async () => {
    const h = harness({
      unlocked: false,
      drain: okPending({ count: 1, pending: [pendingItem("m1")] }),
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.calls.unlock).toBe(1);
    expect(h.calls.drain).toBe(1);
    expect(h.calls.ingest.length).toBe(1);
  });

  test("an already-unlocked vault is not unlocked again", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 1, pending: [pendingItem("m1")] }),
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.calls.unlock).toBe(0);
    expect(h.calls.ingest.length).toBe(1);
  });

  test("a refused unlock stops before the drain and reports it", async () => {
    const h = harness({
      unlocked: false,
      unlock: { ok: false, error: { message: "User rejected the request" } },
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.calls.drain).toBe(0);
    expect(h.calls.ingest.length).toBe(0);
    expect(h.state().notice?.tone).toBe("error");
    expect(h.state().notice?.message).toContain("User rejected the request");
    expect(h.state().busy).toBeNull();
  });

  test("a blocked drain surfaces the reason instead of ingesting nothing quietly", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 0, surfaceBlocked: "revoked" }),
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.calls.ingest.length).toBe(0);
    expect(h.state().queue?.blockedReason).toBe("revoked");
    expect(queueNotices(h.state()).map((n) => n.kind)).toContain("blocked");
  });

  test("an ingest blocked by a locked key is an actionable state, not an error", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 1, pending: [pendingItem("m1")] }),
      ingest: okIngest({ stored: 0, acknowledged: 0, blocked: "key-missing", itemCount: 0 }),
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.state().ingestBlocked).toBe("key-missing");
    expect(queueNotices(h.state()).map((n) => n.kind)).toContain("ingest-blocked");
  });

  test("partial results report successes AND leave the failures visible", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 2, pending: [pendingItem("m1"), pendingItem("m2")] }),
      ingest: okIngest({
        stored: 1,
        acknowledged: 1,
        failures: [{ meetingId: "m2", kind: "transcript", stage: "fetch", message: "429" }],
      }),
      pending: okPending({ count: 1, pending: [pendingItem("m2")] }),
    });
    await syncQueuedMeetings(h.deps, h.emit);
    const s = h.state();
    expect(s.lastIngest?.stored).toBe(1);
    expect(s.lastIngest?.failed).toBe(1);
    // The queue is re-read after processing so the count the card shows is real.
    expect(h.calls.getPending).toBe(1);
    expect(s.queue?.pendingCount).toBe(1);
  });

  test("a stored-but-unacknowledged item is reported as safe, retryable work", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 1, pending: [pendingItem("m1")] }),
      ingest: okIngest({
        stored: 1,
        acknowledged: 0,
        ackError: "offline",
        unacknowledged: [{ meetingId: "m1", kind: "transcript" }],
      }),
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.state().lastIngest?.unacknowledged).toBe(1);
    expect(h.state().notice?.retryable).toBe(true);
  });

  test("a hard ingest failure is reported and never counted as a success", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 1, pending: [pendingItem("m1")] }),
      ingest: { ok: false, error: { kind: "storage", message: "space write failed" } },
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.state().lastIngest).toBeNull();
    expect(h.state().notice?.tone).toBe("error");
    expect(h.state().notice?.message).toContain("space write failed");
  });

  // `targetedSync` acknowledges everything it stored even when a terminal error
  // stopped the loop (those meetings ARE in the space), so the terminal branch
  // used to leave an EARLIER run's "Last collected: N saved" line on screen
  // beside the new error, with the pre-ingest pending count next to it. Neither
  // number describes what just happened.
  test("a terminal ingest failure drops the previous run's line and re-reads the queue", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 2, pending: [pendingItem("m1"), pendingItem("m2")] }),
      ingest: { ok: false, error: { kind: "fireflies", message: "rate limited" } },
      pending: okPending({ count: 1, pending: [pendingItem("m2")] }),
    });
    // A previous, successful run left a summary behind.
    h.emit((s) => ({
      ...s,
      lastIngest: {
        stored: 5,
        acknowledged: 5,
        alreadySettled: 0,
        tombstoned: 0,
        failed: 0,
        unacknowledged: 0,
      },
    }));

    await syncQueuedMeetings(h.deps, h.emit);
    const s = h.state();
    expect(s.lastIngest).toBeNull();
    expect(s.notice?.tone).toBe("error");
    // The count on the card is the backend's, read AFTER the run.
    expect(h.calls.getPending).toBe(1);
    expect(s.queue?.pendingCount).toBe(1);
  });

  test("a terminal ingest failure followed by an unreadable queue never invents a count", async () => {
    const h = harness({
      unlocked: true,
      drain: okPending({ count: 1, pending: [pendingItem("m1")] }),
      ingest: { ok: false, error: { kind: "fireflies", message: "rate limited" } },
      pending: { status: "retryable", httpStatus: 503, code: null },
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.state().queue).toBeNull();
    expect(h.state().queueUnavailable).toBe(true);
  });

  test("a drain outage never reads as an empty queue", async () => {
    const h = harness({
      unlocked: true,
      drain: { status: "retryable", httpStatus: 503, code: null },
    });
    await syncQueuedMeetings(h.deps, h.emit);
    expect(h.state().queueUnavailable).toBe(true);
    expect(h.calls.ingest.length).toBe(0);
    expect(queueNotices(h.state()).map((n) => n.kind)).not.toContain("empty");
  });
});

// ── Status and notices ───────────────────────────────────────────────

describe("status", () => {
  test("a minted config is 'Enabled in TinyChat' — never 'Live'", async () => {
    const h = harness({ enable: okEnabled() });
    await enableBackgroundSync(h.deps, h.emit);
    expect(backgroundSyncStatus(h.state()).label).toBe(BACKGROUND_SYNC_ENABLED_LABEL);
    expect(BACKGROUND_SYNC_ENABLED_LABEL).toBe("Enabled in TinyChat");
  });

  test("no reachable state ever labels itself Live", () => {
    const base = initialBackgroundSyncState();
    const phases: BackgroundSyncState["phase"][] = [
      "loading",
      "dark",
      "signed-out",
      "unavailable",
      "off",
      "enabled",
    ];
    for (const phase of phases) {
      const label = backgroundSyncStatus({ ...base, phase, hasSecret: true }).label;
      expect(label.toLowerCase()).not.toContain("live");
    }
  });

  test("an outage is labelled unavailable, not off", () => {
    const s = { ...initialBackgroundSyncState(), phase: "unavailable" as const };
    expect(backgroundSyncStatus(s).label.toLowerCase()).toContain("unavailable");
  });
});

describe("queueNotices", () => {
  function enabledWith(queue: Partial<NonNullable<BackgroundSyncState["queue"]>>): BackgroundSyncState {
    return {
      ...initialBackgroundSyncState(),
      phase: "enabled",
      hasSecret: true,
      queue: {
        pendingCount: 0,
        deadCount: 0,
        rateLimited: false,
        blockedReason: null,
        ...queue,
      },
    };
  }

  test("pending, dead-letter and rate-limited are DISTINCT notices", () => {
    const kinds = queueNotices(
      enabledWith({ pendingCount: 3, deadCount: 2, rateLimited: true }),
    ).map((n) => n.kind);
    expect(kinds).toContain("pending");
    expect(kinds).toContain("dead");
    expect(kinds).toContain("rate-limited");
    expect(kinds).not.toContain("empty");
  });

  test("a dead-letter with nothing pending is still surfaced", () => {
    const kinds = queueNotices(enabledWith({ pendingCount: 0, deadCount: 4 })).map((n) => n.kind);
    expect(kinds).toContain("dead");
    expect(kinds).not.toContain("empty");
  });

  test("a genuinely empty queue says so exactly once", () => {
    const notices = queueNotices(enabledWith({}));
    expect(notices.map((n) => n.kind)).toEqual(["empty"]);
  });

  test("pending work offers the user-initiated sync action", () => {
    const notice = queueNotices(enabledWith({ pendingCount: 2 })).find((n) => n.kind === "pending");
    expect(notice?.action).toBe("sync");
    expect(notice?.detail).toContain("2");
  });

  test("nothing is surfaced while the surface is off or dark", () => {
    const off = { ...initialBackgroundSyncState(), phase: "off" as const };
    expect(queueNotices(off)).toEqual([]);
    const dark = { ...initialBackgroundSyncState(), phase: "dark" as const };
    expect(queueNotices(dark)).toEqual([]);
  });
});

// ── Custody ──────────────────────────────────────────────────────────

describe("custody of the one-time values", () => {
  test("no action writes the delivery URL or secret to storage, or logs it", async () => {
    const writes: string[] = [];
    const logged: string[] = [];
    const originalStorage = Reflect.get(globalThis, "localStorage");
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        setItem: (k: string, v: string) => writes.push(`${k}=${v}`),
        getItem: () => null,
        removeItem: () => {},
      },
    });
    const capture = (...args: unknown[]) => logged.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      const h = harness({
        enable: okEnabled(),
        config: okConfig({ enabled: true, hasSecret: true, url: DELIVERY_URL }),
      });
      await enableBackgroundSync(h.deps, h.emit);
      await rotateCredentials(h.deps, h.emit);
      await loadOnMount(h.deps, h.emit);
      await refreshQueue(h.deps, h.emit);
      expect(writes).toEqual([]);
      expect(logged.join("\n")).not.toContain(DELIVERY_SECRET);
      expect(logged.join("\n")).not.toContain(DELIVERY_URL);
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      if (originalStorage === undefined) {
        Reflect.deleteProperty(globalThis, "localStorage");
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: originalStorage,
        });
      }
    }
  });

  test("the secret is never carried in a notice message", async () => {
    const h = harness({ enable: okEnabled() });
    await enableBackgroundSync(h.deps, h.emit);
    for (const s of h.seen) {
      expect(s.notice?.message ?? "").not.toContain(DELIVERY_SECRET);
    }
  });
});

// ── The purge ledger is cleared only on purpose (FE4) ────────────────
//
// After a "disconnect and delete all my meetings", the backend holds a purge
// tombstone. It is what stops a replayed or in-flight signed delivery from
// putting those meetings back. Re-connecting the connector, re-enabling
// notifications, rotating credentials and syncing must therefore ALL leave it
// standing — the only thing that clears it is the user saying, in as many
// words, that historical meetings may come back.

describe("historical re-sync", () => {
  test("nothing in the ordinary lifecycle clears the ledger", async () => {
    const flows: Array<[string, (h: ReturnType<typeof harness>) => Promise<void>]> = [
      ["mount", (h) => loadOnMount(h.deps, h.emit)],
      ["enable / reconnect", (h) => enableBackgroundSync(h.deps, h.emit)],
      ["rotate", (h) => rotateCredentials(h.deps, h.emit)],
      ["disable", (h) => disableBackgroundSync(h.deps, h.emit)],
      ["refresh", (h) => refreshQueue(h.deps, h.emit)],
      ["sync", (h) => syncQueuedMeetings(h.deps, h.emit)],
    ];
    for (const [, run] of flows) {
      const h = harness({ unlocked: true });
      await run(h);
      expect(h.calls.clearPurgeLedger).toEqual([]);
    }
  });

  test("re-enabling after a purge is a mint, not a ledger reset", async () => {
    // The exact reconnect the handoff calls out: the user deleted everything,
    // then turned background notifications back on.
    const h = harness({ config: okConfig({ enabled: false, hasSecret: false }) });
    await loadOnMount(h.deps, h.emit);
    await enableBackgroundSync(h.deps, h.emit);
    expect(h.calls.enable).toEqual([{ source: "fireflies" }]);
    expect(h.calls.clearPurgeLedger).toEqual([]);
    expect(h.state().phase).toBe("enabled");
  });

  test("asking for it only arms a confirmation — no call is made", async () => {
    const h = harness();
    h.emit((s) => ({ ...s, phase: "enabled" }));
    h.emit(requestHistoricalResync);
    expect(h.state().resyncConfirming).toBe(true);
    expect(h.calls.clearPurgeLedger).toEqual([]);
  });

  test("cancelling disarms it and still calls nothing", async () => {
    const h = harness();
    h.emit(requestHistoricalResync);
    h.emit(cancelHistoricalResync);
    expect(h.state().resyncConfirming).toBe(false);
    expect(h.calls.clearPurgeLedger).toEqual([]);
  });

  test("confirming clears the ledger for THIS source, once", async () => {
    const h = harness();
    h.emit((s) => ({ ...s, phase: "enabled" }));
    h.emit(requestHistoricalResync);
    await confirmHistoricalResync(h.deps, h.emit);
    expect(h.calls.clearPurgeLedger).toEqual(["fireflies"]);
    expect(h.state().resyncConfirming).toBe(false);
    expect(h.state().busy).toBeNull();
    expect(h.state().notice?.tone).toBe("info");
  });

  test("confirming without the confirmation armed does nothing", async () => {
    // Defence in depth: the destructive call cannot be reached by a stray
    // handler that skipped the confirm step.
    const h = harness();
    await confirmHistoricalResync(h.deps, h.emit);
    expect(h.calls.clearPurgeLedger).toEqual([]);
  });

  test("a failed clear says so and stays armed for a retry", async () => {
    const h = harness({
      clearPurgeLedger: { status: "retryable", httpStatus: 503, code: null },
    });
    h.emit((s) => ({ ...s, phase: "enabled" }));
    h.emit(requestHistoricalResync);
    await confirmHistoricalResync(h.deps, h.emit);
    expect(h.state().notice?.tone).toBe("error");
    expect(h.state().notice?.retryable).toBe(true);
    // NOT cleared: the surface must not imply history is available again.
    expect(h.state().resyncConfirming).toBe(true);
    expect(h.state().busy).toBeNull();
  });

  test("a lost session moves the phase rather than claiming a clear", async () => {
    const h = harness({ clearPurgeLedger: { status: "unauthenticated" } });
    h.emit((s) => ({ ...s, phase: "enabled" }));
    h.emit(requestHistoricalResync);
    await confirmHistoricalResync(h.deps, h.emit);
    expect(h.state().phase).toBe("signed-out");
    expect(h.state().resyncConfirming).toBe(true);
  });

  test("the confirmation copy is about history returning, not about the queue", async () => {
    const h = harness();
    h.emit((s) => ({ ...s, phase: "enabled" }));
    h.emit(requestHistoricalResync);
    await confirmHistoricalResync(h.deps, h.emit);
    const message = h.state().notice?.message ?? "";
    expect(message.toLowerCase()).toContain("deleted");
  });
});
