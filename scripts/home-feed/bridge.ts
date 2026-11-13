import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ErrorCodes } from "@tinycloud/sdk-services";
import type { QueryOptions, Result, SqlValue } from "@tinycloud/sdk-services";
import {
  deliverFeedResponse, feedCardSchema, feedResourceNames, getFeedHandoff,
  listFeedCards, listFeedResponseDeliveries, listFeedResponses,
  projectFeedResponseNotification, publishFeedCard, readFeedResponseHandling, readFeedResponsePayload, recordFeedHandling,
} from "@tinycloud/sdk-services/feed";
import type { FeedCard, FeedCardIdentity, FeedDatabase, FeedDeliveryOptions, FeedHandling, FeedHandoff, FeedHooks, FeedResponse, FeedResponsePayload } from "@tinycloud/sdk-services/feed";
import {
  applyUpsert, boardKey, claimDecisionHistory, closePatch, currentAnswer,
  decodeLegacySendNote, decodeOwnerThreadMessage,
  emptySitrepOwnerData, holdLiftPatch, isKind, openApprovals, ownerAnswerLookup,
  parseSitrepCardPayload, validateAnswer, validateClaimDecision, validateRecord,
  validateSitrepAction, validateState,
} from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Patch, SamState } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeMirrorBinding, HomeMirrorCloseReceipt, HomeMirrorContext, HomeMirrorIdentity } from "./bridge-types";

