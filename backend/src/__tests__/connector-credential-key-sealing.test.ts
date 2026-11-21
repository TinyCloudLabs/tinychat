import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ConnectorKeyStore } from "../services/connector-key-store.js";
import { CredentialStore, InMemoryCredentialRowStore } from "../services/credential-store.js";
import { useRealConnectorStorageInTests } from "./connector-real-storage-test-setup.js";

useRealConnectorStorageInTests();

const SOURCE = "fireflies";
const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER_OWNER = "0x2222222222222222222222222222222222222222";
const fixtureSecret = { kind: "oauth", accessToken: "synthetic-access-token" } as const;
const free: Array<() => void> = [];
afterEach(() => { for (const cleanup of free.splice(0)) cleanup(); });

function fixture() {
  const dir = mkdtempSync("/var/tmp/tc2778-credential-");
  let keys = ConnectorKeyStore.open(dir);
  free.push(() => { keys.close(); rmSync(dir, { recursive: true, force: true }); });
  const rows = new InMemoryCredentialRowStore();
  return {
    get keys() { return keys; },
    rows,
    create: () => new CredentialStore(rows, { credentialKeys: keys }),
    loseFile() {
      keys.close();
      unlinkSync(join(dir, "connector-keys.json"));
      keys = ConnectorKeyStore.open(dir);
    },
  };
}

const input = { source: SOURCE, address: OWNER, secret: fixtureSecret };

test("disconnect destroys the credential key before the row CAS and a new sign-in has a fresh key", async () => {
  const f = fixture();
  const store = f.create();
  await store.store(input);
  const old = (await f.rows.read(SOURCE, OWNER))!;
  expect(old.keyId === undefined).toBe(false);
  expect(await store.getCredential(SOURCE, OWNER, "fetch-worker")).toEqual(fixtureSecret);
  await store.rotate({ ...input, secret: { kind: "oauth", accessToken: "synthetic-refresh" } });
  expect((await f.rows.read(SOURCE, OWNER))!.keyId === old.keyId).toBe(true);
  const actualRemove = f.rows.remove.bind(f.rows);
  f.rows.remove = async (...args) => {
    expect(f.keys.getCredentialKey(old.keyId!)).toBeNull();
    return actualRemove(...args);
  };
  expect((await store.revoke(SOURCE, OWNER)).deleted).toBe(true);
  expect(await f.rows.read(SOURCE, OWNER)).toBeNull();

  await store.store(input);
  const fresh = (await f.rows.read(SOURCE, OWNER))!;
  expect(fresh.keyId !== old.keyId).toBe(true);
  await f.rows.write(old);
  await expect(store.getCredential(SOURCE, OWNER, "fetch-worker")).rejects.toThrow("credential envelope is unreadable");
}, 20_000);

test("a failed row delete leaves unreadable ciphertext and an idempotent retry removes it", async () => {
  const f = fixture();
  const store = f.create();
  await store.store(input);
  const row = (await f.rows.read(SOURCE, OWNER))!;
  const actualRemove = f.rows.remove.bind(f.rows);
  f.rows.remove = async () => { throw new Error("Row delete unavailable"); };
  await expect(store.revoke(SOURCE, OWNER)).rejects.toThrow("Row delete unavailable");
  expect(await f.rows.read(SOURCE, OWNER)).not.toBeNull();
  expect(f.keys.getCredentialKey(row.keyId!)).toBeNull();
  await expect(store.getCredential(SOURCE, OWNER, "fetch-worker")).rejects.toThrow("credential envelope is unreadable");
  f.rows.remove = actualRemove;
  expect((await store.revoke(SOURCE, OWNER)).deleted).toBe(true);
  expect(await f.rows.read(SOURCE, OWNER)).toBeNull();
}, 20_000);

test("a swapped row neither opens nor destroys the other owner's key", async () => {
  const f = fixture();
  const store = f.create();
  await store.store(input);
  await store.store({ ...input, address: OTHER_OWNER });
  const other = (await f.rows.read(SOURCE, OTHER_OWNER))!;
  await f.rows.write({ ...other, address: OWNER });
  await expect(store.getCredential(SOURCE, OWNER, "fetch-worker")).rejects.toThrow("credential envelope is unreadable");
  await store.revoke(SOURCE, OWNER);
  expect(await store.getCredential(SOURCE, OTHER_OWNER, "fetch-worker")).toEqual(fixtureSecret);
}, 20_000);

test("losing the volume requires a new sign-in and leaves the old row unreadable", async () => {
  const f = fixture();
  await f.create().store(input);
  const old = (await f.rows.read(SOURCE, OWNER))!;
  f.loseFile();
  const restarted = f.create();
  expect(await restarted.status(SOURCE, OWNER)).toBeNull();
  await expect(restarted.getCredential(SOURCE, OWNER, "fetch-worker")).rejects.toThrow("credential envelope is unreadable");
  await restarted.store(input);
  expect((await f.rows.read(SOURCE, OWNER))!.keyId !== old.keyId).toBe(true);
}, 20_000);
