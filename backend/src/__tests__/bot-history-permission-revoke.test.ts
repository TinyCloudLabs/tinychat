import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { BotManager } from "../../../bots/src/bot";
import { HistoryJournal } from "../../../bots/src/history";
import { createApp } from "../../../bots/src/server";
import { BotHistory, HISTORY_PREFIX, historyBotId, historyOwner } from "../bot-history";
import { createBotHistoryRouter, GRANT_RESEND_MS, startBotHistoryDrain } from "../routes/bot-history";
import type { BotsConfig } from "../routes/bots";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

test("a confirmed revoke reaches the bot and takes effect earlier than the pushed grant end", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-history-permission-"));
  const ownerKey = `0x${"11".repeat(32)}` as const;
  const address = privateKeyToAccount(ownerKey).address;
  const owner = historyOwner(address);
  const secret = "b".repeat(64);
  const host = "http://127.0.0.1:9137";
  const options = { signerDid: "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810", host, policy: "notice-then-expiry-30-days" as const };
  const space = makePkhSpaceId(address, 1, "applications");
  const path = `${HISTORY_PREFIX}${historyBotId(address)}/`;
  const mint = (expiresAt: number) => makeSignedTranscriptGrant({
    privateKey: ownerKey, expiresAt: Math.floor(expiresAt / 1000), att: { [`${space}/kv/${path}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] } },
  });
  const original = await mint(Date.now() + 4 * 60 * 60_000);
  const replacement = await mint(Date.now() + 2 * 60 * 60_000);
  const rows = new Map<string, unknown>();
  const retired: string[] = [];
  const pushes: URL[] = [];
  let refusal: string | undefined;
  const node = {
    did: options.signerDid, computeDelegationCid,
    useDelegation: async () => {
      if (refusal !== undefined) throw new Error("Failed to activate delegated session: HTTP 401", {
        cause: { success: false, status: 401, error: refusal },
      });
      return {};
    },
    revokeDelegation: async (cid: string) => { retired.push(cid); return { ok: true }; },
    kv: {
      get: async (key: string) => ({ ok: true, data: { data: rows.get(key), headers: { etag: "row" } } }),
      put: async (key: string, value: unknown, condition: { ifNoneMatch?: string; ifMatch?: string }) => {
        if (rows.has(key) && condition.ifNoneMatch === "*") return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
        rows.set(key, value);
        return { ok: true, data: {} };
      },
      list: async () => ({ ok: true, data: { keys: [...rows.keys()] } }),
    },
  } as unknown as TinyCloudNode;
  const history = new BotHistory(node, `0x${"22".repeat(32)}`, host);
  const bots = new BotManager({
    hasState: () => false, leftover: () => false, mountPoints: () => [], launch: async () => { throw new Error("unexpected launch"); },
  }, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") },
  { idleMs: 60_000, turnTimeoutMs: 5000, maxTurnBytes: 512, history: options }, 1);
  const app = createApp({ secret, accounts: "*", bots, acceptLegacyOwnerHeader: false });
  const configuration: BotsConfig = {
    serviceUrl: "http://bots.test", serviceSecret: secret, accountAllowed: () => true, postTimeoutMs: 1000,
    fetchImpl: (async (input, init) => {
      const request = new Request(input, init);
      const response = await app(request);
      if (request.method === "PUT" && response.ok) pushes.push(new URL(request.url));
      return response;
    }) as typeof fetch,
  };
  const api = express();
  api.use(createBotHistoryRouter(history, configuration, (req, _res, next) => {
    req.user = { address } as typeof req.user;
    next();
  }));
  const server = api.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const grantUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/grant`;
  const accept = (signed: typeof original) => fetch(grantUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ serialized: signed.serialized, siwe: signed.siwe, signature: signed.signature }),
  });
  let drain: ReturnType<typeof startBotHistoryDrain> | undefined;
  try {
    expect((await accept(original)).status).toBe(204);
    const layout = bots.forOwner(owner).layout;
    expect(new HistoryJournal(layout, options).permission?.grant?.cid).toBe(original.cid);
    expect((await accept(replacement)).status).toBe(204);
    expect(retired).toEqual([original.cid]);
    expect(pushes.map(({ searchParams }) => [searchParams.get("kind"), searchParams.get("cid")])).toEqual([
      ["extend", original.cid], ["revoke", original.cid], ["extend", replacement.cid],
    ]);
    expect(new HistoryJournal(layout, options).permission?.validUntil).toBe(replacement.expiresAt.getTime());
    drain = startBotHistoryDrain(history, configuration);
    await Bun.sleep(0);
    const start = Date.now();

    refusal = "uncoded 401";
    setSystemTime(start + GRANT_RESEND_MS + 1000);
    await drain.drain();
    expect(new HistoryJournal(layout, options).notice()).toBeUndefined();

    refusal = JSON.stringify({ code: "parent_revoked" });
    setSystemTime(start + 2 * GRANT_RESEND_MS + 2000);
    await drain.drain();
    const journal = new HistoryJournal(layout, options);
    expect(journal.notice()?.expiresAt).toBeLessThan(replacement.expiresAt.getTime());
    expect(journal.permission?.revoked).toBe(true);
  } finally {
    setSystemTime();
    drain?.stop();
    server.close();
    await bots.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the drain tags an existing Main grant once and can then apply a confirmed revoke", async () => {
  const { HistoryPermissionRevoked } = await import("../bot-history");
  const root = mkdtempSync(join(tmpdir(), "main-history-grant-tag-"));
  const address = "0x" + "12".repeat(20);
  const owner = historyOwner(address);
  const secret = "b".repeat(64);
  const options = { signerDid: "did:pkh:eip155:1:0x141f8c2b0fc5d114875f02627deb085e46ddd810", host: "http://127.0.0.1:9137", policy: "notice-then-expiry-30-days" as const };
  const permission = { cid: "legacy-grant", revision: 0, validUntil: Date.now() + 4 * GRANT_RESEND_MS };
  let revoked = false;
  const history = {
    owners: async () => [address],
    grantPermission: async () => {
      if (revoked) throw new HistoryPermissionRevoked(permission);
      return permission;
    },
  } as unknown as BotHistory;
  const bots = new BotManager({
    hasState: () => false, leftover: () => false, mountPoints: () => [], launch: async () => { throw new Error("unexpected launch"); },
  }, { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") },
  { idleMs: 60_000, turnTimeoutMs: 5000, maxTurnBytes: 512, history: options }, 1);
  const main = bots.forOwner(owner);
  const app = createApp({ secret, accounts: "*", bots, acceptLegacyOwnerHeader: false });
  const applied = Promise.withResolvers<void>();
  const pushes: string[][] = [];
  const config: BotsConfig = {
    serviceUrl: "http://bots.test", serviceSecret: secret, accountAllowed: () => true, postTimeoutMs: 1000,
    fetchImpl: (async (input, init) => {
      const request = new Request(input, init);
      const response = await app(request);
      if (request.method === "PUT" && response.ok) {
        const params = new URL(request.url).searchParams;
        pushes.push([params.get("kind")!, params.get("cid")!, params.get("revision")!]);
        applied.resolve();
      }
      return response;
    }) as typeof fetch,
  };
  let drain: ReturnType<typeof startBotHistoryDrain> | undefined;
  try {
    await main.historyPermission(owner, undefined, permission.validUntil);
    expect(new HistoryJournal(main.layout, options).permission?.grant).toBeUndefined();

    const start = Date.now();
    drain = startBotHistoryDrain(history, config);
    await applied.promise;
    await Bun.sleep(0);
    expect(new HistoryJournal(main.layout, options).permission?.grant?.cid).toBe(permission.cid);
    setSystemTime(start + GRANT_RESEND_MS + 1000);
    await drain.drain();
    expect(pushes).toEqual([["extend", permission.cid, "0"]]);

    revoked = true;
    setSystemTime(start + 2 * GRANT_RESEND_MS + 2000);
    await drain.drain();
    expect(pushes).toEqual([["extend", permission.cid, "0"], ["revoke", permission.cid, "0"]]);
    expect(new HistoryJournal(main.layout, options).permission?.revoked).toBe(true);
  } finally {
    setSystemTime();
    drain?.stop();
    await bots.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