const OWNER = "xyz.tinycloud.tinychat/home_feed";
const PREFIX = "xyz.tinycloud.tinychat/feed";
const text = z.string().min(1), uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema = z.object({ cardId: uuid, revision: z.number().int().positive().safe(), issuanceId: text }).strict();
const referenceSchema = z.object({ spaceId: text, database: text }).strict();
const sourceSchema = z.object({ sourceId: text, agentDid: text, output: referenceSchema, responses: referenceSchema }).strict();
const bindingSchema = z.object({
  version: z.literal(1), source: sourceSchema, identity: identitySchema, cardUuid: uuid,
  legacy: z.object({ spaceId: text, fullKey: text, kind: z.custom<BoardRecord["kind"]>((value: unknown) => typeof value === "string" && isKind(value)), id: text, publicationSha256: digest, publishedETag: text }).strict(),
}).strict();
const receiptSchema = z.object({
  version: z.literal(1), sourceId: text, identity: identitySchema, responseId: text, legacyKey: text,
  publicationSha256: digest, expectedETag: text, closedETag: text,
  status: z.enum(["answered", "dropped", "done", "resolved", "lifted"]), observedAt: z.string().datetime({ offset: true }),
}).strict();
// The owner's card actions (frontend/src/feed/ownerActions.ts): told to the agent, never closing evidence.
const ownerActionSchema = z.union([
  z.object({ type: z.enum(["feed.drop", "feed.acknowledge"]), version: z.literal(1), data: z.object({}).strict() }).strict(),
  z.object({ type: z.literal("feed.snooze"), version: z.literal(1), data: z.object({ until: z.string().datetime({ offset: true }) }).strict() }).strict(),
]);
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const businessSchema = z.custom<BoardRecord>((value: unknown) => object(value) && typeof value.kind === "string" && isKind(value.kind) && validateRecord(value.kind, value).ok);
const cardSchema = z.custom<FeedCard>((value: unknown) => feedCardSchema.safeParse(value).success);
const inputSchema = z.object({
  source: sourceSchema.extend({ label: z.string() }).strict(), card: cardSchema,
  legacy: z.object({ spaceId: text, fullKey: text, record: businessSchema }).strict(),
}).strict();
type SafeDiagnostic = { name: string; message: string; code: string; step: string; status?: number };
class MirrorFailure extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(readonly diagnostic: SafeDiagnostic) {
    super(diagnostic.message);
    this.name = diagnostic.name; this.code = diagnostic.code; this.status = diagnostic.status;
  }
}
const argumentCodes = new Set(["ERR_PARSE_ARGS_UNKNOWN_OPTION", "ERR_PARSE_ARGS_INVALID_OPTION_VALUE", "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL", "ERR_INVALID_URL"]);
const transientCodes = new Set(["NETWORK_ERROR", "TIMEOUT", "NODE_BUSY", "REQUEST_TIMEOUT"]);
const refusalMessages = [
  "Home mirror operation refused", "Invalid node host", "Existing owner session is unavailable",
  "Home mirror requires explicit mode, profile, full spaces, input, and watch handoff file",
  "Home mirror inventory requires a board index, a source and full spaces",
  "Home mirror inventory leaves approvals, holds and claims on the board",
  "Board index is unreadable",
  "The synthetic check runs only in a QA owner space",
  "Synthetic check requires a profile, full spaces and a source",
  "Synthetic check readback did not match",
  "This response is not one the runner writes through",
  "This response is not deliverable to this runner",
  "This handoff ledger belongs to another Home feed source",
  "The board already holds a different answer for this response",
  "The board already holds a different message for this response",
  "This card is closed; the note was not passed on",
  "This note names recipients the board's card thread cannot route to",
  "Answer runner requires a source, a recipient, spaces and a response on stdin",
] as const;
export type HomeMirrorRefusalMessage = (typeof refusalMessages)[number];
const safeMessages = new Set<string>([
  ...refusalMessages,
  "Local durable handoff initialization failed", "Home mirror watch requires Bun SQLite",
  "Home mirror handoff requires a persistent file path", "Local durable handoff unavailable",
]);
const argumentMessages = new Set<string>([
  "Home mirror requires explicit mode, profile, full spaces, input, and watch handoff file", "Home mirror inventory requires a board index, a source and full spaces",
  "Synthetic check requires a profile, full spaces and a source", "Answer runner requires a source, a recipient, spaces and a response on stdin",
]);
const inputFields = new Set(["source", "sourceId", "agentDid", "label", "output", "responses", "spaceId", "database", "card", "cardId", "revision", "issuanceId", "legacy", "fullKey", "record", "recipient", "runner", "renewalSeconds", "responseId", "kind", "createdAt", "sequence", "payloadType", "payloadVersion"]);
function failure(code: string = ErrorCodes.INVALID_INPUT): Error { return Object.assign(new Error("Home mirror operation refused"), { code }); }
/** A refusal whose message may reach the diagnostic (it names no input value). */
export function homeMirrorRefusal(message: HomeMirrorRefusalMessage, code: string = ErrorCodes.INVALID_INPUT): Error { return Object.assign(new Error(message), { code }); }
function safeFailure(error: unknown, step = "mirror"): MirrorFailure {
  if (error instanceof MirrorFailure) return error.diagnostic.step === "mirror" && step !== "mirror" ? new MirrorFailure({ ...error.diagnostic, step }) : error;
  const candidate = object(error) ? error.code : undefined;
  const code = typeof candidate === "string" && (Object.hasOwn(ErrorCodes, candidate) || argumentCodes.has(candidate)) ? candidate : error instanceof z.ZodError || error instanceof SyntaxError ? ErrorCodes.INVALID_INPUT : "HOME_MIRROR_ERROR";
  const meta = object(error) && object(error.meta) ? error.meta : undefined;
  const status = meta?.status;
  const name = error instanceof z.ZodError ? "ZodError" : error instanceof TypeError ? "TypeError" : error instanceof SyntaxError ? "SyntaxError" : error instanceof RangeError ? "RangeError" : object(error) && error.service === "sql" ? "ServiceError" : "Error";
  let message = "Error details redacted";
  if (error instanceof z.ZodError) {
    // Schema-defined paths and issue codes only: Zod messages may echo input values.
    message = error.issues.map((issue) => `${issue.path.filter((part) => typeof part === "string" && inputFields.has(part)).join(".") || "input"}: ${issue.code}`).join("; ");
  } else if (object(error) && error.service === "sql") {
    // Preserve the SDK's already-redacted SQL message, never its HTTP body/cause.
    message = error.message === "Local durable handoff operation failed" ? error.message : "SQL operation failed";
  } else if (argumentCodes.has(code)) {
    message = "Invalid command-line arguments"; step = "arguments";
  } else if (error instanceof Error && safeMessages.has(error.message)) {
    message = error.message;
    if (argumentMessages.has(message)) step = "arguments";
  }
  return new MirrorFailure({ name, message, code, step, ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}) });
}
/** Any failure as the mirror reports it: a code, a safe message and a step, never a node message or HTTP body. */
export function homeMirrorFailure(error: unknown, step: string): Error { return safeFailure(error, step); }
export function homeMirrorDiagnostic(error: unknown) {
  const failure = safeFailure(error, "run");
  const { code, status } = failure.diagnostic;
  const transient = code !== ErrorCodes.OUTCOME_UNKNOWN && (transientCodes.has(code) || status === 429 || status === 503);
  return { error: failure.diagnostic, delivery: "not-confirmed", retry: "manual-reconciliation-required", exitCode: code === ErrorCodes.INVALID_INPUT || argumentCodes.has(code) ? 2 : transient ? 6 : 1 };
}
function take<T>(result: Result<T>, step?: string): T { if (!result.ok) throw safeFailure(result.error, step); return result.data; }
function active(ctx: HomeMirrorContext): void { if (ctx.signal?.aborted) throw failure(ErrorCodes.ABORTED); }
function tuple(value: FeedCardIdentity): FeedCardIdentity { return { cardId: value.cardId, revision: value.revision, issuanceId: value.issuanceId }; }
function sameIdentity(a: FeedCardIdentity, b: FeedCardIdentity): boolean { return a.cardId === b.cardId && a.revision === b.revision && a.issuanceId === b.issuanceId; }
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const publication = (record: BoardRecord, cardUuid: string) => JSON.stringify({ ...record, cardUuid });
function privateDatabase(database: FeedDatabase, ctx: HomeMirrorContext): FeedDatabase {
  return {
    query<T = Record<string, unknown>>(sql: string, params?: SqlValue[], options?: QueryOptions) {
      return database.query<T>(sql, params, { ...options, signal: options?.signal ?? ctx.signal, redactErrors: true });
    },
    execute: (sql, params, options) => database.execute(sql, params, { ...options, signal: options?.signal ?? ctx.signal, redactErrors: true }),
    batch: (statements, options) => database.batch(statements, { ...options, signal: options?.signal ?? ctx.signal, redactErrors: true }),
  };
}
async function agentRows(ctx: HomeMirrorContext): Promise<unknown[][]> {
  if (ctx.cache?.agents) return ctx.cache.agents;
  const owner = privateDatabase(ctx.sql.db(OWNER), ctx);
  const rows = take(await owner.query<unknown>("SELECT agent_id,agent_did,output_resource,response_resource FROM feed_agents")).rows;
  if (ctx.cache) ctx.cache.agents = rows;
  return rows;
}
async function registered(ctx: HomeMirrorContext, sourceId: string): Promise<HomeMirrorBinding["source"]> {
  const rows = await agentRows(ctx);
  const reserved = new Set(["home_feed", "threads"]);
  let source: HomeMirrorBinding["source"] | undefined;
  for (const raw of rows) {
    const row = z.tuple([text, text, text, text]).parse(raw);
    const expected = take(feedResourceNames(PREFIX, row[0]));
    if (row[2] !== expected.outputResource || row[3] !== expected.responseResource) throw failure();
    for (const path of [row[2], row[3]]) {
      const basename = path.split("/").at(-1)!;
      if (reserved.has(basename)) throw failure();
      reserved.add(basename);
    }
    if (row[0] === sourceId) {
      if (source) throw failure();
      source = { sourceId, agentDid: row[1], output: { spaceId: ctx.ownerSpaceId, database: row[2] }, responses: { spaceId: ctx.ownerSpaceId, database: row[3] } };
    }
  }
  if (!source) throw failure(ErrorCodes.NOT_FOUND);
  return source;
}
function validateBinding(ctx: HomeMirrorContext, value: unknown): HomeMirrorBinding {
  const binding = bindingSchema.parse(value);
  if (binding.cardUuid !== binding.identity.cardId || binding.legacy.spaceId !== ctx.legacySpaceId ||
    binding.source.output.spaceId !== ctx.ownerSpaceId || binding.source.responses.spaceId !== ctx.ownerSpaceId ||
    binding.legacy.fullKey !== boardKey(binding.legacy.kind, binding.legacy.id)) throw failure();
  return binding;
}
type StoredBinding = { binding: HomeMirrorBinding; receipt: HomeMirrorCloseReceipt | null; receiptJSON: string | null };
function stored(ctx: HomeMirrorContext, row: unknown[]): StoredBinding {
  if (row.length !== 6 || typeof row[0] !== "string" || typeof row[1] !== "string" || typeof row[2] !== "number" || typeof row[3] !== "string" || typeof row[4] !== "string" || (row[5] !== null && typeof row[5] !== "string")) throw failure();
  const binding = validateBinding(ctx, JSON.parse(row[4]));
  if (binding.source.sourceId !== row[0] || !sameIdentity(binding.identity, { cardId: row[1], revision: row[2], issuanceId: row[3] })) throw failure();
  const receipt = row[5] === null ? null : receiptSchema.parse(JSON.parse(row[5]));
  if (receipt && (receipt.sourceId !== binding.source.sourceId || !sameIdentity(receipt.identity, binding.identity) || receipt.legacyKey !== binding.legacy.fullKey || receipt.publicationSha256 !== binding.legacy.publicationSha256)) throw failure();
  return { binding, receipt, receiptJSON: row[5] };
}
async function load(ctx: HomeMirrorContext, identity: HomeMirrorIdentity): Promise<StoredBinding | undefined> {
  const rows = take(await privateDatabase(ctx.sql.db(OWNER), ctx).query<unknown>("SELECT source_id,card_id,revision,issuance_id,binding_json,close_receipt_json FROM feed_sitrep_mirrors WHERE source_id=? AND card_id=? AND revision=? AND issuance_id=?", [identity.sourceId, identity.cardId, identity.revision, identity.issuanceId])).rows;
  if (rows.length > 1) throw failure();
  return rows[0] ? stored(ctx, rows[0]) : undefined;
}
/** The binding of one mirrored card issuance, if it has one. */
export async function readHomeMirrorBinding(ctx: HomeMirrorContext, identity: HomeMirrorIdentity): Promise<HomeMirrorBinding | undefined> {
  try { return (await load(ctx, identity))?.binding; } catch (error) { throw safeFailure(error, "binding"); }
}
/** A registered feed source, as the mirror reads it from the owner's feed_agents. */
export async function readHomeMirrorSource(ctx: HomeMirrorContext, sourceId: string): Promise<HomeMirrorBinding["source"]> {
  try { return await registered(ctx, sourceId); } catch (error) { throw safeFailure(error, "source"); }
}
async function mirrorRows(ctx: HomeMirrorContext): Promise<unknown[][]> {
  if (ctx.cache?.mirrors) return ctx.cache.mirrors;
  const rows = take(await privateDatabase(ctx.sql.db(OWNER), ctx).query<unknown>("SELECT source_id,card_id,revision,issuance_id,binding_json,close_receipt_json FROM feed_sitrep_mirrors")).rows;
  if (ctx.cache) ctx.cache.mirrors = rows;
  return rows;
}
/** Every binding in the owner's mirror table (read once per run when the context carries a cache). */
export async function homeMirrorBindings(ctx: HomeMirrorContext): Promise<HomeMirrorBinding[]> {
  try { return (await mirrorRows(ctx)).map((row) => stored(ctx, row).binding); } catch (error) { throw safeFailure(error, "binding"); }
}
/** What a binding records as the board copy's hash, for one record and card UUID. */
export function homeMirrorPublicationSha256(record: BoardRecord, cardUuid: string): string { return hash(publication(record, cardUuid)); }
async function currentCard(ctx: HomeMirrorContext, source: HomeMirrorBinding["source"], identity: FeedCardIdentity): Promise<FeedCard | undefined> {
  const cards = take(await listFeedCards(privateDatabase(ctx.sql.db(source.output.database), ctx)));
  return cards.find((card) => card.cardId === identity.cardId && sameIdentity(card, identity));
}
type LegacyRead = { raw: Record<string, unknown>; record: BoardRecord; etag: string; sha256: string };
async function readLegacy(ctx: HomeMirrorContext, kind: BoardRecord["kind"], key: string): Promise<LegacyRead | undefined> {
  const result = await ctx.legacy.get<Uint8Array>(key, { binary: true, source: "network", prefix: "", signal: ctx.signal });
  if (!result.ok) {
    if (result.error.code === ErrorCodes.KV_NOT_FOUND) return undefined;
    throw safeFailure(result.error);
  }
  const { data, headers } = result.data;
  if (!(data instanceof Uint8Array) || !headers.etag || headers.etag.startsWith("W/")) throw failure();
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  if (!object(raw)) throw failure();
  const { cardUuid: _cardUuid, ...body } = raw;
  if (Object.hasOwn(raw, "cardUuid") && !uuid.safeParse(raw.cardUuid).success) throw failure();
  const checked = validateRecord(kind, body);
  if (!checked.ok) throw failure();
  return { raw, record: checked.value, etag: headers.etag, sha256: hash(data) };
}
/** The board's current copy of a mirrored card, without its Home marker; undefined once it is gone. */
export async function readHomeMirrorBoardRecord(ctx: HomeMirrorContext, binding: HomeMirrorBinding): Promise<BoardRecord | undefined> {
  try { return (await readLegacy(ctx, binding.legacy.kind, binding.legacy.fullKey))?.record; } catch (error) { throw safeFailure(error); }
}

