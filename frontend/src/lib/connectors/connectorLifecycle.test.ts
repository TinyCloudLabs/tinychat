// RED-first tests for the connector teardown orchestrator (FE4).
//
// Every assertion here is an ORDER or a NEVER, because that is what the
// handoff's lifecycle section actually specifies:
//
//  - the purge tombstone is written BEFORE a single local row or body is
//    deleted, so a delivery that arrives mid-teardown cannot resurrect a
//    meeting the user just deleted;
//  - webhook delivery is disabled BEFORE the API key is removed, so the
//    connector never sits in the state Listen leaves it in — key gone, webhook
//    still live, queue still filling;
//  - a partial failure NEVER reports a disconnect. It stops on the failing
//    step, keeps what it already collected, and leaves a retry that resumes
//    rather than restarts;
//  - the teardown never clears the purge ledger. Clearing it is the separate,
//    explicitly-confirmed "allow historical re-sync" action.
//
// The suite drives the orchestrator through fakes that record an ops log, so
// "before" is asserted against a real sequence and not against a comment.

import { describe, expect, test } from "bun:test";

import {
  DISCONNECT_PLANS,
  disconnectRetry,
  disconnectStatusMessage,
  initialDisconnectProgress,
  runDisconnect,
  type DisconnectDeps,
  type DisconnectProgress,
  type DisconnectStep,
} from "./connectorLifecycle";
import type { ConnectorConnection } from "./types";

const SOURCE = "fireflies";
const IDS = ["01JMEETINGAAA", "01JMEETINGBBB"];

interface Recorded {
  ops: string[];
  purges: Array<{ source: string; ids: string[]; purgedThrough?: string }>;
  syncStates: unknown[];
  clearLedgerCalls: number;
  unlocks: number;
}

interface Failures {
  listIds?: string;
  recordPurge?: "retryable" | "rejected" | "feature-dark" | "unauthenticated";
  disable?: "retryable" | "rejected" | "feature-dark" | "unauthenticated" | "offline";
  deleteKey?: string;
  unlock?: string;
  purgeLocal?: string;
  getConnection?: string;
  countMeetings?: string;
  updateSyncState?: string;
}

function connection(patch: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    connectorId: "fireflies",
    status: "connected",
    lastSyncedAt: "2026-08-01T09:00:00.000Z",
    lastSyncStatus: "ok",
    lastSyncError: null,
    itemCount: 2,
    ...patch,
  };
}

