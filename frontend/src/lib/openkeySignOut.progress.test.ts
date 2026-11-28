import { describe, expect, spyOn, test } from "bun:test";
import { signOutOpenKeySession, type OpenKeySignOutClient } from "./openkeySignOut";

type Progress = (progress: "ready" | "confirmed") => void;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A sign-out sheet that reports through the SDK's `onProgress` the way OpenKey's does. */
function sheet(script: (onProgress: Progress) => Promise<{ requestId: string; revoked: boolean }>): OpenKeySignOutClient {
  return { signOut: async (opts) => script(opts?.onProgress ?? (() => undefined)) };
}

// Transport bound 20 ms, owner wait 400 ms: the owner's pause is far longer than the transport bound.
const TRANSPORT = 20;
const OWNER = 400;
const run = (client: OpenKeySignOutClient) => signOutOpenKeySession(client, () => client, TRANSPORT, OWNER);

describe("signOutOpenKeySession follows the sheet's progress", () => {
  test("an owner who confirms after the transport bound still gets the verified verdict", async () => {
    const outcome = await run(sheet(async (onProgress) => {
      onProgress("ready");
      await sleep(TRANSPORT * 4);
      onProgress("confirmed");
      await sleep(TRANSPORT / 4);
      return { requestId: "r", revoked: true };
    }));
    expect(outcome).toEqual({ status: "revoked" });
  });

  test("a confirmed sign-out OpenKey could not prove is unverified", async () => {
    const outcome = await run(sheet(async (onProgress) => {
      onProgress("ready");
      await sleep(TRANSPORT * 2);
      onProgress("confirmed");
      return { requestId: "r", revoked: false };
    }));
    expect(outcome).toEqual({ status: "unverified" });
  });

  test("a ready sheet nobody confirms settles as unverified at the owner wait", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const started = Date.now();
      const outcome = await run(sheet(async (onProgress) => {
        onProgress("ready");
        return new Promise(() => {});
      }));
      expect(outcome).toEqual({ status: "unverified" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(OWNER - 10);
    } finally {
      warn.mockRestore();
    }
  });

  test("a sheet that never reports ready settles as unverified at the transport bound, not the owner wait", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const started = Date.now();
      const outcome = await run(sheet(() => new Promise(() => {})));
      expect(outcome).toEqual({ status: "unverified" });
      expect(Date.now() - started).toBeLessThan(OWNER / 2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a confirmation OpenKey never answers settles as unverified at the transport bound", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const started = Date.now();
      const outcome = await run(sheet(async (onProgress) => {
        onProgress("ready");
        onProgress("confirmed");
        return new Promise(() => {});
      }));
      expect(outcome).toEqual({ status: "unverified" });
      expect(Date.now() - started).toBeLessThan(OWNER / 2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a confirmation without a ready sheet does not extend the wait", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outcome = await run(sheet(async (onProgress) => {
        onProgress("confirmed");
        await sleep(TRANSPORT * 4);
        return { requestId: "r", revoked: true };
      }));
      expect(outcome).toEqual({ status: "unverified" });
    } finally {
      warn.mockRestore();
    }
  });

  test("the owner closing a ready sheet is cancelled", async () => {
    const outcome = await run(sheet(async (onProgress) => {
      onProgress("ready");
      await sleep(TRANSPORT * 2);
      throw { code: "USER_CANCELLED", message: "User cancelled the request" };
    }));
    expect(outcome).toEqual({ status: "cancelled" });
  });

  test("progress after the call settled starts no timer", async () => {
    let late: Progress = () => undefined;
    const outcome = await run(sheet(async (onProgress) => {
      late = onProgress;
      return { requestId: "r", revoked: true };
    }));
    expect(outcome).toEqual({ status: "revoked" });
    late("ready");
    late("confirmed");
    await sleep(TRANSPORT * 2);
  });
});