export async function publishHomeMirror(ctx: HomeMirrorContext, value: unknown): Promise<HomeMirrorBinding> {
  try {
    active(ctx);
    const input = inputSchema.parse(value), identity = identitySchema.parse(tuple(input.card));
    const source = await registered(ctx, input.source.sourceId);
    const requestedSource = { sourceId: input.source.sourceId, agentDid: input.source.agentDid, output: input.source.output, responses: input.source.responses };
    if (!isDeepStrictEqual(source, requestedSource) || input.legacy.spaceId !== ctx.legacySpaceId) throw failure();
    const typed = parseSitrepCardPayload(input.card.payload?.sitrep);
    const checked = validateRecord(input.legacy.record.kind, input.legacy.record);
    if (!typed || !checked.ok || typed.record.kind !== input.card.kind || !isDeepStrictEqual(typed.record, checked.value) || input.legacy.fullKey !== boardKey(checked.value.kind, checked.value.id)) throw failure();
    const record = checked.value, body = publication(record, identity.cardId), publicationSha256 = hash(body);
    const owner = privateDatabase(ctx.sql.db(OWNER), ctx);
    const all = (await mirrorRows(ctx)).map((row) => stored(ctx, row));
    const previous = all.find((row) => row.binding.source.sourceId === source.sourceId && sameIdentity(row.binding.identity, identity));
    if (previous && (!isDeepStrictEqual(previous.binding.source, source) || previous.binding.legacy.fullKey !== input.legacy.fullKey || previous.binding.legacy.publicationSha256 !== publicationSha256)) throw failure();
    for (const row of all) if (row.binding.legacy.fullKey === input.legacy.fullKey && (row.binding.source.sourceId !== source.sourceId || row.binding.cardUuid !== identity.cardId)) throw failure();
    // Home is canonical and durable before its mirror is published. No schema is created here.
    take(await publishFeedCard(privateDatabase(ctx.sql.db(source.output.database), ctx), input.card));
    if (!await currentCard(ctx, source, identity)) throw failure();
    if (previous?.receipt) return previous.binding;
    let head = await readLegacy(ctx, record.kind, input.legacy.fullKey);
    if (previous) {
      if (!head || head.etag !== previous.binding.legacy.publishedETag || head.sha256 !== publicationSha256 || head.raw.cardUuid !== identity.cardId) throw failure(ErrorCodes.KV_PRECONDITION_FAILED);
      return previous.binding;
    }
    if (!head || head.sha256 !== publicationSha256 || head.raw.cardUuid !== identity.cardId) {
      const priorHead = head;
      // A Home close rewrote the board copy after publication: its receipt, not the binding, names that head.
      const predecessor = priorHead && all.find((row) => row.binding.source.sourceId === source.sourceId && row.binding.cardUuid === identity.cardId && row.binding.legacy.fullKey === input.legacy.fullKey &&
        ((row.binding.legacy.publishedETag === priorHead.etag && row.binding.legacy.publicationSha256 === priorHead.sha256) ||
          (row.receipt !== null && row.receipt.closedETag === priorHead.etag && priorHead.raw.cardUuid === identity.cardId && priorHead.record.status === row.receipt.status)));
      const unboundSameBusiness = head && !Object.hasOwn(head.raw, "cardUuid") && isDeepStrictEqual(head.record, record);
      if (head && !predecessor && !unboundSameBusiness) throw failure(ErrorCodes.KV_PRECONDITION_FAILED);
      if (!await currentCard(ctx, source, identity)) throw failure();
      active(ctx);
      take(await ctx.legacy.put(input.legacy.fullKey, body, { ...(head ? { ifMatch: head.etag } : { ifNoneMatch: "*" as const }), prefix: "", contentType: "application/json", signal: ctx.signal }));
      head = await readLegacy(ctx, record.kind, input.legacy.fullKey);
    }
    if (!head || head.sha256 !== publicationSha256 || head.raw.cardUuid !== identity.cardId) throw failure();
    const binding: HomeMirrorBinding = { version: 1, source, identity, cardUuid: identity.cardId, legacy: { spaceId: ctx.legacySpaceId, fullKey: input.legacy.fullKey, kind: record.kind, id: record.id, publicationSha256, publishedETag: head.etag } };
    const json = JSON.stringify(binding);
    try {
      // Ownership is checked by the same SQLite write that claims the binding.
      // Multiple issuances remain legal only for the same source and shared UUID.
      take(await owner.execute(`INSERT INTO feed_sitrep_mirrors(source_id,card_id,revision,issuance_id,binding_json)
        SELECT ?,?,?,?,? WHERE NOT EXISTS (
          SELECT 1 FROM feed_sitrep_mirrors AS bound
          WHERE json_extract(bound.binding_json,'$.legacy.spaceId')=?
            AND json_extract(bound.binding_json,'$.legacy.fullKey')=?
            AND (bound.source_id<>? OR bound.card_id<>?)
        ) ON CONFLICT(source_id,card_id,revision,issuance_id) DO NOTHING`,
      [source.sourceId, identity.cardId, identity.revision, identity.issuanceId, json,
        ctx.legacySpaceId, input.legacy.fullKey, source.sourceId, identity.cardId]));
    } catch (error) {
      const replay = await load(ctx, { sourceId: source.sourceId, ...identity });
      if (!replay || !isDeepStrictEqual(replay.binding, binding)) throw error;
    }
    const replay = await load(ctx, { sourceId: source.sourceId, ...identity });
    if (!replay || !isDeepStrictEqual(replay.binding, binding)) throw failure();
    // Later posts in the same run see this binding without reading the table again.
    ctx.cache?.mirrors?.push([source.sourceId, identity.cardId, identity.revision, identity.issuanceId, json, replay.receiptJSON]);
    return replay.binding;
  } catch (error) { throw safeFailure(error, "post"); }
}

