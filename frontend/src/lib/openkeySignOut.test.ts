import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  signOutOpenKeySession,
  type OpenKeySignOutClient,
} from "./openkeySignOut";
import { AccountStateTimeout, withCaptureDeadline } from "./voiceNotes/accountHandoff";

function appWarnings(): string {
  const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
  const signOut = app.slice(app.indexOf("const signOut = useCallback"), app.indexOf("const isReady"));
  return signOut.slice(signOut.indexOf('if (openKeyOutcome.status === "cancelled")'), signOut.indexOf("if (tcw && !nativeSession"));
}

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

  test("embedded WebView popup-unavailable is local sign-out done: its own outcome, logged, no UI warning", async () => {
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
    expect(appWarnings()).not.toMatch(/remote-unavailable/);
  });

  describe("revoked: false", () => {
    const unrevoked: OpenKeySignOutClient = { signOut: async () => ({ requestId: "r", revoked: false }) };

    test("a restored session in the phone app has nothing left to revoke: no-session", async () => {
      await expect(signOutOpenKeySession(unrevoked, () => unrevoked, { signedInThisRun: false, sessionOnlyInRun: true }))
        .resolves.toEqual({ status: "no-session" });
    });

    test("a session signed in during this run that was not revoked is still unverified", async () => {
      await expect(signOutOpenKeySession(unrevoked, () => unrevoked, { signedInThisRun: true, sessionOnlyInRun: true }))
        .resolves.toEqual({ status: "unverified" });
    });

    test("where the widget session can outlive a run (cookies) a restored session stays unverified", async () => {
      await expect(signOutOpenKeySession(unrevoked, () => unrevoked, { signedInThisRun: false, sessionOnlyInRun: false }))
        .resolves.toEqual({ status: "unverified" });
    });

    test("a thrown failure is unverified even for a restored phone session", async () => {
      const failing: OpenKeySignOutClient = { signOut: async () => { throw { code: "NETWORK", message: "offline" }; } };
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await expect(signOutOpenKeySession(failing, () => failing, { signedInThisRun: false, sessionOnlyInRun: true }))
          .resolves.toEqual({ status: "unverified" });
      } finally {
        warn.mockRestore();
      }
    });

    test("an acknowledged revocation is revoked whatever the context", async () => {
      const ok: OpenKeySignOutClient = { signOut: async () => ({ requestId: "r", revoked: true }) };
      await expect(signOutOpenKeySession(ok, () => ok, { signedInThisRun: false, sessionOnlyInRun: true }))
        .resolves.toEqual({ status: "revoked" });
    });
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

  test("App warns only where a live OpenKey session may remain, in plain fixed copy", () => {
    const warnings = appWarnings();
    expect(warnings).toContain('openKeyOutcome.status === "unverified"');
    expect(warnings).toContain("OpenKey may still be signed in. Exo is signed out here. ");
    expect(warnings).not.toMatch(/could not be verified|\$\{|openKeyOutcome\.reason|openKeyErrorMessage|\.message/);
    expect(warnings).not.toContain('"no-session"');
    expect(warnings.match(/openKeyWarning =/g)?.length).toBe(2);
    const app = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
    expect(app).toContain("signedInThisRun: openkeyRef.current !== null");
    expect(app).toContain('sessionOnlyInRun: appPlatform() === "ios"');
  });
});
