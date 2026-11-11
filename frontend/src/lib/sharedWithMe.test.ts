import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { clearAccountSignOutStorage } from "./accountSignOutStorage";
import {
  addSharedWithMe,
  bindSharedWithMe,
  LEGACY_SHARED_WITH_ME_KEY,
  readSharedWithMe,
  removeSharedWithMe,
  resetSharedWithMeForTests,
  SHARED_WITH_ME_KEY_PREFIX,
  sharedWithMeLocalKey,
} from "./sharedWithMe";

const ALICE = "did:pkh:eip155:1:0xA11CE00000000000000000000000000000000001";
const BOB = "did:pkh:eip155:1:0xB0B0000000000000000000000000000000000002";
const FUTURE = "2999-01-01T00:00:00.000Z";
const SECRET = "tcchat1:SECRET-share-key";

const originalWindow = globalThis.window;

// One browser profile's localStorage, with key enumeration for the sign-out sweep.
function device() {
  const values = new Map<string, string>();
  const localStorage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } as Storage;
  return {
    values,
    localStorage,
    use() {
      (globalThis as { window?: unknown }).window = { localStorage };
    },
  };
}

// One account's space: an in-memory KV that records every call.
function space(did: string, kv = new Map<string, string>()) {
  const calls: Array<{ op: string; key: string; value?: string }> = [];
  const tcw = {
    did,
    kv: {
      put: async (key: string, value: string) => {
        calls.push({ op: "put", key, value });
        kv.set(key, value);
        return { ok: true, data: {} };
      },
      get: async (key: string) => {
        calls.push({ op: "get", key });
        return kv.has(key) ? { ok: true, data: { data: kv.get(key) } } : { ok: false, error: { message: "not found" } };
      },
      delete: async (key: string) => {
        calls.push({ op: "delete", key });
        kv.delete(key);
        return { ok: true, data: {} };
      },
      list: async ({ path }: { path: string }) => {
        calls.push({ op: "list", key: path });
        return { ok: true, data: { keys: [...kv.keys()].filter((key) => key.startsWith(path)) } };
      },
    },
  };
  return { tcw: tcw as never, kv, calls };
}

function share(id: string, addedAt = "2026-11-01T00:00:00.000Z") {
  return { id, addedAt, expiresAt: FUTURE, token: `${SECRET}-${id}` };
}

const ids = () => readSharedWithMe().filter((r) => !r.removedAt).map((r) => r.id);

beforeEach(() => resetSharedWithMeForTests());
afterEach(() => {
  resetSharedWithMeForTests();
  (globalThis as { window?: unknown }).window = originalWindow;
});