type Decision = { response: FeedResponse; patch: Patch };
async function matchingCompletion(ctx: HomeMirrorContext, binding: HomeMirrorBinding, response: FeedResponse, state: SamState): Promise<boolean> {
  const rows = take(await privateDatabase(ctx.sql.db(OWNER), ctx).query<unknown>("SELECT agent_id,card_id,revision,issuance_id,event_type,payload_json,created_at FROM feed_owner_events WHERE event_id=?", [response.responseId])).rows;
  const row = rows[0];
  if (rows.length !== 1 || row.length !== 7 || row[0] !== binding.source.sourceId || row[1] !== binding.identity.cardId || row[2] !== binding.identity.revision || row[3] !== binding.identity.issuanceId || row[4] !== "state" || typeof row[5] !== "string") return false;
  try {
    const parsed = validateState(JSON.parse(row[5]));
    if (!parsed.ok || parsed.value.kind !== state.kind || parsed.value.id !== state.id || parsed.value.updatedAt !== state.updatedAt || row[6] !== parsed.value.updatedAt) return false;
    return state.kind === "task" ? state.doneAt !== undefined && parsed.value.doneAt === state.doneAt
      : state.kind === "hold" && state.lift !== undefined && isDeepStrictEqual(parsed.value.lift, state.lift);
  } catch { return false; }
}
async function decision(ctx: HomeMirrorContext, binding: HomeMirrorBinding, record: BoardRecord): Promise<{ selected: Decision | null; sequence: number }> {
  const responses = privateDatabase(ctx.sql.db(binding.source.responses.database), ctx);
  const headers: FeedResponse[] = [];
  let sequence = 0;
  for (;;) {
    const page = take(await listFeedResponses(responses, { afterSequence: sequence, limit: 1000, signal: ctx.signal }));
    headers.push(...page.filter((header) => sameIdentity(header, binding.identity)));
    if (page.length) sequence = page[page.length - 1].sequence;
    if (page.length < 1000) break;
  }
  const owner = emptySitrepOwnerData(), byKey = new Map<string, FeedResponse>();
  const answerResponses = new Map<object, FeedResponse>();
  let completion: { response: FeedResponse; at: string; patch: Patch } | undefined;
  for (const response of headers) {
    const isDecision = response.kind !== "message" && ((record.kind === "ask" || record.kind === "approval") ? response.payloadType === "sitrep.answer" : record.kind === "claim" && response.payloadType === "sitrep.claim");
    const isCompletion = response.kind === "message" && (record.kind === "task" || record.kind === "hold") && response.payloadType === "sitrep.state";
    if (!isDecision && !isCompletion) continue;
    const payload = take(await readFeedResponsePayload(responses, response));
    if (!payload || payload.version !== 1) continue;
    const sourceKey = `response/${binding.source.sourceId}/${response.responseId}`;
    if (isDecision) {
      try {
        if (payload.type === "sitrep.answer" && (record.kind === "ask" || record.kind === "approval")) {
          const parsed = validateAnswer(payload.data);
          if (!parsed.ok) continue;
          const action = validateSitrepAction(record, payload.type, payload.data, parsed.value.at);
          if (action.type !== "sitrep.answer") continue;
          owner.answers.push({ sourceKey, card: { kind: record.kind, id: record.id }, value: action.value });
          answerResponses.set(action.value, response);
        } else if (payload.type === "sitrep.claim" && record.kind === "claim") {
          const parsed = validateClaimDecision(payload.data);
          if (!parsed.ok) continue;
          const action = validateSitrepAction(record, payload.type, payload.data, parsed.value.at);
          if (action.type !== "sitrep.claim") continue;
          owner.claimDecisions.push({ sourceKey, card: { kind: "claim", id: record.id }, value: action.value }); byKey.set(sourceKey, response);
        }
      } catch { /* Invalid typed content is not closing evidence. SQL failures occur outside this block. */ }
      continue;
    }
    let state: SamState;
    try {
      if (!object(payload.data)) continue;
      const allowed = record.kind === "task" ? ["kind", "id", "steps", "updatedAt", "doneAt"] : ["kind", "id", "steps", "updatedAt", "lift"];
      if (Object.keys(payload.data).some((key) => !allowed.includes(key))) continue;
      const parsed = validateState(payload.data);
      if (!parsed.ok || Object.keys(parsed.value.steps).length) continue;
      const action = validateSitrepAction(record, payload.type, payload.data, parsed.value.updatedAt);
      if (action.type !== "sitrep.state") continue;
      state = action.value;
    } catch { continue; }
    if (!await matchingCompletion(ctx, binding, response, state)) continue;
    const at = record.kind === "task" ? state.doneAt : state.lift?.at;
    if (!at) continue;
    const patch = record.kind === "hold" ? holdLiftPatch("Lift requested in Home", "sam") : closePatch("task", undefined);
    if ("ok" in patch && !patch.ok) continue;
    const value = "ok" in patch ? patch.patch : patch;
    if (!completion || Date.parse(at) > Date.parse(completion.at)) completion = { response, at, patch: value };
  }
  let selected: Decision | null = null;
  const lookup = ownerAnswerLookup(owner);
  if (record.kind === "ask" || record.kind === "approval") {
    const answer = record.kind === "ask" ? currentAnswer(record, lookup("ask", record.id))
      : openApprovals([record], [], Date.parse(ctx.now()), lookup).find((entry) => entry.approval.id === record.id)?.answer;
    const response = answer && answerResponses.get(answer);
    if (answer && response) {
      const patch = closePatch(record.kind, record.kind === "ask" && answer.action === "drop" ? "dropped" : undefined);
      if (patch.ok) selected = { response, patch: patch.patch };
    }
  } else if (record.kind === "claim") {
    const latest = claimDecisionHistory(owner, record.id).at(-1), response = latest && byKey.get(latest.sourceKey);
    const patch = closePatch("claim", undefined);
    if (response && patch.ok) selected = { response, patch: patch.patch };
  } else if (completion) selected = { response: completion.response, patch: completion.patch };
  return { selected, sequence };
}

