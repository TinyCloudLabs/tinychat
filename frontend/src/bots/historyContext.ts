// Full record context carried inside each bot-history batch, under the same encryption as the batch.
// Every read checks it against the owner, space and stored key the reader derives on its own.
//
// New records add `ctx: { v: 1, owner, spaceId, path, bot, generation, seq, challenge }` to the batch
// (`bot` is the sibling key, or "main"). A batch with no `ctx` is a legacy record: it opens by the earlier
// rule and is reported as "legacy". A `ctx` that is present must match exactly; it is never ignored.
// The backend writer in backend/src/bot-history-context.ts defines the same format.

export const HISTORY_CONTEXT_VERSION = 1;

export interface BotHistoryScope {
  owner: string;
  spaceId: string;
  /** The full stored record key. */
  path: string;
  /** A sibling's key, or "main". */
  bot: string;
}

export type BotHistoryContextState = "bound" | "legacy";

const CONTEXT_KEYS = ["bot", "challenge", "generation", "owner", "path", "seq", "spaceId", "v"].join();

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Throws `history_binding_mismatch` when `ctx` is present but does not match what the reader derived.
 * Returns "legacy" only when `ctx` is absent.
 */
export function checkBotHistoryContext(batch: unknown, expected: BotHistoryScope): BotHistoryContextState {
  if (!isObject(batch)) throw new Error("history_binding_mismatch");
  if (!("ctx" in batch)) return "legacy";
  const ctx = batch.ctx;
  if (
    !isObject(ctx) ||
    Object.keys(ctx).sort().join() !== CONTEXT_KEYS ||
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

/** The bytes of an earlier batch with its full record context added: the batch's own fields as they were, then `ctx`. */
export function bindBotHistoryContext(batch: Record<string, unknown>, scope: BotHistoryScope): Uint8Array {
  const ctx = {
    v: HISTORY_CONTEXT_VERSION,
    owner: scope.owner,
    spaceId: scope.spaceId,
    path: scope.path,
    bot: scope.bot,
    generation: batch.generation,
    seq: batch.seq,
    challenge: batch.challenge,
  };
  return new TextEncoder().encode(JSON.stringify({ ...batch, ctx }));
}

/** True when `opened` is exactly `original` with a verified context added and nothing else changed. */
export function isContextBindingOf(opened: Uint8Array, original: Record<string, unknown>, scope: BotHistoryScope): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(opened));
    if (checkBotHistoryContext(parsed, scope) !== "bound") return false;
  } catch {
    return false;
  }
  const { ctx: _ctx, ...rest } = parsed as Record<string, unknown>;
  return JSON.stringify(rest) === JSON.stringify(original);
}
