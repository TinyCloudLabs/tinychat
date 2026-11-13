import { describe, expect, jest, test } from "bun:test";
import { signOutOpenKeySession, type OpenKeySignOutClient } from "./openkeySignOut";

describe("sign-out progress deadlines", () => {
  for (const restored of [false, true]) {
    test(`${restored ? "restored" : "fresh"}: ten seconds deciding does not spend the revoke deadline`, async () => {
      jest.useFakeTimers();
      let progress!: (state: "ready" | "confirmed") => void;
      let complete!: (value: { requestId: string; revoked: boolean }) => void;
      const client: OpenKeySignOutClient = {
        signOut(options) {
          progress = options!.onProgress!;
          return new Promise((resolve) => { complete = resolve; });
        },
      };
      try {
        let outcome: unknown;
        const result = signOutOpenKeySession(restored ? null : client, () => client).then(value => { outcome = value; return value; });
        await Promise.resolve();
        progress("ready");
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
        expect(outcome).toBeUndefined();
        progress("confirmed");
        complete({ requestId: "signout", revoked: true });
        expect(await result).toEqual({ status: "revoked" });
      } finally { jest.useRealTimers(); }
    });
  }

  test("a stalled revoke times out after confirmation; repeated progress cannot extend it", async () => {
    jest.useFakeTimers();
    let progress!: (state: "ready" | "confirmed") => void;
    const client: OpenKeySignOutClient = { signOut(options) {
      progress = options!.onProgress!;
      return new Promise(() => {});
    } };
    try {
      const result = signOutOpenKeySession(client, () => client);
      await Promise.resolve();
      progress("ready");
      progress("confirmed");
      jest.advanceTimersByTime(4_000);
      progress("ready");
      progress("confirmed");
      jest.advanceTimersByTime(1_000);
      expect(await result).toEqual({ status: "unverified" });
    } finally { jest.useRealTimers(); }
  });

  test("cancelling after taking time to decide stays cancelled", async () => {
    const client: OpenKeySignOutClient = { async signOut(options) {
      options!.onProgress!("ready");
      throw { code: "USER_CANCELLED" };
    } };
    expect(await signOutOpenKeySession(client, () => client)).toEqual({ status: "cancelled" });
  });
});
