// TC-3804 on a real node: a Fireflies key an older TinyChat sealed to the network key is resealed to its own key by
// the owner's foreground read, and afterwards a session holding only the network decrypt can no longer open it.
// Needs a node binary built with named keys: TC_REPLICATION_E2E_NODE_BIN=/path/to/tinycloud bun test <this file>.
// Skipped without it (CI has none).
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type * as NodeSdk from "@tinycloud/node-sdk";
import { secretKeyPath } from "@tinycloud/sdk-services";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { readWithConnectorKeyAccess, resetConnectorKeyAccessForTests } from "./connectorKeyAccess";
import { getConnectorKey, resetVaultSecretCacheForTests } from "./connectorSecrets";
import { CONNECTORS } from "./registry";

// Never touch a real home.
const testHome = mkdtempSync("/var/tmp/tc-3804-reseal.");
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]) process.env[name] = testHome;
afterAll(() => rmSync(testHome, { recursive: true, force: true }));

const nodeBinary = process.env.TC_REPLICATION_E2E_NODE_BIN;
const fireflies = CONNECTORS.find((d) => d.id === "fireflies")!;
const VAULT_KEY = `vault/secrets/${fireflies.secretName}`;
const V1_VALUE = "ff-key-sealed-by-an-older-tinychat";

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<number>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return listening.reject(new Error("No local node port"));
    server.close(() => listening.resolve(address.port));
  });
  return listening.promise;
}

