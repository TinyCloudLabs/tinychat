import { describe, expect, test } from "bun:test";
import type { ExoActivatedGrant } from "../exo/activated-grant.js";
import { createOwnerGrantCache, EXO_GRANT_CACHE_MISS_TTL_MS, EXO_GRANT_CACHE_TTL_MS } from "../exo/grant-cache.js";
import { createTrackedGrantStore } from "../exo/grant-holders.js";
import { verifyWake, type ExoMailboxPorts } from "../exo/mailbox.js";
import { createExoStorePorts, type ExoBackendKv } from "../exo/stores.js";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const OWNER_LC = OWNER.toLowerCase();
const OTHER = `0x${"c".repeat(40)}`;
const REQUEST_ID = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";

function grant(): ExoActivatedGrant {
  return { requestsGet: async () => undefined } as unknown as ExoActivatedGrant;
}

/** An opener that counts its calls and answers from `answers`, one lookup per call. */
function opener(answers: Array<ExoActivatedGrant | null | Error>) {
  const calls: string[] = [];
  return {
    calls,
    open: async (owner: string) => {
      calls.push(owner);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

describe("owner grant cache", () => {
  test("concurrent opens for one owner share one lookup", async () => {
    const source = opener([grant()]);
    const cache = createOwnerGrantCache(source.open);
    const results = await Promise.all([cache.open(OWNER_LC), cache.open(OWNER_LC), cache.open(OWNER_LC), cache.open(OWNER_LC)]);
    expect(source.calls).toHaveLength(1);
    expect(new Set(results).size).toBe(1);
  });

  test("an opened grant is reused until its window ends, then opened again", async () => {
    let at = 1_000;
    const source = opener([grant(), grant()]);
    const cache = createOwnerGrantCache(source.open, { now: () => at });
    await cache.open(OWNER_LC);
    at += EXO_GRANT_CACHE_TTL_MS - 1;
    await cache.open(OWNER_LC);
    expect(source.calls).toHaveLength(1);
    at += 1;
    await cache.open(OWNER_LC);
    expect(source.calls).toHaveLength(2);
  });

  test("no grant is remembered for a shorter window than a grant", async () => {
    let at = 1_000;
    const source = opener([null, grant()]);
    const cache = createOwnerGrantCache(source.open, { now: () => at });
    expect(await cache.open(OWNER_LC)).toBeNull();
    at += EXO_GRANT_CACHE_MISS_TTL_MS - 1;
    expect(await cache.open(OWNER_LC)).toBeNull();
    expect(source.calls).toHaveLength(1);
    at += 1;
    expect(await cache.open(OWNER_LC)).not.toBeNull();
    expect(source.calls).toHaveLength(2);
  });

  test("owners are cached apart, and the owner key ignores letter case", async () => {
    const source = opener([grant()]);
    const cache = createOwnerGrantCache(source.open);
    await cache.open(OWNER);
    await cache.open(OWNER_LC);
    await cache.open(OTHER);
    expect(source.calls).toHaveLength(2);
  });

  test("invalidate drops one owner and leaves the others", async () => {
    const source = opener([grant()]);
    const cache = createOwnerGrantCache(source.open);
    await cache.open(OWNER_LC);
    await cache.open(OTHER);
    cache.invalidate(OWNER);
    await cache.open(OWNER_LC);
    await cache.open(OTHER);
    expect(source.calls).toEqual([OWNER_LC, OTHER, OWNER_LC]);
  });

  test("a lookup that throws is not remembered", async () => {
    const source = opener([new Error("node down"), grant()]);
    const cache = createOwnerGrantCache(source.open);
    await expect(cache.open(OWNER_LC)).rejects.toThrow("node down");
    expect(await cache.open(OWNER_LC)).not.toBeNull();
    expect(source.calls).toHaveLength(2);
  });

  test("past the owner limit the oldest owner is forgotten", async () => {
    const source = opener([grant()]);
    const cache = createOwnerGrantCache(source.open, { maxOwners: 2 });
    await cache.open("0x1");
    await cache.open("0x2");
    await cache.open("0x3");
    await cache.open("0x2");
    await cache.open("0x1");
    expect(source.calls).toEqual(["0x1", "0x2", "0x3", "0x1"]);
  });
});

describe("a wake check through the cached opener", () => {
  function wakePorts(opened: string[], answers: Array<ExoActivatedGrant | null>) {
    let call = 0;
    const cache = createOwnerGrantCache(async (owner) => {
      opened.push(owner);
      return answers[Math.min(call++, answers.length - 1)];
    });
    const ports = createExoStorePorts({
      backendKv: {} as ExoBackendKv,
      openOwnerGrant: cache.open,
      webhooks: { config: async () => null },
      controls: { readDisabled: async () => null },
      grantHolders: { mayHold: () => true, remove: () => {} },
      frontendOrigin: "https://app.example",
    }) as ExoMailboxPorts;
    return { cache, ports };
  }

  test("one wake opens the owner grant once, however many reads it makes", async () => {
    const opened: string[] = [];
    const { ports } = wakePorts(opened, [grant()]);
    // The wake reads the grant, then one request path per capability. Nothing is on file, so it ends unverified.
    expect(await verifyWake(ports, { owner: OWNER_LC, requestId: REQUEST_ID })).toBeUndefined();
    expect(opened).toEqual([OWNER_LC]);
    expect(await verifyWake(ports, { owner: OWNER_LC, requestId: REQUEST_ID })).toBeUndefined();
    expect(opened).toEqual([OWNER_LC]);
  });

  test("a grant removed through the tracked store reads as inactive on the next wake", async () => {
    const opened: string[] = [];
    const { cache, ports } = wakePorts(opened, [grant(), null]);
    expect(await ports.grants.isActive(OWNER_LC)).toBe(true);
    const removed: string[] = [];
    const tracked = createTrackedGrantStore(
      { store: async () => {}, load: async () => null, remove: async (id: string) => void removed.push(id) },
      { add: () => {}, remove: () => {} },
      cache.invalidate,
    );
    await tracked.remove(OWNER_LC);
    expect(await ports.grants.isActive(OWNER_LC)).toBe(false);
    expect(opened).toEqual([OWNER_LC, OWNER_LC]);
    expect(removed).toEqual([OWNER_LC]);
  });

  test("a grant stored through the tracked store is seen at once by an owner cached as having none", async () => {
    const opened: string[] = [];
    const { cache, ports } = wakePorts(opened, [null, grant()]);
    expect(await ports.grants.isActive(OWNER_LC)).toBe(false);
    const tracked = createTrackedGrantStore(
      { store: async () => {}, load: async () => null, remove: async () => {} },
      { add: () => {}, remove: () => {} },
      cache.invalidate,
    );
    await tracked.store(OWNER_LC, "grant", { expiresAt: "2099-01-01T00:00:00.000Z" } as never);
    expect(await ports.grants.isActive(OWNER_LC)).toBe(true);
  });
});