export async function closeHomeMirror(ctx: HomeMirrorContext, identity: HomeMirrorIdentity): Promise<HomeMirrorCloseReceipt | null> {
  try {
    active(ctx);
    const row = await load(ctx, identity);
    if (!row) return null;
    const { binding } = row;
    if (!isDeepStrictEqual(await registered(ctx, binding.source.sourceId), binding.source)) throw failure();
    const card = await currentCard(ctx, binding.source, binding.identity);
    const typed = card && parseSitrepCardPayload(card.payload?.sitrep);
    if (!card || !typed || typed.record.kind !== binding.legacy.kind || typed.record.id !== binding.legacy.id || hash(publication(typed.record, binding.cardUuid)) !== binding.legacy.publicationSha256) return null;
    const { selected, sequence } = await decision(ctx, binding, typed.record);
    if (!selected) return null;
    let head = await readLegacy(ctx, binding.legacy.kind, binding.legacy.fullKey);
    if (!head || head.raw.cardUuid !== binding.cardUuid || head.record.id !== binding.legacy.id) return null;
    if (row.receipt && head.etag === row.receipt.closedETag && row.receipt.responseId === selected.response.responseId) return row.receipt;
    const expected = applyUpsert(typed.record.kind, typed.record.id, typed.record, selected.patch, { now: head.record.updatedAt, from: typed.record.from });
    const matchingClosed = expected.ok && hash(publication(expected.record, binding.cardUuid)) === head.sha256;
    const ownPreviousClose = row.receipt !== null && row.receipt.closedETag === head.etag && row.receipt.status === head.record.status;
    if (head.sha256 !== binding.legacy.publicationSha256 && !matchingClosed && !ownPreviousClose) return null;
    if (head.sha256 === binding.legacy.publicationSha256 && head.etag !== binding.legacy.publishedETag) return null;
    const expectedETag = matchingClosed && row.receipt === null ? binding.legacy.publishedETag : head.etag;
    const planned = applyUpsert(typed.record.kind, typed.record.id, head.record, selected.patch, { now: ctx.now(), from: typed.record.from });
    if (!planned.ok) throw failure();
    if (!await currentCard(ctx, binding.source, binding.identity)) return null;
    // A newly saved response gets a new drain; never close from a superseded selection.
    if (take(await listFeedResponses(privateDatabase(ctx.sql.db(binding.source.responses.database), ctx), { afterSequence: sequence, limit: 1, signal: ctx.signal })).length) return null;
    active(ctx);
    if (!matchingClosed && planned.changed) {
      take(await ctx.legacy.put(binding.legacy.fullKey, publication(planned.record, binding.cardUuid), { ifMatch: expectedETag, prefix: "", contentType: "application/json", signal: ctx.signal }));
      head = await readLegacy(ctx, binding.legacy.kind, binding.legacy.fullKey);
      if (!head || head.raw.cardUuid !== binding.cardUuid || head.sha256 !== hash(publication(planned.record, binding.cardUuid))) throw failure();
    }
    const receipt = receiptSchema.parse({ version: 1, sourceId: binding.source.sourceId, identity: binding.identity, responseId: selected.response.responseId, legacyKey: binding.legacy.fullKey, publicationSha256: binding.legacy.publicationSha256, expectedETag, closedETag: head.etag, status: planned.record.status, observedAt: ctx.now() });
    const json = JSON.stringify(receipt);
    // sqlparser on the node accepts IS NULL, but not SQLite's IS ? extension.
    const params: SqlValue[] = [json, identity.sourceId, identity.cardId, identity.revision, identity.issuanceId];
    const condition = row.receiptJSON === null ? "close_receipt_json IS NULL" : "close_receipt_json = ?";
    if (row.receiptJSON !== null) params.push(row.receiptJSON);
    take(await privateDatabase(ctx.sql.db(OWNER), ctx).execute(`UPDATE feed_sitrep_mirrors SET close_receipt_json=? WHERE source_id=? AND card_id=? AND revision=? AND issuance_id=? AND ${condition}`, params), "close.receipt-update");
    const recorded = await load(ctx, identity);
    if (!recorded?.receipt || !isDeepStrictEqual(recorded.receipt, receipt)) throw failure();
    return recorded.receipt;
  } catch (error) { throw safeFailure(error, "close"); }
}