function harness(
  overrides: {
    mode: DisconnectProgress["mode"];
    fail?: Failures;
    unlocked?: boolean;
    scopedIds?: readonly string[];
    purgedThrough?: string;
    ids?: string[];
    /** The mount-time probe's verdict, as the card carries it. */
    featureDark?: boolean;
  },
): { deps: DisconnectDeps; rec: Recorded; seen: DisconnectProgress[]; emit: (u: (p: DisconnectProgress) => DisconnectProgress) => void; progress: () => DisconnectProgress } {
  const fail = overrides.fail ?? {};
  const rec: Recorded = {
    ops: [],
    purges: [],
    syncStates: [],
    clearLedgerCalls: 0,
    unlocks: 0,
  };
  let current = initialDisconnectProgress(overrides.mode);
  const seen: DisconnectProgress[] = [];
  const emit = (updater: (prev: DisconnectProgress) => DisconnectProgress) => {
    current = updater(current);
    seen.push(current);
  };

  const deps: DisconnectDeps = {
    connectorId: "fireflies",
    source: SOURCE,
    mode: overrides.mode,
    ...(overrides.scopedIds ? { scopedIds: overrides.scopedIds } : {}),
    ...(overrides.purgedThrough ? { purgedThrough: overrides.purgedThrough } : {}),
    ...(overrides.featureDark === undefined ? {} : { featureDark: overrides.featureDark }),
    webhooks: {
      disable: async () => {
        rec.ops.push("disable-webhooks");
        switch (fail.disable) {
          case "retryable":
            return { status: "retryable", httpStatus: 503, code: null };
          case "rejected":
            return { status: "rejected", httpStatus: 400, code: "unknown_source" };
          case "feature-dark":
            return { status: "feature-dark" };
          case "unauthenticated":
            return { status: "unauthenticated" };
          case "offline":
            return { status: "offline" };
          default:
            return { status: "ok", value: { status: "disabled", queueDropped: 3 } };
        }
      },
      recordPurge: async (request) => {
        rec.ops.push("record-purge");
        rec.purges.push({
          source: request.source,
          ids: [...request.ids],
          ...(request.purgedThrough === undefined
            ? {}
            : { purgedThrough: request.purgedThrough }),
        });
        switch (fail.recordPurge) {
          case "retryable":
            return { status: "retryable", httpStatus: 503, code: null };
          case "rejected":
            return { status: "rejected", httpStatus: 400, code: "invalid_meeting_id" };
          case "feature-dark":
            return { status: "feature-dark" };
          case "unauthenticated":
            return { status: "unauthenticated" };
          default:
            return { status: "ok", value: null };
        }
      },
      // Present ONLY as a tripwire: teardown must never clear the ledger.
      clearPurgeLedger: async () => {
        rec.clearLedgerCalls += 1;
        return { status: "ok", value: null };
      },
    },
    secrets: {
      isUnlocked: () => overrides.unlocked ?? true,
      unlock: async () => {
        rec.ops.push("unlock");
        rec.unlocks += 1;
        return fail.unlock ? { ok: false, error: { message: fail.unlock } } : { ok: true };
      },
      deleteKey: async () => {
        rec.ops.push("delete-key");
        return fail.deleteKey
          ? { ok: false, error: { message: fail.deleteKey } }
          : { ok: true };
      },
    },
    store: {
      listKnownSourceIds: async () => {
        rec.ops.push("collect-ids");
        return fail.listIds
          ? { ok: false, error: { code: "SQL", message: fail.listIds } }
          : { ok: true, data: overrides.ids ?? [...IDS] };
      },
      purgeConnector: async () => {
        rec.ops.push("purge-local");
        return fail.purgeLocal
          ? { ok: false, error: { code: "KV", message: fail.purgeLocal } }
          : { ok: true, data: undefined };
      },
      getConnection: async () => {
        rec.ops.push("get-connection");
        return fail.getConnection
          ? { ok: false, error: { code: "SQL", message: fail.getConnection } }
          : { ok: true, data: connection() };
      },
      countMeetings: async () => {
        rec.ops.push("count-meetings");
        return fail.countMeetings
          ? { ok: false, error: { code: "SQL", message: fail.countMeetings } }
          : { ok: true, data: 7 };
      },
      updateSyncState: async (input) => {
        rec.ops.push("mark-disconnected");
        rec.syncStates.push(input);
        return fail.updateSyncState
          ? { ok: false, error: { code: "SQL", message: fail.updateSyncState } }
          : { ok: true, data: undefined };
      },
    },
  };
  return { deps, rec, seen, emit, progress: () => current };
}

// ── The plans themselves ─────────────────────────────────────────────

describe("disconnect plans", () => {
  test("keeping data disables delivery BEFORE the key is removed", () => {
    expect(DISCONNECT_PLANS["keep-data"]).toEqual([
      "disable-webhooks",
      "delete-key",
      "mark-disconnected",
    ]);
  });

  test("deleting data writes the tombstone BEFORE anything local is deleted", () => {
    const plan = DISCONNECT_PLANS["delete-data"];
    expect(plan).toEqual([
      "collect-ids",
      "record-purge",
      "disable-webhooks",
      "delete-key",
      "purge-local",
    ]);
    expect(plan.indexOf("record-purge")).toBeLessThan(plan.indexOf("purge-local"));
    expect(plan.indexOf("disable-webhooks")).toBeLessThan(plan.indexOf("delete-key"));
  });

  test("an initial progress claims nothing", () => {
    const p = initialDisconnectProgress("keep-data");
    expect(p.done).toBe(false);
    expect(p.completed).toEqual([]);
    expect(p.failure).toBeNull();
    expect(p.ids).toBeNull();
  });
});

// ── Flow 2: disconnect, keep data ────────────────────────────────────

