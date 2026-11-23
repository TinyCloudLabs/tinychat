// Real v1 compatibility across the named-key writer switch, using a throwaway loopback node.
import { expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { botHistoryOwnerPermissions } from "../../../frontend/src/bots/historyAuthorization";
import { publishBotHistoryKeyDescriptor } from "../../../frontend/src/bots/botHistoryKey";
import { readBotHistory } from "../../../frontend/src/bots/historyRead";
import { webSignInManifest } from "../../../frontend/src/lib/homeFeatures";
import { WEB_APP_MANIFEST } from "../../../frontend/src/lib/webSignInPrefetch";
import { BOT_HISTORY_KEY_PATH, botHistoryNetworkId } from "../bot-history-key";
import { HISTORY_PREFIX, historyBotId, historyOwner } from "../bot-history";

const host = process.env.BOT_HISTORY_TEST_NODE;

test.skipIf(!host)("old network grant opens bot history v1 after the named-key reader switch", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const address = account.address;
  const networkId = botHistoryNetworkId(address);
  const node = new TinyCloudNode({
    privateKey, host, prefix: "applications", autoCreateSpace: true, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, manifest: webSignInManifest(WEB_APP_MANIFEST, [], address),
  });
  try {
    await node.signIn();
    await node.hostOwnedSpace("applications");
    await node.grantRuntimePermissions([{
      service: "tinycloud.encryption", path: networkId, skipPrefix: true, actions: ["network.create", "decrypt"],
    }], { expiry: 3_600_000, signMessage: message => account.signMessage({ message }) });
    await node.ensureEncryptionNetwork();
    const generation = "10".repeat(16);
    const challenge = "ab".repeat(32);
    const path = `${HISTORY_PREFIX}${historyBotId(address)}/${generation}/1-${challenge}`;
    const spaceId = makePkhSpaceId(address, 1, "applications");
    const aad = Buffer.from(JSON.stringify({ owner: historyOwner(address), spaceId, path }));
    const plaintext = Buffer.from(JSON.stringify({
      v: 1, generation, challenge, seq: 1, record: { type: "assistant", text: "legacy history" },
    }));
    const legacy = await node.encryption.encryptToNetwork(networkId, plaintext, { aad });
    if (!legacy.ok) throw new Error("legacy encryption failed");
    expect(legacy.data.v).toBe(1);
    expect(legacy.data).not.toHaveProperty("keyPath");
    expect((await node.kv.put(path, legacy.data, { prefix: "" })).ok).toBe(true);
    const tcw = {
      session: () => node.session, kvForSpace: () => node.kv, encryption: node.encryption, keys: node.keys,
      hasPermissions: node.hasRuntimePermissions.bind(node), signSessionBytes: node.signSessionBytes.bind(node),
    } as unknown as TinyCloudWeb;
    expect((await readBotHistory(tcw)).map(line => line.text)).toEqual(["legacy history"]);

    // The old network grant may decrypt v1 but cannot decrypt a named-key envelope.
    await node.grantRuntimePermissions(botHistoryOwnerPermissions(address).map(entry => ({
      ...entry, actions: ["key.create"],
    })), { expiry: 3_600_000, signMessage: message => account.signMessage({ message }) });
    const descriptor = await node.keys.ensureKey(BOT_HISTORY_KEY_PATH, { networkId });
    const named = await node.keys.encrypt(BOT_HISTORY_KEY_PATH, plaintext, { networkId, aad, descriptor });
    await expect(node.keys.decrypt(named)).rejects.toThrow();
    await node.grantRuntimePermissions(botHistoryOwnerPermissions(address), {
      expiry: 3_600_000, signMessage: message => account.signMessage({ message }),
    });
    expect(Buffer.from(await node.keys.decrypt(named))).toEqual(plaintext);

    await publishBotHistoryKeyDescriptor(tcw, descriptor, { post: async () => {} });
    const reports: unknown[] = [];
    expect((await readBotHistory(tcw, undefined, { reseal: true, onResealReport: report => reports.push(report) })).map(line => line.text))
      .toEqual(["legacy history"]);
    expect(reports).toEqual([{ resealed: 1, failed: [] }]);
    const resealed = await node.kv.get(path, { prefix: "", source: "network" });
    expect(resealed).toMatchObject({ ok: true, data: { data: { v: 2, keyPath: BOT_HISTORY_KEY_PATH } } });
  } finally { await node.signOut(); }
}, 60_000);