export interface HomeMirrorForwardOptions {
  identity: HomeMirrorIdentity;
  responseId: string;
  handoff: FeedDatabase;
  recipient: string;
  deliver: FeedDeliveryOptions["deliver"];
  /** Where the drain saw this response; read first, so one row is read instead of every page. */
  sequence?: number;
}

async function savedResponse(ctx: HomeMirrorContext, binding: HomeMirrorBinding, responseId: string, sequence?: number): Promise<FeedResponse | null> {
  const responses = privateDatabase(ctx.sql.db(binding.source.responses.database), ctx);
  if (sequence !== undefined && Number.isSafeInteger(sequence) && sequence > 0) {
    const [hinted] = take(await listFeedResponses(responses, { afterSequence: sequence - 1, limit: 1, signal: ctx.signal }));
    active(ctx);
    if (hinted?.responseId === responseId) return sameIdentity(hinted, binding.identity) ? hinted : null;
  }
  let afterSequence = 0;
  for (;;) {
    const page = take(await listFeedResponses(responses, { afterSequence, limit: 1000, signal: ctx.signal }));
    active(ctx);
    const response = page.find((header) => header.responseId === responseId);
    if (response) return sameIdentity(response, binding.identity) ? response : null;
    if (page.length < 1000) return null;
    const next = page[page.length - 1].sequence;
    if (next <= afterSequence) throw failure();
    afterSequence = next;
  }
}

/**
 * A response as the owner's responses database holds it, with its private payload, for a bound card issuance.
 * `sequence` is where it was seen; the stored row decides, so a caller's copy of the header grants nothing.
 */
export async function readHomeMirrorResponse(ctx: HomeMirrorContext, binding: HomeMirrorBinding, responseId: string, sequence?: number): Promise<{ response: FeedResponse; payload: FeedResponsePayload | null } | null> {
  try {
    const response = await savedResponse(ctx, binding, responseId, sequence);
    if (!response) return null;
    const payload = take(await readFeedResponsePayload(privateDatabase(ctx.sql.db(binding.source.responses.database), ctx), response));
    return { response, payload: payload ?? null };
  } catch (error) { throw safeFailure(error, "response"); }
}

/** Records the agent's "received" for a response once; a second call returns the first record. */
export async function acknowledgeHomeMirrorResponse(ctx: HomeMirrorContext, binding: HomeMirrorBinding, response: FeedResponse): Promise<{ handling: FeedHandling; recorded: boolean }> {
  try {
    const output = privateDatabase(ctx.sql.db(binding.source.output.database), ctx);
    const identity = { ...tuple(response), responseId: response.responseId };
    const existing = await readFeedResponseHandling(output, identity);
    if (!existing.ok && existing.error.code !== ErrorCodes.NOT_FOUND) throw safeFailure(existing.error);
    if (existing.ok && existing.data.acknowledgement) return { handling: existing.data.acknowledgement, recorded: false };
    const handling = take(await recordFeedHandling(output, { ...identity, handlingId: `${response.responseId}:acknowledged`, phase: "acknowledged", createdAt: ctx.now() }));
    return { handling, recorded: true };
  } catch (error) { throw safeFailure(error, "handling"); }
}

