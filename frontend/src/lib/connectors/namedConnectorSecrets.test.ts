import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import manifest from "../../../../manifest.json";
import { TINYCHAT_KEY_PREFIX, CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import { resolveManifest } from "@tinycloud/sdk-core";
import {
  connectorEnvelopeKvPath,
  connectorKeyPath,
  deleteConnectorCredentials,
  getConnectorKey,
  isConnectorKeysReady,
  readNamedConnectorKey,
  readOrMigrateConnectorKey,
  saveNamedConnectorKey,
  sessionHasConnectorKeyGrant,
} from "./namedConnectorSecrets";
import { setSecretsAvailableForTests } from "../openkeyNative";
import type { ConnectorDescriptor } from "./types";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const connector: ConnectorDescriptor = {
  id: "fireflies", name: "Fireflies", description: "", status: "available",
  secretName: "FIREFLIES_API_KEY", source: "fireflies",
};
const googleConnector: ConnectorDescriptor = {
  id: "google-meet", name: "Google Meet", description: "", status: "available",
  secretName: "REFRESH_TOKEN", secretScope: "google-meet", source: "google-meet",
};
const address = "0x00000000000000000000000000000000000000aa";
const legacyPath = "vault/secrets/FIREFLIES_API_KEY";
const secretsSpace = "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000000AA:secrets";

function stub() {
  const rows = new Map<string, string>();
  const legacyRows = new Map<string, string>();
  const calls: string[] = [];
  let readbackOverride: string | undefined;
  let readbackFails = false;
  let legacyDeleteFails = false;
  let siwe = "";
  const client = {
    session: () => ({ address, walletAddress: address, chainId: 1, siwe }),
    keys: {
      async ensureKey(path: string) { calls.push(`ensure:${path}`); },
      async encrypt(path: string, bytes: Uint8Array) {
        calls.push(`encrypt:${path}`);
        return { v: 2, keyPath: path, ciphertext: new TextDecoder().decode(bytes) };
      },
      async decrypt(envelope: { keyPath: string; ciphertext?: unknown }) {
        calls.push(`decrypt:${envelope.keyPath}`);
        if (readbackFails) throw new Error("read-back failed");
        return new TextEncoder().encode(readbackOverride ?? String(envelope.ciphertext));
      },
    },
    kv: {
      async get(path: string) {
        calls.push(`get:${path}`);
        const data = rows.get(path);
        return data === undefined
          ? { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } }
          : { ok: true as const, data: { data } };
      },
      async put(path: string, value: string) { calls.push(`put:${path}`); rows.set(path, value); return { ok: true as const, data: undefined }; },
      async delete(path: string) { calls.push(`delete:${path}`); rows.delete(path); return { ok: true as const, data: undefined }; },
    },
    kvForSpace(space: string) {
      if (space !== secretsSpace) throw new Error(`Wrong secrets space: ${space}`);
      return { delete: async (path: string) => {
        calls.push(`delete-legacy:${path}`);
        if (legacyDeleteFails) return { ok: false as const, error: { code: "KV_REFUSED", message: "Could not remove the old credential" } };
        if (!legacyRows.delete(path)) return { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } };
        return { ok: true as const, data: undefined };
      } };
    },
    secrets: { isUnlocked: false, delete: async () => { throw new Error("vault delete must not run"); } },
  } as unknown as TinyCloudWeb;
  return { client, rows, legacyRows, calls,
    overrideReadback: (value: string) => { readbackOverride = value; },
    failReadback: () => { readbackFails = true; },
    failLegacyDelete: () => { legacyDeleteFails = true; },
    setSiwe: (value: string) => { siwe = value; } };
}

function oldVault(value: string) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      secrets: {
        isUnlocked: true,
        async get(name: string) {
          calls.push(`get:${name}`);
          return { ok: true as const, data: value };
        },
        async delete(name: string) {
          calls.push(`delete:${name}`);
          return { ok: true as const, data: undefined };
        },
      },
    },
  };
}

