import { beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  UNLOCK_NEEDS_SIGN_IN_MESSAGE,
  deleteConnectorKey,
  getConnectorKey,
  isSecretsUnlocked,
  notifySecretsUnlockedForTests,
  onSecretsUnlocked,
  resetSecretsUnlockedListenersForTests,
  saveConnectorKey,
  unlockSecrets,
} from "./connectorSecrets";
import { CONNECTORS } from "./registry";
import type { ConnectorDescriptor } from "./types";

const FIREFLIES: ConnectorDescriptor = CONNECTORS.find(
  (c) => c.id === "fireflies",
)!;

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
}

function keyFor(name: string, scope: string): string {
  return `${scope}:${name}`;
}

function makeFake(
  opts: {
    locked?: boolean;
    omitEnsureOwnedSpaceHosted?: boolean;
  } = {},
): Fake {
  const entries = new Map<string, StoredKey>();
  const calls: FakeCalls = {
    unlockCount: 0,
    putCount: 0,
    getCount: 0,
    deleteCount: 0,
    ensureOwnedSpaceHostedCalls: [],
  };
  const state = {
    locked: opts.locked === true,
    putErrorOnce: null as SecretErr | null,
    putErrorSticky: null as SecretErr | null,
    omitEnsureOwnedSpaceHosted: opts.omitEnsureOwnedSpaceHosted === true,
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
    omitEnsureOwnedSpaceHosted: state.omitEnsureOwnedSpaceHosted,
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

    const got = await getConnectorKey(f.tcw, FIREFLIES);
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

    const get = await getConnectorKey(f.tcw, FIREFLIES);
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
