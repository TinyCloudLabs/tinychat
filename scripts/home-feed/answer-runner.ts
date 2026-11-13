// The runner `run.ts watch --runner` starts once per handed-off response (TC-2204). It writes the owner's Home answer
// where the board's watcher already reads Sam's answers, then tells Home the response was received:
//   sitrep.answer → xyz.tinycloud.rocinante/sam/answers/<askId>/<stamp>.json (answerKey), as the sitrep UI writes it
//   sitrep.state  → xyz.tinycloud.rocinante/sam/state/<kind>/<id>.json (stateKey), merged into what is there
// then a feed_handling "acknowledged". It exits 0 only after both writes are read back. Anything else (a comment, a
// card action) is not written through and exits non-zero, so it stays unconfirmed in the handoff ledger.
//
// Approval codes pass through here: the log holds ids and times only, never a payload or response text.
import { appendFile, chmod } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ErrorCodes } from "@tinycloud/sdk-services";
import { answerKey, mergeSitrepStates, stateKey, validateAnswer, validateState } from "@tinyboilerplate/core/feed/sitrep";
import type { SamState } from "@tinyboilerplate/core/feed/sitrep";
import { acknowledgeHomeMirrorResponse, homeMirrorDiagnostic, homeMirrorRefusal, readHomeMirrorBinding, readHomeMirrorResponse } from "./bridge";
import type { HomeMirrorContext } from "./bridge-types";
import { openOwnerSession, withStopSignal } from "./owner-session";

/** The notification run.ts writes on the runner's stdin (projectFeedResponseNotification). */
export const handedOffResponse = z.object({
  responseId: z.string().min(1), cardId: z.string().uuid(), revision: z.number().int().positive().safe(), issuanceId: z.string().min(1),
  kind: z.enum(["answer", "followup", "message"]), createdAt: z.string().min(1), sequence: z.number().int().positive().safe(),
  choiceId: z.string().optional(), text: z.string().optional(), supersedesResponseId: z.string().optional(),
  payloadType: z.string().optional(), payloadVersion: z.number().int().optional(),
}).strict();
export type HandedOffResponse = z.infer<typeof handedOffResponse>;

export interface WriteThroughResult { wrote: "answer" | "state"; key: string; stored: "written" | "already"; received: "recorded" | "already" }

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

async function writeAnswer(kv: Kv, key: string, value: unknown, signal?: AbortSignal): Promise<"written" | "already"> {
  const existing = await read(kv, key, signal);
  if (existing) {
    if (sameJson(existing.text, value)) return "already";
    throw homeMirrorRefusal("The board already holds a different answer for this response");
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

/** Writes one handed-off response through to the board and records Home's "received". Throws when it does not. */
export async function writeThroughResponse(ctx: HomeMirrorContext, options: { sourceId: string; header: HandedOffResponse }): Promise<WriteThroughResult> {
  const { header } = options;
  const binding = await readHomeMirrorBinding(ctx, { sourceId: options.sourceId, cardId: header.cardId, revision: header.revision, issuanceId: header.issuanceId });
  if (!binding) throw homeMirrorRefusal("Home mirror operation refused", ErrorCodes.NOT_FOUND);
  const saved = await readHomeMirrorResponse(ctx, binding, header.responseId, header.sequence);
  if (!saved || saved.response.kind !== header.kind || saved.response.sequence !== header.sequence) throw homeMirrorRefusal("Home mirror operation refused", ErrorCodes.NOT_FOUND);
  const { response, payload } = saved;
  let wrote: WriteThroughResult["wrote"], key: string, stored: WriteThroughResult["stored"];
  if (payload?.type === "sitrep.answer" && payload.version === 1 && response.kind !== "message" && (binding.legacy.kind === "ask" || binding.legacy.kind === "approval")) {
    const answer = validateAnswer(payload.data);
    if (!answer.ok || answer.value.askId !== binding.legacy.id) throw homeMirrorRefusal("Home mirror operation refused");
    wrote = "answer"; key = answerKey(answer.value.askId, answer.value.at);
    stored = await writeAnswer(ctx.legacy, key, payload.data, ctx.signal);
  } else if (payload?.type === "sitrep.state" && payload.version === 1 && response.kind === "message" && (binding.legacy.kind === "task" || binding.legacy.kind === "hold")) {
    const state = validateState(payload.data);
    if (!state.ok || state.value.kind !== binding.legacy.kind || state.value.id !== binding.legacy.id) throw homeMirrorRefusal("Home mirror operation refused");
    wrote = "state"; key = stateKey(state.value.kind, state.value.id);
    stored = await writeState(ctx.legacy, key, state.value, ctx.signal);
  } else throw homeMirrorRefusal("This response is not one the runner writes through");
  const { recorded } = await acknowledgeHomeMirrorResponse(ctx, binding, response);
  return { wrote, key, stored, received: recorded ? "recorded" : "already" };
}

/** One log line per run: ids and times only. `pickupMs` is how long after the owner's save the runner started. */
export function runnerLogLine(start: string, header: Pick<HandedOffResponse, "responseId" | "cardId" | "createdAt"> | undefined, outcome: { result?: WriteThroughResult; code?: string }): string {
  const pickupMs = header && Number.isFinite(Date.parse(header.createdAt)) ? Date.parse(start) - Date.parse(header.createdAt) : null;
  return `${JSON.stringify({
    at: start, ...(header ? { responseId: header.responseId, cardId: header.cardId, createdAt: header.createdAt } : {}), pickupMs,
    ...(outcome.result ? { wrote: outcome.result.wrote, stored: outcome.result.stored, received: outcome.result.received } : {}),
    ...(outcome.code ? { error: outcome.code } : {}),
  })}\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runAnswerRunner(argv: string[], stdin: () => Promise<string> = readStdin): Promise<number> {
  const start = new Date().toISOString();
  let header: HandedOffResponse | undefined, log: string | undefined;
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: {
      "tc-home": { type: "string" }, profile: { type: "string" }, host: { type: "string" },
      "owner-space": { type: "string" }, "legacy-space": { type: "string" }, source: { type: "string" }, log: { type: "string" },
    } });
    log = values.log;
    if (!values["tc-home"] || !values.profile || !values["owner-space"] || !values["legacy-space"] || !values.source || !values.log) throw homeMirrorRefusal("Answer runner requires a source, spaces and a response on stdin");
    const parsed = handedOffResponse.safeParse(JSON.parse(await stdin()));
    if (!parsed.success) throw homeMirrorRefusal("Answer runner requires a source, spaces and a response on stdin");
    header = parsed.data;
    const options = { tcHome: values["tc-home"], profile: values.profile, ownerSpace: values["owner-space"], legacySpace: values["legacy-space"], host: values.host };
    const sourceId = values.source, logPath = values.log, response = header;
    const result = await withStopSignal(async (signal) => {
      const { ctx } = await openOwnerSession({ ...options, signal });
      return writeThroughResponse(ctx, { sourceId, header: response });
    });
    await writeLog(logPath, runnerLogLine(start, header, { result }));
    return 0;
  } catch (error) {
    const diagnostic = homeMirrorDiagnostic(error);
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    if (log) await writeLog(log, runnerLogLine(start, header, { code: diagnostic.error.code })).catch(() => {});
    return diagnostic.exitCode;
  }
}

async function writeLog(path: string, line: string): Promise<void> {
  await appendFile(path, line, { mode: 0o600 });
  await chmod(path, 0o600);
}

if (import.meta.main) process.exitCode = await runAnswerRunner(process.argv.slice(2));
