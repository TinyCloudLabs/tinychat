import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  DECRYPT_DECLINED_MESSAGE,
  DECRYPT_STEP_UP_EXPIRY_MS,
  DECRYPT_STEP_UP_FAILED_MESSAGE,
  ENCRYPTION_NETWORK_FAILED_MESSAGE,
  NEEDS_UNLOCK_MESSAGE,
  UNLOCK_NEEDS_SIGN_IN_MESSAGE,
  deleteConnectorKey,
  isSecretsUnlocked,
  notifySecretsUnlockedForTests,
  onSecretsUnlocked,
  readConnectorKey,
  resetSecretsUnlockedListenersForTests,
  saveConnectorKey,
  unlockSecrets,
  WALLET_UNAVAILABLE_MESSAGE,
} from "./connectorSecrets";
import { CONNECTORS } from "./registry";
import type { ConnectorDescriptor } from "./types";

const FIREFLIES: ConnectorDescriptor = CONNECTORS.find(
  (c) => c.id === "fireflies",
)!;

const FAKE_DID = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";

type Result<T, E> = { ok: true; data: T } | { ok: false; error: E };
type SecretErr = { code: string; message: string };

interface StoredKey {
  name: string;
  scope: string;
  value: string;
}

interface FakeCalls {
  unlockCount: number;
  putCount: number;
  getCount: number;
  deleteCount: number;
  ensureOwnedSpaceHostedCalls: string[];
  ensureNetworkCalls: string[];
  order: string[];
  permissionChecks: Record<string, unknown>[][];
  permissionRequests: { entries: Record<string, unknown>[]; options: unknown }[];
  /** Wallet signatures / runtime-grant creations: incremented only when a grant is approved. */
  signerCalls: number;
}

interface Fake {
  tcw: TinyCloudWeb;
  entries: Map<string, StoredKey>;
  calls: FakeCalls;
  /** When set, next put returns this error once, then falls back to normal behavior. */
  putErrorOnce: SecretErr | null;
  /** When set, put returns this on EVERY call. */
  putErrorSticky: SecretErr | null;
  /** When true, secrets is locked and every op reports VAULT_LOCKED. */
  locked: boolean;
  omitEnsureOwnedSpaceHosted?: boolean;
  /** When set, the next ensureEncryptionNetwork rejects with this once. */
  ensureErrorOnce: Error | null;
  /** Decrypt step-up grant. Shared with the fake's permission methods. */
  grant: { held: boolean; approve: boolean; throwWith: Error | null };
}

function keyFor(name: string, scope: string): string {
  return `${scope}:${name}`;
}

