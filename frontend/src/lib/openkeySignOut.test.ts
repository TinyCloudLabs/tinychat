import { describe, expect, spyOn, test } from "bun:test";
import {
  signOutOpenKeySession,
  type OpenKeySignOutClient,
} from "./openkeySignOut";

describe("signOutOpenKeySession", () => {
  test("uses the client that authenticated the current page", async () => {
    const calls: string[] = [];
    const current: OpenKeySignOutClient = {
      async signOut() {
        calls.push("current");
        return { requestId: "current-request", revoked: true };
      },
    };

    const result = await signOutOpenKeySession(current, () => {
      calls.push("fallback-created");
      throw new Error("fallback must stay lazy");
    });

    expect(result).toEqual({ status: "revoked" });
    expect(calls).toEqual(["current"]);
  });

  test("creates a client for a restored TinyChat session", async () => {
    const calls: string[] = [];

    const result = await signOutOpenKeySession(null, () => {
      calls.push("fallback-created");
      return {
        async signOut() {
          calls.push("fallback-sign-out");
          return { requestId: "restored-request", revoked: false };
        },
      };
    });

    expect(result).toEqual({ status: "unverified" });
    expect(calls).toEqual(["fallback-created", "fallback-sign-out"]);
  });

  test("recognizes the SDK's plain-object cancellation", async () => {
    const current: OpenKeySignOutClient = {
      async signOut() {
        throw { code: "USER_CANCELLED", message: "User cancelled sign-out" };
      },
    };

    await expect(
      signOutOpenKeySession(current, () => current),
    ).resolves.toEqual({
      status: "cancelled",
    });
  });

  test("reports a non-cancel widget failure without blocking local logout", async () => {
    const current: OpenKeySignOutClient = {
      async signOut() {
        throw { code: "TIMEOUT", message: "OpenKey timed out" };
      },
    };

    await expect(
      signOutOpenKeySession(current, () => current),
    ).resolves.toEqual({
      status: "unverified",
    });
  });

  test("embedded WebView popup-unavailable is its own outcome and is logged", async () => {
    const current: OpenKeySignOutClient = {
      async signOut() {
        throw { code: "POPUP_BLOCKED", reason: "embedded-webview",
          message: "Popups are not available in this embedded app WebView" };
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(signOutOpenKeySession(current, () => current))
        .resolves.toEqual({ status: "remote-unavailable" });
      expect(warn.mock.calls).toHaveLength(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("POPUP_BLOCKED");
    } finally {
      warn.mockRestore();
    }
  });

  describe("revoked: false", () => {
    test("is unverified however the session was obtained: the widget cannot say there was nothing to revoke", async () => {
      const unrevoked: OpenKeySignOutClient = { signOut: async () => ({ requestId: "r", revoked: false }) };
      await expect(signOutOpenKeySession(unrevoked, () => unrevoked)).resolves.toEqual({ status: "unverified" });
      await expect(signOutOpenKeySession(null, () => unrevoked)).resolves.toEqual({ status: "unverified" });
    });

    test("a thrown failure is unverified and logged once through the redacting logger", async () => {
      const failing: OpenKeySignOutClient = { signOut: async () => { throw new Error("offline, token=tok-secret"); } };
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await expect(signOutOpenKeySession(failing, () => failing)).resolves.toEqual({ status: "unverified" });
        expect(warn.mock.calls).toEqual([["[OpenKey native] OpenKey sign-out: Error message=offline, token=[redacted]"]]);
      } finally {
        warn.mockRestore();
      }
    });

    test("an acknowledged revocation is revoked", async () => {
      const ok: OpenKeySignOutClient = { signOut: async () => ({ requestId: "r", revoked: true }) };
      await expect(signOutOpenKeySession(ok, () => ok)).resolves.toEqual({ status: "revoked" });
    });
  });

  test("a never-resolving widget settles as unverified at its deadline", async () => {
    const current: OpenKeySignOutClient = { signOut: async () => new Promise(() => {}) };
    await expect(signOutOpenKeySession(current, () => current, 1))
      .resolves.toEqual({ status: "unverified" });
  });

  test("a raw sign-out failure never reaches the UI copy and is logged only through the redacting logger", async () => {
    const secret = "HTTP 500 at https://internal.invalid/revoke?token=tok-secret";
    const failures: unknown[] = [
      new Error(secret),
      { code: "SERVER_ERROR", message: secret },
      { message: secret },
      secret,
    ];
    const sinks = (["log", "warn", "error"] as const).map((name) => spyOn(console, name).mockImplementation(() => undefined));
    try {
      for (const failure of failures) {
        const current: OpenKeySignOutClient = { signOut: async () => { throw failure; } };
        const outcome = await signOutOpenKeySession(current, () => current);
        expect(JSON.stringify(outcome)).not.toContain("internal.invalid");
        expect(JSON.stringify(outcome)).not.toContain("tok-secret");
      }
      const [log, warn, error] = sinks;
      expect(log.mock.calls).toEqual([]);
      expect(error.mock.calls).toEqual([]);
      // Only the redacting logger writes, as one string — never an error object or its cause chain.
      expect(warn.mock.calls).toHaveLength(failures.length);
      for (const call of warn.mock.calls) {
        expect(call).toHaveLength(1);
        expect(typeof call[0]).toBe("string");
        expect(call[0]).toStartWith("[OpenKey native] OpenKey sign-out: ");
      }
    } finally {
      sinks.forEach((sink) => sink.mockRestore());
    }
  });
});
