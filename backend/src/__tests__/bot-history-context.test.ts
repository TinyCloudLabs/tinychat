import { describe, expect, test } from "bun:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { makePkhSpaceId } from "@tinycloud/sdk-core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { BotHistory, HISTORY_PREFIX, historyBotId, historyHash, historyOwner } from "../bot-history";
import { bindBotHistoryContext, openBotHistoryBatch, type BotHistoryScope } from "../bot-history-context";
import { botHistoryNetworkId } from "../bot-history-key";
import { computeDelegationCid, makeSignedTranscriptGrant } from "./helpers/transcript-grant";

const ownerKey = generatePrivateKey();
const backendKey = generatePrivateKey();
const address = privateKeyToAccount(ownerKey).address;
const backendDid = historyOwner(privateKeyToAccount(backendKey).address);
const host = "http://127.0.0.1:9138";
const networkId = botHistoryNetworkId(address);
const directory = `${HISTORY_PREFIX}${historyBotId(address)}/`;
const spaceId = makePkhSpaceId(address, 1, "applications");
const sibling = "5a".repeat(16);

const batch = {
  v: 1 as const, generation: "ab".repeat(16), seq: 7, challenge: "cd".repeat(32),
  record: { type: "assistant", text: "synthetic reply" },
};
const path = `${directory}${batch.generation}/${batch.seq}-${batch.challenge}`;
const scope: BotHistoryScope = { owner: historyOwner(address), spaceId, path, bot: "main" };

function storage() {
  const entries = new Map<string, { body: unknown; etag: string }>();
  let writes = 0;
  return {
    get: async (key: string) => {
      const entry = entries.get(key);
      return entry ? { ok: true, data: { data: entry.body, headers: { etag: entry.etag } } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: `Key not found: ${key}`, service: "kv" } };
    },
    put: async (key: string, body: unknown, options?: { ifMatch?: string; ifNoneMatch?: string }) => {
      const entry = entries.get(key);
      if ((options?.ifNoneMatch === "*" && entry) || (options?.ifMatch && options.ifMatch !== entry?.etag)) {
        return { ok: false, error: { code: "KV_PRECONDITION_FAILED" } };
      }
      entries.set(key, { body, etag: `"${++writes}"` });
      return { ok: true, data: {} };
    },
  };
}