describe("disconnect, keep data", () => {
  test("runs disable → delete key → mark disconnected, in that order", async () => {
    const h = harness({ mode: "keep-data" });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(true);
    expect(result.failure).toBeNull();
    expect(h.rec.ops.indexOf("disable-webhooks")).toBeLessThan(
      h.rec.ops.indexOf("delete-key"),
    );
    expect(h.rec.ops.indexOf("delete-key")).toBeLessThan(
      h.rec.ops.indexOf("mark-disconnected"),
    );
  });

  test("keeps the meetings: no purge tombstone, no local purge", async () => {
    const h = harness({ mode: "keep-data" });
    await runDisconnect(h.deps, h.emit);
    expect(h.rec.purges).toEqual([]);
    expect(h.rec.ops).not.toContain("purge-local");
  });

  test("preserves lastSyncedAt and re-reads the real count", async () => {
    const h = harness({ mode: "keep-data" });
    await runDisconnect(h.deps, h.emit);
    expect(h.rec.syncStates).toEqual([
      {
        connectorId: "fireflies",
        status: "disconnected",
        lastSyncedAt: "2026-08-01T09:00:00.000Z",
        lastSyncStatus: "ok",
        lastSyncError: null,
        itemCount: 7,
      },
    ]);
  });

  test("unlocks the vault only when it is locked", async () => {
    const unlocked = harness({ mode: "keep-data", unlocked: true });
    await runDisconnect(unlocked.deps, unlocked.emit);
    expect(unlocked.rec.unlocks).toBe(0);

    const locked = harness({ mode: "keep-data", unlocked: false });
    await runDisconnect(locked.deps, locked.emit);
    expect(locked.rec.unlocks).toBe(1);
    expect(locked.rec.ops.indexOf("unlock")).toBeLessThan(
      locked.rec.ops.indexOf("delete-key"),
    );
  });
});

// ── Flow 3: disconnect and delete all data ───────────────────────────

describe("disconnect and delete all data", () => {
  test("tombstones the collected ids before a single local delete", async () => {
    const h = harness({ mode: "delete-data" });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(true);
    expect(h.rec.ops).toEqual([
      "collect-ids",
      "record-purge",
      "disable-webhooks",
      "delete-key",
      "purge-local",
    ]);
    expect(h.rec.purges).toEqual([{ source: SOURCE, ids: IDS }]);
  });

  test("omits purgedThrough for 'forget everything up to now'", async () => {
    const h = harness({ mode: "delete-data" });
    await runDisconnect(h.deps, h.emit);
    expect(h.rec.purges[0]).not.toHaveProperty("purgedThrough");
  });

  test("still records the tombstone when the space holds no rows", async () => {
    // The watermark, not the id list, is what suppresses an in-flight delivery.
    const h = harness({ mode: "delete-data", ids: [] });
    const result = await runDisconnect(h.deps, h.emit);
    expect(result.done).toBe(true);
    expect(h.rec.purges).toEqual([{ source: SOURCE, ids: [] }]);
  });

  test("a scoped subset MUST carry an explicit provider watermark", async () => {
    // Fail closed: the route's default is `now`, which would silently suppress
    // every earlier meeting the user did NOT select.
    const h = harness({ mode: "delete-data", scopedIds: [IDS[0]!] });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(false);
    expect(result.failure?.step).toBe("record-purge");
    expect(result.failure?.retryable).toBe(false);
    // Nothing at all ran: not a network call, not a read.
    expect(h.rec.ops).toEqual([]);
  });

  test("a scoped subset sends the given watermark verbatim", async () => {
    const h = harness({
      mode: "delete-data",
      scopedIds: [IDS[1]!],
      purgedThrough: "2026-08-05T12:00:00.000Z",
    });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(true);
    expect(h.rec.purges).toEqual([
      {
        source: SOURCE,
        ids: [IDS[1]!],
        purgedThrough: "2026-08-05T12:00:00.000Z",
      },
    ]);
    // A scoped purge names its own ids; it does not re-read the whole space.
    expect(h.rec.ops).not.toContain("collect-ids");
  });
});

// ── Partial failure never claims success ─────────────────────────────