describe("TinyChat connector named keys", () => {
  let previousWindow: PropertyDescriptor | undefined;
  beforeAll(() => {
    previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "https://tinycloud.chat" } } });
  });
  afterAll(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  test("normal sign-in manifest requests the named-key row without bare-network decrypt", () => {
    expect(manifest.keys_app_id).toBe("chat.tinycloud.tinychat");
    expect(manifest.keys).toEqual([{ prefix: TINYCHAT_KEY_PREFIX, abilities: ["key.create", "decrypt"] }]);
    expect(manifest.permissions.some((entry) => entry.service === "tinycloud.encryption" && entry.actions.includes("decrypt"))).toBe(false);
    expect(manifest.app_id).toBe("xyz.tinycloud.tinychat");
  });
  test("uses one host-bound prefix and a connector record beside existing KV data", () => {
    expect(connectorKeyPath(connector)).toBe(`${TINYCHAT_KEY_PREFIX}connectors/fireflies`);
    expect(connectorEnvelopeKvPath(connector)).toBe(`${CONNECTORS_KV_PREFIX}/credentials/fireflies`);
  });

  test("the manifest grants exact secrets-space deletes for locked-vault cleanup", () => {
    const resources = resolveManifest(manifest).resources;
    for (const path of [legacyPath, "vault/secrets/scoped/google-meet/REFRESH_TOKEN"]) {
      expect(resources).toContainEqual(expect.objectContaining({
        service: "tinycloud.kv", space: "secrets", path,
        actions: expect.arrayContaining(["tinycloud.kv/del"]),
      }));
    }
  });

  test("readiness follows the signed connector decrypt row, not the keys accessor", () => {
    const s = stub();
    expect(isConnectorKeysReady(s.client)).toBe(false);
    const resource = `urn:tinycloud:encryption:did:pkh:eip155:1:0x00000000000000000000000000000000000000AA:default/${TINYCHAT_KEY_PREFIX}`;
    const signed = (path: string, caveats: unknown[]) => `Resources:\n- urn:recap:${Buffer.from(JSON.stringify({ att: { [path]: { "tinycloud.encryption/decrypt": caveats } } })).toString("base64url")}`;
    s.setSiwe(signed(resource.replace(TINYCHAT_KEY_PREFIX, "apps/other/"), [{}]));
    expect(isConnectorKeysReady(s.client)).toBe(false);
    s.setSiwe(signed(resource.replace("00AA:default", "00BB:default"), [{}]));
    expect(isConnectorKeysReady(s.client)).toBe(false);
    s.setSiwe(signed(resource, [{ constrained: true }]));
    expect(isConnectorKeysReady(s.client)).toBe(false);
    s.setSiwe(signed(resource, [{}]));
    expect(isConnectorKeysReady(s.client)).toBe(true);
    setSecretsAvailableForTests(false);
    try {
      expect(sessionHasConnectorKeyGrant(s.client)).toBe(true);
      expect(isConnectorKeysReady(s.client)).toBe(false);
    } finally { setSecretsAvailableForTests(null); }
  });

  test("an absent envelope requests one approval with the connector name", async () => {
    const s = stub();
    expect(await getConnectorKey(s.client, connector)).toEqual({
      ok: false,
      error: { code: "CONNECTOR_MIGRATION_REQUIRED", message: "Approve once to move your saved Fireflies key." },
    });
  });

  test("an invalid envelope gives the disconnect and connect recovery steps", async () => {
    const s = stub();
    s.rows.set(connectorEnvelopeKvPath(connector), "not-json");
    expect(await readNamedConnectorKey(s.client, connector)).toEqual({
      ok: false,
      error: { code: "CONNECTOR_ENVELOPE_INVALID", message: "This saved Fireflies key can't be read. To fix it, disconnect Fireflies and connect it again." },
    });
  });

  test("saves a v2 envelope and reads the same secret through named keys", async () => {
    const s = stub();
    expect(await saveNamedConnectorKey(s.client, connector, "secret-a")).toEqual({ ok: true, data: undefined });
    expect(JSON.parse(s.rows.get(connectorEnvelopeKvPath(connector))!)).toEqual({
      v: 2, keyPath: connectorKeyPath(connector), ciphertext: "secret-a",
    });
    expect(await readNamedConnectorKey(s.client, connector)).toEqual({ ok: true, data: "secret-a" });
    expect(s.calls).toEqual([
      `ensure:${connectorKeyPath(connector)}`, `encrypt:${connectorKeyPath(connector)}`,
      `put:${connectorEnvelopeKvPath(connector)}`, `get:${connectorEnvelopeKvPath(connector)}`,
      `decrypt:${connectorKeyPath(connector)}`,
    ]);
  });

  test("approval migrates an old vault secret and verifies the saved envelope before returning", async () => {
    const s = stub();
    const old = oldVault("legacy-secret");
    const result = await readOrMigrateConnectorKey(s.client, connector, async () => old.client as never);
    expect(result).toEqual({ ok: true, data: "legacy-secret" });
    expect(old.calls).toEqual(["get:FIREFLIES_API_KEY"]);
    expect(s.rows.has(connectorEnvelopeKvPath(connector))).toBe(true);
    expect(s.calls.filter((call) => call === `get:${connectorEnvelopeKvPath(connector)}`)).toHaveLength(2);
  });

  test("declining step-up preserves the old secret and writes no envelope", async () => {
    const s = stub();
    const old = oldVault("legacy-secret");
    const result = await readOrMigrateConnectorKey(s.client, connector, async () => null);
    expect(result).toEqual({ ok: false, error: { code: "CONNECTOR_MIGRATION_DECLINED", message: "Not moved. Your Fireflies key is kept, but Fireflies won't work until you approve. You'll be asked again next time." } });
    expect(old.calls).toEqual([]);
    expect(s.rows.size).toBe(0);
  });

  test("read-back mismatch keeps the old vault copy", async () => {
    const s = stub();
    const old = oldVault("legacy-secret");
    s.overrideReadback("different");
    const result = await readOrMigrateConnectorKey(s.client, connector, async () => old.client as never);
    expect(result).toEqual({ ok: false, error: { code: "CONNECTOR_MIGRATION_MISMATCH", message: "Couldn't confirm the new copy, so your Fireflies key stays where it was." } });
    expect(old.calls).toEqual(["get:FIREFLIES_API_KEY"]);
    expect(s.rows.has(connectorEnvelopeKvPath(connector))).toBe(false);
  });

  test("failed read-back removes the pending envelope", async () => {
    const s = stub();
    const old = oldVault("legacy-secret");
    s.failReadback();
    const result = await readOrMigrateConnectorKey(s.client, connector, async () => old.client as never);
    expect(result.ok).toBe(false);
    expect(s.rows.has(connectorEnvelopeKvPath(connector))).toBe(false);
    expect(old.calls).toEqual(["get:FIREFLIES_API_KEY"]);
  });

  test("OpenKey cancellation returns the decline line", async () => {
    const s = stub();
    const result = await readOrMigrateConnectorKey(s.client, connector, async () => { throw { code: "USER_CANCELLED", message: "Request closed" }; });
    expect(result).toEqual({ ok: false, error: { code: "CONNECTOR_MIGRATION_DECLINED", message: "Not moved. Your Fireflies key is kept, but Fireflies won't work until you approve. You'll be asked again next time." } });
    expect(s.rows.size).toBe(0);
  });

  test("disconnect removes both credentials after migration with a locked vault", async () => {
    const s = stub();
    s.legacyRows.set(legacyPath, "legacy-secret");
    const old = oldVault("legacy-secret");
    expect((await readOrMigrateConnectorKey(s.client, connector, async () => old.client as never)).ok).toBe(true);
    expect(await deleteConnectorCredentials(s.client, connector)).toEqual({ ok: true, data: undefined });
    expect(s.legacyRows.size).toBe(0);
    expect(s.rows.size).toBe(0);
    expect(s.calls).toContain(`delete-legacy:${legacyPath}`);
  });

  test("disconnect removes an unmigrated credential with a locked vault", async () => {
    const s = stub();
    s.legacyRows.set(legacyPath, "legacy-secret");
    expect(await deleteConnectorCredentials(s.client, connector)).toEqual({ ok: true, data: undefined });
    expect(s.legacyRows.size).toBe(0);
    expect(s.rows.size).toBe(0);
  });

  test("disconnect removes an unmigrated scoped Google credential", async () => {
    const s = stub();
    const scopedPath = "vault/secrets/scoped/google-meet/REFRESH_TOKEN";
    s.legacyRows.set(scopedPath, "refresh-secret");
    expect(await deleteConnectorCredentials(s.client, googleConnector)).toEqual({ ok: true, data: undefined });
    expect(s.legacyRows.size).toBe(0);
    expect(s.calls).toContain(`delete-legacy:${scopedPath}`);
  });

  test("a refused legacy delete keeps the named envelope for retry", async () => {
    const s = stub();
    s.legacyRows.set(legacyPath, "legacy-secret");
    s.rows.set(connectorEnvelopeKvPath(connector), "envelope");
    s.failLegacyDelete();
    expect(await deleteConnectorCredentials(s.client, connector)).toEqual({ ok: false, error: { code: "KV_REFUSED", message: "Could not remove the old credential" } });
    expect(s.legacyRows.size).toBe(1);
    expect(s.rows.size).toBe(1);
  });
});
