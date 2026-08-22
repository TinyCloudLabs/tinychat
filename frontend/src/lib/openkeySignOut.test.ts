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

    expect(result).toEqual({ requestId: "current-request", revoked: true });
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

    expect(result).toEqual({ requestId: "restored-request", revoked: false });
    expect(calls).toEqual(["fallback-created", "fallback-sign-out"]);
  });

  test("propagates cancellation so TinyChat can preserve its local session", async () => {
    const cancelled = new Error("User cancelled sign-out");
    const current: OpenKeySignOutClient = {
      async signOut() {
        throw cancelled;
      },
    };

    expect(signOutOpenKeySession(current, () => current)).rejects.toBe(cancelled);
  });
});