describe("partial failure", () => {
  test("a failed tombstone deletes NOTHING — not the key, not the rows", async () => {
    const h = harness({ mode: "delete-data", fail: { recordPurge: "retryable" } });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(false);
    expect(result.failure).toMatchObject({ step: "record-purge", retryable: true });
    expect(h.rec.ops).not.toContain("delete-key");
    expect(h.rec.ops).not.toContain("purge-local");
    expect(h.rec.ops).not.toContain("disable-webhooks");
  });

  test("a failed disable never removes the key", async () => {
    const h = harness({ mode: "keep-data", fail: { disable: "retryable" } });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(false);
    expect(result.failure).toMatchObject({ step: "disable-webhooks", retryable: true });
    expect(h.rec.ops).not.toContain("delete-key");
    expect(h.rec.ops).not.toContain("mark-disconnected");
  });

  test("a lost session is a failure, never a quiet success", async () => {
    const h = harness({ mode: "keep-data", fail: { disable: "unauthenticated" } });
    const result = await runDisconnect(h.deps, h.emit);
    expect(result.done).toBe(false);
    expect(result.failure?.step).toBe("disable-webhooks");
  });

  test("a route that is not deployed is not a teardown failure", async () => {
    // 404 = the companion router is not mounted, so there is no webhook config
    // to disable. The rest of the teardown must still complete — but ONLY
    // because the mount-time probe already established that the feature is dark.
    const h = harness({
      mode: "keep-data",
      featureDark: true,
      fail: { disable: "feature-dark" },
    });
    const result = await runDisconnect(h.deps, h.emit);
    expect(result.done).toBe(true);
    expect(h.rec.ops).toContain("delete-key");
  });

  // ── The 404 that is NOT the feature being dark ──────────────────────
  //
  // A per-route 404 inside a MOUNTED router is real: a method/path drift, a
  // reverse proxy, or a bundle that outlived a backend route rename all produce
  // one. Reading that as "nothing to do" deleted the key and the local rows and
  // reported success while the webhook stayed live — so darkness must be
  // ESTABLISHED (by the mount-time probe) before a 404 may be forgiven.

  test("an unexplained 404 on disable stops the teardown with a retry", async () => {
    const h = harness({ mode: "keep-data", fail: { disable: "feature-dark" } });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(false);
    expect(result.failure?.step).toBe("disable-webhooks");
    expect(disconnectRetry(result)).not.toBeNull();
    // Nothing irreversible ran.
    expect(h.rec.ops).not.toContain("delete-key");
  });

  test("an unexplained 404 on the tombstone deletes nothing and offers a retry", async () => {
    const h = harness({ mode: "delete-data", fail: { recordPurge: "feature-dark" } });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(false);
    expect(result.failure?.step).toBe("record-purge");
    expect(disconnectRetry(result)).not.toBeNull();
    expect(h.rec.ops).not.toContain("disable-webhooks");
    expect(h.rec.ops).not.toContain("delete-key");
    expect(h.rec.ops).not.toContain("purge-local");
    // And it never claims the deletion happened.
    expect(disconnectStatusMessage(result)).not.toContain("have been deleted");
  });

  test("an established-dark delete-data run still skips both webhook calls", async () => {
    const h = harness({
      mode: "delete-data",
      featureDark: true,
      fail: { recordPurge: "feature-dark", disable: "feature-dark" },
    });
    const result = await runDisconnect(h.deps, h.emit);
    expect(result.done).toBe(true);
    expect(h.rec.ops).toContain("purge-local");
  });

  test("a failed key delete leaves the meetings in place", async () => {
    const h = harness({ mode: "delete-data", fail: { deleteKey: "secrets offline" } });
    const result = await runDisconnect(h.deps, h.emit);

    expect(result.done).toBe(false);
    expect(result.failure).toMatchObject({ step: "delete-key", retryable: true });
    expect(result.failure?.message).toContain("secrets offline");
    expect(h.rec.ops).not.toContain("purge-local");
  });

  test("a failed unlock fails the key step rather than proceeding keyless", async () => {
    const h = harness({
      mode: "keep-data",
      unlocked: false,
      fail: { unlock: "user rejected the signature" },
    });
    const result = await runDisconnect(h.deps, h.emit);
    expect(result.done).toBe(false);
    expect(result.failure?.step).toBe("delete-key");
    expect(h.rec.ops).not.toContain("delete-key");
  });

  test("every failure leaves a VISIBLE retry action", async () => {
    const h = harness({ mode: "delete-data", fail: { purgeLocal: "kv down" } });
    const result = await runDisconnect(h.deps, h.emit);
    const retry = disconnectRetry(result);
    expect(retry).not.toBeNull();
    expect(retry?.label.length).toBeGreaterThan(0);
    expect(retry?.resumesFrom).toBe("purge-local");
  });

  test("a completed run offers no retry and IS the success signal", async () => {
    const h = harness({ mode: "delete-data" });
    const result = await runDisconnect(h.deps, h.emit);
    expect(disconnectRetry(result)).toBeNull();
    expect(result.done).toBe(true);
  });

  test("the progress never reports done while a step is still running", async () => {
    const h = harness({ mode: "delete-data" });
    await runDisconnect(h.deps, h.emit);
    for (const snapshot of h.seen) {
      if (snapshot.running !== null) expect(snapshot.done).toBe(false);
    }
  });
});

