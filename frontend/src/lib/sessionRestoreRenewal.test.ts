import { expect, test } from "bun:test";
import { restorePersistedSession } from "./sessionRestore";

function session() {
  let active = true;
  return {
    hasSession: () => active,
    isExpired: () => false,
    getAddress: () => "owner",
    getToken: () => "token",
    clear: () => {
      active = false;
    },
  };
}

for (const status of [401, 403]) {
  test(`explicit lease bootstrap signs out on first-read ${status} before publishing`, async () => {
    const store = session();
    const calls: string[] = [];
    const outcome = await restorePersistedSession(store, {
      loadManifest: async () => ({}),
      restore: async () => ({ status: "restored", tcw: {} }),
      isOffline: () => false,
      renewalVerification: {
        read: async () => {
          calls.push("read");
          throw { meta: { status } };
        },
        signOut: async () => {
          calls.push("signOut");
        },
        cleanup: () => {
          calls.push("cleanup");
        },
      },
    });
    expect(outcome.kind).toBe("signedOut");
    expect(store.hasSession()).toBe(false);
    expect(calls).toEqual(["read", "signOut"]);
  });
}

test("explicit lease bootstrap does not publish or clear credentials on an unavailable read", async () => {
  const store = session();
  let cleaned = false;
  const outcome = await restorePersistedSession(store, {
    loadManifest: async () => ({}),
    restore: async () => ({ status: "restored", tcw: {} }),
    isOffline: () => true,
    renewalVerification: {
      read: async () => {
        throw new TypeError("Failed to fetch");
      },
      signOut: async () => {
        throw new Error("unexpected signOut");
      },
      cleanup: () => {
        cleaned = true;
      },
    },
  });
  expect(outcome.kind).toBe("unavailable");
  expect(store.hasSession()).toBe(true);
  expect(cleaned).toBe(true);
});

test("explicit lease bootstrap publishes only after one successful live read", async () => {
  const store = session();
  let reads = 0;
  const outcome = await restorePersistedSession(store, {
    loadManifest: async () => ({}),
    restore: async () => ({ status: "restored", tcw: {} }),
    isOffline: () => false,
    renewalVerification: {
      read: async () => {
        reads++;
      },
      signOut: async () => {},
      cleanup: () => {},
    },
  });
  expect(outcome.kind).toBe("restored");
  expect(reads).toBe(1);
});