describe("shared-with-me list in the account's space", () => {
  it("a share added on device A shows on device B after B syncs", async () => {
    const aliceKv = new Map<string, string>();
    const phone = device();
    const laptop = device();

    phone.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    await addSharedWithMe(share("s1"));
    expect([...aliceKv.keys()]).toEqual([`${SHARED_WITH_ME_KEY_PREFIX}s1`]);

    laptop.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    expect(ids()).toEqual(["s1"]);
    expect(readSharedWithMe()[0].token).toBe(`${SECRET}-s1`);
  });

  it("each device's adds survive a concurrent add on the other", async () => {
    const aliceKv = new Map<string, string>();
    const phone = device();
    const laptop = device();
    phone.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    laptop.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);

    phone.use();
    await addSharedWithMe(share("from-phone"));
    laptop.use();
    await addSharedWithMe(share("from-laptop", "2026-11-02T00:00:00.000Z"));
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);

    expect(ids()).toEqual(["from-laptop", "from-phone"]);
  });

  it("a removal propagates as a tombstone and drops the secret", async () => {
    const aliceKv = new Map<string, string>();
    const phone = device();
    const laptop = device();
    phone.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    await addSharedWithMe(share("s1"));
    laptop.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    expect(ids()).toEqual(["s1"]);

    phone.use();
    await removeSharedWithMe("s1", FUTURE, ALICE);
    const tombstone = JSON.parse(aliceKv.get(`${SHARED_WITH_ME_KEY_PREFIX}s1`)!);
    expect(tombstone).toMatchObject({ id: "s1", removedAt: expect.any(String) });
    expect(tombstone.token).toBeUndefined();

    // The laptop still holds the live copy; its sync must not resurrect it.
    laptop.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    expect(ids()).toEqual([]);
    expect(laptop.values.get(sharedWithMeLocalKey(ALICE))).not.toContain(SECRET);
    expect(aliceKv.get(`${SHARED_WITH_ME_KEY_PREFIX}s1`)).not.toContain(SECRET);
  });

  it("re-adding a share after removing it wins over the older tombstone", async () => {
    const aliceKv = new Map<string, string>();
    device().use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    await addSharedWithMe(share("s1"));
    await removeSharedWithMe("s1", FUTURE, ALICE);
    await addSharedWithMe(share("s1", new Date(Date.now() + 1000).toISOString()));

    device().use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    expect(ids()).toEqual(["s1"]);
  });

  it("a record the space fails to return is not overwritten (a tombstone stays)", async () => {
    const aliceKv = new Map<string, string>();
    const phone = device();
    const laptop = device();
    phone.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    await addSharedWithMe(share("s1"));
    laptop.use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    phone.use();
    await removeSharedWithMe("s1", FUTURE, ALICE);
    const tombstone = aliceKv.get(`${SHARED_WITH_ME_KEY_PREFIX}s1`);

    // The laptop still holds the live copy, and its read of s1 fails once.
    laptop.use();
    const flaky = space(ALICE, aliceKv);
    const get = flaky.tcw as unknown as { kv: { get: (key: string) => Promise<unknown> } };
    get.kv.get = async () => ({ ok: false, error: { code: "NETWORK_ERROR", message: "offline" } });
    await bindSharedWithMe(flaky.tcw);

    expect(aliceKv.get(`${SHARED_WITH_ME_KEY_PREFIX}s1`)).toBe(tombstone);
    expect(flaky.calls.filter((c) => c.op === "put")).toEqual([]);
  });

  it("stopping a share stamped by a device whose clock runs ahead still removes it", async () => {
    const aliceKv = new Map<string, string>();
    device().use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    await addSharedWithMe(share("s1", new Date(Date.now() + 60_000).toISOString()));
    await removeSharedWithMe("s1", FUTURE, ALICE);

    expect(ids()).toEqual([]);
    expect(aliceKv.get(`${SHARED_WITH_ME_KEY_PREFIX}s1`)).not.toContain(SECRET);
  });

  it("migrates the device's legacy list once, to the first account that signs in", async () => {
    const shared = device();
    shared.values.set(LEGACY_SHARED_WITH_ME_KEY, JSON.stringify([
      { format: "tinychat.share", id: "old-1", acceptedAt: "2026-10-01T00:00:00.000Z", expiresAt: FUTURE, token: `${SECRET}-old-1`, threadId: "t" },
      { format: "tinychat.share", id: "expired", acceptedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2001-01-01T00:00:00.000Z", token: `${SECRET}-x` },
    ]));
    shared.use();
    const alice = space(ALICE);

    await bindSharedWithMe(alice.tcw);

    expect(ids()).toEqual(["old-1"]);
    expect([...alice.kv.keys()]).toEqual([`${SHARED_WITH_ME_KEY_PREFIX}old-1`]);
    expect(shared.values.has(LEGACY_SHARED_WITH_ME_KEY)).toBe(false);

    // A second sign-in, as Alice again or as Bob, migrates nothing more.
    const puts = alice.calls.filter((c) => c.op === "put").length;
    await bindSharedWithMe(null);
    await bindSharedWithMe(space(ALICE, alice.kv).tcw);
    expect(alice.calls.filter((c) => c.op === "put").length).toBe(puts);
    const bob = space(BOB);
    await bindSharedWithMe(bob.tcw);
    expect(ids()).toEqual([]);
    expect(bob.kv.size).toBe(0);
  });

  it("keeps each account's list to that account", async () => {
    const shared = device();
    shared.use();
    const alice = space(ALICE);
    const bob = space(BOB);

    await bindSharedWithMe(alice.tcw);
    await addSharedWithMe(share("alice-share"));
    await bindSharedWithMe(bob.tcw);
    expect(ids()).toEqual([]);
    await addSharedWithMe(share("bob-share"));

    expect([...alice.kv.keys()]).toEqual([`${SHARED_WITH_ME_KEY_PREFIX}alice-share`]);
    expect([...bob.kv.keys()]).toEqual([`${SHARED_WITH_ME_KEY_PREFIX}bob-share`]);
    expect(shared.values.get(sharedWithMeLocalKey(BOB))).not.toContain("alice-share");
    await bindSharedWithMe(alice.tcw);
    expect(ids()).toEqual(["alice-share"]);
  });

  it("signed out: the list is hidden and nothing is sent; a link opened then joins the next sign-in", async () => {
    const shared = device();
    shared.use();
    const alice = space(ALICE);

    await addSharedWithMe(share("opened-signed-out"));
    expect(readSharedWithMe()).toEqual([]);
    expect([...shared.values.keys()]).toEqual([]);
    expect(alice.calls).toEqual([]);

    await bindSharedWithMe(alice.tcw);
    expect(ids()).toEqual(["opened-signed-out"]);
    expect(alice.kv.has(`${SHARED_WITH_ME_KEY_PREFIX}opened-signed-out`)).toBe(true);
  });

  it("sign-out clears this device's copy; the space copy brings it back on sign-in", async () => {
    const shared = device();
    shared.use();
    const alice = space(ALICE);
    await bindSharedWithMe(alice.tcw);
    await addSharedWithMe(share("s1"));

    clearAccountSignOutStorage(ALICE, ALICE.split(":").pop()!, shared.localStorage);
    expect(shared.values.has(sharedWithMeLocalKey(ALICE))).toBe(false);
    expect(readSharedWithMe()).toEqual([]);

    await bindSharedWithMe(space(ALICE, alice.kv).tcw);
    expect(ids()).toEqual(["s1"]);
  });

  it("a sync still in flight at sign-out does not write the copy back", async () => {
    const shared = device();
    shared.use();
    const aliceKv = new Map<string, string>([[`${SHARED_WITH_ME_KEY_PREFIX}s1`, JSON.stringify({ version: 1, ...share("s1") })]]);
    const alice = space(ALICE, aliceKv);

    const syncing = bindSharedWithMe(alice.tcw);
    clearAccountSignOutStorage(ALICE, ALICE.split(":").pop()!, shared.localStorage);
    await syncing;

    expect(shared.values.has(sharedWithMeLocalKey(ALICE))).toBe(false);
  });

  it("a share an owner created lands only in that owner's list, even if it finishes after sign-out", async () => {
    const shared = device();
    shared.use();
    const alice = space(ALICE);
    const bob = space(BOB);
    await bindSharedWithMe(alice.tcw);

    // Alice's create resolves after she signed out, then Bob signs in on the same page.
    clearAccountSignOutStorage(ALICE, ALICE.split(":").pop()!, shared.localStorage);
    await addSharedWithMe(share("alice-created"), ALICE);
    await bindSharedWithMe(bob.tcw);
    // And one that resolves while Bob is bound.
    await addSharedWithMe(share("alice-late"), ALICE);
    await removeSharedWithMe("bob-unknown", FUTURE, ALICE);

    expect(ids()).toEqual([]);
    expect(bob.kv.size).toBe(0);
    expect(alice.calls.filter((c) => c.op === "put")).toEqual([]);
  });

  it("sign-out forgets links opened while unbound, so the next account never gets them", async () => {
    const shared = device();
    shared.use();
    const bob = space(BOB);

    // Opened while Alice's session was offline (unbound), then Alice signs out.
    await addSharedWithMe(share("opened-offline"));
    clearAccountSignOutStorage(ALICE, ALICE.split(":").pop()!, shared.localStorage);
    await bindSharedWithMe(bob.tcw);

    expect(ids()).toEqual([]);
    expect(bob.kv.size).toBe(0);
  });

  it("drops expired shares locally and from the space", async () => {
    const aliceKv = new Map<string, string>([
      [`${SHARED_WITH_ME_KEY_PREFIX}old`, JSON.stringify({ version: 1, ...share("old"), expiresAt: "2001-01-01T00:00:00.000Z" })],
    ]);
    device().use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);

    expect(readSharedWithMe()).toEqual([]);
    expect(aliceKv.size).toBe(0);
  });

  it("ignores a record stored under another share's key", async () => {
    const aliceKv = new Map<string, string>([
      [`${SHARED_WITH_ME_KEY_PREFIX}s1`, JSON.stringify({ version: 1, ...share("s2") })],
    ]);
    device().use();
    await bindSharedWithMe(space(ALICE, aliceKv).tcw);
    expect(ids()).toEqual([]);
  });

  it("sends share links only to the account's own space, under the shared-with-me prefix, and never logs them", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const logs = [
      spyOn(console, "log"), spyOn(console, "info"), spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "debug"),
    ];
    try {
      const aliceKv = new Map<string, string>();
      device().use();
      const alice = space(ALICE, aliceKv);
      await bindSharedWithMe(alice.tcw);
      await addSharedWithMe(share("s1"));
      await removeSharedWithMe("s1", FUTURE, ALICE);
      await addSharedWithMe(share("s2"));
      device().use();
      const laptop = space(ALICE, aliceKv);
      await bindSharedWithMe(laptop.tcw);

      expect(fetchSpy).not.toHaveBeenCalled();
      for (const call of [...alice.calls, ...laptop.calls]) {
        expect(call.key.startsWith(SHARED_WITH_ME_KEY_PREFIX)).toBe(true);
      }
      for (const spy of logs) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
      }
    } finally {
      fetchSpy.mockRestore();
      for (const spy of logs) spy.mockRestore();
    }
  });

  it("stores the share under the manifest's threads/ KV grant", () => {
    expect(SHARED_WITH_ME_KEY_PREFIX).toBe("xyz.tinycloud.tinychat/threads/shared-with-me/");
  });
});
