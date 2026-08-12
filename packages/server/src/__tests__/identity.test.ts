import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  KvResultError,
  assertKvResult,
  isKvMissingKeyResult,
  validateBackendPrefix,
  withSessionRefresh,
} from "../identity.js";

function createMockNode() {
  return {
    signIn: mock(() => Promise.resolve()),
  };
}

describe("withSessionRefresh", () => {
  let mockNode: ReturnType<typeof createMockNode>;

  beforeEach(() => {
    mockNode = createMockNode();
  });

  test("returns the function result on success", async () => {
    const result = await withSessionRefresh(mockNode as any, () =>
      Promise.resolve("ok"),
    );
    expect(result).toBe("ok");
    expect(mockNode.signIn).not.toHaveBeenCalled();
  });

  test("retries once after session-related error", async () => {
    let callCount = 0;
    const fn = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("session expired"));
      }
      return Promise.resolve("recovered");
    });

    const result = await withSessionRefresh(mockNode as any, fn);

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockNode.signIn).toHaveBeenCalledTimes(1);
  });

  test("re-throws non-session errors without retrying", async () => {
    const fn = mock(() => Promise.reject(new Error("network timeout")));

    await expect(withSessionRefresh(mockNode as any, fn)).rejects.toThrow(
      "network timeout",
    );

    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockNode.signIn).not.toHaveBeenCalled();
  });

  test("calls node.signIn() before retry", async () => {
    const callOrder: string[] = [];

    mockNode.signIn = mock(() => {
      callOrder.push("signIn");
      return Promise.resolve();
    });

    let callCount = 0;
    const fn = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("401 Unauthorized"));
      }
      callOrder.push("fn-retry");
      return Promise.resolve("done");
    });

    await withSessionRefresh(mockNode as any, fn);

    expect(callOrder).toEqual(["signIn", "fn-retry"]);
  });

  describe("session error detection", () => {
    const sessionErrorMessages = [
      "session expired",
      "invalid session token",
      "expired credentials",
      "401 Not Authorized",
      "Unauthorized access",
      "unauthorized request",
    ];

    for (const msg of sessionErrorMessages) {
      test(`retries on error: "${msg}"`, async () => {
        let callCount = 0;
        const fn = mock(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error(msg));
          }
          return Promise.resolve("ok");
        });

        const result = await withSessionRefresh(mockNode as any, fn);
        expect(result).toBe("ok");
        expect(mockNode.signIn).toHaveBeenCalledTimes(1);
      });
    }
  });

  test("does not retry on generic errors", async () => {
    const nonSessionErrors = [
      "not found",
      "internal server error",
      "rate limited",
      "ECONNREFUSED",
    ];

    for (const msg of nonSessionErrors) {
      const node = createMockNode();
      const fn = mock(() => Promise.reject(new Error(msg)));

      await expect(withSessionRefresh(node as any, fn)).rejects.toThrow(msg);
      expect(node.signIn).not.toHaveBeenCalled();
    }
  });

  describe("false positive rejection", () => {
    const falsePositives = [
      "Failed to update session preferences for user 401-smith",
      "session preferences not found",
      "session config invalid",
      "subscription expired",
    ];

    for (const msg of falsePositives) {
      test(`does NOT retry on: "${msg}"`, async () => {
        const node = createMockNode();
        const fn = mock(() => Promise.reject(new Error(msg)));

        await expect(withSessionRefresh(node as any, fn)).rejects.toThrow();
        expect(node.signIn).not.toHaveBeenCalled();
      });
    }
  });
});

