import { describe, expect, test } from "bun:test";
import {
  applyManifestRevisionGate,
  browserRevisionStore,
  EXO_MANIFEST_REVISION,
  MANIFEST_RESIGN_NOTICE,
  needsManifestResign,
  recordManifestRevision,
  type RevisionStore,
} from "./manifestRevision";

const ADDRESS = "0x00000000000000000000000000000000000000Aa";
const OTHER = "0x00000000000000000000000000000000000000Bb";
const KEY = `xyz.tinycloud.tinychat:manifest-revision:${ADDRESS.toLowerCase()}`;

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

/** Runs the gate over `store`, logging every side effect in order. */
async function runGate(options: { store: RevisionStore | null; address?: string | null; offline?: boolean; handoff?: boolean | "throws" }) {
  const calls: string[] = [];
  const handoff = options.handoff ?? true;
  const outcome = await applyManifestRevisionGate({
    store: options.store,
    address: options.address === undefined ? ADDRESS : options.address,
    isOffline: () => options.offline ?? false,
    handoff: async () => {
      calls.push("handoff");
      if (handoff === "throws") throw new Error("handoff blew up");
      return handoff;
    },
    clearSession: (address) => { calls.push(`clear:${address}`); },
  });
  return { outcome, calls };
}

describe("revision value and storage key", () => {
  test("the revision is \"2\": a record written by the withdrawn \"1\" gate is stale", () => {
    expect(EXO_MANIFEST_REVISION).toBe("2");
    const { store } = memoryStore({ [KEY]: "1" });
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
  });

  test("the record is written under the device-local key prefix, lower-cased address, value \"2\"", () => {
    const { store, data } = memoryStore();
    recordManifestRevision(store, ADDRESS);
    expect(data).toEqual({ [KEY]: "2" });
  });
});

