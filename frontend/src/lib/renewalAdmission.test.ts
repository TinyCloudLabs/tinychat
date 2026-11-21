import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadRenewalReceipt } from "@tinyboilerplate/client";
import type { PersistedSessionData } from "@tinycloud/web-sdk";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { admitSignInRenewal } from "./renewalReceipt";
import { fixture } from "./renewalReceipt.fixture";

// The real SDK admission against a loopback stand-in for the session's node: it publishes the renewer identity and
// records every lease presented to /delegate.

type Receipt = Awaited<ReturnType<typeof fixture>>["receipt"];

let node: ReturnType<typeof Bun.serve>;
let published: unknown;
let delegateStatus: number | "hang";
let presented: string[];

beforeEach(() => {
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() { return values.size; },
  } as Storage;
  presented = [];
  delegateStatus = 200;
  node = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/.well-known/tinycloud/node-keys") return Response.json(published);
      if (request.method === "POST" && pathname === "/delegate") {
        presented.push(request.headers.get("Authorization") ?? "");
        if (delegateStatus === "hang") return new Promise<Response>(() => {});
        return Response.json({ activated: [], skipped: [] }, { status: delegateStatus });
      }
      return new Response("unexpected", { status: 500 });
    },
  });
});

afterEach(() => node.stop(true));

function admit(address: string, record: PersistedSessionData, renewal: unknown, load = async () => record as PersistedSessionData | null, arrivedAt: number | undefined = performance.now()) {
  return admitSignInRenewal({
    tcw: { activeNodeIdentity: async () => ({ origin: `http://127.0.0.1:${node.port}`, nodeDid: "did:key:node" }) },
    address,
    renewal,
    arrivedAt,
    storage: { load },
  });
}

function publish(receipt: Receipt) {
  published = receipt.receipt.nodeIdentity;
}

describe("renewal chosen at sign-in", () => {
  test("is admitted at the session's node with the lease OpenKey signed, then kept as the session's receipt", async () => {
    const { owner, record, receipt, lease } = await fixture();
    publish(receipt);
    expect(await admit(owner.address, record, receipt)).toBe(true);
    expect(presented).toEqual([lease.authorization]);
    expect(loadRenewalReceipt(owner.address)).toEqual(receipt);
  });

  test("is not kept when the session was signed out while the node admitted it", async () => {
    const { owner, record, receipt } = await fixture();
    publish(receipt);
    expect(await admit(owner.address, record, receipt, async () => (presented.length === 0 ? record : null))).toBe(false);
    expect(presented).toHaveLength(1);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });

  test("is not kept when the node refuses the lease, so the session runs to its signed end", async () => {
    const { owner, record, receipt } = await fixture();
    publish(receipt);
    delegateStatus = 403;
    expect(await admit(owner.address, record, receipt)).toBe(false);
    expect(presented).toHaveLength(1);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });

  test("is given up after five seconds when the node doesn't answer, and not kept", async () => {
    const { owner, record, receipt } = await fixture();
    publish(receipt);
    delegateStatus = "hang";
    const started = Date.now();
    expect(await admit(owner.address, record, receipt)).toBe(false);
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(presented).toHaveLength(1);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  }, 10_000);

  test("is not sent when the node's renewer is no longer the one the lease names", async () => {
    const { owner, record, receipt } = await fixture();
    publish(receipt);
    published = { ...receipt.receipt.nodeIdentity, renewerEpoch: 1 };
    expect(await admit(owner.address, record, receipt)).toBe(false);
    expect(presented).toEqual([]);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });

  test("is not sent when the lease doesn't check out against the session just signed in", async () => {
    const { owner, record, receipt } = await fixture({ leaseSigner: privateKeyToAccount(generatePrivateKey()) });
    publish(receipt);
    expect(await admit(owner.address, record, receipt)).toBe(false);
    const other = await fixture();
    expect(await admit(owner.address, record, other.receipt)).toBe(false);
    expect(presented).toEqual([]);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });

  test("absent (renewal unticked, or an OpenKey without it) contacts no node and keeps nothing", async () => {
    const { owner, record } = await fixture();
    expect(await admit(owner.address, record, undefined)).toBe(false);
    expect(presented).toEqual([]);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });

  test("is not sent once a minute has passed since it arrived, and not kept", async () => {
    const { owner, record, receipt } = await fixture();
    publish(receipt);
    expect(await admit(owner.address, record, receipt, undefined, performance.now() - 60_001)).toBe(false);
    // No arrival time (the outcome never came through the sign-in client): not sent.
    expect(await admitSignInRenewal({ tcw: { activeNodeIdentity: async () => ({ origin: `http://127.0.0.1:${node.port}`, nodeDid: "did:key:node" }) },
      address: owner.address, renewal: receipt, arrivedAt: undefined, storage: { load: async () => record } })).toBe(false);
    expect(presented).toEqual([]);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  });

  test("is given up when its minute runs out, even with the five seconds not yet up", async () => {
    const { owner, record, receipt } = await fixture();
    publish(receipt);
    delegateStatus = "hang";
    const started = performance.now();
    expect(await admit(owner.address, record, receipt, undefined, started - 59_000)).toBe(false);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(presented).toHaveLength(1);
    expect(loadRenewalReceipt(owner.address)).toBeNull();
  }, 10_000);

  test("counts its minute from arrival on this device, not from when OpenKey approved it by the wall clock", async () => {
    const { owner, record, receipt } = await fixture();
    publish(receipt);
    // This device's wall clock runs two minutes past OpenKey's `approvedAt`; the lease has only just arrived.
    const wallClock = Date.now;
    Date.now = () => wallClock() + 120_000;
    try {
      expect(await admit(owner.address, record, receipt)).toBe(true);
    } finally {
      Date.now = wallClock;
    }
    expect(presented).toHaveLength(1);
  });
});
