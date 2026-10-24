import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { startReplicationFill } from "./replicationClient";
import { replicationDebugEnabled, formatReplicationStatus, REPLICATION_DEBUG_KEY } from "./ReplicationStatusLine";
import { startupPurgeSettled, trackStartupPurge } from "./replicationStartupPurge";
import { getReplicationStatus, recordReplicationEvent, refreshReplicationStatus, resetReplicationStatus } from "./replicationStatus";

/** Lets every already-settled promise continuation run. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

function clientWith(sync: () => Promise<void>): TinyCloudWeb {
  return { did: "did:pkh:eip155:1:0xaaaa", replication: { sync } } as unknown as TinyCloudWeb;
}

beforeEach(resetReplicationStatus);

describe("first sync after sign-in / restore", () => {
  test("ON with a controller: sync() is called once", async () => {
    let calls = 0;
    startReplicationFill(clientWith(async () => { calls += 1; }), () => true);
    await flush();
    expect(calls).toBe(1);
  });

  test("OFF: never called, even with a controller", async () => {
    let calls = 0;
    startReplicationFill(clientWith(async () => { calls += 1; }), () => false);
    await flush();
    expect(calls).toBe(0);
  });

  test("a client without a replication controller: never called, never throws", async () => {
    expect(() => startReplicationFill({ did: "did:pkh:eip155:1:0xaaaa" } as unknown as TinyCloudWeb, () => true)).not.toThrow();
    await flush();
  });

  test("with the default gates a new profile (no build flag, no opt-in) never syncs", async () => {
    let calls = 0;
    startReplicationFill(clientWith(async () => { calls += 1; }));
    await flush();
    expect(calls).toBe(0);
  });

  test("a rejected sync (a gated restore) does not throw into sign-in", async () => {
    startReplicationFill(clientWith(async () => { throw Object.assign(new Error("gated"), { code: "REPLICA_GATED" }); }), () => true);
    await flush(); // an unhandled rejection would fail this test run
    expect(await startupPurgeSettled()).toBeUndefined();
  });

  test("does not run while a removal of the copy is in flight, then runs once", async () => {
    let calls = 0;
    const removal = Promise.withResolvers<void>();
    void trackStartupPurge(removal.promise);
    startReplicationFill(clientWith(async () => { calls += 1; }), () => true);
    await flush();
    expect(calls).toBe(0);
    removal.resolve();
    await flush();
    expect(calls).toBe(1);
  });

  test("the opt-in is checked again after the wait: switched OFF during a removal, nothing syncs", async () => {
    let calls = 0;
    let enabled = true;
    const removal = Promise.withResolvers<void>();
    void trackStartupPurge(removal.promise);
    startReplicationFill(clientWith(async () => { calls += 1; }), () => enabled);
    enabled = false;
    removal.resolve();
    await flush();
    expect(calls).toBe(0);
  });
});

describe("status fold", () => {
  const entry = (patch: Record<string, unknown> = {}) => ({ prefix: "p/", state: "ready", pending: {}, pinned: [], lagMs: 0, ...patch });
  const client = (entries: unknown[]) => ({ replication: { status: async () => entries } }) as unknown as TinyCloudWeb;

  test("a controller with no entries (nothing opened yet) is idle, not ready", async () => {
    expect(await refreshReplicationStatus(client([]))).toMatchObject({ state: "idle", keys: 0, lastSyncAt: null });
  });

  test("a stale REPLICA_GATED from before the opt-in is dropped once the controller reports no error", async () => {
    await refreshReplicationStatus(client([entry({ state: "gated", errorCode: "REPLICA_GATED" })]));
    expect(getReplicationStatus().errorCode).toBe("REPLICA_GATED");
    expect(await refreshReplicationStatus(client([entry({ lastSyncAt: "2026-01-01T00:00:00Z", counts: { keys: 3 } })])))
      .toMatchObject({ state: "ready", errorCode: null, keys: 3 });
    // And an empty controller does not keep it either.
    recordReplicationEvent({ type: "replication.sync", outcome: "error", code: "REPLICA_GATED" });
    expect((await refreshReplicationStatus(client([]))).errorCode).toBeNull();
  });
});

describe("what a user sees by default", () => {
  const status = { ...getReplicationStatus(), state: "ready", lastSyncAt: "2026-01-01T00:00:00Z", keys: 3, bytes: 5 * 1024 * 1024, errorCode: "REPLICA_GATED" };

  test("a live copy is just 'on': no state, sync time, counts, megabytes or error code", () => {
    const line = formatReplicationStatus(status, { live: true, debug: false });
    expect(line).toBe("Local copy: on");
  });

  test("the debug text is there when asked for", () => {
    const line = formatReplicationStatus(status, { live: true, debug: true });
    expect(line).toContain("state ready");
    expect(line).toContain("error REPLICA_GATED");
  });

  test("the other plain strings do not depend on debug", () => {
    for (const debug of [true, false]) {
      expect(formatReplicationStatus(status, { live: false, optedIn: false, debug })).toBe("Local copy: off");
      expect(formatReplicationStatus(status, { live: false, optedIn: true, debug })).toBe("Local copy: on · starts at your next sign-in");
      expect(formatReplicationStatus({ ...status, purging: true }, { live: true, debug })).toBe("Local copy: removing…");
      expect(formatReplicationStatus({ ...status, offPurgeCode: "DELETE_BLOCKED" }, { live: true, debug }))
        .toBe("Local copy: removal failed (DELETE_BLOCKED) · will retry on next load");
    }
  });

  test("production builds show the debug text only with the debug key; dev/test builds always do", () => {
    const store = (value: string | null) => ({ getItem: (key: string) => (key === REPLICATION_DEBUG_KEY ? value : null) });
    expect(replicationDebugEnabled(true, store(null))).toBe(false);
    expect(replicationDebugEnabled(true, store("false"))).toBe(false);
    expect(replicationDebugEnabled(true, undefined)).toBe(false);
    expect(replicationDebugEnabled(true, store("true"))).toBe(true);
    expect(replicationDebugEnabled(false, store(null))).toBe(true);
  });
});
