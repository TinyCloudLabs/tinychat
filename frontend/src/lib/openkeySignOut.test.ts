import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  signOutOpenKeySession,
  type OpenKeySignOutClient,
} from "./openkeySignOut";
import { AccountStateTimeout, withCaptureDeadline } from "./voiceNotes/accountHandoff";

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

  test("embedded WebView popup-unavailable rejects promptly and leaves remote sign-out warning to the app", async () => {
    const current: OpenKeySignOutClient = {
      async signOut() {
        throw { code: "POPUP_BLOCKED", reason: "embedded-webview",
          message: "Popups are not available in this embedded app WebView" };
      },
    };
    await expect(signOutOpenKeySession(current, () => current))
      .resolves.toEqual({ status: "remote-unavailable" });
  });

  test("a sign-out widget that never acknowledges reaches the local sign-out deadline", async () => {
    const current: OpenKeySignOutClient = { signOut: async () => new Promise(() => {}) };
    await expect(withCaptureDeadline(signOutOpenKeySession(current, () => current), 5))
      .rejects.toBeInstanceOf(AccountStateTimeout);
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

  test("App shows only fixed warning copy and never interpolates a sign-out failure", () => {
    const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
    const signOut = app.slice(app.indexOf("const signOut = useCallback"), app.indexOf("const isReady"));
    const warnings = signOut.slice(signOut.indexOf('if (openKeyOutcome.status === "cancelled")'), signOut.indexOf("if (tcw && !nativeSession"));
    expect(warnings).toContain('openKeyOutcome.status === "unverified"');
    expect(warnings).not.toMatch(/\$\{|openKeyOutcome\.reason|openKeyErrorMessage|\.message/);
    expect(warnings.match(/Exo is signed out locally/g)?.length).toBe(3);
  });
});
