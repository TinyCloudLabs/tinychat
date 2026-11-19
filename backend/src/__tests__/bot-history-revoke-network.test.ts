// Loopback-only: what a TinyCloud node does when the holder of a bot's history grant revokes it (TC-3325). Deleting a
// bot depends on the answer. 127.0.0.1 only, throwaway keys and data, no production accounts, services or keys.
// Needs a local TinyCloud node: BOT_REVOKE_TEST_NODE=http://127.0.0.1:<port>.
//
// The client is given a stand-in location registry on this machine, and every request this process makes is checked:
// one to anything but 127.0.0.1 is refused, and the test fails.
import { afterAll, expect, test } from "bun:test";
import { TinyCloudNode, serializeDelegation } from "@tinycloud/node-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { botHistoryOwnerPermissions } from "../../../frontend/src/bots/historyAuthorization";
import { webSignInManifest } from "../../../frontend/src/lib/homeFeatures";
import { WEB_APP_MANIFEST } from "../../../frontend/src/lib/webSignInPrefetch";
import { BotHistory, HISTORY_PREFIX, historyBotId } from "../bot-history";
import { projectBotHistoryGrant } from "../bot-history-grant";
import { emptyLocationRegistry } from "./helpers/empty-location-registry.js";
import { loopbackOnly } from "./helpers/loopback-only.js";

const host = process.env.BOT_REVOKE_TEST_NODE;
const KEY_A = "ab".repeat(16);
const realFetch = globalThis.fetch;
const guard = loopbackOnly(realFetch);
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const cleanup of cleanups) await cleanup();
  if (guard.refused.length > 0) console.error(`requests refused because they were not to this machine: ${guard.refused.join(", ")}`);
});

/** A result or a thrown error, reduced to what is worth writing down. */
const seen = async (step: () => Promise<unknown>): Promise<string> => {
  try {
    const result = await step();
    if (typeof result === "object" && result !== null && "ok" in result) {
      if (result.ok === true) return "ok";
      const error = "error" in result && typeof result.error === "object" && result.error !== null ? result.error : {};
      return `refused ${JSON.stringify({ code: "code" in error ? error.code : undefined, status: "status" in error ? error.status : undefined, message: "message" in error ? String(error.message).slice(0, 160) : undefined })}`;
    }
    return "ok";
  } catch (error) {
    return `threw ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`;
  }
};

test.skipIf(!host)("real TinyCloud: the holder of a bot's history grant revokes it", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  globalThis.fetch = guard.fetch;
  const registry = await emptyLocationRegistry();
  cleanups.push(registry.close);
  const ownerKey = generatePrivateKey();
  const backendKey = generatePrivateKey();
  const address = privateKeyToAccount(ownerKey).address;
  const owner = new TinyCloudNode({ privateKey: ownerKey, host, prefix: "applications", autoCreateSpace: true, autoBootstrapAccount: false, includeAccountRegistryPermissions: false,
    manifest: webSignInManifest(WEB_APP_MANIFEST, [], address), tinycloudRegistryUrl: registry.url });
  const backend = new TinyCloudNode({ privateKey: backendKey, host, prefix: "bot-history-revoke-test", includeAccountRegistryPermissions: false, tinycloudRegistryUrl: registry.url });
  const directory = `${HISTORY_PREFIX}${historyBotId(address, KEY_A)}/`;
  const report: string[] = [];
  try {
    await owner.signIn(); await owner.hostOwnedSpace("applications");
    await owner.grantRuntimePermissions(botHistoryOwnerPermissions(address), { expiry: 3_600_000, signMessage: message => privateKeyToAccount(ownerKey).signMessage({ message }) });
    await backend.signIn(); await backend.hostOwnedSpace("bot-history-revoke-test");

    // The owner's grant for one bot other than Main, accepted and stored as the backend does.
    const issued = await owner.delegateTo(backend.did, [{ service: "tinycloud.kv", path: directory, actions: ["get", "put"] }], { expiry: 3_600_000 });
    const envelope = { serialized: serializeDelegation(issued.delegation), siwe: owner.session!.siwe, signature: owner.session!.signature };
    const history = new BotHistory(backend, backendKey, host!);
    await history.accept(address, envelope, KEY_A);
    const cid = await history.storedGrantCid(address, KEY_A);
    expect(cid).toBe(issued.delegation.cid);

    const grant = await projectBotHistoryGrant(backend, host!, address, envelope, KEY_A);
    const resource = grant.resources[0];
    const activate = () => backend.useDelegation({ cid: grant.cid, delegationHeader: { Authorization: grant.authorization }, spaceId: grant.spaceId,
      path: resource.path, actions: resource.actions, resources: [resource], expiry: grant.expiresAt,
      delegateDID: grant.backendDid, ownerAddress: grant.ownerAddress, chainId: grant.chainId, host: host! });

    // 1. Before: the grant works.
    const open = await activate();
    const before = await seen(() => open.kv.put(`${directory}probe-before`, { v: 1 }, { prefix: "" }));
    report.push(`before revocation, write under the grant: ${before}`);
    expect(before).toBe("ok");

    // 2. The holder revokes.
    const byHolder = await seen(() => backend.revokeDelegation(cid!));
    report.push(`holder revokes: ${byHolder}`);

    // 3. After: through the access that was already open, and through a fresh activation.
    // Seen against node 1.26.10 on 2026-11-19: the node refuses a revocation from the holder (403), and the grant
    // then works exactly as before. If a later node accepts it, this fails, and deleting a bot can do more than it does.
    expect(byHolder).toContain("403");
    expect(byHolder).toContain("Unauthorized Revoker");
    const afterOpen = await seen(() => open.kv.put(`${directory}probe-after-open`, { v: 1 }, { prefix: "" }));
    const afterFresh = await seen(async () => (await activate()).kv.put(`${directory}probe-after-fresh`, { v: 1 }, { prefix: "" }));
    const afterAccept = await seen(() => history.accept(address, envelope, KEY_A));
    report.push(`after, write through the access opened earlier: ${afterOpen}`, `after, activate again and write: ${afterFresh}`, `after, the backend accepts the same grant again: ${afterAccept}`);
    expect([afterOpen, afterFresh, afterAccept]).toEqual(["ok", "ok", "ok"]);

    // 4. If the holder was refused: what the owner, who issued it, can do.
    const byOwner = await seen(() => owner.revokeDelegation(cid!));
    const afterOwner = await seen(async () => (await activate()).kv.put(`${directory}probe-after-owner`, { v: 1 }, { prefix: "" }));
    report.push(`owner revokes: ${byOwner}`, `after the owner's revocation, activate again and write: ${afterOwner}`);
    expect(byOwner).toBe("ok");
    expect(afterOwner).toContain("parent_revoked");

    // 5. The stored copy is removed either way.
    await history.forget(address, KEY_A);
    expect(await history.storedGrantCid(address, KEY_A)).toBeUndefined();
    report.push("stored grant removed: ok");
  } finally {
    console.info(`REVOCATION RUN ${new Date().toISOString()}\n- ${report.join("\n- ")}\n- location registry stand-in asked ${registry.asked.length} time(s); requests refused by the guard: ${guard.refused.length}`);
    await owner.signOut().catch(() => {});
    await backend.signOut().catch(() => {});
  }
  expect(guard.refused).toEqual([]);
}, 120_000);
