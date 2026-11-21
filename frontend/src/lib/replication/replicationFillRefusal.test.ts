import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ReplicaError, ReplicaErrorCode } from "@tinycloud/replica";
import { resetLanesForTests } from "../localFirst/requestLanes";
import { startReplicationFill, REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS } from "./replicationClient";
import { resetReplicationStatus } from "./replicationStatus";

/** Lets every already-settled promise continuation run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  resetReplicationStatus();
  resetLanesForTests();
});
afterEach(() => { jest.useRealTimers(); });

describe("replica fill after a grant refusal / a stuck first prefix", () => {
  test("the session's own reads still return node data after the refusal closes the controller", async () => {
    const nodeData = new Map([["app/x/key", "from-node"]]);
    let controllerOpen = true;
    let syncCalls = 0;
    // A closed controller serves nothing locally; reads go to the node, as the app's network reads do.
    const tcw = {
      did: "did:pkh:eip155:1:0xbbbb",
      replication: {
        sync: async () => {
          syncCalls += 1;
          throw new ReplicaError(ReplicaErrorCode.GRANT_FORMAT_UNSUPPORTED, "The grant is not a compact UCAN.");
        },
        close: async () => { controllerOpen = false; },
      },
      kv: { get: async (key: string) => ({ ok: true as const, data: { data: nodeData.get(key) } }) },
    } as unknown as TinyCloudWeb;

    const debug = console.debug;
    console.debug = () => undefined;
    try {
      startReplicationFill(tcw, () => true, { firstLoadSettled: async () => {}, prefixes: ["app/x/", "app/y/"], startGapMs: 0 });
      await flush();
    } finally {
      console.debug = debug;
    }

    expect(controllerOpen).toBe(false);
    expect(syncCalls).toBe(1);
    const read = await (tcw as unknown as { kv: { get(key: string): Promise<{ ok: boolean; data: { data?: string } }> } }).kv.get("app/x/key");
    expect(read).toEqual({ ok: true, data: { data: "from-node" } });
  });

  test("a first prefix that never settles does not hold the rest of the fill past the deadline", async () => {
    jest.useFakeTimers();
    const started: string[] = [];
    const tcw = {
      did: "did:pkh:eip155:1:0xcccc",
      replication: {
        sync: ({ prefix }: { prefix: string }) => {
          started.push(prefix);
          return prefix === "a/" ? new Promise<void>(() => undefined) : Promise.resolve();
        },
      },
    } as unknown as TinyCloudWeb;

    startReplicationFill(tcw, () => true, { firstLoadSettled: async () => {}, prefixes: ["a/", "b/", "c/"], startGapMs: 0 });
    await flush();
    jest.advanceTimersByTime(REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS / 2);
    await flush();
    expect(started).toEqual(["a/"]);
    for (let step = 0; step < 20 && started.length < 3; step += 1) {
      jest.advanceTimersByTime(REPLICATION_FILL_FIRST_LOAD_DEADLINE_MS / 2);
      await flush();
    }
    expect(started).toEqual(["a/", "b/", "c/"]);
  });
});
