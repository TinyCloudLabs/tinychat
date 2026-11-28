// Explicit loopback-only network exercise for a second bot's history (TC-3325): its own grant, its own directory,
// its own receipt, with Main untouched. No production accounts, services, model calls or keys. Needs a local
// TinyCloud node: BOT_HISTORY_TEST_NODE=http://127.0.0.1:<port>.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TinyCloudNode, serializeDelegation } from "@tinycloud/node-sdk";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { botHistoryOwnerPermissions } from "../../../frontend/src/bots/historyAuthorization";
import { readBotHistory } from "../../../frontend/src/bots/historyRead";
import { webSignInManifest } from "../../../frontend/src/lib/homeFeatures";
import { WEB_APP_MANIFEST } from "../../../frontend/src/lib/webSignInPrefetch";
import type { SandboxLauncher } from "../../../bots/src/bot";
import { canonicalizeEncryptionJson } from "@tinycloud/sdk-core";
import { BotHistory, HISTORY_PREFIX, historyBotId, historyOwner } from "../bot-history";
import { BOT_HISTORY_KEY_MAX_MS, BOT_HISTORY_KEY_PATH, type BotHistoryKeyDescriptorPayload } from "../bot-history-key";

import { backendHistoryFixtureManifest } from "./helpers/transcript-grant";

const host = process.env.BOT_HISTORY_TEST_NODE;
const KEY_A = "ab".repeat(16);
const KEY_B = "cd".repeat(16);