async function archived() {
  const owned = storage();
  const sealed: { plaintext: Uint8Array; aad: Uint8Array }[] = [];
  const node = {
    did: backendDid, computeDelegationCid, kv: storage(),
    useDelegation: async () => ({ kv: owned }),
    keys: {
      encrypt: async (keyPath: string, plaintext: Uint8Array, options: { aad: Uint8Array; descriptor: { keyVersion: number } }) => {
        sealed.push({ plaintext, aad: options.aad });
        return {
          v: 2, networkId, keyPath, keyVersion: options.descriptor.keyVersion,
          aad: Buffer.from(options.aad).toString("base64"), ciphertext: "synthetic ciphertext",
        };
      },
    },
  } as unknown as TinyCloudNode;
  const history = new BotHistory(node, backendKey, host);
  const grant = await makeSignedTranscriptGrant({
    privateKey: ownerKey, audience: backendDid, host, now: Date.now(), att: {
      [`${spaceId}/kv/${directory}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
    },
  });
  await history.accept(address, grant);
  await history.acceptKeyDescriptor(address, grant.signKeyDescriptor());
  const receipt = await history.archive(address, batch, async () => {});
  return { sealed, receipt };
}

describe("the writer seals the full record context with each new batch", () => {
  test("the sealed bytes are the batch plus its context, and that opens as verified", async () => {
    const { sealed } = await archived();
    expect(sealed).toHaveLength(1);
    const stored = JSON.parse(Buffer.from(sealed[0]!.plaintext).toString());
    expect(stored).toEqual({
      ...batch,
      ctx: { v: 1, owner: historyOwner(address), spaceId, path, bot: "main", generation: batch.generation, seq: 7, challenge: batch.challenge },
    });
    const { ctx, ...rest } = stored;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(batch));
    expect(openBotHistoryBatch(sealed[0]!.plaintext, scope).context).toBe("bound");
  });

  test("the receipt and the envelope's own binding are unchanged", async () => {
    const { sealed, receipt } = await archived();
    expect(receipt.body.batchHash).toBe(historyHash(JSON.stringify(batch)));
    expect(Buffer.from(sealed[0]!.aad).toString()).toBe(JSON.stringify({ owner: historyOwner(address), spaceId, path }));
  });
});

describe("opening a stored batch checks the full record context", () => {
  const sealedFor = (scopeOf: BotHistoryScope, value = batch) => bindBotHistoryContext(value, scopeOf);

  test("a new batch opens for its own owner, space, path and bot, for Main and for a sibling", () => {
    expect(openBotHistoryBatch(sealedFor(scope), scope).context).toBe("bound");
    const siblingBatch = { ...batch, bot: sibling };
    const siblingScope = { ...scope, path: `${HISTORY_PREFIX}${historyBotId(address, sibling)}/${batch.generation}/7-${batch.challenge}`, bot: sibling };
    expect(openBotHistoryBatch(sealedFor(siblingScope, siblingBatch), siblingScope).context).toBe("bound");
  });

  test("an earlier batch with no context opens and is identified as legacy", () => {
    const opened = openBotHistoryBatch(Buffer.from(JSON.stringify(batch)), scope);
    expect(opened.context).toBe("legacy");
    expect(opened.batch.record).toEqual(batch.record);
  });

  const other: Array<[string, Partial<BotHistoryScope>]> = [
    ["owner", { owner: historyOwner(privateKeyToAccount(generatePrivateKey()).address) }],
    ["space", { spaceId: makePkhSpaceId(address, 1, "default") }],
    ["path", { path: `${directory}${batch.generation}/8-${batch.challenge}` }],
    ["bot", { bot: sibling }],
  ];
  for (const [name, change] of other) {
    test(`a batch opened under another ${name} is refused`, () => {
      expect(() => openBotHistoryBatch(sealedFor(scope), { ...scope, ...change })).toThrow("history_binding_mismatch");
    });
  }

  const edits: Array<[string, (value: Record<string, unknown>, ctx: Record<string, unknown>) => void]> = [
    ["generation in the context", (_value, ctx) => { ctx.generation = "ef".repeat(16); }],
    ["sequence in the context", (_value, ctx) => { ctx.seq = 8; }],
    ["challenge in the context", (_value, ctx) => { ctx.challenge = "01".repeat(32); }],
    ["generation in the batch", (value) => { value.generation = "ef".repeat(16); }],
    ["sequence in the batch", (value) => { value.seq = 8; }],
    ["challenge in the batch", (value) => { value.challenge = "01".repeat(32); }],
    ["bot in the batch", (value) => { value.bot = sibling; }],
    ["context version", (_value, ctx) => { ctx.v = 2; }],
    ["context fields (one added)", (_value, ctx) => { ctx.extra = 1; }],
    ["context fields (one removed)", (_value, ctx) => { delete ctx.spaceId; }],
  ];
  for (const [name, edit] of edits) {
    test(`a batch with a changed ${name} is refused`, () => {
      const value = JSON.parse(sealedFor(scope).toString()) as Record<string, unknown>;
      edit(value, value.ctx as Record<string, unknown>);
      expect(() => openBotHistoryBatch(Buffer.from(JSON.stringify(value)), scope)).toThrow("history_binding_mismatch");
    });
  }

  test("a context that is not an object, and bytes that are not JSON, are refused", () => {
    expect(() => openBotHistoryBatch(Buffer.from(JSON.stringify({ ...batch, ctx: null })), scope)).toThrow("history_binding_mismatch");
    expect(() => openBotHistoryBatch(Buffer.from("not json"), scope)).toThrow("history_binding_mismatch");
  });
});
