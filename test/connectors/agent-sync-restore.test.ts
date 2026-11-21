// Agent-host Fireflies runner (TC-1192): restoring a CLI profile that holds an owner renewal lease.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProfile, restoreProfileSession } from "../../scripts/agent-sync/fireflies";

const NOW = Date.parse("2026-11-20T00:00:00Z");
const PAST = "2026-11-16T05:00:00.000Z";
const LEASE = { authorization: "lease-auth-1", expiresAt: "2027-02-14T00:00:00.000Z" };

type Session = Parameters<typeof restoreProfileSession>[1]["session"];
const session = { delegationCid: "cid" } as unknown as Session;

function codeError(code: string): Error {
  return Object.assign(new Error(`private ${code}`), { code });
}

function fakeNode(opts: { restore?: Error; renew?: Error } = {}) {
  const calls: string[] = [];
  return {
    calls,
    node: {
      async restoreSession() { calls.push("restore"); if (opts.restore) throw opts.restore; },
      async restoreSessionWithRenewal(_data: unknown, authorization: string) {
        calls.push(`renew:${authorization}`);
        if (opts.renew) throw opts.renew;
      },
    },
  };
}

async function outcome(promise: Promise<void>): Promise<string> {
  try {
    await promise;
    return "restored";
  } catch (error) {
    return error instanceof Error && "result" in error ? String(error.result) : "other";
  }
}

describe("restoreProfileSession", () => {
  test("an expired original grant with a live lease restores through the lease", async () => {
    const { node, calls } = fakeNode({ restore: codeError("AUTH_EXPIRED") });
    const profile = { expiresAt: PAST, lease: LEASE, session };
    expect(await outcome(restoreProfileSession(node, profile, NOW))).toBe("restored");
    expect(calls).toEqual(["restore", "renew:lease-auth-1"]);
  });

  test("a live original grant restores without touching the lease", async () => {
    const { node, calls } = fakeNode();
    const profile = { expiresAt: "2026-12-01T00:00:00.000Z", lease: LEASE, session };
    expect(await outcome(restoreProfileSession(node, profile, NOW))).toBe("restored");
    expect(calls).toEqual(["restore"]);
  });

  test.each(["RENEWAL_LEASE_EXPIRED", "RENEWAL_AUTHORITY_INACTIVE", "RENEWAL_LEASE_ORIGINAL_EXPIRED", "AUTH_EXPIRED"])(
    "a lease refused with %s needs a new approval",
    async (code) => {
      const { node } = fakeNode({ restore: codeError("AUTH_EXPIRED"), renew: codeError(code) });
      const profile = { expiresAt: PAST, lease: LEASE, session };
      expect(await outcome(restoreProfileSession(node, profile, NOW))).toBe("needs_renewal");
    },
  );

  test("a lease whose end has passed is not tried", async () => {
    const { node, calls } = fakeNode();
    const profile = { expiresAt: PAST, lease: { ...LEASE, expiresAt: "2026-11-19T00:00:00.000Z" }, session };
    expect(await outcome(restoreProfileSession(node, profile, NOW))).toBe("needs_renewal");
    expect(calls).toEqual([]);
  });

  test("an expired grant without a lease needs a new approval before any restore", async () => {
    const { node, calls } = fakeNode();
    expect(await outcome(restoreProfileSession(node, { expiresAt: PAST, lease: null, session }, NOW))).toBe("needs_renewal");
    expect(calls).toEqual([]);
  });

  test("a node that does not answer is not reported as an ended lease", async () => {
    const down = codeError("NETWORK_ERROR");
    const first = fakeNode({ restore: codeError("AUTH_EXPIRED"), renew: down });
    expect(await outcome(restoreProfileSession(first.node, { expiresAt: PAST, lease: LEASE, session }, NOW))).toBe("other");
    const second = fakeNode({ restore: down });
    expect(await outcome(restoreProfileSession(second.node, { expiresAt: PAST, lease: LEASE, session }, NOW))).toBe("other");
    expect(second.calls).toEqual(["restore"]);
  });
});

describe("loadProfile", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agent-sync-profile-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function write(renewal: unknown) {
    const dir = join(home, "profiles", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "profile.json"), JSON.stringify({ host: "https://node.example", ownerDid: "did:pkh:eip155:1:0xabc" }));
    writeFileSync(join(dir, "key.json"), JSON.stringify({ kty: "OKP" }));
    writeFileSync(join(dir, "session.json"), JSON.stringify({
      delegationHeader: { Authorization: "auth" },
      delegationCid: "cid",
      spaceId: "tinycloud:pkh:eip155:1:0xabc:applications",
      verificationMethod: "did:key:z#z",
      expiresAt: PAST,
      ...(renewal === undefined ? {} : { renewal }),
    }));
  }

  test("keeps the stored lease", () => {
    write({ receipt: { leaseAuthorization: "lease-auth-1", leaseExpiresAt: LEASE.expiresAt } });
    expect(loadProfile(home, "p").lease).toEqual(LEASE);
  });

  test("a profile without a usable receipt has no lease", () => {
    write(undefined);
    expect(loadProfile(home, "p").lease).toBeNull();
    write({ receipt: { leaseAuthorization: "", leaseExpiresAt: LEASE.expiresAt } });
    expect(loadProfile(home, "p").lease).toBeNull();
  });
});
