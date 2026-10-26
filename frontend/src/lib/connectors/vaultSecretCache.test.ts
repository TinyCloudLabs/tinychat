import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  clearVaultSecretCache,
  deleteConnectorKey,
  getConnectorKey,
  resetVaultSecretCacheForTests,
  saveConnectorKey,
} from "./connectorSecrets";
import type { SecretLocation } from "./connectorSecrets";

// Rule: tests never touch a real home. Nothing here writes files, but HOME is
// pinned to a ticket-named temp dir before anything else runs and asserted.
const TEST_HOME = mkdtempSync("/var/tmp/tc-2080.");
process.env.HOME = TEST_HOME;
expect(process.env.HOME).toBe(TEST_HOME);
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }));

const LOC: SecretLocation = { secretName: "fireflies-api-key", secretScope: "connectors" };
const OTHER: SecretLocation = { secretName: "other-key", secretScope: "connectors" };
const VALUE = "vault-value-1";

type Outcome = { ok: true; data: string } | { ok: false; error: { code: string; message: string } };

interface FakeVault {
  tcw: TinyCloudWeb;
  gets: () => number;
  stored: Map<string, string>;
  setUnlocked: (unlocked: boolean) => void;
  /** Hold every `get` until `release()` so a test can overlap reads. */
  hold: () => () => void;
  failNextGet: (error: { code: string; message: string }) => void;
}

const slot = (loc: SecretLocation) => `${loc.secretScope ?? ""}:${loc.secretName}`;