function makeFake(
  opts: {
    locked?: boolean;
    omitEnsureOwnedSpaceHosted?: boolean;
    stepUpHeld?: boolean;
    stepUpApprove?: boolean;
    signerConnected?: boolean;
  } = {},
): Fake {
  const entries = new Map<string, StoredKey>();
  const calls: FakeCalls = {
    unlockCount: 0,
    putCount: 0,
    getCount: 0,
    deleteCount: 0,
    ensureOwnedSpaceHostedCalls: [],
    ensureNetworkCalls: [],
    order: [],
    permissionChecks: [],
    permissionRequests: [],
    signerCalls: 0,
  };
  const state = {
    locked: opts.locked === true,
    putErrorOnce: null as SecretErr | null,
    putErrorSticky: null as SecretErr | null,
    omitEnsureOwnedSpaceHosted: opts.omitEnsureOwnedSpaceHosted === true,
    ensureErrorOnce: null as Error | null,
    grant: { held: opts.stepUpHeld !== false, approve: opts.stepUpApprove !== false, throwWith: null as Error | null },
    signer: { connected: opts.signerConnected !== false },
  };

  const secrets = {
    get isUnlocked(): boolean {
      return !state.locked;
    },
    async unlock(): Promise<Result<void, SecretErr>> {
      calls.unlockCount++;
      state.locked = false;
      return { ok: true, data: undefined as unknown as void };
    },
    lock(): void {
      state.locked = true;
    },
    async put(
      name: string,
      value: string,
      options?: { scope?: string },
    ): Promise<Result<void, SecretErr>> {
      calls.putCount++;
      calls.order.push(`put:${name}`);
      if (state.locked) {
        return {
          ok: false,
          error: { code: "VAULT_LOCKED", message: "Vault is locked" },
        };
      }
      if (state.putErrorSticky) {
        return { ok: false, error: state.putErrorSticky };
      }
      if (state.putErrorOnce) {
        const e = state.putErrorOnce;
        state.putErrorOnce = null;
        return { ok: false, error: e };
      }
      const scope = options?.scope ?? "";
      entries.set(keyFor(name, scope), { name, scope, value });
      return { ok: true, data: undefined as unknown as void };
    },
    async get(
      name: string,
      options?: { scope?: string },
    ): Promise<Result<string, SecretErr>> {
      calls.getCount++;
      calls.order.push(`get:${name}`);
      if (state.locked) {
        return {
          ok: false,
          error: { code: "VAULT_LOCKED", message: "Vault is locked" },
        };
      }
      const scope = options?.scope ?? "";
      const row = entries.get(keyFor(name, scope));
      if (!row) {
        return {
          ok: false,
          error: { code: "KEY_NOT_FOUND", message: `no key ${name}` },
        };
      }
      return { ok: true, data: row.value };
    },
    async delete(
      name: string,
      options?: { scope?: string },
    ): Promise<Result<void, SecretErr>> {
      calls.deleteCount++;
      if (state.locked) {
        return {
          ok: false,
          error: { code: "VAULT_LOCKED", message: "Vault is locked" },
        };
      }
      const scope = options?.scope ?? "";
      const k = keyFor(name, scope);
      if (!entries.has(k)) {
        return {
          ok: false,
          error: { code: "KEY_NOT_FOUND", message: `no key ${name}` },
        };
      }
      entries.delete(k);
      return { ok: true, data: undefined as unknown as void };
    },
  };

  const raw: Record<string, unknown> = { secrets };
  raw.ensureEncryptionNetwork = async (name: string) => {
    calls.order.push("ensure");
    calls.ensureNetworkCalls.push(name);
    if (state.ensureErrorOnce) {
      const e = state.ensureErrorOnce;
      state.ensureErrorOnce = null;
      throw e;
    }
    return { name };
  };
  raw.did = FAKE_DID;
  raw.hasPermissions = (entries: Record<string, unknown>[]): boolean => {
    calls.permissionChecks.push(entries);
    return state.grant.held;
  };
  raw.requestPermissions = async (
    entries: Record<string, unknown>[],
    options: unknown,
  ): Promise<{ approved: boolean }> => {
    calls.permissionRequests.push({ entries, options });
    calls.order.push("stepUp");
    if (state.grant.throwWith) throw state.grant.throwWith;
    if (!state.grant.approve) return { approved: false };
    state.grant.held = true;
    calls.signerCalls++;
    return { approved: true };
  };
  Object.defineProperty(raw, "isWalletConnected", { get: () => state.signer.connected, enumerable: true });
  if (!state.omitEnsureOwnedSpaceHosted) {
    raw.ensureOwnedSpaceHosted = async (name: string) => {
      calls.ensureOwnedSpaceHostedCalls.push(name);
      return `space://${name}`;
    };
  }

  const fake: Fake = {
    tcw: raw as unknown as TinyCloudWeb,
    entries,
    calls,
    get putErrorOnce() {
      return state.putErrorOnce;
    },
    set putErrorOnce(v: SecretErr | null) {
      state.putErrorOnce = v;
    },
    get putErrorSticky() {
      return state.putErrorSticky;
    },
    set putErrorSticky(v: SecretErr | null) {
      state.putErrorSticky = v;
    },
    get locked() {
      return state.locked;
    },
    set locked(v: boolean) {
      state.locked = v;
    },
    get ensureErrorOnce() {
      return state.ensureErrorOnce;
    },
    set ensureErrorOnce(v: Error | null) {
      state.ensureErrorOnce = v;
    },
    omitEnsureOwnedSpaceHosted: state.omitEnsureOwnedSpaceHosted,
    grant: state.grant,
  };
  return fake;
}

