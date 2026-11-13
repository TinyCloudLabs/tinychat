import { afterEach, expect, mock, test } from "bun:test";

const calls: unknown[][] = [];
let lastConfig: any;
let afterSdkFenceRead: (() => void) | undefined;
afterEach(() => { afterSdkFenceRead = undefined; });
let result = { status: "restored", session: {} };
mock.module("@tinycloud/web-sdk", () => ({
  serializeDelegation: (delegation: any) => delegation.serialized ?? "serialized-delegation",
  BrowserSessionStorage: class {},
  TinyCloudWeb: class {
    constructor(private config: any) { lastConfig = config; }
    get spaceId() { return undefined; }
    cleanup() { calls.push(["cleanup"]); }
    async restoreSession(address: string) {
      calls.push(["ordinary", address]);
      const loaded = await this.config.sessionStorage.loadWithStatus(address);
      if (this.config.sessionStorage.isSignedOut?.(address, loaded.data?.signature)) return { status: "missing" };
      afterSdkFenceRead?.();
      return result;
    }
    async restoreSessionWithRenewal(lease: string, address: string) {
      calls.push(["renewal", lease, address]);
      const loaded = await this.config.sessionStorage.loadRenewalCandidate(address);
      if (this.config.sessionStorage.isSignedOut?.(address, loaded.data?.signature)) return { status: "missing" };
      afterSdkFenceRead?.();
      return result;
    }
  },
}));
const { createTinyCloudWeb, restoreTinyCloudWebSession } = await import("../tinycloud.js?renewal");
const storage = {
  loadWithStatus: async () => ({ status: "loaded", data: { tinycloudSession: { spaceId: "ordinary-space" } } }),
  loadRenewalCandidate: async () => ({ status: "loaded", data: { tinycloudSession: { spaceId: "renewal-space" } } }),
} as any;

test("ordinary restore retains its storage path", async () => {
  calls.length = 0;
  const restored = await restoreTinyCloudWebSession("alice", { sessionStorage: storage });
  expect(calls).toEqual([["ordinary", "alice"]]);
  expect(restored.tcw?.spaceId).toBe("ordinary-space");
});

test("explicit lease reaches SDK verification with the selected account and candidate", async () => {
  calls.length = 0;
  const restored = await restoreTinyCloudWebSession("bob", { sessionStorage: storage, renewalLeaseAuthorization: "owner-signed-lease" });
  expect(calls).toEqual([["renewal", "owner-signed-lease", "bob"]]);
  expect(restored.tcw?.spaceId).toBe("renewal-space");
});

test("SDK refusal returns no client and never falls back to ordinary restore", async () => {
  calls.length = 0;
  result = { status: "restore-failed", session: {} };
  const restored = await restoreTinyCloudWebSession("alice", { sessionStorage: storage, renewalLeaseAuthorization: "invalid" });
  expect(restored.tcw).toBeNull();
  expect(restored.status).toBe("restore-failed");
  expect(calls).toEqual([["renewal", "invalid", "alice"], ["cleanup"]]);
});


test("fresh sign-in forwards the selected bootstrap host or explicit refusal", () => {
  createTinyCloudWeb({} as any, { newUserHost: "http://127.0.0.1:1234" });
  expect(lastConfig.newUserHost).toBe("http://127.0.0.1:1234");
  createTinyCloudWeb({} as any, { newUserHost: null });
  expect(lastConfig.newUserHost).toBeNull();
  createTinyCloudWeb({} as any);
  expect(lastConfig.newUserHost).toBeUndefined();
});

test("restore disables new-user bootstrap even when a caller supplies one", async () => {
  await restoreTinyCloudWebSession("alice", { sessionStorage: storage, newUserHost: "http://127.0.0.1:1234" });
  expect(lastConfig.newUserHost).toBeNull();
});


test("captures an expired renewal candidate without replacing its space", async () => {
  result = { status: "restored", session: {} };
  const candidateStorage = {
    loadRenewalCandidate: async () => ({ status: "renewal-candidate", data: { signature: "signed", tinycloudSession: { spaceId: "candidate-space" } } }),
  } as any;
  const restored = await restoreTinyCloudWebSession("alice", { sessionStorage: candidateStorage, renewalLeaseAuthorization: "owner-signed-lease" });
  expect(restored.tcw?.spaceId).toBe("candidate-space");
});

for (const lease of [undefined, "owner-signed-lease"]) {
  test(`rechecks the captured session fence before returning with lease ${lease !== undefined}`, async () => {
    calls.length = 0;
    result = { status: "restored", session: {} };
    let signedOut = false;
    const load = async () => {
      return { status: lease ? "renewal-candidate" : "loaded", data: { signature: "signed", tinycloudSession: { spaceId: "space" } } };
    };
    afterSdkFenceRead = () => { signedOut = true; };
    const fencedStorage = {
      loadWithStatus: load,
      loadRenewalCandidate: load,
      isSignedOut: (address: string, signature: string) => signedOut && address === "alice" && signature === "signed",
    } as any;
    const restored = await restoreTinyCloudWebSession("alice", { sessionStorage: fencedStorage, renewalLeaseAuthorization: lease });
    expect(restored.tcw).toBeNull();
    expect(restored.status).toBe("missing");
    expect(calls.at(-1)).toEqual(["cleanup"]);
  });
}
