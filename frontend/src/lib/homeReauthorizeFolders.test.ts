import { expect, test } from "bun:test";
import type { ISessionStorage, PermissionEntry, PersistedSessionData, TinyCloudWeb } from "@tinycloud/web-sdk";
import { reauthorizeHome, type HomeReauthorizeDeps } from "./homeReauthorize";
import { connectorKeyDecryptGrants, encryptionDecryptGrant } from "./connectors/encryptionGrant";
import { WEB_APP_MANIFEST } from "./webSignInPrefetch";

const ADDRESS = "0x00000000000000000000000000000000000000A1";
const OLD = { tag: "old session" } as unknown as PersistedSessionData;
const NEW = { tag: "new session" } as unknown as PersistedSessionData;
const MASTER_PATH = encryptionDecryptGrant(ADDRESS).path;
const FOLDER_PATHS = connectorKeyDecryptGrants(ADDRESS).map((grant) => grant.path);

const isMaster = (entry: PermissionEntry) => entry.service === "tinycloud.encryption" && entry.path === MASTER_PATH;
const isFolder = (entry: PermissionEntry) => entry.service === "tinycloud.encryption" && FOLDER_PATHS.includes(entry.path);

/** An OpenKey approval whose signed approval lacks every entry `missing` picks: hasPermissions is true only when all asked about are covered. */
function approvedWithout(missing: (entry: PermissionEntry) => boolean) {
  const records = new Map<string, PersistedSessionData>([[ADDRESS, OLD]]);
  const storage: ISessionStorage = {
    save: async (address, data) => { records.set(address, data); },
    load: async (address) => records.get(address) ?? null,
    clear: async (address) => { records.delete(address); },
    exists: (address) => records.has(address),
    isAvailable: () => true,
  };
  const calls = { verified: 0, cleanup: 0, completed: 0 };
  const deps: HomeReauthorizeDeps = {
    connect: async () => ({ address: ADDRESS, openkey: { tag: "openkey" }, web3Provider: { request: async () => null } }),
    prefetch: {
      manifest: async () => WEB_APP_MANIFEST,
      nonceForSigning: async () => "nonce-1",
      guardSigning: (provider) => provider,
      complete: () => { calls.completed += 1; },
      cancel: () => {},
    },
    createTcw: (_provider, config) => ({
      signIn: async () => { await config.sessionStorage!.save(ADDRESS, NEW); return { siwe: "siwe", signature: "signature" }; },
      hasPermissions: (entries: PermissionEntry[]) => !entries.some(missing),
      cleanup: () => { calls.cleanup += 1; },
    }) as unknown as TinyCloudWeb,
    verify: async () => { calls.verified += 1; return { token: "bearer", expiresIn: 3600 }; },
    sessionStorage: storage,
  };
  return { deps, records, calls };
}

const input = { address: ADDRESS, features: ["connectors" as const], config: { autoCreateSpace: true }, canCommit: () => null };

test("the master decrypt grant allowed and the three folders turned down names the folders, and nothing is kept", async () => {
  const { deps, records, calls } = approvedWithout(isFolder);
  expect((await reauthorizeHome(deps, input)).outcome).toBe("partial-folders");
  expect(calls.verified).toBe(0);
  expect(calls.completed).toBe(0);
  expect(calls.cleanup).toBe(1);
  expect(records.get(ADDRESS)).toBe(OLD);
});

test("one folder turned down names the folders", async () => {
  const { deps } = approvedWithout((entry) => entry.path === FOLDER_PATHS[2]);
  expect((await reauthorizeHome(deps, input)).outcome).toBe("partial-folders");
});

test("the master decrypt grant turned down with the folders allowed stays the unlock outcome", async () => {
  const { deps, records } = approvedWithout(isMaster);
  expect((await reauthorizeHome(deps, input)).outcome).toBe("partial");
  expect(records.get(ADDRESS)).toBe(OLD);
});

test("both turned down is its own outcome", async () => {
  const { deps, records } = approvedWithout((entry) => isMaster(entry) || isFolder(entry));
  expect((await reauthorizeHome(deps, input)).outcome).toBe("partial-both");
  expect(records.get(ADDRESS)).toBe(OLD);
});

test("a folder turned down along with something else stays a plain failure", async () => {
  const { deps } = approvedWithout((entry) => isFolder(entry) || entry.service === "tinycloud.sql");
  expect((await reauthorizeHome(deps, input)).outcome).toBe("failed");
});