describe("connectorSecrets happy path", () => {
  test("save → get → delete round-trips for the fireflies descriptor", async () => {
    const f = makeFake();
    expect(isSecretsUnlocked(f.tcw)).toBe(true);

    const saved = await saveConnectorKey(f.tcw, FIREFLIES, "sk-fire-1");
    expect(saved).toEqual({ ok: true, data: undefined as unknown as void });
    expect(f.calls.putCount).toBe(1);
    // No retry-recovery path was needed → ensureOwnedSpaceHosted must NOT be called.
    expect(f.calls.ensureOwnedSpaceHostedCalls).toEqual([]);
    // Source keys are global so Listen and TinyChat share one canonical value.
    const stored = f.entries.get(keyFor(FIREFLIES.secretName, ""));
    expect(stored?.value).toBe("sk-fire-1");

    const got = await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(got).toEqual({ ok: true, data: "sk-fire-1" });

    const del = await deleteConnectorKey(f.tcw, FIREFLIES);
    expect(del.ok).toBe(true);
    expect(f.entries.size).toBe(0);
  });
});

describe("connectorSecrets locked vault", () => {
  test("get/put/delete propagate VAULT_LOCKED without throwing; unlockSecrets clears the lock", async () => {
    const f = makeFake({ locked: true });
    expect(isSecretsUnlocked(f.tcw)).toBe(false);

    const put = await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(put.ok).toBe(false);
    if (!put.ok)
      expect(put.error).toEqual({
        code: "VAULT_LOCKED",
        message: "Vault is locked",
      });

    const get = await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(get.ok).toBe(false);
    if (!get.ok) expect(get.error.code).toBe("VAULT_LOCKED");

    const del = await deleteConnectorKey(f.tcw, FIREFLIES);
    expect(del.ok).toBe(false);
    if (!del.ok) expect(del.error.code).toBe("VAULT_LOCKED");

    // Unlock, then put succeeds.
    const unlocked = await unlockSecrets(f.tcw);
    expect(unlocked.ok).toBe(true);
    expect(f.calls.unlockCount).toBe(1);
    const put2 = await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(put2.ok).toBe(true);
  });
});

describe("connectorSecrets first-put 404 defense", () => {
  test("SPACE_NOT_FOUND → ensureOwnedSpaceHosted('secrets') → retry once → success", async () => {
    const f = makeFake();
    f.putErrorOnce = {
      code: "SPACE_NOT_FOUND",
      message: "Space not found: xxx",
    };

    const res = await saveConnectorKey(f.tcw, FIREFLIES, "sk-fire-2");
    expect(res.ok).toBe(true);
    expect(f.calls.putCount).toBe(2);
    expect(f.calls.ensureOwnedSpaceHostedCalls).toEqual(["secrets"]);
    expect(f.entries.get(keyFor(FIREFLIES.secretName, ""))?.value).toBe(
      "sk-fire-2",
    );
  });

  test("retry runs at most once; if the second put also fails the error is surfaced", async () => {
    const f = makeFake();
    f.putErrorSticky = { code: "NOT_FOUND", message: "not found" };

    const res = await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    // First put + one retry = 2. No third attempt.
    expect(f.calls.putCount).toBe(2);
    expect(f.calls.ensureOwnedSpaceHostedCalls).toEqual(["secrets"]);
  });

  test("non-not-found error does NOT trigger the retry (no silent fallback)", async () => {
    const f = makeFake();
    f.putErrorOnce = { code: "PERMISSION_DENIED", message: "denied" };

    const res = await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PERMISSION_DENIED");
    expect(f.calls.putCount).toBe(1);
    expect(f.calls.ensureOwnedSpaceHostedCalls).toEqual([]);
  });

  test("ensureOwnedSpaceHosted missing on the SDK: the original not-found error is surfaced (no retry, no throw)", async () => {
    const f = makeFake({ omitEnsureOwnedSpaceHosted: true });
    f.putErrorSticky = { code: "SPACE_NOT_FOUND", message: "Space not found" };

    const res = await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("SPACE_NOT_FOUND");
    // No retry because the SDK doesn't expose the hook.
    expect(f.calls.putCount).toBe(1);
  });
});

