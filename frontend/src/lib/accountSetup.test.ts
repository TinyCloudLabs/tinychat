import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  ACCOUNT_SETUP_BUTTON_LABEL, ACCOUNT_SETUP_MESSAGE, ACCOUNT_SETUP_URL, AccountSetupRequiredError, checkAccountSetup,
  isAccountSetupRequired,
} from "./accountSetup";
import { errorLinkFor } from "./authErrors";

/** What the web SDK returns from the first node call on a third-party origin for an owner with no account record. */
const REFUSAL = {
  code: "NETWORK_ERROR",
  message: "Finish setting up your TinyCloud account at https://tinycloud.one/ before signing in to this app.",
  service: "kv",
  cause: { code: "ACCOUNT_SETUP_REQUIRED", setupUrl: "https://tinycloud.one/", name: "AccountSetupRequiredError" },
};

function client(get: () => Promise<unknown>): Pick<TinyCloudWeb, "kv"> {
  return { kv: { get } } as unknown as Pick<TinyCloudWeb, "kv">;
}

describe("the account-setup copy", () => {
  test("the words, the button and the address are the ones written for this screen", () => {
    expect(ACCOUNT_SETUP_MESSAGE).toBe("There's no TinyCloud account for this sign-in. Create one at tinycloud.one, then come back here and sign in.");
    expect(ACCOUNT_SETUP_BUTTON_LABEL).toBe("Open tinycloud.one");
    expect(ACCOUNT_SETUP_URL).toBe("https://tinycloud.one/");
  });

  test("the message carries the button that opens the address; other messages carry none", () => {
    expect(errorLinkFor(ACCOUNT_SETUP_MESSAGE)).toEqual({ href: "https://tinycloud.one/", label: "Open tinycloud.one" });
    expect(errorLinkFor("Couldn't sign in. Try again.")).toBeNull();
  });
});

describe("isAccountSetupRequired", () => {
  test("reads the SDK's refusal as a Result error, as a thrown error and as a cause", () => {
    expect(isAccountSetupRequired(REFUSAL)).toBe(true);
    expect(isAccountSetupRequired(Object.assign(new Error("x"), { name: "AccountSetupRequiredError", code: "ACCOUNT_SETUP_REQUIRED" }))).toBe(true);
    expect(isAccountSetupRequired(new Error("sign-in failed", { cause: REFUSAL }))).toBe(true);
  });

  test("a network failure, a missing key and a refusal for another reason are not it", () => {
    expect(isAccountSetupRequired({ code: "NETWORK_ERROR", message: "Failed to fetch", cause: { code: "ECONNRESET" } })).toBe(false);
    expect(isAccountSetupRequired({ code: "KV_NOT_FOUND", message: "Finish setting up your TinyCloud account" })).toBe(false);
    expect(isAccountSetupRequired(null)).toBe(false);
    expect(isAccountSetupRequired("ACCOUNT_SETUP_REQUIRED")).toBe(false);
  });

  test("a cause chain that loops ends", () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(isAccountSetupRequired(loop)).toBe(false);
  });
});

describe("checkAccountSetup", () => {
  test("throws AccountSetupRequiredError when the first request is refused", async () => {
    await expect(checkAccountSetup(client(async () => ({ ok: false, error: REFUSAL })))).rejects.toBeInstanceOf(AccountSetupRequiredError);
  });

  test("throws it too when the SDK throws the refusal", async () => {
    await expect(checkAccountSetup(client(async () => { throw Object.assign(new Error("setup"), { code: "ACCOUNT_SETUP_REQUIRED" }); })))
      .rejects.toBeInstanceOf(AccountSetupRequiredError);
  });

  test("returns for an owner whose account exists, with or without the key", async () => {
    await expect(checkAccountSetup(client(async () => ({ ok: true, data: {} })))).resolves.toBeUndefined();
    await expect(checkAccountSetup(client(async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "missing" } })))).resolves.toBeUndefined();
  });

  test("returns when the phone is offline or the request fails for another reason, so sign-in goes on", async () => {
    await expect(checkAccountSetup(client(async () => ({ ok: false, error: { code: "NETWORK_ERROR", message: "Failed to fetch" } })))).resolves.toBeUndefined();
    await expect(checkAccountSetup(client(async () => { throw new TypeError("Load failed"); }))).resolves.toBeUndefined();
  });

  test("asks for a path inside the sign-in's grant, with an abort signal", async () => {
    const calls: Array<[string, { signal?: AbortSignal } | undefined]> = [];
    await checkAccountSetup({ kv: { get: async (key: string, options?: { signal?: AbortSignal }) => { calls.push([key, options]); return { ok: true }; } } } as unknown as Pick<TinyCloudWeb, "kv">);
    expect(calls).toHaveLength(1);
    expect(calls[0][0].startsWith("threads/")).toBe(true);
    expect(calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
