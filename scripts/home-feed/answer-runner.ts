// The runner `run.ts watch --runner` starts once per handed-off response (TC-2204). It writes the owner's Home answer
// where the board's watcher already reads Sam's answers, then tells Home the response was received:
//   sitrep.answer → xyz.tinycloud.rocinante/sam/answers/<askId>/<stamp>.json (answerKey), as the sitrep UI writes it
//   sitrep.state  → xyz.tinycloud.rocinante/sam/state/<kind>/<id>.json (stateKey), merged into what is there
//   sitrep.thread → xyz.tinycloud.rocinante/sam/thread/<kind>/<id>/<messageId>.json (threadKey), the card message the
//                   sitrep UI writes and the board's card-thread relay delivers to the card's owner
// then a feed_handling "acknowledged". It exits 0 only after both writes are read back. Anything else (a card action)
// is not written through and exits non-zero, so it stays unconfirmed in the handoff ledger.
//
// The header on stdin names a response and grants nothing. The runner reads the response from the owner's storage
// and, immediately before its first write, checks that the owner's delivery policy releases it to the recipient this
// runner was configured with (`--recipient`, the watch config's recipient), within its dispatch deadline.
//
// Approval codes pass through here: the log holds the stored response's ids and times only, never a payload, a
// response text or anything read from stdin.
import { appendFile, chmod } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ErrorCodes } from "@tinycloud/sdk-services";
import { answerKey, decodeOwnerThreadMessage, isClosed, mergeSitrepStates, stateKey, threadKey, validateAnswer, validateState } from "@tinyboilerplate/core/feed/sitrep";
import type { SamState } from "@tinyboilerplate/core/feed/sitrep";
import { acknowledgeHomeMirrorResponse, homeMirrorDiagnostic, homeMirrorFailure, homeMirrorRefusal, readHomeMirrorBinding, readHomeMirrorBoardRecord, readHomeMirrorDelivery, readHomeMirrorResponse } from "./bridge";
import type { HomeMirrorRefusalMessage } from "./bridge";
import type { HomeMirrorContext } from "./bridge-types";
import { openOwnerSession, withStopSignal } from "./owner-session";

/**
 * The notification run.ts writes on the runner's stdin (projectFeedResponseNotification), restored deliveries'
 * `dispatchBefore` included. Only the identity is used, to find the stored response; fields this runner does not
 * know are dropped rather than refused, so an SDK that adds one does not leave responses unconfirmed forever.
 */
export const handedOffResponse = z.object({
  responseId: z.string().min(1), cardId: z.string().uuid(), revision: z.number().int().positive().safe(), issuanceId: z.string().min(1),
  kind: z.enum(["answer", "followup", "message"]), createdAt: z.string().min(1), sequence: z.number().int().positive().safe(),
  choiceId: z.string().optional(), text: z.string().optional(), supersedesResponseId: z.string().optional(),
  payloadType: z.string().optional(), payloadVersion: z.number().int().optional(), dispatchBefore: z.string().nullable().optional(),
});
export type HandedOffResponse = z.infer<typeof handedOffResponse>;

export interface WriteThroughResult { wrote: "answer" | "state" | "thread"; key: string; stored: "written" | "already"; received: "recorded" | "already" }
/** What the log may hold about a response: taken from the stored row, never from the header. */
export interface RunnerLogIds { responseId: string; cardId: string; createdAt: string }

type Kv = HomeMirrorContext["legacy"];
type Read = { text: string; etag: string } | undefined;

async function read(kv: Kv, key: string, signal?: AbortSignal): Promise<Read> {
  const result = await kv.get<Uint8Array>(key, { binary: true, source: "network", prefix: "", signal });
  if (!result.ok) {
    if (result.error.code === ErrorCodes.KV_NOT_FOUND) return undefined;
    throw result.error;
  }
  const { data, headers } = result.data;
  if (!(data instanceof Uint8Array) || !headers.etag || headers.etag.startsWith("W/")) throw homeMirrorRefusal("Home mirror operation refused");
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), etag: headers.etag };
}
const sameJson = (text: string, value: unknown) => { try { return isDeepStrictEqual(JSON.parse(text), value); } catch { return false; } };

/** Put-if-absent and read back: an identical value already there counts as written, a different one is refused. */
async function writeOnce(kv: Kv, key: string, value: unknown, conflict: HomeMirrorRefusalMessage, signal?: AbortSignal): Promise<"written" | "already"> {
  const existing = await read(kv, key, signal);
  if (existing) {
    if (sameJson(existing.text, value)) return "already";
    throw homeMirrorRefusal(conflict);
  }
  const put = await kv.put(key, JSON.stringify(value), { ifNoneMatch: "*", prefix: "", contentType: "application/json", signal });
  if (!put.ok) {
    // Written by a concurrent run of this same response, or something else: only identical content is accepted.
    const raced = await read(kv, key, signal);
    if (raced && sameJson(raced.text, value)) return "already";
    throw put.error;
  }
  const back = await read(kv, key, signal);
  if (!back || !sameJson(back.text, value)) throw homeMirrorRefusal("Home mirror operation refused");
  return "written";
}