// ── Retry resumes; it does not restart ───────────────────────────────

describe("retry", () => {
  test("resumes from the failed step and re-uses the ids already collected", async () => {
    const first = harness({ mode: "delete-data", fail: { disable: "retryable" } });
    const stopped = await runDisconnect(first.deps, first.emit);
    expect(stopped.completed).toEqual(["collect-ids", "record-purge"]);
    expect(stopped.ids).toEqual(IDS);

    // Same ids, second attempt: no re-collect, no second tombstone.
    const second = harness({ mode: "delete-data" });
    const finished = await runDisconnect(second.deps, second.emit, stopped);

    expect(finished.done).toBe(true);
    expect(second.rec.ops).toEqual(["disable-webhooks", "delete-key", "purge-local"]);
    expect(second.rec.purges).toEqual([]);
  });

  test("a resumed run keeps the ids the first attempt saw, not a post-delete re-read", async () => {
    const first = harness({ mode: "delete-data", fail: { purgeLocal: "kv down" } });
    const stopped = await runDisconnect(first.deps, first.emit);
    expect(stopped.ids).toEqual(IDS);

    const second = harness({ mode: "delete-data", ids: [] });
    const finished = await runDisconnect(second.deps, second.emit, stopped);
    expect(finished.done).toBe(true);
    expect(finished.ids).toEqual(IDS);
    expect(second.rec.ops).toEqual(["purge-local"]);
  });
});

// ── The ledger is never cleared by a teardown ────────────────────────

describe("the purge ledger", () => {
  test("no teardown path clears it — that is the separate re-sync action", async () => {
    for (const mode of ["keep-data", "delete-data"] as const) {
      const h = harness({ mode });
      await runDisconnect(h.deps, h.emit);
      expect(h.rec.clearLedgerCalls).toBe(0);
    }
  });

  test("a failed-then-retried teardown still never clears it", async () => {
    const first = harness({ mode: "delete-data", fail: { disable: "offline" } });
    const stopped = await runDisconnect(first.deps, first.emit);
    const second = harness({ mode: "delete-data" });
    await runDisconnect(second.deps, second.emit, stopped);
    expect(first.rec.clearLedgerCalls + second.rec.clearLedgerCalls).toBe(0);
  });
});

// ── No identifier ever reaches a message ─────────────────────────────

describe("what the surface is told", () => {
  test("a failure message names the step, never a meeting id", async () => {
    const h = harness({ mode: "delete-data", fail: { purgeLocal: "kv down" } });
    const result = await runDisconnect(h.deps, h.emit);
    const message = `${result.failure?.message ?? ""} ${disconnectRetry(result)?.label ?? ""}`;
    for (const id of IDS) expect(message).not.toContain(id);
  });

  test("every step in a plan is reported as completed exactly once", async () => {
    const h = harness({ mode: "delete-data" });
    const result = await runDisconnect(h.deps, h.emit);
    const counts = new Map<DisconnectStep, number>();
    for (const step of result.completed) {
      counts.set(step, (counts.get(step) ?? 0) + 1);
    }
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(result.completed).toEqual([...DISCONNECT_PLANS["delete-data"]]);
  });
});

// ── What the user is told ────────────────────────────────────────────

describe("status copy", () => {
  test("a run in progress never reads as a finished disconnect", async () => {
    const h = harness({ mode: "delete-data" });
    await runDisconnect(h.deps, h.emit);
    for (const snapshot of h.seen) {
      if (snapshot.done) continue;
      expect(disconnectStatusMessage(snapshot) ?? "").not.toContain("Disconnected");
    }
  });

  test("a failure says what did NOT happen", async () => {
    const h = harness({ mode: "delete-data", fail: { deleteKey: "secrets offline" } });
    const result = await runDisconnect(h.deps, h.emit);
    const message = disconnectStatusMessage(result) ?? "";
    expect(message).not.toContain("Disconnected");
    expect(message.toLowerCase()).toContain("nothing beyond this point");
  });

  test("each completed plan says what happened to the meetings", async () => {
    const keep = harness({ mode: "keep-data" });
    const kept = await runDisconnect(keep.deps, keep.emit);
    expect(disconnectStatusMessage(kept)?.toLowerCase()).toContain("still in your space");

    const wipe = harness({ mode: "delete-data" });
    const wiped = await runDisconnect(wipe.deps, wipe.emit);
    expect(disconnectStatusMessage(wiped)?.toLowerCase()).toContain("deleted");
  });
});