test.skipIf(!host)("real TinyCloud: a second bot has its own grant, directory and receipt, and Main's history reads as before", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  // As in bot-history-network.test.ts: the bots service is its own package, loaded only when this test has a node to run against.
  const { HistoryJournal } = await import("../../../bots/src/history");
  const { botLayout } = await import("../../../bots/src/layout");
  const { BotManager } = await import("../../../bots/src/bot");
  const ownerKey = generatePrivateKey();
  const backendKey = generatePrivateKey();
  const address = privateKeyToAccount(ownerKey).address;
  const ownerDid = historyOwner(address);
  // The session the web app composes at sign-in, with nothing added for bots.
  const ownerConfig = { privateKey: ownerKey, host, prefix: "applications", autoCreateSpace: true, autoBootstrapAccount: false, includeAccountRegistryPermissions: false,
    manifest: webSignInManifest(WEB_APP_MANIFEST, [], address) };
  const owner = new TinyCloudNode(ownerConfig);
  const backend = new TinyCloudNode({ privateKey: backendKey, host, prefix: "bot-history-siblings-test", includeAccountRegistryPermissions: false, manifest: backendHistoryFixtureManifest });
  const root = mkdtempSync(join(tmpdir(), "history-siblings-"));
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const directory = (key?: string) => `${HISTORY_PREFIX}${historyBotId(address, key)}/`;
  const network = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
  const approve = async (client: TinyCloudNode) => {
    await client.grantRuntimePermissions(botHistoryOwnerPermissions(address), { expiry: 3_600_000,
      signMessage: message => privateKeyToAccount(ownerKey).signMessage({ message }) });
    if (!(await client.getEncryptionNetwork(network))) {
        await client.grantRuntimePermissions([{
          service: "tinycloud.encryption", path: network, skipPrefix: true, actions: ["network.create"],
        }], { expiry: 3_600_000, signMessage: message => privateKeyToAccount(ownerKey).signMessage({ message }) });
        await client.ensureEncryptionNetwork();
      }
    const desc = await client.keys.ensureKey(BOT_HISTORY_KEY_PATH, { networkId: network });
    const nowSec = Math.floor(Date.now() / 1000);
    const siweExpMs = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(client.session!.siwe)?.[1] ?? "");
    const payload: BotHistoryKeyDescriptorPayload = {
      v: 1, type: "tinychat.bot-history.key-descriptor/v1", owner: `did:pkh:eip155:1:${address}`, networkId: network,
      keyPath: BOT_HISTORY_KEY_PATH, alg: desc.alg, keyVersion: desc.keyVersion, publicEncryptionKey: desc.publicEncryptionKey,
      kind: "deletable", state: "active", iat: nowSec, exp: Math.floor(Math.min(siweExpMs, Date.now() + BOT_HISTORY_KEY_MAX_MS) / 1000),
    };
    const sig = Buffer.from(await client.signSessionBytes(Buffer.from(canonicalizeEncryptionJson({ ...payload }), "utf8"))).toString("base64");
    return { descriptor: payload, descriptorSignature: sig, signerDid: client.session!.verificationMethod.split("#")[0]!, siwe: client.session!.siwe, signature: client.session!.signature };
  };
  let rotated: TinyCloudNode | undefined;
  try {
    await owner.signIn(); await owner.hostOwnedSpace("applications");
    const signedDesc = await approve(owner);
    await backend.signIn(); await backend.hostOwnedSpace("bot-history-siblings-test");
    // The backend's DID is its account's only once it has signed in.
    const options = { host: host!, signerDid: backend.did, policy: "notice-then-expiry-30-days" as const };
    const writer = new BotHistory(backend, backendKey, host!);
    await writer.acceptKeyDescriptor(address, signedDesc);
    /** The browser's request for one bot: that bot's directory, get and put, and it must not prompt. */
    const grantFrom = async (client: TinyCloudNode, key?: string) => {
      const grant = await client.delegateTo(backend.did, [{ service: "tinycloud.kv", path: directory(key), actions: ["get", "put"] }], { expiry: 3_600_000 });
      expect(grant.prompted).toBe(false);
      return { delegation: grant.delegation, envelope: { serialized: serializeDelegation(grant.delegation), siwe: client.session!.siwe, signature: client.session!.signature } };
    };
    const main = await grantFrom(owner);
    await writer.accept(address, main.envelope);
    const forA = await grantFrom(owner, KEY_A);
    // A's grant is not Main's, and not B's.
    await expect(writer.accept(address, forA.envelope)).rejects.toThrow();
    await expect(writer.accept(address, forA.envelope, KEY_B)).rejects.toThrow();
    await writer.accept(address, forA.envelope, KEY_A);

    // Main and the sibling each save one record, each under its own grant.
    const mainJournal = new HistoryJournal(botLayout(historyBotId(address), roots), options);
    mainJournal.begin(ownerDid, 1000); mainJournal.append({ type: "user", text: "main record", at: "2026-11-18T00:00:00.000Z" });
    await mainJournal.accept(await writer.archive(address, mainJournal.pending()!, async staged => { mainJournal.stage(staged); }));
    const siblingLayout = botLayout(historyBotId(address, KEY_A), roots, { botKey: KEY_A, ownerId: historyBotId(address) });
    const siblingJournal = new HistoryJournal(siblingLayout, options);
    siblingJournal.begin(ownerDid, 1000); siblingJournal.append({ type: "user", text: "sibling record", at: "2026-11-18T00:00:01.000Z" });
    const batch = siblingJournal.pending()!;
    expect(batch.bot).toBe(KEY_A);
    // The sibling's batch is refused under Main's grant, and under a bot that has no grant.
    await expect(writer.archive(address, batch, async () => {})).rejects.toThrow("history_bot_mismatch");
    await expect(writer.archive(address, { ...batch, bot: KEY_B }, async () => {}, KEY_B)).rejects.toThrow("history_grant_missing");
    const receipt = await writer.archive(address, batch, async staged => { siblingJournal.stage(staged); }, KEY_A);
    const path = `${directory(KEY_A)}${batch.generation}/${batch.seq}-${batch.challenge}`;
    expect(receipt.body).toMatchObject({ botId: historyBotId(address, KEY_A), key: KEY_A, path });
    // The service's journal accepts that receipt, and Main's journal does not.
    await expect(mainJournal.accept(receipt)).rejects.toThrow();
    await siblingJournal.accept(receipt);
    expect(await siblingJournal.verifyCoverage()).toBe(true);

    // The record is in the sibling's own directory, sealed to the owner.
    const stored = await owner.kv.get(path, { prefix: "" });
    expect(stored.ok).toBe(true); if (!stored.ok) throw new Error("read failed");
    const sealed = stored.data.data as Parameters<typeof owner.keys.decrypt>[0];
    expect(JSON.stringify(sealed)).not.toContain("sibling record");
    const opened = await owner.keys.decrypt(sealed);
    const { ctx, ...record } = JSON.parse(new TextDecoder().decode(opened));
    expect(record).toEqual(batch);
    expect(ctx).toMatchObject({ v: 1, bot: KEY_A, generation: batch.generation, seq: batch.seq, challenge: batch.challenge, path });

    // The node holds each grant to its own directory: A's cannot write Main's or B's, and Main's cannot write A's.
    const accessA = await backend.useDelegation(forA.delegation);
    const accessMain = await backend.useDelegation(main.delegation);
    const stray = `${"0".repeat(32)}/1-${"1".repeat(64)}`;
    for (const [access, target] of [[accessA, directory()], [accessA, directory(KEY_B)], [accessMain, directory(KEY_A)]] as const) {
      const write = await access.kv.put(`${target}${stray}`, { stray: true }, { prefix: "" });
      expect(write.ok).toBe(false);
      const read = await access.kv.get(`${target}${stray}`, { prefix: "" });
      expect(read.ok).toBe(false);
    }
    expect((await accessA.kv.get(path, { prefix: "" })).ok).toBe(true);

    // Today's reader, unchanged, reads Main's history with the sibling's record in the space, and sees only Main's.
    const asWeb = (client: TinyCloudNode) => ({ session: () => client.session, kvForSpace: () => client.kv, encryption: client.encryption, keys: client.keys }) as unknown as TinyCloudWeb;
    expect((await readBotHistory(asWeb(owner))).map(line => line.text)).toEqual(["main record"]);

    // A restored session (signed out, signed in again under a new session key) issues the sibling's grant again
    // without a prompt, and the next record is saved under it.
    await owner.signOut();
    rotated = new TinyCloudNode(ownerConfig);
    await rotated.signIn();
    await writer.acceptKeyDescriptor(address, await approve(rotated));
    await writer.accept(address, (await grantFrom(rotated, KEY_A)).envelope, KEY_A);
    siblingJournal.append({ type: "assistant", text: "sibling reply", outcome: { type: "done" }, at: "2026-11-18T00:00:02.000Z" });
    await siblingJournal.accept(await writer.archive(address, siblingJournal.pending()!, async staged => { siblingJournal.stage(staged); }, KEY_A));
    expect(await siblingJournal.verifyCoverage()).toBe(true);
    // Main's grant from before is still good.
    mainJournal.append({ type: "assistant", text: "main reply", outcome: { type: "done" }, at: "2026-11-18T00:00:03.000Z" });
    await mainJournal.accept(await writer.archive(address, mainJournal.pending()!, async staged => { mainJournal.stage(staged); }));
    expect((await readBotHistory(asWeb(rotated))).map(line => line.text)).toEqual(["main record", "main reply"]);

    // With every record saved, the sibling's working state can go; its history is still in the owner's space.
    const launcher: SandboxLauncher = { hasState: () => false, leftover: () => false, mountPoints: () => [], launch: async () => { throw new Error("not used"); } };
    const manager = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 5000, maxTurnBytes: 1024, history: options }, 1);
    expect(await manager.deleteBot(ownerDid, KEY_A)).toBeUndefined();
    const after = await rotated.kv.get(path, { prefix: "" });
    expect(after.ok).toBe(true);

    // A session that was never given the threads tree cannot issue the grant silently.
    const narrowManifest = webSignInManifest(WEB_APP_MANIFEST, [], address);
    const narrow = new TinyCloudNode({ ...ownerConfig, manifest: { ...narrowManifest,
      permissions: narrowManifest.permissions.filter(permission => permission.service !== "tinycloud.kv") } });
    await narrow.signIn();
    try {
      const outcome = await narrow.delegateTo(backend.did, [{ service: "tinycloud.kv", path: directory(KEY_A), actions: ["get", "put"] }], { expiry: 3_600_000 })
        .then(grant => (grant.prompted ? "prompted" : "silent"), () => "refused");
      expect(outcome).not.toBe("silent");
    } finally { await narrow.signOut(); }
  } finally {
    await rotated?.signOut().catch(() => {});
    await owner.signOut().catch(() => {}); await backend.signOut().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