/** A throwaway node with named keys on, as js-sdk's `startLocalNode` (node-sdk test-support) starts it. */
async function startLocalNode(binary: string): Promise<{ host: string; stop: () => Promise<void> }> {
  const directory = await mkdtemp("/var/tmp/tc-3804-reseal-node-");
  const port = await freePort();
  const child: ChildProcess = spawn(binary, [], {
    cwd: directory,
    env: {
      ...process.env,
      TINYCLOUD_STORAGE__DATADIR: join(directory, "data"),
      TINYCLOUD_PORT: String(port),
      TINYCLOUD_ADDRESS: "127.0.0.1",
      ROCKET_PORT: String(port),
      ROCKET_ADDRESS: "127.0.0.1",
      TINYCLOUD_KEYS__TYPE: "Static",
      TINYCLOUD_KEYS__SECRET: randomBytes(48).toString("base64url"),
      TINYCLOUD_ENCRYPTION_NETWORK__NAMED_KEYS_V1: "true",
      TINYCLOUD_ENCRYPTION_NETWORK__DELETION_LEDGER_PATH: join(directory, "deletions.jsonl"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = Promise.withResolvers<void>();
      child.once("exit", () => exited.resolve());
      child.kill("SIGTERM");
      await exited.promise;
    }
    await rm(directory, { recursive: true, force: true });
  };
  const launched = Promise.withResolvers<void>();
  const timer = setTimeout(() => launched.reject(new Error("Real node did not become ready")), 45_000);
  let output = "";
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("Rocket has launched")) launched.resolve();
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  child.once("error", launched.reject);
  child.once("exit", (code) => launched.reject(new Error(`Real node exited before readiness (${code})`)));
  try {
    await launched.promise;
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { host: `http://127.0.0.1:${port}`, stop };
}

describe.skipIf(!nodeBinary)("a network-sealed connector key on a real node", () => {
  let node: { host: string; stop: () => Promise<void> } | undefined;
  let registry: ReturnType<typeof Bun.serve> | undefined;
  let owner: NodeSdk.TinyCloudNode;
  // Loaded only when the test runs, so a skipped run never resolves the node SDK.
  let nodeSdk: typeof NodeSdk;
  let address: string;
  let secretsSpace: string;
  let networkId: string;

  // A session holding only the network decrypt and the record's kv get: what the sign-in's grant gives.
  async function networkDecryptOnly() {
    const child = new nodeSdk.TinyCloudNode({ host: node!.host, tinycloudRegistryUrl: registry!.url.origin, autoBootstrapAccount: false });
    const issued = await owner.delegateTo(child.did.split("#")[0]!, [
      { service: "tinycloud.kv", space: secretsSpace, path: VAULT_KEY, actions: ["get"] },
      { service: "tinycloud.encryption", path: networkId, actions: ["tinycloud.encryption/decrypt"] },
    ], { expiry: "1h", disableSubDelegation: true });
    return child.useDelegation(issued.delegation);
  }

  beforeAll(async () => {
    nodeSdk = await import("@tinycloud/node-sdk");
    const { composeManifestRequest, REGISTRY_NOT_FOUND_BODY } = await import("@tinycloud/sdk-core");
    registry = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => /^\/v[12]\/locations\/[^/]+$/.test(new URL(request.url).pathname)
        ? new Response(REGISTRY_NOT_FOUND_BODY, { status: 404, headers: { "content-type": "application/json" } })
        : new Response("unexpected registry request", { status: 400 }),
    });
    node = await startLocalNode(nodeBinary!);

    // The owner's session holds the network decrypt (the sign-in) and decrypt + key.create on the connector's own
    // key: the grant TinyChat asks OpenKey for, signed into the session here because a node has no OpenKey.
    const privateKey = randomBytes(32).toString("hex");
    address = await new nodeSdk.PrivateKeySigner(privateKey).getAddress();
    const ownerNetwork = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
    const capabilityRequest = composeManifestRequest([{
      app_id: "tc-3804-reseal.test", name: "TC-3804 reseal e2e", prefix: "", space: "default", defaults: "all",
      permissions: [{ service: "tinycloud.kv", space: "secrets", path: "vault/secrets/", actions: ["get", "put", "del", "list", "metadata"] }],
    }]);
    capabilityRequest.resources.push(
      { service: "tinycloud.encryption", space: "encryption", path: ownerNetwork, actions: ["tinycloud.encryption/decrypt"], skipPrefix: true },
      {
        service: "tinycloud.encryption", space: "encryption", path: `${ownerNetwork}/${secretKeyPath(fireflies.secretName)}`,
        actions: ["tinycloud.encryption/decrypt", "tinycloud.encryption/key.create"], skipPrefix: true,
      },
    );
    owner = new nodeSdk.TinyCloudNode({
      host: node.host,
      tinycloudRegistryUrl: registry.url.origin,
      privateKey,
      domain: "tc-3804-reseal.test",
      autoCreateSpace: true,
      capabilityRequest,
    });
    await owner.signIn();
    await owner.waitForAccountRegistrySync();
    secretsSpace = await owner.ensureOwnedSpaceHosted("secrets");
    networkId = (await owner.ensureEncryptionNetwork()).networkId;

    // What an older TinyChat left: the key sealed to the network key. `getBaseVault` is private; only a vault write
    // without a key path can make one now (js-sdk DelegatedAccess.encryption.e2e.test.ts does the same).
    const ownerVaults = owner as unknown as {
      getBaseVault(space: string): { put(key: string, value: unknown): Promise<{ ok: boolean }> };
    };
    const now = new Date().toISOString();
    const v1 = await ownerVaults.getBaseVault(secretsSpace).put(`secrets/${fireflies.secretName}`, {
      value: V1_VALUE, createdAt: now, updatedAt: now,
    });
    expect(v1.ok).toBe(true);
  }, 180_000);

  afterAll(async () => {
    await node?.stop();
    registry?.stop(true);
  });

  test("the owner's foreground read reseals it to its own key; network decrypt alone no longer opens it", async () => {
    resetConnectorKeyAccessForTests();
    resetVaultSecretCacheForTests();

    // Before: the sign-in's network decrypt opens the old copy.
    const before = await networkDecryptOnly();
    expect(await before.readSecret({ name: fireflies.secretName })).toEqual({ status: "ok", value: V1_VALUE });

    // TinyChat's read, through the SDK's secrets service for the owner's secrets space.
    const secrets = owner.secretsForSpace(secretsSpace);
    const gets: unknown[] = [];
    const tcw = {
      did: owner.did,
      session: () => ({ address, chainId: 1 }),
      secrets: new Proxy(secrets, {
        get(target, property, receiver) {
          if (property !== "get") return Reflect.get(target, property, receiver);
          return (name: string, options?: unknown) => (gets.push(options), target.get(name, options as never));
        },
      }),
    } as unknown as TinyCloudWeb;
    let asks = 0;
    const read = await readWithConnectorKeyAccess(tcw, fireflies, () => getConnectorKey<unknown>(tcw, fireflies), {
      ask: async () => (asks++, "granted"),
    });
    expect(read).toEqual({ ok: true, data: V1_VALUE });
    expect(asks).toBe(0);
    expect(gets).toEqual([{ namedKeyOnly: true }, { namedKeyOnly: true }]);

    // After: one wrap, to the connector's own key; network decrypt alone is refused.
    const after = await networkDecryptOnly();
    const record = await after.kv.get(VAULT_KEY);
    expect(record.ok).toBe(true);
    const envelope = (record.ok ? record.data.data : undefined) as Record<string, unknown>;
    expect(envelope).toMatchObject({ v: 2, keyPath: secretKeyPath(fireflies.secretName), networkId });
    expect(Object.keys(envelope).sort()).toEqual([
      "aad", "alg", "ciphertext", "encryptedSymmetricKey", "encryptedSymmetricKeyHash", "keyPath", "keyVersion", "metadata", "networkId", "v",
    ]);
    const refused = await after.readSecret({ name: fireflies.secretName });
    expect(refused).not.toHaveProperty("value");
    expect(refused.status).toBe("permission_required");

    // A second read needs no reseal.
    resetVaultSecretCacheForTests();
    gets.length = 0;
    expect(await getConnectorKey<unknown>(tcw, fireflies)).toEqual({ ok: true, data: V1_VALUE });
    expect(gets).toEqual([{ namedKeyOnly: true }]);
  }, 180_000);
});
