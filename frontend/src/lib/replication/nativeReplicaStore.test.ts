import { describe, expect, test } from "bun:test";
import {
  base64ToBytes, bytesToBase64, createNativeReplicaStorage, isNativeReplicaEnabled, nativeReplicaPlugin,
  ReplicaStorageError, wipeNativeReplicaOnSignOut, type NativeReplicaOp, type TinyCloudReplicaStorePlugin,
} from "./nativeReplicaStore";

const ALICE = "did:pkh:eip155:1:0x00000000000000000000000000000000000a11ce";
const BOB = "did:pkh:eip155:1:0x0000000000000000000000000000000000000b0b";

function rejection(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** An in-memory plugin with the native contract's binding rules (one open account; wipe closes it). */
function fakePlugin() {
  const accounts = new Map<string, Map<string, string>>();
  const calls: string[] = [];
  let open: string | null = null;
  const data = () => {
    if (!open) throw rejection("NOT_OPEN");
    return accounts.get(open)!;
  };
  const plugin: TinyCloudReplicaStorePlugin = {
    async open({ account }) {
      calls.push(`open:${account}`);
      const created = !accounts.has(account);
      if (created) accounts.set(account, new Map());
      open = account;
      return { schemaVersion: 1, created };
    },
    async close() { calls.push("close"); open = null; },
    async get({ store, key }) { return { value: data().get(`${store}\0${key}`) ?? null }; },
    async getMany({ store, keys }) { return { values: keys.map((key) => data().get(`${store}\0${key}`) ?? null) }; },
    async list({ store, prefix = "", limit }) {
      const entries = [...data()].filter(([id]) => id.startsWith(`${store}\0${prefix}`))
        .map(([id, value]) => ({ key: id.slice(store.length + 1), value }))
        .sort((a, b) => (a.key < b.key ? -1 : 1));
      return { entries: limit === undefined ? entries : entries.slice(0, limit) };
    },
    async write({ ops }: { ops: NativeReplicaOp[] }) {
      const rows = data();
      calls.push(`write:${ops.length}`);
      for (const op of ops) {
        if (op.op === "put") rows.set(`${op.store}\0${op.key}`, op.value);
        else if (op.op === "delete") rows.delete(`${op.store}\0${op.key}`);
        else for (const id of [...rows.keys()]) if (id.startsWith(`${op.store}\0`)) rows.delete(id);
      }
    },
    async estimate() { return { usedBytes: data().size, freeBytes: null }; },
    async wipe({ account }) {
      calls.push(`wipe:${account}`);
      accounts.delete(account);
      if (open === account) open = null;
    },
    async wipeAll() { calls.push("wipeAll"); accounts.clear(); open = null; },
  };
  return { plugin, calls, accounts, raw: () => (open ? accounts.get(open) : undefined) };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (value: Uint8Array | null) => (value === null ? null : new TextDecoder().decode(value));

describe("native replica storage facade (TC-2862)", () => {
  test("base64 round-trips every byte value and large values", () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect([...base64ToBytes(bytesToBase64(all))]).toEqual([...all]);
    const large = new Uint8Array(200_000).map((_, index) => index % 251);
    expect(base64ToBytes(bytesToBase64(large))).toEqual(large);
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  test("stores bytes as base64 over the bridge and reads them back", async () => {
    const fake = fakePlugin();
    const handle = await createNativeReplicaStorage(fake.plugin).open({ account: ALICE });
    expect(handle.schemaVersion).toBe(1);
    expect(handle.created).toBe(true);
    await handle.write([
      { op: "put", store: "entries", key: "notes/a", value: bytes("hello") },
      { op: "put", store: "entries", key: "notes/b", value: new Uint8Array([0, 255]) },
    ]);
    expect(fake.raw()?.get("entries\0notes/a")).toBe(btoa("hello"));
    expect(text(await handle.get("entries", "notes/a"))).toBe("hello");
    expect(await handle.get("entries", "missing")).toBeNull();
    expect((await handle.getMany("entries", ["notes/b", "missing"])).map((v) => v && [...v])).toEqual([[0, 255], null]);
    const listed = await handle.list("entries", { prefix: "notes/", limit: 1 });
    expect(listed.map(({ key, value }) => [key, text(value)])).toEqual([["notes/a", "hello"]]);
    await handle.write([{ op: "delete", store: "entries", key: "notes/a" }, { op: "clear", store: "meta" }]);
    expect(await handle.get("entries", "notes/a")).toBeNull();
    expect(await handle.estimate()).toEqual({ usedBytes: 1, freeBytes: null });
  });

  test("a handle stops working once another account opens, instead of reading that account", async () => {
    const fake = fakePlugin();
    const storage = createNativeReplicaStorage(fake.plugin);
    const alice = await storage.open({ account: ALICE });
    await alice.write([{ op: "put", store: "s", key: "k", value: bytes("alice") }]);
    const bob = await storage.open({ account: BOB });
    expect(await bob.get("s", "k")).toBeNull();
    const error = await alice.get("s", "k").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReplicaStorageError);
    expect((error as ReplicaStorageError).code).toBe("ACCOUNT_MISMATCH");
    await alice.close();
    expect(fake.calls).not.toContain("close");
  });

  test("wipe ends the open handle", async () => {
    const fake = fakePlugin();
    const storage = createNativeReplicaStorage(fake.plugin);
    const handle = await storage.open({ account: ALICE });
    await storage.wipe(ALICE);
    await expect(handle.list("s")).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(fake.calls).toContain(`wipe:${ALICE}`);
  });

  test("native rejections keep their contract code; anything else reads as IO", async () => {
    const plugin = fakePlugin().plugin;
    const handle = await createNativeReplicaStorage({
      ...plugin,
      write: async () => { throw rejection("STORAGE_BUDGET", "too big"); },
      get: async () => { throw new Error("bridge went away"); },
      estimate: async () => { throw rejection("constructor"); },
    }).open({ account: ALICE });
    await expect(handle.write([])).rejects.toMatchObject({ code: "STORAGE_BUDGET", message: "too big" });
    await expect(handle.get("s", "k")).rejects.toMatchObject({ code: "IO" });
    await expect(handle.estimate()).rejects.toMatchObject({ code: "IO" });
  });

  test("open passes maxBytes only when given and refuses an empty account", async () => {
    const seen: unknown[] = [];
    const plugin = { ...fakePlugin().plugin, open: async (options: unknown) => { seen.push(options); return { schemaVersion: 1, created: false }; } };
    const storage = createNativeReplicaStorage(plugin as TinyCloudReplicaStorePlugin);
    await storage.open({ account: ALICE });
    await storage.open({ account: ALICE, maxBytes: 100 });
    expect(seen).toEqual([{ account: ALICE }, { account: ALICE, maxBytes: 100 }]);
    await expect(storage.open({ account: "" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("native replica flag and availability (TC-2862)", () => {
  const plugin = fakePlugin().plugin;

  test("off unless the build flag is exactly \"true\" and the shell has the plugin", () => {
    expect(isNativeReplicaEnabled({ buildFlag: undefined, plugin })).toBe(false);
    expect(isNativeReplicaEnabled({ buildFlag: "false", plugin })).toBe(false);
    expect(isNativeReplicaEnabled({ buildFlag: "1", plugin })).toBe(false);
    expect(isNativeReplicaEnabled({ buildFlag: "true", plugin: null })).toBe(false);
    expect(isNativeReplicaEnabled({ buildFlag: "true", plugin })).toBe(true);
  });

  test("the default build leaves it off", () => {
    expect(isNativeReplicaEnabled()).toBe(false);
  });

  test("only the phone apps with the plugin get one", () => {
    expect(nativeReplicaPlugin("web", () => true)).toBeNull();
    expect(nativeReplicaPlugin("tauri", () => true)).toBeNull();
    expect(nativeReplicaPlugin("ios", () => false)).toBeNull();
    expect(nativeReplicaPlugin("android", () => true)).not.toBeNull();
  });
});

describe("sign-out wipe (TC-2862, TC-2785 rule)", () => {
  test("deletes the account's copy, then every account's", async () => {
    const fake = fakePlugin();
    const storage = createNativeReplicaStorage(fake.plugin);
    const alice = await storage.open({ account: ALICE });
    await alice.write([{ op: "put", store: "s", key: "k", value: bytes("v") }]);
    await storage.open({ account: BOB });
    expect(await wipeNativeReplicaOnSignOut(ALICE, fake.plugin)).toEqual({ ok: true, skipped: false });
    expect(fake.calls.slice(-2)).toEqual([`wipe:${ALICE}`, "wipeAll"]);
    expect(fake.accounts.size).toBe(0);
  });

  test("with no known account it still wipes everything", async () => {
    const fake = fakePlugin();
    expect(await wipeNativeReplicaOnSignOut(null, fake.plugin)).toEqual({ ok: true, skipped: false });
    expect(fake.calls).toEqual(["wipeAll"]);
  });

  test("a shell without the plugin has nothing to wipe", async () => {
    expect(await wipeNativeReplicaOnSignOut(ALICE, null)).toEqual({ ok: true, skipped: true });
  });

  test("never throws; reports the failure code", async () => {
    const plugin = { ...fakePlugin().plugin, wipeAll: async () => { throw rejection("IO", "disk"); } };
    expect(await wipeNativeReplicaOnSignOut(ALICE, plugin)).toEqual({ ok: false, code: "IO" });
  });
});