async function writeState(kv: Kv, key: string, delta: SamState, signal?: AbortSignal): Promise<"written" | "already"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await read(kv, key, signal);
    let current: SamState | undefined;
    if (existing) {
      const parsed = validateState(JSON.parse(existing.text));
      if (!parsed.ok) throw homeMirrorRefusal("Home mirror operation refused");
      current = parsed.value;
    }
    const merged = mergeSitrepStates(current ? [current, delta] : [delta]).find((state) => state.kind === delta.kind && state.id === delta.id);
    const checked = merged && validateState(merged);
    if (!checked || !checked.ok) throw homeMirrorRefusal("Home mirror operation refused");
    if (current && isDeepStrictEqual(current, checked.value)) return "already";
    const put = await kv.put(key, JSON.stringify(checked.value), { ...(existing ? { ifMatch: existing.etag } : { ifNoneMatch: "*" as const }), prefix: "", contentType: "application/json", signal });
    if (!put.ok) { if (put.error.code === ErrorCodes.KV_PRECONDITION_FAILED && attempt === 0) continue; throw put.error; }
    const back = await read(kv, key, signal);
    if (!back || !sameJson(back.text, checked.value)) throw homeMirrorRefusal("Home mirror operation refused");
    return "written";
  }
  throw homeMirrorRefusal("Home mirror operation refused", ErrorCodes.KV_PRECONDITION_FAILED);
}

/**
 * Writes one handed-off response through to the board and records Home's "received". Throws when it does not; the
 * error carries a code and a safe message only. `recipient` must come from this runner's own configuration.
 * `observe` receives the stored response's ids as soon as they are known, for the log.
 */
export async function writeThroughResponse(ctx: HomeMirrorContext, options: { sourceId: string; recipient: string; header: HandedOffResponse; observe?: (ids: RunnerLogIds) => void }): Promise<WriteThroughResult> {
  try {
    const { header, recipient } = options;
    if (!recipient || recipient === "*") throw homeMirrorRefusal("Answer runner requires a source, a recipient, spaces and a response on stdin");
    const binding = await readHomeMirrorBinding(ctx, { sourceId: options.sourceId, cardId: header.cardId, revision: header.revision, issuanceId: header.issuanceId });
    if (!binding) throw homeMirrorRefusal("Home mirror operation refused", ErrorCodes.NOT_FOUND);
    const saved = await readHomeMirrorResponse(ctx, binding, header.responseId, header.sequence);
    if (!saved || saved.response.kind !== header.kind || saved.response.sequence !== header.sequence) throw homeMirrorRefusal("Home mirror operation refused", ErrorCodes.NOT_FOUND);
    const { response, payload } = saved;
    options.observe?.({ responseId: response.responseId, cardId: response.cardId, createdAt: response.createdAt });
    let wrote: WriteThroughResult["wrote"], key: string, write: () => Promise<WriteThroughResult["stored"]>;
    if (payload?.type === "sitrep.answer" && payload.version === 1 && response.kind !== "message" && (binding.legacy.kind === "ask" || binding.legacy.kind === "approval")) {
      const answer = validateAnswer(payload.data);
      if (!answer.ok || answer.value.askId !== binding.legacy.id) throw homeMirrorRefusal("Home mirror operation refused");
      wrote = "answer"; key = answerKey(answer.value.askId, answer.value.at);
      write = () => writeOnce(ctx.legacy, key, payload.data, "The board already holds a different answer for this response", ctx.signal);
    } else if (payload?.type === "sitrep.state" && payload.version === 1 && response.kind === "message" && (binding.legacy.kind === "task" || binding.legacy.kind === "hold")) {
      const state = validateState(payload.data);
      if (!state.ok || state.value.kind !== binding.legacy.kind || state.value.id !== binding.legacy.id) throw homeMirrorRefusal("Home mirror operation refused");
      wrote = "state"; key = stateKey(state.value.kind, state.value.id);
      const delta = state.value;
      write = () => writeState(ctx.legacy, key, delta, ctx.signal);
    } else if (payload?.type === "sitrep.thread" && payload.version === 1 && response.kind === "message") {
      // Home's message carries its id; the board stores only the sitrep UI's message fields under that id, and its relay
      // sends them to the card's owner (or the XO). A note Home routed to named recipients is refused, never re-routed:
      // the board cannot honour that route, and Sam was shown it. A card closed since Sam wrote is refused too, so Home
      // does not say "received" for a note the relay would drop.
      const decoded = (() => { try { return decodeOwnerThreadMessage({ kind: binding.legacy.kind, id: binding.legacy.id }, payload.data); } catch { throw homeMirrorRefusal("Home mirror operation refused"); } })();
      if (decoded.delivery) throw homeMirrorRefusal("This note names recipients the board's card thread cannot route to");
      const card = await readHomeMirrorBoardRecord(ctx, binding);
      if (!card || card.id !== binding.legacy.id || isClosed(card)) throw homeMirrorRefusal("This card is closed; the note was not passed on");
      const { side: _side, messageId, ...message } = decoded.message;
      wrote = "thread"; key = threadKey("sam", message.kind, message.id, message.at, messageId.slice(-32));
      write = () => writeOnce(ctx.legacy, key, message, "The board already holds a different message for this response", ctx.signal);
    } else throw homeMirrorRefusal("This response is not one the runner writes through");
    // The delivery gate, immediately before the first write: the owner's stored policy for this recipient, and its deadline.
    if (!await readHomeMirrorDelivery(ctx, binding, response, recipient)) throw homeMirrorRefusal("This response is not deliverable to this runner", ErrorCodes.PERMISSION_DENIED);
    const stored = await write();
    const { recorded } = await acknowledgeHomeMirrorResponse(ctx, binding, response);
    return { wrote, key, stored, received: recorded ? "recorded" : "already" };
  } catch (error) { throw homeMirrorFailure(error, "runner"); }
}

