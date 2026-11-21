import { expect, test } from "bun:test";
import { restorePersistedSession } from "./sessionRestore";

// D2 (TC-2872): with the bearer lapsed, a verified renewal receipt carries the session, and a new bearer is issued
// from the lease-restored session only after its live read succeeds.

function lapsedBearer() {
  let cleared = false;
  return {
    hasSession: () => false,
    isExpired: () => true,
    getAddress: () => null,
    getToken: () => null,
    clear: () => {
      cleared = true;
    },
    wasCleared: () => cleared,
  };
}

function deps(calls: string[], bearer: () => Promise<void>, options: { reissue?: boolean; offline?: boolean } = {}) {
  return {
    loadManifest: async () => ({}),
    restore: async (address: string) => {
      calls.push(`restore:${address}`);
      return { status: "restored" as const, tcw: {} };
    },
    isOffline: () => options.offline ?? false,
    renewalVerification: {
      read: async () => { calls.push("read"); },
      signOut: async () => { calls.push("signOut"); },
      cleanup: () => { calls.push("cleanup"); },
      ...(options.reissue === false ? {} : { reissue: { address: "0xowner", bearer } }),
    },
  };
}

test("a lapsed bearer is reissued after the lease-restored session's live read, then the session is published", async () => {
  const calls: string[] = [];
  const outcome = await restorePersistedSession(lapsedBearer(), deps(calls, async () => { calls.push("bearer"); }));
  expect(outcome).toMatchObject({ kind: "restored", address: "0xowner" });
  expect(calls).toEqual(["restore:0xowner", "read", "bearer"]);
});

test("a lapsed bearer without a receipt to carry it signs out without restoring", async () => {
  const calls: string[] = [];
  const outcome = await restorePersistedSession(lapsedBearer(), deps(calls, async () => {}, { reissue: false }));
  expect(outcome.kind).toBe("signedOut");
  expect(calls).toEqual([]);
});

for (const status of [401, 403]) {
  test(`a reissue the backend refuses with ${status} signs the restored session out`, async () => {
    const calls: string[] = [];
    const store = lapsedBearer();
    const outcome = await restorePersistedSession(store, deps(calls, async () => {
      throw Object.assign(new Error("refused"), { status });
    }));
    expect(outcome.kind).toBe("signedOut");
    expect(calls).toEqual(["restore:0xowner", "read", "signOut"]);
    expect(store.wasCleared()).toBe(true);
  });
}

test("a reissue that cannot reach the backend publishes nothing and keeps the saved session", async () => {
  const calls: string[] = [];
  const store = lapsedBearer();
  const outcome = await restorePersistedSession(store, deps(calls, async () => {
    throw new TypeError("Failed to fetch");
  }, { offline: true }));
  expect(outcome.kind).toBe("unavailable");
  expect(calls).toEqual(["restore:0xowner", "read", "cleanup"]);
  expect(store.wasCleared()).toBe(false);
});

test("a live bearer is not reissued", async () => {
  const calls: string[] = [];
  const store = { ...lapsedBearer(), hasSession: () => true, isExpired: () => false, getAddress: () => "0xowner", getToken: () => "token" };
  const outcome = await restorePersistedSession(store, deps(calls, async () => { calls.push("bearer"); }));
  expect(outcome.kind).toBe("restored");
  expect(calls).toEqual(["restore:0xowner", "read"]);
});
