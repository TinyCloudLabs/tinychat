import { describe, expect, test } from "bun:test";
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

    expect(result).toEqual({ status: "unverified", reason: null });
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
      reason: "OpenKey timed out",
    });
  });
});