describe("connectorSecrets delete", () => {
  test("delete of a missing key surfaces the SDK's KEY_NOT_FOUND — never invents a success", async () => {
    const f = makeFake();
    const res = await deleteConnectorKey(f.tcw, FIREFLIES);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("KEY_NOT_FOUND");
  });
});

describe("connectorSecrets unlock on a restored session", () => {
  /** tcw whose unlock returns the vault's cold-cache failure verbatim. */
  function unlockFailingTcw(error: SecretErr): TinyCloudWeb {
    return {
      secrets: {
        isUnlocked: false,
        unlock: async (): Promise<Result<void, SecretErr>> => ({
          ok: false,
          error,
        }),
      },
    } as unknown as TinyCloudWeb;
  }

  test("cold-cache VAULT_LOCKED is rewritten into an actionable sign-in message", async () => {
    // Exactly what DataVaultService.unlock returns when the session was
    // restored (no wallet signer) and IndexedDB holds no master signature.
    const tcw = unlockFailingTcw({
      code: "VAULT_LOCKED",
      message: "Signer is required when no cached master signature exists",
    });

    const res = await unlockSecrets<SecretErr>(tcw);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe(UNLOCK_NEEDS_SIGN_IN_MESSAGE);
      // The code survives for logs.
      expect(res.error.code).toBe("VAULT_LOCKED");
    }
  });

  test("other VAULT_LOCKED failures keep the SDK's own message", async () => {
    const tcw = unlockFailingTcw({
      code: "VAULT_LOCKED",
      message: "Vault is locked",
    });

    const res = await unlockSecrets<SecretErr>(tcw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toBe("Vault is locked");
  });
});

// ── I2: the unlock event registry ────────────────────────────────────
//
// `unlockSecrets` is the ONE choke point every production unlock site shares
// (the section's deps, the card's "Sync now", the dialog's "Save & sync" and
// its teardown deps), so anything that wants to react to a user-initiated
// unlock subscribes HERE instead of to four call sites.
//
// The registry is deliberately zero-dependency and lives in `lib/`: the import
// direction is chat → lib, never lib → chat. And it is strictly an OUTPUT — a
// listener learns that the vault opened; nothing a listener does can make this
// module open it.

describe("I2 unlock events", () => {
  beforeEach(() => {
    resetSecretsUnlockedListenersForTests();
  });

  /** tcw whose unlock fails with the given error, verbatim. */
  function failingUnlockTcw(error: SecretErr): TinyCloudWeb {
    return {
      secrets: {
        isUnlocked: false,
        unlock: async (): Promise<Result<void, SecretErr>> => ({
          ok: false,
          error,
        }),
      },
    } as unknown as TinyCloudWeb;
  }

  test("a successful unlock notifies every listener, in registration order", async () => {
    const f = makeFake({ locked: true });
    const seen: string[] = [];
    onSecretsUnlocked(() => seen.push("a"));
    onSecretsUnlocked(() => seen.push("b"));

    const res = await unlockSecrets<SecretErr>(f.tcw);

    expect(res.ok).toBe(true);
    expect(seen).toEqual(["a", "b"]);
    // The notify rides the ONE unlock the caller asked for — it never calls
    // back into the vault itself.
    expect(f.calls.unlockCount).toBe(1);
    expect(isSecretsUnlocked(f.tcw)).toBe(true);
  });

  test("a failed unlock notifies nobody — including the rewritten missing-signer path", async () => {
    const seen: string[] = [];
    onSecretsUnlocked(() => seen.push("notified"));

    // The cold-cache failure, whose message this module rewrites. Rewriting an
    // error is still a failure: the vault did not open, so no re-arm may fire.
    const rewritten = await unlockSecrets<SecretErr>(
      failingUnlockTcw({
        code: "VAULT_LOCKED",
        message: "Signer is required when no cached master signature exists",
      }),
    );
    expect(rewritten.ok).toBe(false);
    if (!rewritten.ok)
      expect(rewritten.error.message).toBe(UNLOCK_NEEDS_SIGN_IN_MESSAGE);

    // And any other failure.
    const plain = await unlockSecrets<SecretErr>(
      failingUnlockTcw({ code: "VAULT_LOCKED", message: "Vault is locked" }),
    );
    expect(plain.ok).toBe(false);

    expect(seen).toEqual([]);
  });

  test("a throwing listener neither corrupts the unlock result nor starves the others", async () => {
    const f = makeFake({ locked: true });
    const seen: string[] = [];
    onSecretsUnlocked(() => {
      seen.push("a");
      throw new Error("a subscriber blew up");
    });
    onSecretsUnlocked(() => seen.push("b"));

    // The caller is awaiting an unlock, not a subscriber: a broken listener
    // must not reject this promise nor turn a real unlock into a failure.
    const res = await unlockSecrets<SecretErr>(f.tcw);

    expect(res.ok).toBe(true);
    expect(seen).toEqual(["a", "b"]);
    expect(isSecretsUnlocked(f.tcw)).toBe(true);
  });

  test("the disposer unregisters, and re-registering the same callback is not a double notify", async () => {
    const f = makeFake({ locked: true });
    let count = 0;
    const listener = () => {
      count++;
    };
    const off = onSecretsUnlocked(listener);
    onSecretsUnlocked(listener);

    await unlockSecrets<SecretErr>(f.tcw);
    expect(count).toBe(1);

    off();
    f.locked = true;
    await unlockSecrets<SecretErr>(f.tcw);
    expect(count).toBe(1);
  });

  test("with no listeners at all an unlock is exactly what it was before", async () => {
    const f = makeFake({ locked: true });
    const res = await unlockSecrets<SecretErr>(f.tcw);
    expect(res.ok).toBe(true);
    expect(f.calls.unlockCount).toBe(1);
  });
});

