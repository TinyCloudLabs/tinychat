import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { clientHasReplication, REPLICA_PURGE_FAILED_WARNING, signOutReplicaAware } from "./replicationSignOut";
import { formatReplicationStatus } from "./ReplicationStatusLine";
import { getReplicationStatus, recordReplicationEvent, refreshReplicationStatus, resetReplicationStatus } from "./replicationStatus";
import { readRecordingNoteFromSpace } from "../voiceNotes/voiceNoteStore";
import { webConnectorPort } from "../connectors/connectorPort";

function fakeClient(signOut: () => Promise<void>, replication: unknown = {}): TinyCloudWeb {
  return { signOut, replication } as unknown as TinyCloudWeb;
}

beforeEach(resetReplicationStatus);

describe("sign-out with replication", () => {
  test("an OFF client (no controller) is not replication-aware", () => {
    const off = { signOut: async () => undefined } as unknown as TinyCloudWeb;
    expect(clientHasReplication(off)).toBe(false);
    expect(clientHasReplication(fakeClient(async () => undefined))).toBe(true);
  });

  test("a clean sign-out leaves the status untouched", async () => {
    expect(await signOutReplicaAware(fakeClient(async () => undefined))).toEqual({ ok: true });
    expect(getReplicationStatus().purgeFailed).toBe(false);
  });

  test("a failed replica deny is a visible failed purge, not a failed sign-out", async () => {
    const tcw = fakeClient(async () => {
      throw new Error("Replica gate was not denied (REPLICA_GATED); the replica may still be restorable.");
    });
    const result = await signOutReplicaAware(tcw);
    expect(result).toEqual({ ok: false, message: REPLICA_PURGE_FAILED_WARNING, code: "REPLICA_GATED" });
    expect(getReplicationStatus()).toMatchObject({ purgeFailed: true, errorCode: "REPLICA_GATED" });
    expect(formatReplicationStatus(getReplicationStatus())).toContain("sign-out erase failed");
  });

  test("any sign-out error on a replica client is a failed purge with a visible code", async () => {
    const result = await signOutReplicaAware(fakeClient(async () => { throw new Error("network down"); }));
    expect(result).toEqual({ ok: false, message: REPLICA_PURGE_FAILED_WARNING, code: "REPLICA_SIGNOUT_FAILED" });
  });

  test("a sign-out error on a client without replication is rethrown for the caller's existing handling", async () => {
    const offClient = { signOut: async () => { throw new Error("network down"); } } as unknown as TinyCloudWeb;
    await expect(signOutReplicaAware(offClient)).rejects.toThrow("network down");
  });

  test("runs signOut once per client even when the button and the signed-out hook both ask", async () => {
    let calls = 0;
    const tcw = fakeClient(async () => { calls++; });
    await Promise.all([signOutReplicaAware(tcw), signOutReplicaAware(tcw)]);
    expect(calls).toBe(1);
  });
});

describe("debug status line", () => {
  test("surfaces STORAGE_BUDGET from a failed sync, with counters only", async () => {
    recordReplicationEvent({ type: "replication.sync", outcome: "error", code: "STORAGE_BUDGET", at: "2026-01-01T00:00:00Z" });
    const tcw = {
      replication: {
        status: async () => [
          { prefix: "p1/", state: "ready", pending: {}, pinned: [], lagMs: 0, bytes: 3 * 1024 * 1024, lastSyncAt: "2026-01-01T00:00:00Z",
            counts: { keys: 7 }, lastError: { at: "x", code: "STORAGE_BUDGET", message: "path/secret-looking-detail" } },
          { prefix: "p2/", state: "ready", pending: {}, pinned: [], lagMs: 0, bytes: 1024 * 1024, counts: { keys: 1 } },
        ],
      },
    } as unknown as TinyCloudWeb;
    const status = await refreshReplicationStatus(tcw);
    expect(status).toMatchObject({ state: "ready", errorCode: "STORAGE_BUDGET", bytes: 4 * 1024 * 1024, keys: 8 });
    const line = formatReplicationStatus(status);
    expect(line).toContain("error STORAGE_BUDGET");
    expect(line).toContain("4.0 of 100 MB");
    expect(line).not.toContain("secret-looking-detail");
    expect(line).not.toContain("p1/");
  });

  test("an unfinished erase from a previous sign-out is shown", async () => {
    const tcw = { replication: { status: async () => [{ prefix: "p/", state: "gated", errorCode: "REPLICA_GATED", purgePending: true, pending: {}, pinned: [], lagMs: null }] } } as unknown as TinyCloudWeb;
    const status = await refreshReplicationStatus(tcw);
    expect(status).toMatchObject({ state: "gated", errorCode: "REPLICA_GATED", purgePending: true });
  });
});

describe("commit-verification reads bypass the replica", () => {
  // A kv whose default read is a stale replica hit and whose source:"network" read is the truth.
  function staleKv() {
    const calls: Array<{ key: string; source?: string }> = [];
    return {
      calls,
      kv: {
        get: async (key: string, options?: { source?: string }) => {
          calls.push({ key, source: options?.source });
          return options?.source === "network"
            ? { ok: false as const, error: { code: "KV_NOT_FOUND", message: "not found" } }
            : { ok: true as const, data: { data: "stale replica copy" } };
        },
      },
    };
  }

  test("recording-note read from the space", async () => {
    const { kv, calls } = staleKv();
    expect(await readRecordingNoteFromSpace({ kv } as unknown as TinyCloudWeb, "n1")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.source).toBe("network");
  });

  test("connector port existence check used to decide a repair write", async () => {
    const { kv, calls } = staleKv();
    const tcw = { kv, sql: { db: () => ({ query: async () => ({ ok: true, data: { rows: [] } }), execute: async () => ({ ok: true, data: {} }) }) } } as unknown as TinyCloudWeb;
    const port = webConnectorPort(tcw);
    expect(await port.kvGet("some/key")).toEqual({ ok: true, data: "missing" });
    expect(calls[0]!.source).toBe("network");
  });
});
