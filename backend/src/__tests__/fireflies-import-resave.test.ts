import { describe, expect, it } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { deriveFirefliesImportKeys, FIREFLIES_DELEGATE_KMS_PATH } from "../fireflies-import-identity.js";
import {
  defaultReadSecretKey,
  FirefliesDirectImporter,
} from "../services/fireflies-import-executor.js";
import { FirefliesGrantStore } from "../services/fireflies-grant-store.js";
import { createMemoryGrantKv, HOST, mintGrantPair } from "./helpers/fireflies-grant-fixtures.js";

const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);

async function activeGrant(seed: number) {
  const keys = await deriveFirefliesImportKeys(
    { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? seed : seed + 1) },
    { host: HOST, env: {} },
  );
  const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
  const pair = await mintGrantPair(keys.delegate.did, cidOf, { now: NOW });
  const { kv } = createMemoryGrantKv();
  const grantStore = new FirefliesGrantStore({ kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
  await grantStore.store(pair.address, pair, pair.expiresAt);
  const loaded = await grantStore.loadActive(pair.address, {
    configuredHost: HOST,
    deps: { computeDelegationCid: cidOf },
    now: NOW,
  });
  if (loaded.state !== "active") throw new Error("expected an active grant");
  return { keys, cidOf, pair, grantStore, verified: loaded.verified };
}

const fakeNode = (readSecret: () => Promise<unknown>) =>
  ({ useDelegation: async () => ({}), readSecret }) as unknown as TinyCloudNode;

describe("Fireflies import with a key the server cannot open", () => {
  it("classifies keys that only the owner can fix apart from failures a retry can fix", async () => {
    const { verified } = await activeGrant(0xe1);
    const read = (status: string) => defaultReadSecretKey(fakeNode(async () => ({ status })), verified, HOST);

    expect(await read("legacy_envelope")).toEqual({ status: "resave_required" });
    expect(await read("corrupt_envelope")).toEqual({ status: "resave_required" });
    expect(await read("invalid_payload")).toEqual({ status: "resave_required" });

    // The node being unreachable or failing a read can pass on the next delivery.
    expect(await read("node_unreachable")).toEqual({ status: "error" });
    expect(await read("read_failed")).toEqual({ status: "error" });
  });

  it("answers 200 without a retry, calls Fireflies never, writes nothing and keeps the grant", async () => {
    const { keys, cidOf, pair, grantStore } = await activeGrant(0xe3);
    let firefliesCalls = 0;
    let writes = 0;
    const logs: string[] = [];
    const importer = new FirefliesDirectImporter({
      delegate: keys.delegate,
      grantStore,
      configuredHost: HOST,
      control: { readLedger: async () => ({ status: "absent" }), readDeleted: async () => false },
      fetchOptions: {
        fetchImpl: (async () => {
          firefliesCalls += 1;
          return new Response("{}");
        }) as typeof fetch,
        now: () => NOW,
      },
      checkMeetingsGrant: async () => ({ status: "ok" }),
      readSecretKey: async () => ({ status: "resave_required" }),
      writeMeeting: async () => {
        writes += 1;
        return { status: "written" };
      },
      perUserSpacingMs: 0,
      now: () => NOW,
      log: (line) => logs.push(line),
    });

    const first = await importer.handleWebhook({
      address: pair.address,
      meetingId: "ff-resave-1",
      receivedAt: new Date(NOW).toISOString(),
    });
    expect(first).toEqual({
      handled: true,
      httpStatus: 200,
      body: { status: "resave_required" },
      outcome: "resave_required",
    });
    expect(firefliesCalls).toBe(0);
    expect(writes).toBe(0);
    expect(importer.metrics().resaveRequired).toBe(1);
    expect(importer.metrics().nodeErrors).toBe(0);
    expect(logs.some((line) => line.includes("result=resave_required"))).toBe(true);

    // Saved grants stay: the owner re-saving the key is enough, with no new consent.
    const status = await grantStore.status(pair.address, {
      configuredHost: HOST,
      deps: { computeDelegationCid: cidOf },
      now: NOW,
    });
    expect(status.state).toBe("active");
  });
});
