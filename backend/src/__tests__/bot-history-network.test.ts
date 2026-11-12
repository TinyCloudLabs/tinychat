// Explicit loopback-only network exercise; no production accounts, services, model calls or keys.
import express from "express";
import { once } from "node:events";
import type { SandboxLauncher } from "../../../bots/src/bot";
import { createBotsRouter } from "../routes/bots";
import { readBotHistory } from "../../../frontend/src/bots/historyRead";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { Frame } from "../../../bots/src/rpc";
import { expect, spyOn, test } from "bun:test";
import { TinyCloudNode, serializeDelegation } from "@tinycloud/node-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BotHistory, HISTORY_PREFIX, historyBotId, historyOwner } from "../bot-history";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const host = process.env.BOT_HISTORY_TEST_NODE;
test.skipIf(!host)("real TinyCloud: encrypted archival, KV-only backend decrypt refusal, owner session and grant rotation", async () => {
  if (new URL(host!).hostname !== "127.0.0.1") throw new Error("loopback node required");
  const { HistoryJournal } = await import("../../../bots/src/history");
  const { botLayout } = await import("../../../bots/src/layout");
  const { BotManager } = await import("../../../bots/src/bot");
  const { createApp } = await import("../../../bots/src/server");
  const ownerKey = generatePrivateKey();
  const backendKey = generatePrivateKey();
  const address = privateKeyToAccount(ownerKey).address;
  const network = `urn:tinycloud:encryption:did:pkh:eip155:1:${address}:default`;
  const ownerConfig = { privateKey: ownerKey, host, prefix: "applications", autoCreateSpace: true, includeAccountRegistryPermissions: false,
    manifest: { manifest_version: 1 as const, app_id: "xyz.tinycloud.tinychat", name: "History test", defaults: false as const,
      permissions: [{ service: "tinycloud.kv", path: "xyz.tinycloud.tinychat/threads/", actions: ["get", "put", "list"] },
        { service: "tinycloud.encryption", path: network, actions: ["network.create", "decrypt"] }] } };
  const owner = new TinyCloudNode(ownerConfig);
  const backend = new TinyCloudNode({ privateKey: backendKey, host, prefix: "bot-history-network-test", includeAccountRegistryPermissions: false });
  const root = mkdtempSync(join(tmpdir(), "history-network-"));
  try {
    await owner.signIn(); await owner.hostOwnedSpace("applications"); await owner.createEncryptionNetwork();
    await backend.signIn(); await backend.hostOwnedSpace("bot-history-network-test");
    const writer = new BotHistory(backend, backendKey, host!);
    const permissions = [{ service: "tinycloud.kv", path: `${HISTORY_PREFIX}${historyBotId(address)}/`, actions: ["get", "put"] }];
    async function grantFrom(client: TinyCloudNode) {
      const grant = await client.delegateTo(backend.did, permissions, { expiry: 3_600_000 });
      expect(grant.prompted).toBe(false);
      await writer.accept(address, { serialized: serializeDelegation(grant.delegation), siwe: client.session!.siwe, signature: client.session!.signature });
      return grant.delegation;
    }
    const delegation = await grantFrom(owner);
    expect(await writer.owners()).toContain(address.toLowerCase());
    const layout = botLayout(historyBotId(address), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") });
    const journal = new HistoryJournal(layout, { host: host!, signerDid: backend.did, policy: "notice-then-expiry-30-days" });
    journal.begin(historyOwner(address), 1000); journal.append({ type: "user", text: "archive round trip" });
    const batch = journal.pending()!;
    const target = `${HISTORY_PREFIX}${historyBotId(address)}/${batch.generation}/${batch.seq}-${batch.challenge}`;
    const nativeFetch = globalThis.fetch.bind(globalThis);
    let networkReads = 0;
    const transport = spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      try {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        const payload = JSON.parse(Buffer.from(auth.replace(/^Bearer /i, "").split(".")[1], "base64url").toString());
        if (JSON.stringify(payload.att).includes(target) && Object.values(payload.att).some(value => value && typeof value === "object" && Object.hasOwn(value, "tinycloud.kv/get"))) networkReads++;
      } catch { /* other node operations are not KV object reads */ }
      return nativeFetch(url, init);
    });
    let receipt;
    try { receipt = await writer.archive(address, batch, async staged => { journal.stage(staged); }); }
    finally { transport.mockRestore(); }
    expect(networkReads).toBe(2); // pre-retry existence read plus fresh post-write network readback
    await journal.accept(receipt);
    expect(await journal.verifyCoverage()).toBe(true);
    const path = `${HISTORY_PREFIX}${historyBotId(address)}/${batch.generation}/${batch.seq}-${batch.challenge}`;
    const access = await backend.useDelegation(delegation);
    const read = await access.kv.get(path, { prefix: "" });
    expect(read.ok).toBe(true); if (!read.ok) throw new Error("read failed");
    const envelope = read.data.data as Parameters<typeof owner.encryption.decryptEnvelope>[0];
    expect(JSON.stringify(envelope)).not.toContain("archive round trip");
    const denied = await backend.encryption.decryptEnvelope(envelope, { proofs: [] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("DECRYPT_DENIED");
    const opened = await owner.encryption.decryptEnvelope(envelope, { proofs: [] });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(JSON.parse(new TextDecoder().decode(opened.data))).toEqual(batch);
    // Create-only is a real node precondition, not just random ID uniqueness.
    const overwrite = await access.kv.put(path, { overwritten: true }, { prefix: "", ifNoneMatch: "*" });
    expect(overwrite.ok).toBe(false);
    if (!overwrite.ok) expect(overwrite.error.meta?.status).toBe(412);
    const oldSession = owner.session!.verificationMethod;
    await owner.signOut();
    const rotated = new TinyCloudNode(ownerConfig);
    await rotated.signIn();
    expect(rotated.session!.verificationMethod).not.toBe(oldSession);
    await grantFrom(rotated);
    const reopened = await rotated.encryption.decryptEnvelope(envelope, { proofs: [] });
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(JSON.parse(new TextDecoder().decode(reopened.data))).toEqual(batch);
    // Public backend message route -> supervisor journal -> real owner TinyCloud -> verified retention barrier.
    const listeners = new Set<(frame: Frame) => void>();
    const exited = Promise.withResolvers<void>();
    const launcher: SandboxLauncher = {
      hasState: () => false, leftover: () => false, mountPoints: () => [],
      provenance: async () => [{ verified: false, fixture: true }],
      launch: async layout => {
        mkdirSync(layout.stateMount, { recursive: true }); writeFileSync(layout.stateSnapshot, "fixture state");
        return { exited: exited.promise, nextId: () => "turn",
          onFrame: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          snapshot: async () => {}, refreshEgress: async () => {}, stop: async () => { exited.resolve(); },
          request: async command => {
            if (command.type === "prompt") queueMicrotask(() => {
              for (const listener of listeners) listener({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "pong" } });
              for (const listener of listeners) listener({ type: "prompt_result", id: "turn", status: "completed", sessionSettled: true });
            });
            return { agentInvoked: true };
          },
        };
      },
    };
    const roots = { dataRoot: join(root, "public-data"), runRoot: join(root, "public-run"), egressRoot: join(root, "public-egress") };
    const manager = new BotManager(launcher, roots, { idleMs: 60_000, turnTimeoutMs: 5000, maxTurnBytes: 1024,
      history: { signerDid: backend.did, host: host!, policy: "notice-then-expiry-30-days" } }, 1);
    const secret = "fixture-" + "x".repeat(64);
    const service = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp({ secret, accounts: "*", bots: manager }) });
    const app = express(); app.use(express.json());
    app.use("/api/bots", createBotsRouter({ config: { serviceUrl: service.url.origin, serviceSecret: secret, accountAllowed: () => true, postTimeoutMs: 5000 },
      authMiddleware: (req, _res, next) => { req.user = { address } as typeof req.user; next(); } }));
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const message = await fetch(`http://127.0.0.1:${port}/api/bots/main/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Reply pong" }) });
      const stream = await message.text();
      expect(stream).toContain("pong"); expect(stream).toContain("event: done");
      const bot = manager.forOwner(historyOwner(address));
      await manager.deleteWorkingState(historyBotId(address), "unused");
      expect(await bot.historyCovered()).toBe(false);
      for (;;) {
        const next = await bot.historyPending(); if (!next) break;
        await bot.historyReceipt(await writer.archive(address, next, async staged => { await bot.historyStage(staged); }));
      }
      expect(await bot.historyCovered()).toBe(true);
      await manager.deleteWorkingState(historyBotId(address), "unused");
      const archived = await readBotHistory({ session: () => rotated.session, kvForSpace: () => rotated.kv, encryption: rotated.encryption } as unknown as TinyCloudWeb);
      expect(archived.map(line => line.text)).toContain("Reply pong");
      expect(archived.map(line => line.text)).toContain("pong");
    } finally {
      await manager.stopAll(); service.stop(true); server.close();
    }
    const retried = await writer.archive(address, { ...batch, staged: { seq: batch.seq, challenge: batch.challenge,
      batchHash: receipt.body.batchHash, envelope } }, async () => { throw new Error("must reuse staged envelope"); });
    expect(retried.body.ciphertextHash).toBe(receipt.body.ciphertextHash);
    await rotated.signOut();
  } finally {
    await owner.signOut(); await backend.signOut();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