async function deliverable(ctx: HomeMirrorContext, binding: HomeMirrorBinding, response: FeedResponse, recipient: string): Promise<FeedResponse | null> {
  if (!recipient || recipient === "*") throw failure();
  const responses = privateDatabase(ctx.sql.db(binding.source.responses.database), ctx);
  const page = take(await listFeedResponseDeliveries(responses, { recipient, afterSequence: response.sequence - 1, limit: 1, signal: ctx.signal }));
  active(ctx);
  return page.responses.find((header) => header.responseId === response.responseId && sameIdentity(header, binding.identity)) ?? null;
}

/**
 * The stored response as the owner's delivery policy releases it to `recipient` now (restored rows carry their
 * `dispatchBefore`), or null when the policy withholds it: never dispatched, another recipient's, or past its cutoff.
 * The recipient must come from the caller's own configuration, never from a handed-off header.
 */
export async function readHomeMirrorDelivery(ctx: HomeMirrorContext, binding: HomeMirrorBinding, response: FeedResponse, recipient: string): Promise<FeedResponse | null> {
  try {
    const allowed = await deliverable(ctx, binding, response, recipient);
    const cutoff = allowed?.dispatchBefore;
    if (!allowed || (typeof cutoff === "string" && !(Date.now() < Date.parse(cutoff)))) return null;
    return allowed;
  } catch (error) { throw safeFailure(error, "delivery"); }
}

/** Close is projection evidence; only the existing durable handoff records delivery. */
export async function forwardHomeMirrorResponse(ctx: HomeMirrorContext, options: HomeMirrorForwardOptions): Promise<FeedHandoff | null> {
  try {
    active(ctx);
    if (!options.responseId || !options.recipient || options.recipient === "*") throw failure();
    const storedBinding = await load(ctx, options.identity);
    if (!storedBinding) return null;
    const { binding } = storedBinding;
    if (!isDeepStrictEqual(await registered(ctx, binding.source.sourceId), binding.source)) throw failure();
    const card = await currentCard(ctx, binding.source, binding.identity);
    const typed = card && parseSitrepCardPayload(card.payload?.sitrep);
    if (!typed || typed.record.kind !== binding.legacy.kind || typed.record.id !== binding.legacy.id ||
      hash(publication(typed.record, binding.cardUuid)) !== binding.legacy.publicationSha256) return null;
    const response = await savedResponse(ctx, binding, options.responseId, options.sequence);
    if (!response) return null;
    // A targeted verified policy page also protects restored rows on a fresh local ledger.
    const allowed = await deliverable(ctx, binding, response, options.recipient);
    if (!allowed) return null;
    const responses = privateDatabase(ctx.sql.db(binding.source.responses.database), ctx);
    const payload = take(await readFeedResponsePayload(responses, response));
    active(ctx);
    if (!payload || payload.version !== 1) return null;

    let nonclosing = false;
    if (response.kind === "message" && payload.type === "sitrep.thread") {
      try { decodeOwnerThreadMessage(typed.record, payload.data); nonclosing = true; } catch { return null; }
    } else if (response.kind === "message" && payload.type === "sitrep.note") {
      try { decodeLegacySendNote(typed.record, payload.data); nonclosing = true; } catch { return null; }
    } else if (response.kind === "message" && payload.type.startsWith("feed.")) {
      // Unknown or malformed owner actions are refused, never treated as decisions.
      if (!ownerActionSchema.safeParse(payload).success) return null;
      nonclosing = true;
    } else {
      // Reuse the same original-time answer and exact owner-event completion semantics.
      // Unsupported or malformed claimed decisions never fall through as ordinary notes.
      const { selected } = await decision(ctx, binding, typed.record);
      if (selected?.response.responseId !== response.responseId) return null;
    }
    const handoff = privateDatabase(options.handoff, ctx);
    const existing = take(await getFeedHandoff(handoff, response.responseId, options.recipient));
    active(ctx);
    if (existing && !isDeepStrictEqual(existing.response, projectFeedResponseNotification(allowed))) throw failure();
    if (existing && existing.state !== "prepared") return existing;
    if (!nonclosing) {
      const receipt = await closeHomeMirror(ctx, options.identity);
      if (!receipt || receipt.responseId !== response.responseId || receipt.sourceId !== binding.source.sourceId ||
        !sameIdentity(receipt.identity, binding.identity) || receipt.publicationSha256 !== binding.legacy.publicationSha256) return null;
      const head = await readLegacy(ctx, binding.legacy.kind, binding.legacy.fullKey);
      if (!head || head.etag !== receipt.closedETag || head.raw.cardUuid !== binding.cardUuid || head.record.status !== receipt.status) return null;
    }
    if (!await currentCard(ctx, binding.source, binding.identity)) return null;
    active(ctx);
    // This is the first operation allowed to prepare/claim a handoff or start a child.
    const delivered = await deliverFeedResponse({ handoff, recipient: options.recipient, response: allowed, deliver: options.deliver });
    if (!delivered.ok && delivered.error.service === "feed" && delivered.error.code === ErrorCodes.PERMISSION_DENIED && delivered.error.meta?.reason === "dispatch_deadline") return null;
    return take(delivered);
  } catch (error) { throw safeFailure(error, "forward"); }
}

export interface HomeMirrorWatchOptions {
  sourceId: string;
  recipient: string;
  hooks: FeedHooks;
  handoff: FeedDatabase;
  deliver: FeedDeliveryOptions["deliver"];
  signal: AbortSignal;
  renewalSeconds?: number;
}

/**
 * A handoff ledger serves one owner's source: its first drain records the owner space, the source and its responses
 * database, and a drain for anything else is refused. Sequences are per responses database, so a mark taken from
 * another source's handoffs would pass over this one's pending responses. A ledger that already holds handoffs but
 * names no source is refused too, since its marks cannot be attributed.
 */
async function bindLedger(ctx: HomeMirrorContext, ledger: FeedDatabase, source: HomeMirrorBinding["source"]): Promise<void> {
  const scope = JSON.stringify({ ownerSpaceId: ctx.ownerSpaceId, sourceId: source.sourceId, responses: { spaceId: source.responses.spaceId, database: source.responses.database } });
  const refused = () => homeMirrorRefusal("This handoff ledger belongs to another Home feed source");
  take(await ledger.execute("CREATE TABLE IF NOT EXISTS home_mirror_ledger (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), scope_json TEXT NOT NULL)"));
  let [row] = take(await ledger.query<unknown>("SELECT scope_json FROM home_mirror_ledger WHERE singleton=1")).rows;
  if (!row) {
    if (take(await ledger.query<unknown>("SELECT 1 FROM feed_handoffs LIMIT 1")).rows.length) throw refused();
    take(await ledger.execute("INSERT OR IGNORE INTO home_mirror_ledger (singleton,scope_json) VALUES (1,?)", [scope]));
    [row] = take(await ledger.query<unknown>("SELECT scope_json FROM home_mirror_ledger WHERE singleton=1")).rows;
  }
  if (row?.[0] !== scope) throw refused();
}