describe("assertKvResult", () => {
  test("passes through a legacy void resolution unchanged", () => {
    expect(assertKvResult(undefined)).toBeUndefined();
    expect(assertKvResult(null)).toBeNull();
  });

  test("passes through a { ok: true } Result unchanged", () => {
    const value = { ok: true, data: { hello: "world" } };
    expect(assertKvResult(value)).toBe(value);
  });

  test("passes through a legacy { data } shape unchanged (no ok discriminator)", () => {
    const value = { data: { hello: "world" } };
    expect(assertKvResult(value)).toBe(value);
  });

  test("throws a typed redacted error for every explicit ok:false shape", () => {
    const arbitraryMessages = [
      "kv unreachable",
      new Error("write conflict"),
      undefined,
    ];

    for (const error of arbitraryMessages) {
      let caught: unknown;
      try {
        assertKvResult({ ok: false, error });
      } catch (thrown) {
        caught = thrown;
      }

      expect(caught).toBeInstanceOf(KvResultError);
      expect((caught as Error).message).toBe("KV operation failed");
      expect((caught as Error).message).not.toContain("kv unreachable");
      expect((caught as Error).message).not.toContain("write conflict");
    }
  });

  test("throws a typed structured error without exposing the service message", () => {
    const sensitive = "delegation=AUTHZ_BYTES payload=PRIVATE";
    let caught: unknown;

    try {
      assertKvResult({
        ok: false,
        error: {
          code: "NETWORK_ERROR",
          message: sensitive,
          service: "kv",
          meta: { status: 503, requestId: "PRIVATE_REQUEST_ID" },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KvResultError);
    expect(caught).toMatchObject({ code: "NETWORK_ERROR", status: 503 });
    expect((caught as KvResultError).code).toBe("NETWORK_ERROR");
    expect((caught as KvResultError).status).toBe(503);
    expect((caught as Error).message).toContain("NETWORK_ERROR");
    expect((caught as Error).message).toContain("503");
    expect((caught as Error).message).not.toContain(sensitive);
    expect((caught as Error).message).not.toContain("PRIVATE_REQUEST_ID");
  });

  test("omits unsafe code and status values from the public message and structure", () => {
    let caught: unknown;

    try {
      assertKvResult({
        ok: false,
        error: {
          code: "BAD CODE: delegation=PRIVATE",
          message: "AUTHZ_BYTES",
          service: "kv",
          meta: { status: "401 PRIVATE", requestId: "PRIVATE_REQUEST_ID" },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(KvResultError);
    expect(caught).toMatchObject({ code: undefined, status: undefined });
    expect((caught as Error).message).toBe("KV operation failed");
  });

  test("retries exactly once for each exact structured session code", async () => {
    const failures = [
      {
        code: "AUTH_REQUIRED",
        message: "Authentication required. Please sign in first.",
      },
      {
        code: "AUTH_EXPIRED",
        message: "Session has expired. Please sign in again.",
      },
      {
        code: "AUTH_UNAUTHORIZED",
        message: "Request is not authorized for this session.",
      },
    ];

    for (const failure of failures) {
      const node = createMockNode();
      let calls = 0;
      const fn = mock(async () => {
        calls += 1;
        if (calls === 1) {
          return assertKvResult({
            ok: false,
            error: { ...failure, service: "kv" },
          });
        }
        return { ok: true as const, data: failure.code };
      });

      await expect(withSessionRefresh(node as any, fn)).resolves.toEqual({
        ok: true,
        data: failure.code,
      });
      expect(fn).toHaveBeenCalledTimes(2);
      expect(node.signIn).toHaveBeenCalledTimes(1);
    }
  });

  test("retries exactly once for structured status 401", async () => {
    const node = createMockNode();
    let calls = 0;
    const fn = mock(async () => {
      calls += 1;
      if (calls === 1) {
        return assertKvResult({
          ok: false,
          error: {
            code: "NETWORK_ERROR",
            message: "message deliberately contains no session hint",
            service: "kv",
            meta: { status: 401 },
          },
        });
      }
      return { ok: true as const, data: "recovered" };
    });

    await expect(withSessionRefresh(node as any, fn)).resolves.toEqual({
      ok: true,
      data: "recovered",
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(node.signIn).toHaveBeenCalledTimes(1);
  });

  test("does not retry structured failures with session-like messages or non-exact codes", async () => {
    const failures = [
      {
        code: "NETWORK_ERROR",
        message: "Unauthorized request",
      },
      {
        code: "UNAUTHORIZED",
        message: "No session hint in the service message",
      },
    ];

    for (const failure of failures) {
      const node = createMockNode();
      const fn = mock(async () =>
        assertKvResult({
          ok: false,
          error: { ...failure, service: "kv" },
        }),
      );

      await expect(withSessionRefresh(node as any, fn)).rejects.toMatchObject({
        code: failure.code,
      });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(node.signIn).not.toHaveBeenCalled();
    }
  });

  test("a repeated structured session failure refreshes and retries exactly once", async () => {
    const node = createMockNode();
    const fn = mock(async () =>
      assertKvResult({
        ok: false,
        error: {
          code: "AUTH_EXPIRED",
          message: "Session has expired. Please sign in again.",
          service: "kv",
        },
      }),
    );

    await expect(withSessionRefresh(node as any, fn)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
    });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(node.signIn).toHaveBeenCalledTimes(1);
  });
});

describe("isKvMissingKeyResult", () => {
  const key = "webhooks/config/0xabc";

  test("accepts only the production key-missing Result for the exact requested key", () => {
    expect(
      isKvMissingKeyResult(
        {
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: `Key not found: ${key}`,
            service: "kv",
          },
        },
        key,
      ),
    ).toBe(true);

    expect(
      isKvMissingKeyResult(
        {
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: "Key not found: webhooks/config/a-different-key",
            service: "kv",
          },
        },
        key,
      ),
    ).toBe(false);
  });

  test("rejects Space-not-found even when it shares KV_NOT_FOUND and status 404", () => {
    expect(
      isKvMissingKeyResult(
        {
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: "KV 404 - Space not found",
            service: "kv",
            meta: { status: 404 },
          },
        },
        key,
      ),
    ).toBe(false);
  });
});

describe("validateBackendPrefix", () => {
  test("returns a slash- and backslash-free backend operational prefix", () => {
    expect(validateBackendPrefix("ops.auditprefix.backend")).toBe(
      "ops.auditprefix.backend",
    );
  });

  test("requires an explicit backend operational prefix", () => {
    expect(() => validateBackendPrefix(undefined)).toThrow(
      "requires an explicit prefix",
    );
    expect(() => validateBackendPrefix("")).toThrow(
      "requires an explicit prefix",
    );
  });

  test("rejects prefixes with slashes or backslashes", () => {
    expect(() => validateBackendPrefix("xyz.tinycloud.notes/backend")).toThrow(
      "must be slash- and backslash-free",
    );
    expect(() => validateBackendPrefix("xyz.tinycloud.notes\\backend")).toThrow(
      "must be slash- and backslash-free",
    );
  });
});