describe("stored revision table", () => {
  const cases: Array<[string, string | null, boolean]> = [
    ["missing", null, true],
    ["older (\"0\")", "0", true],
    ["the withdrawn gate's \"1\"", "1", true],
    ["current", "2", false],
    ["empty", "", true],
    ["padded", " 2", true],
    ["numeric spelling", "2.0", true],
    ["zero padded", "02", true],
    ["not a number", "two", true],
  ];
  for (const [name, stored, stale] of cases) {
    test(`${name} revision ${stale ? "re-signs" : "is kept"}`, () => {
      const { store } = memoryStore(stored === null ? {} : { [KEY]: stored });
      expect(needsManifestResign(store, ADDRESS)).toBe(stale);
    });
  }

  test("checking a current session never writes", () => {
    const { store, writes } = memoryStore();
    recordManifestRevision(store, ADDRESS);
    writes.length = 0;
    expect(needsManifestResign(store, ADDRESS)).toBe(false);
    expect(needsManifestResign(store, ADDRESS)).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("the record is per address and letter case does not matter", () => {
    const { store } = memoryStore();
    recordManifestRevision(store, ADDRESS);
    expect(needsManifestResign(store, OTHER)).toBe(true);
    expect(needsManifestResign(store, ADDRESS.toLowerCase())).toBe(false);
  });
});

describe("unavailable storage", () => {
  test("unreadable storage re-signs instead of failing", () => {
    expect(needsManifestResign(blockedStore, ADDRESS)).toBe(true);
    expect(needsManifestResign(null, ADDRESS)).toBe(true);
  });

  test("unwritable or absent storage does not fail the sign-in that succeeded", () => {
    expect(() => recordManifestRevision(blockedStore, ADDRESS)).not.toThrow();
    expect(() => recordManifestRevision(null, ADDRESS)).not.toThrow();
  });

  test("blocked localStorage resolves to no store", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    try {
      expect(browserRevisionStore()).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("restore gate", () => {
  test("a stale session: handoff first, then clear that address", async () => {
    const { store } = memoryStore();
    expect(await runGate({ store })).toEqual({ outcome: "cleared", calls: ["handoff", `clear:${ADDRESS}`] });
  });

  test("a stale session whose record is older: handoff, then clear", async () => {
    const { store } = memoryStore({ [KEY]: "1" });
    expect(await runGate({ store })).toEqual({ outcome: "cleared", calls: ["handoff", `clear:${ADDRESS}`] });
  });

  test("a current session is untouched: no handoff, no clear, online or offline", async () => {
    const { store } = memoryStore({ [KEY]: "2" });
    expect(await runGate({ store })).toEqual({ outcome: "current", calls: [] });
    expect(await runGate({ store, offline: true })).toEqual({ outcome: "current", calls: [] });
  });

  test("a failed handoff keeps the session: nothing is cleared", async () => {
    const { store } = memoryStore();
    expect(await runGate({ store, handoff: false })).toEqual({ outcome: "handoff_failed", calls: ["handoff"] });
  });

  test("a handoff that throws keeps the session and surfaces the error", async () => {
    const { store } = memoryStore();
    const calls: string[] = [];
    const result = applyManifestRevisionGate({
      store,
      address: ADDRESS,
      isOffline: () => false,
      handoff: async () => { throw new Error("handoff blew up"); },
      clearSession: (address) => { calls.push(`clear:${address}`); },
    });
    await expect(result).rejects.toThrow("handoff blew up");
    expect(calls).toEqual([]);
  });

  test("offline defers a stale session: no handoff, no clear, still stale", async () => {
    const { store } = memoryStore();
    expect(await runGate({ store, offline: true })).toEqual({ outcome: "deferred", calls: [] });
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
  });

  test("offline never clears, whatever the stored revision", async () => {
    for (const stored of [undefined, "0", "1", "", "garbage"]) {
      const { store } = memoryStore(stored === undefined ? {} : { [KEY]: stored });
      expect(await runGate({ store, offline: true })).toEqual({ outcome: "deferred", calls: [] });
    }
  });

  test("a deferred session is cleared on the first online load", async () => {
    const { store } = memoryStore();
    expect((await runGate({ store, offline: true })).outcome).toBe("deferred");
    expect(await runGate({ store })).toEqual({ outcome: "cleared", calls: ["handoff", `clear:${ADDRESS}`] });
  });

  test("unreadable storage on a stored session clears it once (handoff first)", async () => {
    expect(await runGate({ store: blockedStore })).toEqual({ outcome: "cleared", calls: ["handoff", `clear:${ADDRESS}`] });
    expect(await runGate({ store: null })).toEqual({ outcome: "cleared", calls: ["handoff", `clear:${ADDRESS}`] });
  });
});

describe("users without a stored session", () => {
  test("a signed-out user is unaffected: no handoff, no clear, no write", async () => {
    const { store, writes } = memoryStore();
    expect(await runGate({ store, address: null })).toEqual({ outcome: "current", calls: [] });
    expect(await runGate({ store, address: null, offline: true })).toEqual({ outcome: "current", calls: [] });
    expect(writes).toEqual([]);
  });

  test("a new user signs in under the new manifest and records \"2\": the next restore is left alone", async () => {
    const { store, data } = memoryStore();
    expect((await runGate({ store, address: null })).outcome).toBe("current");
    recordManifestRevision(store, ADDRESS);
    expect(data[KEY]).toBe("2");
    expect(await runGate({ store })).toEqual({ outcome: "current", calls: [] });
  });

  test("a forced re-sign asks once: cleared, sign-in records, the next restore is current", async () => {
    const { store } = memoryStore();
    expect((await runGate({ store })).outcome).toBe("cleared");
    // A sign-in that failed or was cancelled records nothing: the next restore still re-signs.
    expect(needsManifestResign(store, ADDRESS)).toBe(true);
    recordManifestRevision(store, ADDRESS);
    expect((await runGate({ store })).outcome).toBe("current");
  });
});

describe("notice", () => {
  test("the forced-re-sign line is Monica's final wording, verbatim", () => {
    expect(MANIFEST_RESIGN_NOTICE).toBe(
      "Exo needs you to sign in again to update what it can access. You'll do this once on each of your devices.",
    );
  });
});