describe("I2 unlock events — notify re-entrancy guard", () => {
  beforeEach(() => {
    resetSecretsUnlockedListenersForTests();
  });

  test("a listener that re-triggers the notify loop does not loop; others still run exactly once", () => {
    const calls: string[] = [];
    let retriggered = false;
    onSecretsUnlocked(() => {
      calls.push("a");
      if (!retriggered) {
        retriggered = true;
        // Nested and synchronous, while the outer notification is mid-loop.
        // Unbounded, this is the self-feed the audit called out; bounded to
        // once, a missing guard shows up as duplication instead of a hang.
        notifySecretsUnlockedForTests();
      }
    });
    onSecretsUnlocked(() => {
      calls.push("b");
    });

    notifySecretsUnlockedForTests();

    // The nested notification was suppressed entirely: one pass, in order.
    // (Defense in depth — our production subscriber re-arms a drain and never
    // unlocks, so suppression loses nothing.)
    expect(calls).toEqual(["a", "b"]);
  });

  test("the guard resets after every pass — even a throwing one — so later unlocks still notify", async () => {
    const calls: string[] = [];
    let retriggered = false;
    onSecretsUnlocked(() => {
      calls.push("a");
      if (!retriggered) {
        retriggered = true;
        notifySecretsUnlockedForTests();
      }
      throw new Error("a subscriber blew up mid-pass");
    });
    onSecretsUnlocked(() => {
      calls.push("b");
    });

    // A suppression pass whose first listener also throws…
    notifySecretsUnlockedForTests();
    expect(calls).toEqual(["a", "b"]);

    // …leaves the guard DOWN: the next real unlock notifies normally.
    const f = makeFake({ locked: true });
    const res = await unlockSecrets<SecretErr>(f.tcw);
    expect(res.ok).toBe(true);
    expect(calls).toEqual(["a", "b", "a", "b"]);
  });
});