/** One log line per run: the stored response's ids and times only. `pickupMs` is how long after the owner's save the runner started. */
export function runnerLogLine(start: string, ids: RunnerLogIds | undefined, outcome: { result?: WriteThroughResult; code?: string }): string {
  const pickupMs = ids && Number.isFinite(Date.parse(ids.createdAt)) ? Date.parse(start) - Date.parse(ids.createdAt) : null;
  return `${JSON.stringify({
    at: start, ...(ids ? { responseId: ids.responseId, cardId: ids.cardId, createdAt: ids.createdAt } : {}), pickupMs,
    ...(outcome.result ? { wrote: outcome.result.wrote, stored: outcome.result.stored, received: outcome.result.received } : {}),
    ...(outcome.code ? { error: outcome.code } : {}),
  })}\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

type OpenSession = (options: Parameters<typeof openOwnerSession>[0]) => Promise<{ ctx: HomeMirrorContext }>;

export async function runAnswerRunner(argv: string[], stdin: () => Promise<string> = readStdin, open: OpenSession = openOwnerSession): Promise<number> {
  const start = new Date().toISOString();
  let ids: RunnerLogIds | undefined, log: string | undefined;
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: {
      "tc-home": { type: "string" }, profile: { type: "string" }, host: { type: "string" },
      "owner-space": { type: "string" }, "legacy-space": { type: "string" }, source: { type: "string" }, recipient: { type: "string" }, log: { type: "string" },
    } });
    log = values.log;
    const refused = () => homeMirrorRefusal("Answer runner requires a source, a recipient, spaces and a response on stdin");
    if (!values["tc-home"] || !values.profile || !values["owner-space"] || !values["legacy-space"] || !values.source || !values.recipient || values.recipient === "*" || !values.log) throw refused();
    let input: unknown;
    try { input = JSON.parse(await stdin()); } catch { throw refused(); }
    const parsed = handedOffResponse.safeParse(input);
    if (!parsed.success) throw refused();
    const options = { tcHome: values["tc-home"], profile: values.profile, ownerSpace: values["owner-space"], legacySpace: values["legacy-space"], host: values.host };
    const sourceId = values.source, recipient = values.recipient, logPath = values.log, header = parsed.data;
    const result = await withStopSignal(async (signal) => {
      const { ctx } = await open({ ...options, signal });
      return writeThroughResponse(ctx, { sourceId, recipient, header, observe: (stored) => { ids = stored; } });
    });
    await writeLog(logPath, runnerLogLine(start, ids, { result }));
    return 0;
  } catch (error) {
    const diagnostic = homeMirrorDiagnostic(error);
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    if (log) await writeLog(log, runnerLogLine(start, ids, { code: diagnostic.error.code })).catch(() => {});
    return diagnostic.exitCode;
  }
}

async function writeLog(path: string, line: string): Promise<void> {
  await appendFile(path, line, { mode: 0o600 });
  await chmod(path, 0o600);
}

if (import.meta.main) process.exitCode = await runAnswerRunner(process.argv.slice(2));
