import { describe, expect, test } from "bun:test";
import { TINYCHAT_KEY_PREFIX } from "@tinyboilerplate/core";
import { composeManifestRequest, type Manifest } from "@tinycloud/sdk-core";
import manifestJson from "../../../public/.well-known/openkey-manifest.json";
import { connectorSignInManifest, usesNamedConnectorKeys } from "./connectorKeyMode";
import { deleteConnectorCredentials, getConnectorKey, saveConnectorKey } from "./namedConnectorSecrets";
import { applyConnectorKeyRevisionGate, recordConnectorKeyRevision } from "./namedKeyRevision";
import type { ConnectorDescriptor } from "./types";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const manifest = manifestJson as Manifest;
const address = "0x00000000000000000000000000000000000000Aa";
const descriptor: ConnectorDescriptor = {
  id: "fireflies", name: "Fireflies", description: "", status: "available",
  secretName: "FIREFLIES_API_KEY", source: "fireflies",
};

async function withOrigin<T>(origin: string, run: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin } } });
  try { return await run(); } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

describe("connector key origin routing", () => {
  test("tinycloud.chat sign-in requests its named row and no vault-wide decrypt", async () => {
    await withOrigin("https://tinycloud.chat", async () => {
      expect(usesNamedConnectorKeys()).toBe(true);
      const request = composeManifestRequest([connectorSignInManifest(manifest, address)], { includeAccountRegistryPermissions: false });
      expect(request.manifests[0]?.keys).toEqual([{ prefix: TINYCHAT_KEY_PREFIX, abilities: ["key.create", "decrypt"] }]);
      expect(request.resources.filter((resource) => resource.service === "tinycloud.encryption")).toEqual([]);
    });
  });

  test("on tinycloud.chat the sign-in manifest is the served manifest itself, so OpenKey's digest check sees the file it fetches", async () => {
    await withOrigin("https://tinycloud.chat", async () => {
      expect(connectorSignInManifest(manifest, address)).toBe(manifest);
    });
  });

  test("desktop origin uses the legacy vault for connect, read and disconnect", async () => {
    await withOrigin("http://localhost", async () => {
      expect(usesNamedConnectorKeys()).toBe(false);
      const request = composeManifestRequest([connectorSignInManifest(manifest, address)], { includeAccountRegistryPermissions: false });
      expect(request.resources.filter((resource) => resource.service === "tinycloud.encryption" && resource.actions.includes("tinycloud.encryption/decrypt"))).toHaveLength(1);

      const values = new Map<string, string>();
      const calls: string[] = [];
      const client = {
        session: () => ({ address, chainId: 1 }),
        secrets: {
          isUnlocked: true,
          async put(name: string, value: string) { calls.push("vault-put"); values.set(name, value); return { ok: true as const, data: undefined }; },
          async get(name: string) { calls.push("vault-get"); return { ok: true as const, data: values.get(name) }; },
          delete: () => { throw new Error("vault delete must not run"); },
        },
        kvForSpace: () => ({ delete: async (path: string) => {
          if (path !== "vault/secrets/FIREFLIES_API_KEY") throw new Error(`Wrong legacy path: ${path}`);
          calls.push("vault-delete");
          values.delete(descriptor.secretName);
          return { ok: true as const, data: undefined };
        } }),
        keys: { ensureKey: () => { throw new Error("named key used on desktop"); } },
        kv: {
          put: () => { throw new Error("named envelope written on desktop"); },
          delete: async () => ({ ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } }),
        },
      } as unknown as TinyCloudWeb;
      expect(await saveConnectorKey(client, descriptor, "desktop-secret")).toEqual({ ok: true, data: undefined });
      expect(await getConnectorKey(client, descriptor)).toEqual({ ok: true, data: "desktop-secret" });
      expect(await deleteConnectorCredentials(client, descriptor)).toEqual({ ok: true, data: undefined });
      expect(values.size).toBe(0);
      expect(calls).toEqual(["vault-put", "vault-get", "vault-delete"]);

      const revision = new Map<string, string>();
      const store = { getItem: (key: string) => revision.get(key) ?? null, setItem: (key: string, value: string) => { revision.set(key, value); } };
      recordConnectorKeyRevision(store, address, manifest);
      expect(await applyConnectorKeyRevisionGate({
        store, address, isOffline: () => false, loadManifest: async () => manifest,
        handoff: async () => { throw new Error("sign-in loop"); },
        clearSession: () => { throw new Error("sign-in loop"); },
      })).toBe("current");
    });
  });

  test("desktop disconnect removes a named envelope when the legacy vault has no key", async () => {
    await withOrigin("http://localhost", async () => {
      const envelopePath = "xyz.tinycloud.tinychat/connectors/credentials/fireflies";
      const records = new Map([[envelopePath, "sealed-envelope"]]);
      const client = {
        session: () => ({ address, chainId: 1 }),
        kvForSpace: () => ({ delete: async () => ({ ok: false as const, error: { code: "KV_NOT_FOUND", message: "missing" } }) }),
        kv: {
          delete: async (path: string) => {
            records.delete(path);
            return { ok: true as const, data: undefined };
          },
        },
      } as unknown as TinyCloudWeb;
      expect(await deleteConnectorCredentials(client, descriptor)).toEqual({ ok: true, data: undefined });
      expect(records.size).toBe(0);
    });
  });

  test("desktop disconnect keeps the envelope when the legacy delete is refused", async () => {
    await withOrigin("http://localhost", async () => {
      const envelopePath = "xyz.tinycloud.tinychat/connectors/credentials/fireflies";
      const records = new Map([[envelopePath, "sealed-envelope"]]);
      const client = {
        session: () => ({ address, chainId: 1 }),
        kvForSpace: () => ({ delete: async () => ({ ok: false as const, error: { code: "KV_REFUSED", message: "Authorization refused" } }) }),
        kv: { delete: () => { throw new Error("envelope delete must not run"); } },
      } as unknown as TinyCloudWeb;
      expect(await deleteConnectorCredentials(client, descriptor)).toEqual({ ok: false, error: { code: "KV_REFUSED", message: "Authorization refused" } });
      expect(records.has(envelopePath)).toBe(true);
    });
  });

  test("preview and Windows desktop origins use the legacy vault", async () => {
    for (const origin of ["https://qa.tinychat-4jq.pages.dev", "https://tauri.localhost"]) {
      await withOrigin(origin, async () => { expect(usesNamedConnectorKeys()).toBe(false); });
    }
  });
});