describe("connectorSecrets encryption network before first write", () => {
  test("creates the default network before the first put, and not again in the session", async () => {
    const f = makeFake();
    await saveConnectorKey(f.tcw, FIREFLIES, "k1");
    await saveConnectorKey(f.tcw, FIREFLIES, "k2");
    expect(f.calls.ensureNetworkCalls).toEqual(["default"]);
    expect(f.calls.order).toEqual([
      "ensure",
      `put:${FIREFLIES.secretName}`,
      `put:${FIREFLIES.secretName}`,
    ]);
  });

  test("concurrent first saves share one network ensure", async () => {
    const f = makeFake();
    const [a, b] = await Promise.all([
      saveConnectorKey(f.tcw, FIREFLIES, "k1"),
      saveConnectorKey(f.tcw, FIREFLIES, "k2"),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(f.calls.ensureNetworkCalls).toEqual(["default"]);
  });

  test("a failed ensure blocks the write, returns the neutral message with the SDK error as cause, and the next save retries", async () => {
    const f = makeFake();
    const boom = new Error("HTTP 401 Unauthorized Action: network.create");
    f.ensureErrorOnce = boom;
    const failed = await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(failed).toEqual({
      ok: false,
      error: { code: "encryption-network-failed", message: ENCRYPTION_NETWORK_FAILED_MESSAGE, cause: boom },
    });
    expect(f.calls.putCount).toBe(0);
    expect(f.entries.size).toBe(0);

    const retried = await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(retried.ok).toBe(true);
    expect(f.calls.ensureNetworkCalls).toEqual(["default", "default"]);
    expect(f.calls.putCount).toBe(1);
  });
});

describe("connectorSecrets decrypt step-up", () => {
  test("a read requests exactly one decrypt entry on the default network, capped at one hour", async () => {
    const f = makeFake({ stepUpHeld: false });
    await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(f.calls.permissionRequests).toHaveLength(1);
    const { entries, options } = f.calls.permissionRequests[0]!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      service: "tinycloud.encryption",
      path: `urn:tinycloud:encryption:${FAKE_DID}:default`,
      actions: ["decrypt"],
      skipPrefix: true,
    });
    expect(options).toEqual({ expiryMs: DECRYPT_STEP_UP_EXPIRY_MS });
    expect(DECRYPT_STEP_UP_EXPIRY_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test("the step-up never requests a KV entry: a KV grant would fail this", async () => {
    const f = makeFake({ stepUpHeld: false });
    await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    const entries = f.calls.permissionRequests.flatMap((r) => r.entries);
    expect(entries.some((e) => e.service === "tinycloud.kv")).toBe(false);
    expect(entries.every((e) => e.service === "tinycloud.encryption")).toBe(true);
  });

  test("no prompt when the decrypt grant is already held", async () => {
    const f = makeFake({ stepUpHeld: true });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    const r = await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(r).toEqual({ ok: true, data: "k" });
    expect(f.calls.permissionChecks).toHaveLength(1);
    expect(f.calls.permissionRequests).toHaveLength(0);
  });

  test("the step-up precedes the vault read", async () => {
    const f = makeFake({ stepUpHeld: false });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(f.calls.order).toEqual([
      "ensure",
      `put:${FIREFLIES.secretName}`,
      "stepUp",
      `get:${FIREFLIES.secretName}`,
    ]);
  });

  test("a decline returns the neutral error, reads nothing, and is not retried", async () => {
    const f = makeFake({ stepUpHeld: false, stepUpApprove: false });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    const r = await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({ code: "decrypt-declined", message: DECRYPT_DECLINED_MESSAGE });
    }
    expect(f.calls.getCount).toBe(0);
    expect(f.calls.permissionRequests).toHaveLength(1);
  });

  test("an SDK error from the step-up is returned as the neutral message, with the error as cause, and nothing is read", async () => {
    const f = makeFake({ stepUpHeld: false });
    const boom = new Error("prompt dismissed");
    f.grant.throwWith = boom;
    const r = await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(r).toEqual({
      ok: false,
      error: { code: "step-up-failed", message: DECRYPT_STEP_UP_FAILED_MESSAGE, cause: boom },
    });
    expect(f.calls.getCount).toBe(0);
  });

  test.each([
    "OpenKey: wallet request rejected by the user",
    "HTTP 500 Internal Server Error during requestPermissions",
  ])("a wallet error during the step-up (%s) never reaches the user as raw text", async (raw) => {
    const f = makeFake({ stepUpHeld: false });
    f.grant.throwWith = new Error(raw);
    const r = await readConnectorKey(f.tcw, FIREFLIES, { interactive: true });
    expect(r).toMatchObject({
      ok: false,
      error: { code: "step-up-failed", message: DECRYPT_STEP_UP_FAILED_MESSAGE },
    });
    expect(f.calls.getCount).toBe(0);
  });

  test("one signature on the first reveal, none on a second within the hour", async () => {
    // The granted decrypt entry stays held until its ≤1h expiry (asserted above),
    // so the second reveal reuses it and does not sign.
    const f = makeFake({ stepUpHeld: false, stepUpApprove: true });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(f.calls.signerCalls).toBe(0);
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({ ok: true, data: "k" });
    expect(f.calls.signerCalls).toBe(1);
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({ ok: true, data: "k" });
    expect(f.calls.signerCalls).toBe(1);
  });

  test("a background read with no decrypt grant returns needs-unlock and makes no permission call", async () => {
    const f = makeFake({ stepUpHeld: false, stepUpApprove: true });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: false })).toEqual({
      ok: false,
      error: { code: "needs-unlock", message: NEEDS_UNLOCK_MESSAGE },
    });
    expect(f.calls.permissionRequests).toHaveLength(0);
    expect(f.calls.signerCalls).toBe(0);
    expect(f.calls.getCount).toBe(0);
  });

  test("a background read on a signer-less client still defers as needs-unlock, never the wallet message", async () => {
    const f = makeFake({ stepUpHeld: false, signerConnected: false });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: false })).toEqual({
      ok: false,
      error: { code: "needs-unlock", message: NEEDS_UNLOCK_MESSAGE },
    });
    expect(f.calls.permissionRequests).toHaveLength(0);
  });

  test("a background read after an interactive grant reads without prompting again", async () => {
    const f = makeFake({ stepUpHeld: false, stepUpApprove: true });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({ ok: true, data: "k" });
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: false })).toEqual({ ok: true, data: "k" });
    expect(f.calls.permissionRequests).toHaveLength(1);
    expect(f.calls.signerCalls).toBe(1);
  });

  // Receivers that may carry an injected `secrets` bag, per file (paths relative
  // to src/). Any other `.secrets` access outside connectorSecrets.ts is flagged,
  // whatever the receiver is called.
  const INJECTED_SECRETS_RECEIVERS: Record<string, Record<string, true>> = {
    "chat/BackendReconciler.tsx": { options: true },
    "chat/backgroundSyncState.ts": { deps: true },
    "lib/connectors/backendReconcile.ts": { opts: true },
    "lib/connectors/connectorLifecycle.ts": { deps: true },
    "lib/connectors/targetedSync.ts": { opts: true },
  };
  function secretsAccessOffenders(rel: string, text: string): string[] {
    const allowed = INJECTED_SECRETS_RECEIVERS[rel] ?? {};
    const hits: string[] = [];
    for (const line of text.split("\n")) {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
      for (const m of code.matchAll(/(\w+)\??\.(?:secrets|getSecret)\b/g)) {
        if (allowed[m[1] ?? ""] !== true) hits.push(code);
      }
      for (const m of code.matchAll(/\{[^}]*\bsecrets\b[^}]*\}\s*=\s*(\w+)/g)) {
        if (allowed[m[1] ?? ""] !== true) hits.push(code);
      }
    }
    return hits;
  }

  test("the secrets-access guard flags aliases, destructuring and getSecret receivers", () => {
    expect(secretsAccessOffenders("chat/x.ts", "await tcw.getSecret(key);")).toEqual(["await tcw.getSecret(key);"]);
    expect(secretsAccessOffenders("chat/x.ts", "const vault = tcw.secrets;")).toEqual(["const vault = tcw.secrets;"]);
    expect(secretsAccessOffenders("chat/x.ts", "const { secrets } = tcw;")).toEqual(["const { secrets } = tcw;"]);
    expect(secretsAccessOffenders("chat/x.ts", "await deps.secrets.isUnlocked();")).toEqual([
      "await deps.secrets.isUnlocked();",
    ]);
    expect(secretsAccessOffenders("chat/backgroundSyncState.ts", "await deps.secrets.isUnlocked();")).toEqual([]);
    expect(secretsAccessOffenders("chat/x.ts", "const opts = tcw;\nopts.secrets.get(a);")).toEqual([
      "opts.secrets.get(a);",
    ]);
    expect(secretsAccessOffenders("chat/BackendReconciler.tsx", "const { tcw, secrets } = options;")).toEqual([]);
    expect(secretsAccessOffenders("chat/x.ts", "const { tcw, secrets } = options;")).toEqual([
      "const { tcw, secrets } = options;",
    ]);
    expect(secretsAccessOffenders("chat/x.ts", "// tcw.secrets.get is not called here")).toEqual([]);
  });

  test("no file outside connectorSecrets.ts reaches the TinyCloud secrets service", () => {
    const srcRoot = join(import.meta.dir, "..", "..");
    const offenders: string[] = [];
    for (const rel of readdirSync(srcRoot, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.(ts|tsx)$/.test(rel)) continue;
      if (rel.endsWith(join("lib", "connectors", "connectorSecrets.ts"))) continue;
      for (const hit of secretsAccessOffenders(rel, readFileSync(join(srcRoot, rel), "utf8"))) offenders.push(`${rel}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  test("every readConnectorKey call site is classified by its literal interactive flag", () => {
    // Closed inventory: a caller may only pass a literal that matches its file's role.
    // Flipping a background caller to `interactive: true` fails here.
    const USER_PRESS_CALLERS: Record<string, true> = {
      "capture/meetingSources/useSourceSync.ts": true,
      "chat/ConnectorDialog.tsx": true,
      "chat/ConnectorsCard.tsx": true,
    };
    const BACKGROUND_CALLERS: Record<string, true> = {
      "chat/useBackgroundDrain.ts": true,
      "chat/useGmeetSessionSync.ts": true,
    };
    // Forward a caller-supplied flag; the definition and the queue adapter.
    const FLAG_PASS_THROUGH: Record<string, true> = {
      "lib/connectors/connectorSecrets.ts": true,
      "lib/connectors/targetedSync.ts": true,
    };
    const srcRoot = join(import.meta.dir, "..", "..");
    const offenders: string[] = [];
    for (const rel of readdirSync(srcRoot, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.(ts|tsx)$/.test(rel)) continue;
      const text = readFileSync(join(srcRoot, rel), "utf8");
      for (const m of text.matchAll(/readConnectorKey(?:<[^>]*>)?\(([^()]*)\)/g)) {
        const args = m[1] ?? "";
        const literal = /\binteractive:\s*(true|false)\b/.exec(args)?.[1];
        const where = `${rel}: ${m[0]}`;
        if (literal === "true") {
          if (!Object.hasOwn(USER_PRESS_CALLERS, rel)) offenders.push(where);
        } else if (literal === "false") {
          if (!Object.hasOwn(BACKGROUND_CALLERS, rel)) offenders.push(where);
        } else if (!/\binteractive\b/.test(args) || !Object.hasOwn(FLAG_PASS_THROUGH, rel)) {
          offenders.push(where);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("connectorSecrets reveal after reload", () => {
  test("a signer-less client is refused before any prompt, with the neutral message", async () => {
    const f = makeFake({ stepUpHeld: false, signerConnected: false });
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({
      ok: false,
      error: { code: "wallet-unavailable", message: WALLET_UNAVAILABLE_MESSAGE },
    });
    expect(f.calls.permissionRequests).toHaveLength(0);
    expect(f.calls.getCount).toBe(0);
  });

  test("a signer-less client that already holds the grant still reads", async () => {
    const f = makeFake({ stepUpHeld: true, signerConnected: false });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({ ok: true, data: "k" });
    expect(f.calls.permissionRequests).toHaveLength(0);
  });

  test("a signer-connected restored client prompts on the first reveal only", async () => {
    const f = makeFake({ stepUpHeld: false, stepUpApprove: true });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({ ok: true, data: "k" });
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({ ok: true, data: "k" });
    expect(f.calls.permissionRequests).toHaveLength(1);
    expect(f.calls.signerCalls).toBe(1);
  });

  test("a declined prompt on a signer-connected client is not retried", async () => {
    const f = makeFake({ stepUpHeld: false, stepUpApprove: false });
    await saveConnectorKey(f.tcw, FIREFLIES, "k");
    expect(await readConnectorKey(f.tcw, FIREFLIES, { interactive: true })).toEqual({
      ok: false,
      error: { code: "decrypt-declined", message: DECRYPT_DECLINED_MESSAGE },
    });
    expect(f.calls.permissionRequests).toHaveLength(1);
  });
});
