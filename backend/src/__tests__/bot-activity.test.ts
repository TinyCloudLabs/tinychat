import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";
import { BotManager, type SandboxLauncher } from "../../../bots/src/bot";
import { HistoryJournal } from "../../../bots/src/history";
import type { Frame } from "../../../bots/src/rpc";
import { createApp } from "../../../bots/src/server";
import { BotHistory, checkedBatch, HISTORY_PREFIX, historyBotId, historyOwner } from "../bot-history";
import { createBotsRouter } from "../routes/bots";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const ownerKey = `0x${"11".repeat(32)}` as const;
const backendKey = `0x${"44".repeat(32)}` as const;
const address = privateKeyToAccount(ownerKey).address;
const owner = historyOwner(address);
const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
const host = "http://127.0.0.1:9137";
const secret = "activity-" + "x".repeat(64);
const hidden = "sandbox tool text and file paths";
const at = "2026-11-18T23:00:00.000Z";
const networkId = "fixture-network";

function fakeOwnerStorage() {
  const store = () => {
    const entries = new Map<string, unknown>();
    const reads: string[] = [];
    const kv = {
      put: async (path: string, value: unknown) => {
        entries.set(path, value);
        return { ok: true, data: {} };
      },
      get: async (path: string) => {
        reads.push(path);
        return entries.has(path)
          ? { ok: true, data: { data: entries.get(path) } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${path}`, service: "kv" } };
      },
    };
    return { entries, reads, kv };
  };
  const saved = store();
  const node = {
    did: backendDid,
    computeDelegationCid,
    kv: store().kv,
    useDelegation: async () => saved,
    getEncryptionNetworkIdForSpace: () => networkId,
    encryption: {
      discoverNetwork: async () => ({ ok: true, data: { ownerDid: `did:pkh:eip155:1:${address}`, networkId, state: "active" } }),
      encryptToNetwork: async (_network: string, payload: Buffer, { aad }: { aad: Buffer }) => ({
        ok: true, data: { networkId, aad: aad.toString("base64"), payload: payload.toString("base64") },
      }),
    },
  } as unknown as TinyCloudNode;
  return { node, saved };
}

function fakeLauncher(): SandboxLauncher {
  return {
    hasState: () => false,
    leftover: () => false,
    launch: async () => {
      const listeners = new Set<(frame: Frame) => void>();
      const exit = Promise.withResolvers<void>();
      const emit = (frame: Frame) => { for (const listener of listeners) listener(frame); };
      const tool = (toolName: string, toolCallId: string, details: unknown, isError = false) => {
        emit({ type: "tool_execution_start", toolName, toolCallId, args: { text: hidden } });
        emit({ type: "tool_execution_update", toolName, toolCallId, partialResult: hidden });
        const end = { type: "tool_execution_end", toolName, toolCallId, result: { details, content: hidden }, isError };
        emit(end);
        emit(end);
      };
      return {
        exited: exit.promise,
        nextId: () => "turn",
        snapshot: async () => {},
        refreshEgress: async () => {},
        stop: async () => exit.resolve(),
        onFrame: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        request: async command => {
          if (command.type === "prompt") {
            emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "unmatched" });
            tool("bash", "one", {});
            tool("bash", "two", {});
            tool("bash", "failed", {}, true);
            tool("read", "unknown", {});
            tool("write", "write", { resolvedPath: `/${hidden}` });
            tool("edit", "edit", { perFileResults: [{ path: `/${hidden}` }, { path: "/other" }, { path: "/failed", isError: true }] });
            emit({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "pong" } });
            emit({ type: "prompt_result", id: command.id, status: "completed", sessionSettled: true });
          }
          return { agentInvoked: true };
        },
      };
    },
  };
}

test("activity travels through the stream, restarted journal, backend list and owner storage", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-activity-"));
  const history = { signerDid: backendDid, host, policy: "notice-then-expiry-30-days" } as const;
  const roots = { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") };
  const options = { idleMs: 60_000, turnTimeoutMs: 5_000, maxTurnBytes: 1024, history };
  const manager = new BotManager(fakeLauncher(), roots, options, 1);
  const restarted = new BotManager(fakeLauncher(), roots, options, 1);
  let service = createApp({ secret, accounts: "*", bots: manager });
  const app = express();
  app.use(express.json());
  app.use("/api/bots", createBotsRouter({
    config: {
      serviceUrl: "http://bots.test", serviceSecret: secret, accountAllowed: () => true, postTimeoutMs: 5000,
      fetchImpl: (async (input, init) => service(new Request(input as string, init))) as typeof fetch,
    },
    authMiddleware: (req, _res, next) => { req.user = { address } as typeof req.user; next(); },
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots/main/messages`;
  try {
    const turn = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"text":"ping"}' });
    const stream = await turn.text();
    const activity = [...stream.matchAll(/^event: activity\ndata: (.+)$/gm)].map(match => JSON.parse(match[1]!));
    expect(activity.map(record => [record.verb, record.count])).toEqual([["ran_commands", 2], ["changed_files", 2]]);
    expect(stream).not.toContain(hidden);
    expect(stream.indexOf("event: activity")).toBeLessThan(stream.indexOf("event: done"));

    await manager.stopAll();
    service = createApp({ secret, accounts: "*", bots: restarted });
    const listed = await (await fetch(url)).json();
    expect(listed.activity).toEqual(activity);
    expect(listed.messages.map(({ role, text }: { role: string; text: string }) => [role, text])).toEqual([["user", "ping"], ["bot", "pong"]]);

    const { node, saved } = fakeOwnerStorage();
    const writer = new BotHistory(node, backendKey, host);
    const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
    const scope = makePkhSpaceId(address, 1, "applications");
    const grant = await makeSignedTranscriptGrant({ privateKey: ownerKey, audience: backendDid, att: {
      [`${scope}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
    } });
    await writer.accept(address, grant);
    const journal = new HistoryJournal(restarted.forOwner(owner).layout, history);
    const readBack = [];
    while (journal.pending()) {
      const batch = journal.pending()!;
      const receipt = await writer.archive(address, batch, async staged => journal.stage(staged));
      await journal.accept(receipt);
      const path = `${directory}${batch.generation}/${batch.seq}-${batch.challenge}`;
      const savedEnvelope = saved.entries.get(path) as { payload: string };
      expect(saved.reads.filter(read => read === path)).toHaveLength(2);
      const opened = JSON.parse(Buffer.from(savedEnvelope.payload, "base64").toString());
      if (opened.record.type === "activity") readBack.push(opened.record);
    }
    expect(readBack).toEqual(activity);
    expect(await journal.verifyCoverage()).toBe(true);
  } finally {
    await restarted.stopAll();
    await manager.stopAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("activity history accepts only the fixed record fields and bounded counts", () => {
  const record = { type: "activity", id: "a".repeat(32), verb: "ran_commands", count: 2, at };
  const batch = { v: 1, generation: "a".repeat(32), seq: 1, challenge: "b".repeat(64), record };
  expect(checkedBatch(batch)).toEqual(batch);
  for (const extra of [{ text: hidden }, { verb: hidden }, { count: 0 }, { count: 257 }, { count: 1.5 }, { id: hidden }, { at: hidden }]) {
    expect(() => checkedBatch({ ...batch, record: { ...record, ...extra } })).toThrow("invalid_history_batch");
  }
});
