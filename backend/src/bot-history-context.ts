// Full record context carried inside each bot-history batch, under the same encryption as the batch.
// Every read checks it against the owner, space and stored key the reader derives on its own.
//
// Stored plaintext (new records): the batch fields, unchanged and in their usual order, then
//   "ctx": { v: 1, owner, spaceId, path, bot, generation, seq, challenge }
// `bot` is the sibling key, or "main". A batch with no `ctx` is a legacy record: it opens by the earlier
// rule (path derived from the batch) and is reported as "legacy". A `ctx` that is present must match
// exactly; it is never ignored. Receipts hash the batch without `ctx`, so existing receipts are unchanged.
// The browser reader in frontend/src/bots/historyContext.ts implements the same rule.
import type { HistoryBatch } from "./bot-history.js";

export const HISTORY_CONTEXT_VERSION = 1;

export interface BotHistoryScope {
  owner: string;
  spaceId: string;
  path: string;
  /** A sibling's key, or "main". */
  bot: string;
}

export interface BotHistoryContext extends BotHistoryScope {
  v: typeof HISTORY_CONTEXT_VERSION;
  generation: string;
  seq: number;
  challenge: string;
}

export type BotHistoryContextState = "bound" | "legacy";

const CONTEXT_KEYS = ["bot", "challenge", "generation", "owner", "path", "seq", "spaceId", "v"];

/** The bytes to seal: the batch with its full record context added. */
export function bindBotHistoryContext(batch: HistoryBatch, scope: BotHistoryScope): Buffer {
  const ctx: BotHistoryContext = {
    v: HISTORY_CONTEXT_VERSION,
    owner: scope.owner,
    spaceId: scope.spaceId,
    path: scope.path,
    bot: scope.bot,
    generation: batch.generation,
    seq: batch.seq,
    challenge: batch.challenge,
  };
  return Buffer.from(JSON.stringify({ ...batch, ctx }));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Checks an opened batch against the context the reader derives on its own. Throws before any record is
 * returned when `ctx` is present but does not match. Returns "legacy" only when `ctx` is absent.
 */
export function checkBotHistoryContext(batch: unknown, expected: BotHistoryScope): BotHistoryContextState {
  if (!isObject(batch)) throw new Error("history_binding_mismatch");
  if (!("ctx" in batch)) return "legacy";
  const ctx = batch.ctx;
  if (
    !isObject(ctx) ||
    Object.keys(ctx).sort().join() !== CONTEXT_KEYS.join() ||
    ctx.v !== HISTORY_CONTEXT_VERSION ||
    ctx.owner !== expected.owner ||
    ctx.spaceId !== expected.spaceId ||
    ctx.path !== expected.path ||
    ctx.bot !== expected.bot ||
    ctx.generation !== batch.generation ||
    ctx.seq !== batch.seq ||
    ctx.challenge !== batch.challenge ||
    (batch.bot ?? "main") !== expected.bot ||
    !expected.path.endsWith(`/${String(ctx.generation)}/${String(ctx.seq)}-${String(ctx.challenge)}`)
  ) throw new Error("history_binding_mismatch");
  return "bound";
}

/** Parses opened plaintext and checks its context. The batch is returned only after the check passes. */
export function openBotHistoryBatch(
  plaintext: Uint8Array,
  expected: BotHistoryScope,
): { batch: Record<string, unknown>; context: BotHistoryContextState } {
  let batch: unknown;
  try {
    batch = JSON.parse(Buffer.from(plaintext).toString("utf8"));
  } catch {
    throw new Error("history_binding_mismatch");
  }
  const context = checkBotHistoryContext(batch, expected);
  return { batch: batch as Record<string, unknown>, context };
}
