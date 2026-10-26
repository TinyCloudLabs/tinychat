import { describe, expect, test } from "bun:test";
import manifest from "../../../../manifest.json";
import { TINYCHAT_KEY_PREFIX, CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import {
  connectorEnvelopeKvPath,
  connectorKeyPath,
  readNamedConnectorKey,
  readOrMigrateConnectorKey,
  saveNamedConnectorKey,
  type NamedConnectorClient,
} from "./namedConnectorSecrets";
import type { ConnectorDescriptor } from "./types";

const connector: ConnectorDescriptor = {
  id: "fireflies", name: "Fireflies", description: "", status: "available",
  secretName: "FIREFLIES_API_KEY", source: "fireflies",
};

function stub() {
  const rows = new Map<string, string>();
  const calls: string[] = [];
  let readbackOverride: string | undefined;
  const client: NamedConnectorClient = {
    keys: {
      async ensureKey(path) { calls.push(`ensure:${path}`); },
      async encrypt(path, bytes) {
        calls.push(`encrypt:${path}`);
        return { v: 2, keyPath: path, ciphertext: new TextDecoder().decode(bytes) };
      },
      async decrypt(envelope) {
        calls.push(`decrypt:${envelope.keyPath}`);
        return new TextEncoder().encode(readbackOverride ?? String(envelope.ciphertext));
      },
    },
    kv: {
      async get(path) {
        calls.push(`get:${path}`);
        const data = rows.get(path);
        return data === undefined
          ? { ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } }
          : { ok: true as const, data: { data } };
      },
      async put(path, value) { calls.push(`put:${path}`); rows.set(path, value); return { ok: true as const, data: undefined }; },
      async delete(path) { calls.push(`delete:${path}`); rows.delete(path); return { ok: true as const, data: undefined }; },
    },
  };
  return { client, rows, calls, overrideReadback: (value: string) => { readbackOverride = value; } };
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
    expect(result).toMatchObject({ ok: false, error: { code: "CONNECTOR_MIGRATION_DECLINED" } });
    expect(old.calls).toEqual([]);
    expect(s.rows.size).toBe(0);
  });

  test("read-back mismatch keeps the old vault copy", async () => {
    const s = stub();
    const old = oldVault("legacy-secret");
    s.overrideReadback("different");
    const result = await readOrMigrateConnectorKey(s.client, connector, async () => old.client as never);
    expect(result).toMatchObject({ ok: false, error: { code: "CONNECTOR_MIGRATION_MISMATCH" } });
    expect(old.calls).toEqual(["get:FIREFLIES_API_KEY"]);
    expect(s.rows.has(connectorEnvelopeKvPath(connector))).toBe(true);
  });
});