/**
 * Where a drain for this recipient starts, from its local handoff ledger alone (no node read): after the highest
 * sequence it already handed off, or just before the earliest one still prepared, which is handed off again.
 */
export async function homeMirrorDrainStart(ctx: HomeMirrorContext, options: Pick<HomeMirrorDrainOptions, "source" | "recipient" | "handoff">): Promise<number> {
  const handoff = privateDatabase(options.handoff, ctx);
  await bindLedger(ctx, handoff, options.source);
  const rows = take(await handoff.query<unknown>("SELECT response_json,state FROM feed_handoffs WHERE recipient=?", [options.recipient])).rows;
  let highest = 0, prepared = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string") throw failure();
    const value: unknown = JSON.parse(row[0]);
    const sequence = object(value) ? value.sequence : undefined;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) throw failure();
    if (row[1] === "prepared") prepared = Math.min(prepared, sequence);
    else highest = Math.max(highest, sequence);
  }
  return Number.isFinite(prepared) ? Math.min(highest, prepared - 1) : highest;
}

export interface HomeMirrorDrainOptions {
  source: HomeMirrorBinding["source"];
  recipient: string;
  handoff: FeedDatabase;
  deliver: FeedDeliveryOptions["deliver"];
  /** Exclusive start: responses at or below it were handed off or settled earlier. */
  afterSequence: number;
}

/**
 * Hands off every response after `afterSequence`, in order, and returns the new mark. A response the local ledger
 * already holds as unconfirmed or delivered is passed over before any node read, so a drain with nothing new costs
 * one page read however many responses were handed off before.
 */
export async function drainHomeMirrorResponses(ctx: HomeMirrorContext, options: HomeMirrorDrainOptions): Promise<number> {
  const responses = privateDatabase(ctx.sql.db(options.source.responses.database), ctx);
  const ledger = privateDatabase(options.handoff, ctx);
  await bindLedger(ctx, ledger, options.source);
  let afterSequence = options.afterSequence;
  while (!ctx.signal?.aborted) {
    const page = take(await listFeedResponseDeliveries(responses, { recipient: options.recipient, afterSequence, limit: 100, signal: ctx.signal }));
    if (ctx.signal?.aborted) break;
    for (const response of page.responses) {
      if (ctx.signal?.aborted) return afterSequence;
      const existing = take(await getFeedHandoff(ledger, response.responseId, options.recipient));
      if (existing && existing.state !== "prepared") continue;
      await forwardHomeMirrorResponse(ctx, {
        identity: { sourceId: options.source.sourceId, ...tuple(response) }, responseId: response.responseId, sequence: response.sequence,
        recipient: options.recipient, handoff: options.handoff, deliver: options.deliver,
      });
    }
    if (page.hasMore && page.nextSequence <= afterSequence) throw failure();
    afterSequence = Math.max(afterSequence, page.nextSequence);
    if (!page.hasMore) break;
  }
  return afterSequence;
}

/** One configured source consumer; authorized ready/write notifications only, not DB polling. */
export async function watchHomeMirrors(context: HomeMirrorContext, options: HomeMirrorWatchOptions): Promise<void> {
  const { signal } = options;
  const ctx = { ...context, signal };
  const renewalSeconds = options.renewalSeconds ?? 300;
  if (!Number.isInteger(renewalSeconds) || renewalSeconds < 60 || renewalSeconds > 300 || !options.recipient || options.recipient === "*") throw failure();
  if (signal.aborted) return;
  const source = await registered(ctx, options.sourceId);
  let mark = await homeMirrorDrainStart(ctx, { source, recipient: options.recipient, handoff: options.handoff });
  let ready = false, dirty = false, failed = false;
  let draining: Promise<void> | undefined, failureValue: unknown;
  let current: AbortController | undefined;
  const drain = async (): Promise<void> => {
    do {
      dirty = false;
      mark = await drainHomeMirrorResponses(ctx, { source, recipient: options.recipient, handoff: options.handoff, deliver: options.deliver, afterSequence: mark });
    } while (dirty && !signal.aborted);
  };
  const schedule = (): void => {
    if (!ready || signal.aborted || failed) return;
    dirty = true;
    if (draining) return;
    draining = drain().catch((error: unknown) => {
      if (signal.aborted && object(error) && error.code === ErrorCodes.ABORTED) return;
      failed = true; failureValue = error; current?.abort();
    }).finally(() => { draining = undefined; if (dirty && !failed) schedule(); });
  };
  while (!signal.aborted && !failed) {
    const connection = new AbortController(); current = connection;
    const stop = () => connection.abort();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    // Renew the hook ticket, not a SQL heartbeat. Every authorized ready reconciles from the drain's mark.
    const renewal = setTimeout(stop, renewalSeconds * 1000); renewal.unref?.();
    try {
      for await (const _event of options.hooks.subscribe([{ space: source.responses.spaceId, service: "sql", pathPrefix: source.responses.database }], {
        signal: connection.signal, ttlSeconds: renewalSeconds,
        onReady: () => {
          if (current !== connection || connection.signal.aborted || signal.aborted) return;
          ready = true; schedule();
        },
      })) schedule();
    } catch (error) {
      if (!failed && !(connection.signal.aborted && (object(error) && error.code === ErrorCodes.ABORTED || error instanceof Error && error.name === "AbortError"))) throw safeFailure(error);
    } finally {
      ready = false; current = undefined; clearTimeout(renewal); signal.removeEventListener("abort", stop);
      await draining;
    }
    if (failed) throw safeFailure(failureValue);
    if (!connection.signal.aborted) return;
  }
  if (failed) throw safeFailure(failureValue);
}