function fakeVault(did: string | undefined, initial: Record<string, string> = {}): FakeVault {
  let gets = 0;
  let unlocked = true;
  let gate: Promise<void> | null = null;
  let nextError: { code: string; message: string } | null = null;
  const stored = new Map<string, string>(Object.entries(initial));
  const secrets = {
    get isUnlocked(): boolean {
      return unlocked;
    },
    async get(name: string, options?: { scope?: string }): Promise<Outcome> {
      gets++;
      if (gate) await gate;
      if (!unlocked) return { ok: false, error: { code: "VAULT_LOCKED", message: "Vault is locked" } };
      if (nextError) {
        const error = nextError;
        nextError = null;
        return { ok: false, error };
      }
      const value = stored.get(`${options?.scope ?? ""}:${name}`);
      return value === undefined
        ? { ok: false, error: { code: "KEY_NOT_FOUND", message: "no key" } }
        : { ok: true, data: value };
    },
    async put(name: string, value: string, options?: { scope?: string }) {
      stored.set(`${options?.scope ?? ""}:${name}`, value);
      return { ok: true, data: undefined };
    },
    async delete(name: string, options?: { scope?: string }) {
      stored.delete(`${options?.scope ?? ""}:${name}`);
      return { ok: true, data: undefined };
    },
  };
  const raw: Record<string, unknown> = { secrets };
  if (did !== undefined) raw.did = did;
  return {
    tcw: raw as unknown as TinyCloudWeb,
    gets: () => gets,
    stored,
    setUnlocked: (value) => {
      unlocked = value;
    },
    hold: () => {
      let release = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
    failNextGet: (error) => {
      nextError = error;
    },
  };
}

beforeEach(() => resetVaultSecretCacheForTests());
afterEach(() => resetVaultSecretCacheForTests());

describe("vault secret cache", () => {
  test("a second read in one session is served from memory with one secrets.get", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    expect(await getConnectorKey(v.tcw, LOC)).toEqual({ ok: true, data: VALUE });
    expect(await getConnectorKey(v.tcw, LOC)).toEqual({ ok: true, data: VALUE });
    expect(v.gets()).toBe(1);
  });

  test("scope and name are part of the key", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE, [slot(OTHER)]: "other-value" });
    await getConnectorKey(v.tcw, LOC);
    expect(await getConnectorKey(v.tcw, OTHER)).toEqual({ ok: true, data: "other-value" });
    expect(await getConnectorKey(v.tcw, { ...LOC, secretScope: "elsewhere" })).toMatchObject({ ok: false });
    expect(v.gets()).toBe(3);
  });

  test("concurrent reads of one key coalesce into one secrets.get", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    const release = v.hold();
    const reads = [getConnectorKey(v.tcw, LOC), getConnectorKey(v.tcw, LOC), getConnectorKey(v.tcw, LOC)];
    release();
    expect(await Promise.all(reads)).toEqual([
      { ok: true, data: VALUE },
      { ok: true, data: VALUE },
      { ok: true, data: VALUE },
    ]);
    expect(v.gets()).toBe(1);
  });

  test("a tcw with no identity bypasses the cache", async () => {
    const v = fakeVault(undefined, { [slot(LOC)]: VALUE });
    await getConnectorKey(v.tcw, LOC);
    await getConnectorKey(v.tcw, LOC);
    expect(v.gets()).toBe(2);
  });

  test("clearVaultSecretCache (sign-out) forces the next read back to the vault", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    await getConnectorKey(v.tcw, LOC);
    clearVaultSecretCache();
    await getConnectorKey(v.tcw, LOC);
    expect(v.gets()).toBe(2);
  });

  test("clear drops an in-flight read so it cannot repopulate the cache", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    const release = v.hold();
    const pending = getConnectorKey(v.tcw, LOC);
    clearVaultSecretCache();
    release();
    await pending;
    await getConnectorKey(v.tcw, LOC);
    expect(v.gets()).toBe(2);
  });

  test("a different address on a new tcw misses and never sees the old account's value", async () => {
    const a = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: "account-a" });
    const b = fakeVault("did:pkh:eip155:1:0xbbb", { [slot(LOC)]: "account-b" });
    expect(await getConnectorKey(a.tcw, LOC)).toEqual({ ok: true, data: "account-a" });
    expect(await getConnectorKey(b.tcw, LOC)).toEqual({ ok: true, data: "account-b" });
    expect(b.gets()).toBe(1);
    // Switching back must not resurrect account A's entry either.
    expect(await getConnectorKey(a.tcw, LOC)).toEqual({ ok: true, data: "account-a" });
    expect(a.gets()).toBe(2);
  });

  test("the same address on a new tcw instance (re-sign-in / session expiry) misses", async () => {
    const first = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: "before" });
    const second = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: "after" });
    expect(await getConnectorKey(first.tcw, LOC)).toEqual({ ok: true, data: "before" });
    expect(await getConnectorKey(second.tcw, LOC)).toEqual({ ok: true, data: "after" });
    expect(second.gets()).toBe(1);
  });

  test("locking the vault clears the cache; the locked read is an error, not a stale hit", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    await getConnectorKey(v.tcw, LOC);
    v.setUnlocked(false);
    expect(await getConnectorKey(v.tcw, LOC)).toMatchObject({ ok: false, error: { code: "VAULT_LOCKED" } });
    v.setUnlocked(true);
    expect(await getConnectorKey(v.tcw, LOC)).toEqual({ ok: true, data: VALUE });
    expect(v.gets()).toBe(3);
  });

  test("put updates the entry", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: "old" });
    await getConnectorKey(v.tcw, LOC);
    expect((await saveConnectorKey(v.tcw, LOC, "new")).ok).toBe(true);
    expect(await getConnectorKey(v.tcw, LOC)).toEqual({ ok: true, data: "new" });
    expect(v.gets()).toBe(1);
  });

  test("a failed put evicts the entry", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: "old" });
    await getConnectorKey(v.tcw, LOC);
    (v.tcw.secrets as unknown as { put: () => Promise<Outcome> }).put = async () => ({
      ok: false,
      error: { code: "BOOM", message: "failed" },
    });
    expect((await saveConnectorKey(v.tcw, LOC, "new")).ok).toBe(false);
    await getConnectorKey(v.tcw, LOC);
    expect(v.gets()).toBe(2);
  });

  test("delete invalidates the entry", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    await getConnectorKey(v.tcw, LOC);
    expect((await deleteConnectorKey(v.tcw, LOC)).ok).toBe(true);
    expect(await getConnectorKey(v.tcw, LOC)).toMatchObject({ ok: false, error: { code: "KEY_NOT_FOUND" } });
    expect(v.gets()).toBe(2);
  });

  test("a failed read is not cached, so the retry reaches the vault", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    v.failNextGet({ code: "VAULT_LOCKED", message: "Vault is locked" });
    expect(await getConnectorKey(v.tcw, LOC)).toMatchObject({ ok: false });
    expect(await getConnectorKey(v.tcw, LOC)).toEqual({ ok: true, data: VALUE });
    expect(v.gets()).toBe(2);
  });

  test("a read that throws is not cached and does not wedge later reads", async () => {
    const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
    const real = v.tcw.secrets.get.bind(v.tcw.secrets);
    let blow = true;
    (v.tcw.secrets as unknown as { get: typeof real }).get = (async (...args: Parameters<typeof real>) => {
      if (blow) {
        blow = false;
        throw new Error("network down");
      }
      return real(...args);
    }) as typeof real;
    await expect(getConnectorKey(v.tcw, LOC)).rejects.toThrow("network down");
    expect(await getConnectorKey(v.tcw, LOC)).toEqual({ ok: true, data: VALUE });
  });

  test("nothing is written to localStorage, sessionStorage or indexedDB", async () => {
    const writes: string[] = [];
    const storageStub = () => ({
      getItem: () => null,
      setItem: () => void writes.push("setItem"),
      removeItem: () => void writes.push("removeItem"),
      clear: () => void writes.push("clear"),
      key: () => null,
      length: 0,
    });
    const local = storageStub();
    const session = storageStub();
    const idbOpen = () => {
      writes.push("indexedDB.open");
      throw new Error("indexedDB must not be used");
    };
    const g = globalThis as Record<string, unknown>;
    const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage, indexedDB: g.indexedDB };
    g.localStorage = local;
    g.sessionStorage = session;
    g.indexedDB = { open: idbOpen, deleteDatabase: idbOpen };
    const setSpy = spyOn(local, "setItem");
    try {
      const v = fakeVault("did:pkh:eip155:1:0xaaa", { [slot(LOC)]: VALUE });
      await getConnectorKey(v.tcw, LOC);
      await getConnectorKey(v.tcw, LOC);
      await saveConnectorKey(v.tcw, LOC, "new");
      await deleteConnectorKey(v.tcw, LOC);
      clearVaultSecretCache();
    } finally {
      g.localStorage = saved.localStorage;
      g.sessionStorage = saved.sessionStorage;
      g.indexedDB = saved.indexedDB;
    }
    expect(writes).toEqual([]);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
