import { describe, expect, test } from "bun:test";
import {
  applyManifestRevisionGate,
  EXO_MANIFEST_REVISION,
  needsManifestResign,
  recordManifestRevision,
  type RevisionStore,
} from "./manifestRevision";

const ADDRESS = "0x00000000000000000000000000000000000000Aa";
const OTHER = "0x00000000000000000000000000000000000000Bb";

function memoryStore(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const writes: string[] = [];
  const store: RevisionStore = {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      writes.push(key);
      data[key] = value;
    },
  };
  return { store, data, writes };
}

const blockedStore: RevisionStore = {
  getItem: () => {
    throw new Error("storage blocked");
  },
  setItem: () => {
    throw new Error("storage blocked");
  },
};

describe("manifest revision gate", () => {
  test("a session with no recorded revision (signed in before this change) must re-sign", () => {
    const { store } = memoryStore();
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
  });

  test("a session recorded under an older revision must re-sign", () => {
    const { store } = memoryStore({
      [`xyz.tinycloud.tinychat:manifest-revision:${ADDRESS.toLowerCase()}`]: "0",
    });
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
  });

  test("the current revision does not force a re-sign", () => {
    const { store } = memoryStore();
    recordManifestRevision(store, ADDRESS);
    expect(needsManifestResign(store, ADDRESS)).toBe(false);
  });

  test("a stale session forces exactly one sign-in, then records the revision after it succeeds", () => {
    const { store, writes } = memoryStore();

    // Restore: stale, so the caller clears the session and shows sign-in.
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
    // Sign-in succeeds: the revision is recorded.
    recordManifestRevision(store, ADDRESS);

    // The next restore proceeds without another sign-in.
    expect(needsManifestResign(store, ADDRESS)).toBe(false);
    expect(writes).toHaveLength(1);
  });

  test("a failed sign-in never records the revision, so the next restore still re-signs", () => {
    const { store, writes } = memoryStore();

    expect(needsManifestResign(store, ADDRESS)).toBe(true);
    // The sign-in fails, so recordManifestRevision is never called.
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
    expect(writes).toHaveLength(0);
  });

  test("the revision is not bumped on every load: checking a current session never writes", () => {
    const { store, writes } = memoryStore();
    recordManifestRevision(store, ADDRESS);
    writes.length = 0;

    expect(needsManifestResign(store, ADDRESS)).toBe(false);
    expect(needsManifestResign(store, ADDRESS)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("the revision is recorded per address: one account's sign-in does not clear another's", () => {
    const { store } = memoryStore();
    recordManifestRevision(store, ADDRESS);

    expect(needsManifestResign(store, OTHER)).toBe(true);
  });

  test("addresses match regardless of letter case", () => {
    const { store } = memoryStore();
    recordManifestRevision(store, ADDRESS);

    expect(needsManifestResign(store, ADDRESS.toLowerCase())).toBe(false);
  });

  test("the recorded value is the current revision constant", () => {
    const { store, data } = memoryStore();
    recordManifestRevision(store, ADDRESS);

    expect(Object.values(data)).toEqual([EXO_MANIFEST_REVISION]);
  });
});

describe("unavailable storage", () => {
  test("unreadable storage re-signs instead of failing", () => {
    expect(needsManifestResign(blockedStore, ADDRESS)).toBe(true);
  });

  test("unwritable storage does not fail the sign-in that succeeded", () => {
    expect(() => recordManifestRevision(blockedStore, ADDRESS)).not.toThrow();
  });

  test("no storage at all re-signs, and recording is a no-op", () => {
    expect(needsManifestResign(null, ADDRESS)).toBe(true);
    expect(() => recordManifestRevision(null, ADDRESS)).not.toThrow();
  });
});

describe("restore gate", () => {
  const revisionKey = `xyz.tinycloud.tinychat:manifest-revision:${ADDRESS.toLowerCase()}`;
  const online = () => false;
  const offline = () => true;

  test("a stale session gets one handoff, then is cleared for that address", async () => {
    const { store } = memoryStore();
    const calls: string[] = [];
    const outcome = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: online,
      handoff: async () => { calls.push("handoff"); return true; },
      clearSession: (address) => { calls.push(`clear:${address}`); },
    });
    expect(outcome).toBe("cleared");
    expect(calls).toEqual(["handoff", `clear:${ADDRESS}`]);
  });

  test("an older recorded revision is stale too", async () => {
    const { store } = memoryStore({ [revisionKey]: "0" });
    const clears: string[] = [];
    const outcome = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: online,
      handoff: async () => true,
      clearSession: (address) => { clears.push(address); },
    });
    expect(outcome).toBe("cleared");
    expect(clears).toEqual([ADDRESS]);
  });

  test("a session on the current revision is kept: no handoff, no clear", async () => {
    const { store } = memoryStore();
    recordManifestRevision(store, ADDRESS);
    let handoffs = 0;
    const clears: string[] = [];
    const outcome = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: online,
      handoff: async () => { handoffs += 1; return true; },
      clearSession: (address) => { clears.push(address); },
    });
    expect(outcome).toBe("current");
    expect(handoffs).toBe(0);
    expect(clears).toEqual([]);
  });

  test("a current session stays current while offline", async () => {
    const { store } = memoryStore();
    recordManifestRevision(store, ADDRESS);
    const outcome = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: offline,
      handoff: async () => true,
      clearSession: () => {},
    });
    expect(outcome).toBe("current");
  });

  test("no stored address means nothing to re-sign: no handoff, no clear", async () => {
    const { store } = memoryStore();
    let handoffs = 0;
    const clears: string[] = [];
    const outcome = await applyManifestRevisionGate({
      store,
      address: null,
      isOffline: online,
      handoff: async () => { handoffs += 1; return true; },
      clearSession: (address) => { clears.push(address); },
    });
    expect(outcome).toBe("current");
    expect(handoffs).toBe(0);
    expect(clears).toEqual([]);
  });

  test("a failed handoff keeps the stale session: it is not cleared and reports handoff_failed", async () => {
    const { store } = memoryStore();
    const clears: string[] = [];
    const outcome = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: online,
      handoff: async () => false,
      clearSession: (address) => { clears.push(address); },
    });
    expect(outcome).toBe("handoff_failed");
    expect(clears).toEqual([]);
  });

  test("a stale session is deferred while offline: no handoff, no clear, still stale", async () => {
    const { store } = memoryStore();
    let handoffs = 0;
    const clears: string[] = [];
    const outcome = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: offline,
      handoff: async () => { handoffs += 1; return true; },
      clearSession: (address) => { clears.push(address); },
    });
    expect(outcome).toBe("deferred");
    expect(handoffs).toBe(0);
    expect(clears).toEqual([]);
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
  });

  test("a deferred stale session is cleared on the first online load", async () => {
    const { store } = memoryStore();
    let offlineNow = true;
    const clears: string[] = [];
    const input = {
      store,
      address: ADDRESS,
      isOffline: () => offlineNow,
      handoff: async () => true,
      clearSession: (address: string) => { clears.push(address); },
    };
    expect(await applyManifestRevisionGate(input)).toBe("deferred");
    expect(clears).toEqual([]);
    offlineNow = false;
    expect(await applyManifestRevisionGate(input)).toBe("cleared");
    expect(clears).toEqual([ADDRESS]);
  });

  test("after a successful sign-in records the revision, the next restore leaves the session alone", async () => {
    const { store } = memoryStore();
    const first = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: online,
      handoff: async () => true,
      clearSession: () => {},
    });
    expect(first).toBe("cleared");
    recordManifestRevision(store, ADDRESS);
    let handoffs = 0;
    const second = await applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: online,
      handoff: async () => { handoffs += 1; return true; },
      clearSession: () => {},
    });
    expect(second).toBe("current");
    expect(handoffs).toBe(0);
  });
});
