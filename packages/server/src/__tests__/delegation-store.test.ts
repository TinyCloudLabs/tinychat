import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  DelegationStore,
  type DelegationMetadata,
} from "../delegation-store.js";

interface StoredDelegation {
  serialized: string;
  grantedAt: string;
  expiresAt: string;
  actions: string[];
  path: string;
  delegateDid?: string;
}

function createMockNode() {
  return {
    kv: {
      get: mock(() => Promise.resolve({ data: null })),
      put: mock(() => Promise.resolve()),
      delete: mock(() => Promise.resolve()),
    },
    signIn: mock(() => Promise.resolve()),
  };
}

function makeDelegation(
  overrides?: Partial<StoredDelegation>,
): StoredDelegation {
  return {
    serialized: "base64-encoded-delegation",
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-12-31T23:59:59.000Z",
    actions: ["kv/read", "kv/write"],
    path: "/app/data",
    ...overrides,
  };
}

function makeMetadata(
  overrides?: Partial<DelegationMetadata>,
): DelegationMetadata {
  return {
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-12-31T23:59:59.000Z",
    actions: ["kv/read", "kv/write"],
    path: "/app/data",
    ...overrides,
  };
}

describe("DelegationStore", () => {
  let mockNode: ReturnType<typeof createMockNode>;
  let store: DelegationStore;

  beforeEach(() => {
    mockNode = createMockNode();
    store = new DelegationStore(mockNode as any);
  });

  describe("store", () => {
    test("calls kv.put with correct key and JSON payload", async () => {
      const metadata = makeMetadata();

      await store.store("0xAbC123", "serialized-data", metadata);

      expect(mockNode.kv.put).toHaveBeenCalledTimes(1);
      const [key, value] = mockNode.kv.put.mock.calls[0];
      expect(key).toBe("delegations/0xAbC123");

      // Value is passed as object (SDK handles serialization)
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      expect(parsed.serialized).toBe("serialized-data");
      expect(parsed.grantedAt).toBe(metadata.grantedAt);
      expect(parsed.expiresAt).toBe(metadata.expiresAt);
      expect(parsed.actions).toEqual(metadata.actions);
      expect(parsed.path).toBe(metadata.path);
    });

    test("uses current timestamp when grantedAt is omitted", async () => {
      const metadata = makeMetadata();
      delete (metadata as any).grantedAt;

      const before = new Date().toISOString();
      await store.store("0xABC", "data", metadata);
      const after = new Date().toISOString();

      const [, value] = mockNode.kv.put.mock.calls[0];
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      expect(parsed.grantedAt >= before).toBe(true);
      expect(parsed.grantedAt <= after).toBe(true);
    });

    test("persists policy delegatee metadata", async () => {
      const metadata = {
        ...makeMetadata({
          policyHash: "policy-a",
          resources: [
            {
              service: "tinycloud.kv",
              path: "xyz.tinycloud.app/probe/",
              actions: ["get"],
            },
          ],
        }),
        delegateDid: "did:key:z6MkBackend",
      };

      await store.store("0xABC", "data", metadata);

      const [, value] = mockNode.kv.put.mock.calls[0];
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      expect(parsed.policyHash).toBe("policy-a");
      expect(parsed.delegateDid).toBe("did:key:z6MkBackend");
      expect(parsed.resources).toEqual(metadata.resources);
    });
  });

  describe("load", () => {
    test("calls kv.get and parses the result", async () => {
      const delegation = makeDelegation();
      mockNode.kv.get = mock(() =>
        Promise.resolve({ data: JSON.stringify(delegation) }),
      );

      const result = await store.load("0xAbC123");

      expect(mockNode.kv.get).toHaveBeenCalledTimes(1);
      const [key] = mockNode.kv.get.mock.calls[0];
      expect(key).toBe("delegations/0xAbC123");

      expect(result).toEqual(delegation);
    });

    test("returns null when kv.get returns no data", async () => {
      mockNode.kv.get = mock(() => Promise.resolve({ data: null }));

      const result = await store.load("0xABC");
      expect(result).toBeNull();
    });

    test("returns null when kv.get returns undefined data", async () => {
      mockNode.kv.get = mock(() => Promise.resolve({}));

      const result = await store.load("0xABC");
      expect(result).toBeNull();
    });

    test("returns null on corrupted data", async () => {
      mockNode.kv.get = mock(() =>
        Promise.resolve({ data: "not-valid-json{{{" }),
      );

      const result = await store.load("0xABC");
      expect(result).toBeNull();
    });

    test("returns null when parsed data has missing required fields", async () => {
      mockNode.kv.get = mock(() =>
        Promise.resolve({ data: JSON.stringify({ serialized: "ok" }) }),
      );

      const result = await store.load("0xABC");
      expect(result).toBeNull();
    });

    test("returns null when parsed data has wrong field types", async () => {
      mockNode.kv.get = mock(() =>
        Promise.resolve({
          data: JSON.stringify({
            serialized: 123,
            expiresAt: "2026-12-31",
            actions: [],
          }),
        }),
      );

      const result = await store.load("0xABC");
      expect(result).toBeNull();
    });
  });

  describe("remove", () => {
    test("calls kv.delete with correct key", async () => {
      await store.remove("0xAbC123");

      expect(mockNode.kv.delete).toHaveBeenCalledTimes(1);
      const [key] = mockNode.kv.delete.mock.calls[0];
      expect(key).toBe("delegations/0xAbC123");
    });
  });

  describe("isActive", () => {
    test("returns true for non-expired delegation", async () => {
      const futureDate = new Date(Date.now() + 3600_000).toISOString();
      const delegation = makeDelegation({ expiresAt: futureDate });
      mockNode.kv.get = mock(() =>
        Promise.resolve({ data: JSON.stringify(delegation) }),
      );

      expect(await store.isActive("0xABC")).toBe(true);
    });

    test("returns false for expired delegation", async () => {
      const pastDate = new Date(Date.now() - 3600_000).toISOString();
      const delegation = makeDelegation({ expiresAt: pastDate });
      mockNode.kv.get = mock(() =>
        Promise.resolve({ data: JSON.stringify(delegation) }),
      );

      expect(await store.isActive("0xABC")).toBe(false);
    });

    test("returns false when no delegation exists", async () => {
      mockNode.kv.get = mock(() => Promise.resolve({ data: null }));

      expect(await store.isActive("0xABC")).toBe(false);
    });
  });

  describe("key format", () => {
    test("keys preserve case (sub values are case-sensitive)", async () => {
      await store.store("UserABC123", "data", makeMetadata());
      const [key] = mockNode.kv.put.mock.calls[0];
      expect(key).toBe("delegations/UserABC123");
    });

    test("keys are prefixed with delegations/", async () => {
      await store.load("my-sub-id");
      const [key] = mockNode.kv.get.mock.calls[0];
      expect(key).toBe("delegations/my-sub-id");
    });
  });

  // ── KV Result failure contract ────────────────────────────────────
  // The SDK's kv.put/get/delete now resolve to a Result: `{ ok: true, data }` on success and
  // `{ ok: false, error }` on durable failure — the promise no longer rejects. Silently accepting
  // `{ ok: false }` would report "stored" while the write never landed. Persistence and removal
  // must surface a redacted actionable error; and if the Result carries a session-class error, the
  // existing withSessionRefresh callback must still take the sign-in-and-retry path.
  describe("kv Result failure contract", () => {
    test("store throws a redacted error when kv.put resolves { ok: false }", async () => {
      mockNode.kv.put = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "NETWORK_ERROR",
            message: "kv unreachable PRIVATE",
            service: "kv",
          },
        }),
      );

      await expect(
        store.store("0xABC", "data", makeMetadata()),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    });

    test("remove throws a redacted error when kv.delete resolves { ok: false }", async () => {
      mockNode.kv.delete = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "NETWORK_ERROR",
            message: "kv unreachable PRIVATE",
            service: "kv",
          },
        }),
      );

      await expect(store.remove("0xABC")).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
    });

    test("load throws when kv.get resolves { ok: false } (does not swallow as 'no delegation')", async () => {
      mockNode.kv.get = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "NETWORK_ERROR",
            message: "kv unreachable PRIVATE",
            service: "kv",
          },
        }),
      );

      await expect(store.load("0xABC")).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
    });

    test("store still passes when kv.put resolves { ok: true }", async () => {
      mockNode.kv.put = mock(() => Promise.resolve({ ok: true }));

      await expect(
        store.store("0xABC", "data", makeMetadata()),
      ).resolves.toBeUndefined();
      expect(mockNode.kv.put).toHaveBeenCalledTimes(1);
    });

    test("legacy plain-resolve fake still works (backwards compatible)", async () => {
      // Real SDK tests and existing fakes resolve to `undefined` / `{ data: null }`; those must
      // stay passing so this hardening is purely additive on the failure edge.
      mockNode.kv.put = mock(() => Promise.resolve());
      mockNode.kv.delete = mock(() => Promise.resolve());

      await expect(
        store.store("0xABC", "data", makeMetadata()),
      ).resolves.toBeUndefined();
      await expect(store.remove("0xABC")).resolves.toBeUndefined();
    });

    test("session-class Result failure inside store() takes the sign-in-and-retry path", async () => {
      // The assertion has to live inside the withSessionRefresh callback so that a structured
      // session failure is re-authenticated once and retried.
      let calls = 0;
      mockNode.kv.put = mock(() => {
        calls += 1;
        if (calls === 1)
          return Promise.resolve({
            ok: false,
            error: {
              code: "AUTH_EXPIRED",
              message: "Session has expired. Please sign in again.",
              service: "kv",
            },
          });
        return Promise.resolve({ ok: true });
      });

      await store.store("0xABC", "data", makeMetadata());

      expect(mockNode.signIn).toHaveBeenCalledTimes(1);
      expect(mockNode.kv.put).toHaveBeenCalledTimes(2);
    });

    test("non-session Result failure is NOT retried (preserves single-refresh semantics)", async () => {
      // withSessionRefresh only retries session-class errors. A generic KV failure must surface
      // immediately without a spurious signIn().
      mockNode.kv.put = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "internal server error PRIVATE",
            service: "kv",
          },
        }),
      );

      await expect(
        store.store("0xABC", "data", makeMetadata()),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(mockNode.signIn).not.toHaveBeenCalled();
      expect(mockNode.kv.put).toHaveBeenCalledTimes(1);
    });

    test("redacted error surfaces without leaking the delegation payload", async () => {
      // Neither the stored capability nor the SDK's arbitrary ServiceError.message is public.
      const sensitive = "AUTHZ_BEARER_MATERIAL_" + "z".repeat(40);
      mockNode.kv.put = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "WRITE_REJECTED",
            message: "kv rejected: request too large PRIVATE_MESSAGE",
            service: "kv",
          },
        }),
      );

      let caught: Error | null = null;
      try {
        await store.store("0xABC", sensitive, makeMetadata());
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).not.toContain(sensitive);
      expect(caught!.message).not.toContain("PRIVATE_MESSAGE");
      expect(caught!.message).toContain("WRITE_REJECTED");
    });

    test("load treats the exact structured missing-key Result as no delegation", async () => {
      const key = "delegations/0xABC";
      mockNode.kv.get = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: `Key not found: ${key}`,
            service: "kv",
          },
        }),
      );

      await expect(store.load("0xABC")).resolves.toBeNull();
      expect(mockNode.signIn).not.toHaveBeenCalled();
    });

    test("remove treats the exact structured missing-key Result as idempotent success", async () => {
      const key = "delegations/0xABC";
      mockNode.kv.delete = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: `Key not found: ${key}`,
            service: "kv",
          },
        }),
      );

      await expect(store.remove("0xABC")).resolves.toBeUndefined();
      expect(mockNode.kv.delete).toHaveBeenCalledTimes(1);
      expect(mockNode.signIn).not.toHaveBeenCalled();
    });

    test("load fails closed on Space-not-found despite the shared KV_NOT_FOUND code", async () => {
      mockNode.kv.get = mock(() =>
        Promise.resolve({
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: "KV 404 - Space not found",
            service: "kv",
            meta: { status: 404 },
          },
        }),
      );

      await expect(store.load("0xABC")).rejects.toMatchObject({
        code: "KV_NOT_FOUND",
      });
      expect(mockNode.signIn).not.toHaveBeenCalled();
    });

    test("remove fails closed on Space-not-found without reporting a false deletion", async () => {
      const key = "delegations/0xABC";
      const durable = new Map([[key, makeDelegation()]]);
      mockNode.kv.delete = mock(async () => {
        return {
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: "KV 404 - Space not found",
            service: "kv",
            meta: { status: 404 },
          },
        };
      });

      await expect(store.remove("0xABC")).rejects.toMatchObject({
        code: "KV_NOT_FOUND",
      });
      expect(durable.has(key)).toBe(true);
      expect(mockNode.kv.delete).toHaveBeenCalledTimes(1);
      expect(mockNode.signIn).not.toHaveBeenCalled();
    });
  });
});
