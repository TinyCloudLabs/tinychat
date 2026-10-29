import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { KVService, SQLService, ServiceContext } from "@tinycloud/sdk-services";
import type { Result } from "@tinycloud/sdk-services";
import {
  appendFeedMessage, appendFeedResponse, feedResourceNames, initializeFeedDatabases,
  listFeedCardHistory, listFeedResponses, publishFeedCard, readFeedResponsePayload, recordFeedHandling,
} from "@tinycloud/sdk-services/feed";
import type { FeedCardIdentity, FeedResponsePayload, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";
import { closeHomeMirror, publishHomeMirror } from "./bridge";
import type { HomeMirrorContext, HomeMirrorIdentity, HomeMirrorPublishInput } from "./bridge-types";

const SPACE = "tinycloud:pkh:eip155:1:0x2222222222222222222222222222222222222222:applications";
const OWNER = "xyz.tinycloud.tinychat/home_feed";
const T0 = "2026-10-28T12:00:00.000Z", T1 = "2026-10-29T10:00:00.000Z";
const T2 = "2026-10-29T11:00:00.000Z", NOW = "2026-10-29T12:00:00.000Z", EXPIRES = "2026-10-29T13:00:00.000Z";
const PRIVATE = "SYNTHETIC224PRIVATECODE", NOTE = "SYNTHETIC224OWNERNOTE";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function take<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parse(value: string): unknown { return JSON.parse(value); }
function field(value: unknown, key: string): unknown { if (!object(value)) throw new Error("Missing object"); return value[key]; }
function tuple(value: FeedCardIdentity): FeedCardIdentity { return { cardId: value.cardId, revision: value.revision, issuanceId: value.issuanceId }; }
async function refused(promise: Promise<unknown>): Promise<Error> {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error instanceof Error).toBe(true);
  if (!(error instanceof Error)) throw new Error("Expected refusal");
  expect(inspect(error, { depth: 20 })).not.toContain(PRIVATE);
  expect(error.cause).toBeUndefined();
  return error;
}
const context = {
  background: "This synthetic record exercises only a local disposable Home and legacy mirror fixture without accessing any live board.",
  whyNow: "The isolated owner must select a reversible synthetic action.",
  ifNoAnswer: "No external action is authorized by leaving this synthetic question unanswered.", known: [], related: [],
};
function business(kind: Kind, id: string): BoardRecord {
  const common = { kind, id, from: "SyntheticOfficer", owner: "SyntheticOwner", title: `Synthetic ${kind}`, body: "Synthetic public card body.", createdAt: T0, updatedAt: T0, links: [], urgency: 2, importance: 2 };
  const patches: Record<Kind, Record<string, unknown>> = {
    ask: { status: "open", askedAt: T0, context, options: [{ id: "yes", label: "Proceed" }, { id: "no", label: "Do not proceed" }] },
    task: { status: "todo", context, steps: [{ id: "one", text: "First check" }, { id: "two", text: "Second check" }] },
    approval: { status: "open", approvalType: "go", approvalKind: "deploy", issuedAt: T1, expiresAt: EXPIRES, codeExpected: false, context },
    claim: { status: "open", site: "Synthetic site", url: "https://example.test/claim", quote: "A synthetic claim.", location: "Synthetic paragraph", trueToday: "The fixture has no production evidence.", evidence: [{ label: "Fixture", ref: "https://example.test/evidence" }], makeTrue: { effort: "Verify the fixture" }, severity: "med" },
    hold: { status: "active", what: "Hold the synthetic operation", cause: "An isolated check is incomplete.", exit: "The owner explicitly lifts this hold.", releasedBy: "sam", unblockedBy: ["task:unrelated-task"] },
    incident: { status: "degraded", severity: "sev2", impact: "Only the synthetic fixture is affected.", startedAt: T0 },
    work: { status: "waiting-sam", waitsOn: "A separate question", next: "Wait for the separate decision", askIds: ["unrelated-ask"], standing: false },
    ship: { status: "live", component: "Synthetic component", version: "0.0.1-fixture", at: T0 },
    order: { status: "active", at: T0, source: "chat", verbatim: "Keep the fixture isolated.", appliesTo: "Synthetic fixture" },
    progress: { status: "open", ticket: "TC-1", steps: [{ name: "Build", state: "in-progress" }], currentStep: 0, important: false },
  };
  const checked = validateRecord(kind, { ...common, ...patches[kind] });
  if (!checked.ok) throw new Error(`Invalid synthetic ${kind}: ${checked.errors.join("; ")}`);
  return checked.value;
}
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const statement = z.object({ sql: z.string(), params: z.array(scalar).optional() });
const sqlRequest = z.discriminatedUnion("action", [
  statement.extend({ action: z.literal("query") }), statement.extend({ action: z.literal("execute") }),
  z.object({ action: z.literal("batch"), statements: z.array(statement) }),
]);
type LegacyValue = { text: string; etag: string };
const etag = (text: string) => `"fixture-${createHash("sha256").update(text).digest("hex")}"`;

async function fixture(kind: Kind = "ask") {
  const directory = await mkdtemp(join(tmpdir(), "home-mirror-"));
  const resources = take(feedResourceNames("xyz.tinycloud.tinychat/feed", "mirror_fixture"));
  const files = new Map([OWNER, resources.outputResource, resources.responseResource].map((resource, index) => [resource, new Database(join(directory, `${index}.sqlite`))]));
  cleanup.push(async () => { for (const file of files.values()) file.close(); await rm(directory, { recursive: true, force: true }); });
  const values = new Map<string, LegacyValue>();
  const writes: Array<{ key: string; value: unknown; ifMatch: string | null }> = [];
  let beforePut: (() => Promise<void> | void) | undefined;
  let failPut = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const service = request.headers.get("X-Fixture-Service"), path = request.headers.get("X-Fixture-Path") ?? "";
    try {
      if (service === "sql") {
        const file = files.get(path); if (!file) return Response.json({ error: "Unknown fixture SQL resource" }, { status: 403 });
        const body = sqlRequest.parse(await request.json());
        const execute = (entry: z.infer<typeof statement>) => {
          const result = file.query(entry.sql).run(...(entry.params ?? []));
          return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
        };
        if (body.action === "query") {
          const query = file.query(body.sql), rows = query.values(...(body.params ?? []));
          return Response.json({ columns: query.columnNames, rows, rowCount: rows.length });
        }
        if (body.action === "execute") return Response.json(execute(body));
        file.exec("BEGIN");
        try { const results = body.statements.map(execute); file.exec("COMMIT"); return Response.json({ results }); }
        catch (error) { file.exec("ROLLBACK"); throw error; }
      }
      if (service !== "kv") return new Response(null, { status: 400 });
      const action = request.headers.get("X-Fixture-Action")?.split("/").at(-1);
      if (action === "get") {
        const current = values.get(path);
        return current ? new Response(current.text, { headers: { etag: current.etag, "content-type": "application/json" } })
          : Response.json({ error: "Fixture key is absent" }, { status: 404 });
      }
      if (action !== "put") return new Response(null, { status: 405 });
      const hook = beforePut; beforePut = undefined; await hook?.();
      if (failPut) { failPut = false; return Response.json({ error: PRIVATE, cause: { secret: PRIVATE } }, { status: 500 }); }
      const current = values.get(path), match = request.headers.get("if-match");
      if ((match !== null && match !== current?.etag) || (request.headers.get("if-none-match") === "*" && current)) return new Response(null, { status: 412 });
      const text = await request.text();
      values.set(path, { text, etag: etag(text) }); writes.push({ key: path, value: parse(text), ifMatch: match });
      return new Response(null, { headers: { etag: etag(text) } });
    } catch { return Response.json({ error: PRIVATE, cause: { secret: PRIVATE } }, { status: 400 }); }
  } });
  cleanup.push(() => server.stop(true));
  const serviceContext = new ServiceContext({
    hosts: [server.url.href], retryPolicy: { maxAttempts: 1 },
    invoke: (_session, service, path, action) => ({ Authorization: "synthetic-fixture", "X-Fixture-Service": service, "X-Fixture-Path": path, "X-Fixture-Action": action ?? "" }),
    session: { delegationHeader: { Authorization: "synthetic-fixture" }, delegationCid: "synthetic-cid", spaceId: SPACE, verificationMethod: "did:key:synthetic-owner", jwk: {} },
  });
  const sql = new SQLService(); sql.initialize(serviceContext);
  const legacy = new KVService(); legacy.initialize(serviceContext);
  const owner = sql.db(OWNER), output = sql.db(resources.outputResource), responses = sql.db(resources.responseResource);
  take(await owner.execute("CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY,agent_did TEXT NOT NULL,label TEXT NOT NULL,output_resource TEXT NOT NULL UNIQUE,response_resource TEXT NOT NULL UNIQUE,authorization_json TEXT NOT NULL)"));
  take(await owner.execute("INSERT INTO feed_agents VALUES (?,?,?,?,?,?)", ["mirror_fixture", "did:key:synthetic-publisher", "Synthetic label", resources.outputResource, resources.responseResource, "{}"]));
  // Test-local provisioning only. Production provisioning belongs to HomeDeployGo.
  take(await owner.execute("CREATE TABLE feed_sitrep_mirrors (source_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,binding_json TEXT NOT NULL,close_receipt_json TEXT,PRIMARY KEY(source_id,card_id,revision,issuance_id))"));
  take(await owner.execute("CREATE TABLE feed_owner_events (event_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)"));
  take(await initializeFeedDatabases({ output, responses }));
  const uuid = randomUUID(), record = business(kind, kind === "claim" ? "L-042" : uuid);
  const key = `xyz.tinycloud.rocinante/board/${kind}/${record.id}.json`;
  const input: HomeMirrorPublishInput = {
    source: { sourceId: "mirror_fixture", agentDid: "did:key:synthetic-publisher", label: "Synthetic label", output: { spaceId: SPACE, database: resources.outputResource }, responses: { spaceId: SPACE, database: resources.responseResource } },
    card: { cardId: uuid, revision: 1, issuanceId: randomUUID(), kind, title: record.title, body: record.body ?? "", urgency: 2, createdAt: T0, needsResponse: ["ask", "approval", "claim"].includes(kind), payload: { sitrep: { version: 1, record }, source: { label: "Synthetic legacy", ref: key } } },
    legacy: { spaceId: SPACE, fullKey: key, record },
  };
  const ctx: HomeMirrorContext = { ownerSpaceId: SPACE, sql, legacySpaceId: SPACE, legacy, now: () => NOW };
  const identity: HomeMirrorIdentity = { sourceId: input.source.sourceId, cardId: uuid, revision: 1, issuanceId: input.card.issuanceId };
  const legacyRecord = () => { const current = values.get(key); if (!current) throw new Error("Missing mirror"); return parse(current.text); };
  async function answer(data: FeedResponsePayload["data"], options: { type?: string; kind?: "answer" | "followup"; createdAt?: string; supersedes?: string; responseId?: string } = {}) {
    const header: NewFeedResponse = { ...tuple(input.card), responseId: options.responseId ?? randomUUID(), kind: options.kind ?? "answer", text: "Safe Home decision summary", createdAt: options.createdAt ?? T2, ...(options.supersedes ? { supersedesResponseId: options.supersedes } : {}) };
    return take(await appendFeedResponse(output, responses, header, { type: options.type ?? "sitrep.answer", version: 1, data }));
  }
  async function command(data: FeedResponsePayload["data"], intent?: { eventId?: string; sourceId?: string; revision?: number; issuanceId?: string; eventType?: string; data?: unknown }) {
    const responseId = randomUUID();
    if (intent) take(await owner.execute("INSERT INTO feed_owner_events VALUES (?,?,?,?,?,?,?,?)", [intent.eventId ?? responseId, intent.sourceId ?? identity.sourceId, identity.cardId, intent.revision ?? identity.revision, intent.issuanceId ?? identity.issuanceId, intent.eventType ?? "state", JSON.stringify(intent.data ?? data), T2]));
    const saved = take(await appendFeedMessage(output, responses, { ...tuple(identity), responseId, kind: "message", text: "Safe Home completion request", createdAt: T2 }, { type: "sitrep.state", version: 1, data }));
    return saved;
  }
  return { ctx, input, identity, owner, output, responses, legacy, values, writes, key, legacyRecord, answer, command,
    interceptPut: (hook: () => Promise<void> | void) => { beforePut = hook; }, failPut: () => { failPut = true; } };
}

test("dual-post retries keep the same UUID, full Home issuance and legacy business references", async () => {
  for (const kind of ["ask", "claim"] as const) {
    const f = await fixture(kind), original = structuredClone(f.input);
    const first = await publishHomeMirror(f.ctx, f.input), second = await publishHomeMirror(f.ctx, f.input);
    expect(first).toEqual(second); expect(first.cardUuid).toBe(original.card.cardId);
    expect(first.legacy.id).toBe(original.legacy.record.id);
    expect(field(f.legacyRecord(), "cardUuid")).toBe(original.card.cardId);
    expect(field(f.legacyRecord(), "id")).toBe(original.legacy.record.id);
    const raw = f.legacyRecord(); if (!object(raw)) throw new Error("Invalid mirror value");
    const { cardUuid, ...businessValue } = raw;
    expect(cardUuid).toBe(original.card.cardId);
    const validated = validateRecord(kind, businessValue);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.value).toEqual(original.legacy.record);
    expect(take(await listFeedCardHistory(f.output)).cards).toEqual([original.card]);
    expect(f.input).toEqual(original);
    const rows = take(await f.owner.query<string>("SELECT binding_json FROM feed_sitrep_mirrors")).rows;
    expect(rows.map((row) => parse(row[0]))).toEqual([first]);
    expect(rows[0][0]).not.toContain(original.card.body);
    expect(field(field(original.card.payload, "sitrep"), "record")).not.toHaveProperty("cardUuid");
  }
});

test("a changed binding or spoofed publisher refuses without replacing the durable publication", async () => {
  const f = await fixture(); await publishHomeMirror(f.ctx, f.input);
  const before = f.values.get(f.key), saved = take(await f.owner.query("SELECT * FROM feed_sitrep_mirrors")).rows;
  const changed = structuredClone(f.input); changed.card.body = "Conflicting publication body";
  await refused(publishHomeMirror(f.ctx, changed));
  const spoofed = structuredClone(f.input); spoofed.source.agentDid = "did:key:another-publisher"; spoofed.source.label = PRIVATE;
  await refused(publishHomeMirror(f.ctx, spoofed));
  expect(f.values.get(f.key)).toEqual(before);
  expect(take(await f.owner.query("SELECT * FROM feed_sitrep_mirrors")).rows).toEqual(saved);
});

test("a durable typed question answer closes only its mirror without acknowledgement or outcome", async () => {
  const f = await fixture(); const binding = await publishHomeMirror(f.ctx, f.input);
  const other = "xyz.tinycloud.rocinante/board/ask/unrelated.json";
  take(await f.legacy.put(other, { untouched: true })); const unrelated = f.values.get(other);
  const response = await f.answer({ askId: f.input.legacy.record.id, action: "answer", choice: "yes", text: PRIVATE, at: T2 });
  expect(take(await f.output.query("SELECT * FROM feed_handling")).rows).toEqual([]);
  const receipt = await closeHomeMirror(f.ctx, f.identity);
  expect(receipt).toMatchObject({ sourceId: f.identity.sourceId, identity: tuple(f.input.card), responseId: response.responseId, legacyKey: f.key, expectedETag: binding.legacy.publishedETag, status: "answered" });
  expect(field(f.legacyRecord(), "status")).toBe("answered"); expect(field(f.legacyRecord(), "cardUuid")).toBe(f.input.card.cardId);
  expect(f.values.get(other)).toEqual(unrelated);
  expect(f.writes.at(-1)?.ifMatch).toBe(binding.legacy.publishedETag);
  expect(inspect({ receipt, writes: f.writes }, { depth: 20 })).not.toContain(PRIVATE);
  expect(take(await readFeedResponsePayload(f.responses, response))?.data).toEqual({ askId: f.input.legacy.record.id, action: "answer", choice: "yes", text: PRIVATE, at: T2 });
  expect(take(await f.output.query("SELECT * FROM feed_handling")).rows).toEqual([]);
  const after = [...f.writes]; expect(await closeHomeMirror(f.ctx, f.identity)).toEqual(receipt); expect(f.writes).toEqual(after);
});

test("drop preserves dropped status and semantic answer time outranks later transport sequence", async () => {
  const f = await fixture(); await publishHomeMirror(f.ctx, f.input);
  const chosen = await f.answer({ askId: f.input.legacy.record.id, action: "drop", text: "", at: T2 }, { createdAt: T1 });
  await f.answer({ askId: f.input.legacy.record.id, action: "answer", choice: "yes", text: "Earlier semantic answer", at: T1 }, { kind: "followup", supersedes: chosen.responseId, createdAt: NOW });
  expect(await closeHomeMirror(f.ctx, f.identity)).toMatchObject({ responseId: chosen.responseId, status: "dropped" });
  expect(field(f.legacyRecord(), "status")).toBe("dropped");
});

test("generic message, private note, acknowledgement and outcome alone do not close a question", async () => {
  const f = await fixture(); await publishHomeMirror(f.ctx, f.input);
  const message = take(await appendFeedMessage(f.output, f.responses, { ...tuple(f.identity), responseId: randomUUID(), kind: "message", text: "Not an answer", createdAt: T2 }, { type: "sitrep.answer", version: 1, data: { askId: f.input.legacy.record.id, action: "answer", text: "Not a decision", at: T2 } }));
  take(await recordFeedHandling(f.output, { ...tuple(f.identity), handlingId: randomUUID(), responseId: message.responseId, phase: "acknowledged", createdAt: NOW }));
  take(await recordFeedHandling(f.output, { ...tuple(f.identity), handlingId: randomUUID(), responseId: message.responseId, phase: "succeeded", createdAt: NOW }));
  take(await f.owner.execute("INSERT INTO feed_owner_events VALUES (?,?,?,?,?,?,?,?)", [randomUUID(), f.identity.sourceId, f.identity.cardId, 1, f.identity.issuanceId, "state", JSON.stringify({ kind: "ask", id: f.input.legacy.record.id, steps: {}, notes: [{ at: T2, text: NOTE }], updatedAt: T2 }), T2]));
  const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
});

test("missing, unknown and malformed typed payloads never become close evidence", async () => {
  for (const payload of [undefined, { type: "unknown.private", version: 1, data: { code: PRIVATE } }, { type: "sitrep.answer", version: 1, data: { askId: "wrong-business-id", action: "answer", text: PRIVATE, at: T2 } }]) {
    const f = await fixture(); await publishHomeMirror(f.ctx, f.input);
    take(await appendFeedResponse(f.output, f.responses, { ...tuple(f.identity), responseId: randomUUID(), kind: "answer", text: "Safe header", createdAt: T2 }, payload));
    const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
  }
});

test("a reasked question and old full Home issuance cannot close their current successors", async () => {
  const f = await fixture();
  const record = { ...f.input.legacy.record, lastAskedAt: T2 };
  const checked = validateRecord("ask", record); if (!checked.ok) throw new Error("Invalid reask fixture");
  f.input.legacy.record = checked.value; f.input.card.payload = { ...f.input.card.payload, sitrep: { version: 1, record: checked.value } };
  await publishHomeMirror(f.ctx, f.input);
  await f.answer({ askId: checked.value.id, action: "answer", text: "Old answer", at: T1 });
  expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull();
  const successor = { ...f.input.card, revision: 2, issuanceId: randomUUID() };
  take(await publishFeedCard(f.output, successor));
  const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
});

test("a newer legacy publication wins an actual conditional-PUT race", async () => {
  const f = await fixture(); await publishHomeMirror(f.ctx, f.input);
  await f.answer({ askId: f.input.legacy.record.id, action: "answer", choice: "yes", text: "", at: T2 });
  const replacement = { ...f.input.legacy.record, title: "Newer legacy publication", cardUuid: f.input.card.cardId };
  f.interceptPut(async () => { take(await f.legacy.put(f.key, replacement)); });
  const result = await closeHomeMirror(f.ctx, f.identity).then((value) => ({ value }), (error: unknown) => ({ error }));
  expect(f.legacyRecord()).toEqual(replacement);
  expect(take(await f.owner.query("SELECT close_receipt_json FROM feed_sitrep_mirrors")).rows).toEqual([[null]]);
  expect(inspect(result, { depth: 20 })).not.toContain(PRIVATE);
});

test("an approval closes from its original valid issuance-time answer even when relay time is later", async () => {
  const f = await fixture("approval"); await publishHomeMirror(f.ctx, f.input);
  f.ctx.now = () => "2026-10-30T12:00:00.000Z";
  const response = await f.answer({ askId: f.input.legacy.record.id, action: "done", text: "", issuedAt: T1, at: T2 });
  expect(await closeHomeMirror(f.ctx, f.identity)).toMatchObject({ responseId: response.responseId, status: "done" });
  expect(field(f.legacyRecord(), "status")).toBe("done");
});

test("approval exact issuance-string mismatch and go at its cutoff do not close", async () => {
  for (const answer of [{ issuedAt: T1.replace(".000Z", ".000+00:00"), at: T2 }, { issuedAt: T1, at: EXPIRES }]) {
    const f = await fixture("approval"); await publishHomeMirror(f.ctx, f.input);
    await f.answer({ askId: f.input.legacy.record.id, action: "done", text: "", ...answer });
    const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
  }
});

test("a claim decision keeps its business ID and closes only that UUID-bound claim mirror", async () => {
  const f = await fixture("claim"); await publishHomeMirror(f.ctx, f.input);
  const response = await f.answer({ choice: "keep", note: PRIVATE, at: T2 }, { type: "sitrep.claim" });
  expect(await closeHomeMirror(f.ctx, f.identity)).toMatchObject({ responseId: response.responseId, status: "resolved" });
  expect(f.legacyRecord()).toMatchObject({ id: "L-042", cardUuid: f.input.card.cardId, status: "resolved" });
  expect(inspect(f.writes, { depth: 20 })).not.toContain(PRIVATE);
});

test("explicit task completion needs its matching immutable registry event and durable message", async () => {
  const f = await fixture("task"); await publishHomeMirror(f.ctx, f.input);
  const data = { kind: "task", id: f.input.legacy.record.id, steps: {}, updatedAt: T2, doneAt: T2 };
  const response = await f.command(data, { data: { ...data, dismissedAt: T2 } });
  expect(await closeHomeMirror(f.ctx, f.identity)).toMatchObject({ responseId: response.responseId, status: "done" });
  expect(field(f.legacyRecord(), "status")).toBe("done");
  expect(inspect(f.writes, { depth: 20 })).not.toContain("dismissedAt");
  expect(take(await f.output.query("SELECT * FROM feed_handling")).rows).toEqual([]);
});

test("intent-only, unrelated IDs/tuples, wrong completion and private events cannot complete tasks", async () => {
  for (const mismatch of ["intent-only", "no-intent", "event-id", "source", "revision", "issuance", "type", "completion"] as const) {
    const f = await fixture("task"); await publishHomeMirror(f.ctx, f.input);
    const data = { kind: "task", id: f.input.legacy.record.id, steps: {}, updatedAt: T2, doneAt: T2 };
    if (mismatch === "intent-only") {
      take(await f.owner.execute("INSERT INTO feed_owner_events VALUES (?,?,?,?,?,?,?,?)", [randomUUID(), f.identity.sourceId, f.identity.cardId, 1, f.identity.issuanceId, "state", JSON.stringify(data), T2]));
    } else await f.command(data, mismatch === "no-intent" ? undefined : {
      ...(mismatch === "event-id" ? { eventId: randomUUID() } : {}), ...(mismatch === "source" ? { sourceId: "another-source" } : {}),
      ...(mismatch === "revision" ? { revision: 2 } : {}), ...(mismatch === "issuance" ? { issuanceId: randomUUID() } : {}),
      ...(mismatch === "type" ? { eventType: "held-note" } : {}), ...(mismatch === "completion" ? { data: { ...data, doneAt: T1 } } : {}),
    });
    const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
  }
});

test("all task checks, notes and generic messages remain non-completion evidence", async () => {
  const f = await fixture("task"); await publishHomeMirror(f.ctx, f.input);
  await f.command({ kind: "task", id: f.input.legacy.record.id, steps: { one: T2, two: T2 }, updatedAt: T2 }, {});
  take(await appendFeedMessage(f.output, f.responses, { ...tuple(f.identity), responseId: randomUUID(), kind: "message", text: NOTE, createdAt: T2 }, { type: "sitrep.note", version: 1, data: { text: NOTE } }));
  const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
});

test("explicit hold lift projects a static public reason, never its private reason", async () => {
  const f = await fixture("hold"); await publishHomeMirror(f.ctx, f.input);
  const data = { kind: "hold", id: f.input.legacy.record.id, steps: {}, updatedAt: T2, lift: { at: T2, reason: PRIVATE } };
  const response = await f.command(data, {});
  const receipt = await closeHomeMirror(f.ctx, f.identity);
  expect(receipt).toMatchObject({ responseId: response.responseId, status: "lifted" });
  expect(f.legacyRecord()).toMatchObject({ status: "lifted", liftReason: "Lift requested in Home", liftedBy: "sam", cardUuid: f.input.card.cardId });
  expect(inspect({ receipt, writes: f.writes }, { depth: 20 })).not.toContain(PRIVATE);
});

test("individual blocker clear and mismatched lift event cannot close a whole hold", async () => {
  for (const data of [
    { kind: "hold", id: "unused", steps: {}, updatedAt: T2, clears: [{ id: "clear0001", ref: "task:unrelated-task", at: T2 }] },
    { kind: "hold", id: "unused", steps: {}, updatedAt: T2, lift: { at: T2 } },
  ]) {
    const f = await fixture("hold"); await publishHomeMirror(f.ctx, f.input);
    await f.command({ ...data, id: f.input.legacy.record.id }, { data: { ...data, id: f.input.legacy.record.id, ...(data.lift ? { lift: { at: T1 } } : {}) } });
    const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
  }
});

test("informational cards and work with related asks have no human-answer auto-close shortcut", async () => {
  for (const kind of ["incident", "ship", "order", "progress", "work"] as const) {
    const f = await fixture(kind); await publishHomeMirror(f.ctx, f.input);
    await f.command({ kind, id: f.input.legacy.record.id, steps: {}, updatedAt: T2, doneAt: T2 }, {});
    const before = f.values.get(f.key); expect(await closeHomeMirror(f.ctx, f.identity)).toBeNull(); expect(f.values.get(f.key)).toEqual(before);
  }
});

test("legacy write failures remain failures without leaking private answer data or recording completion", async () => {
  const f = await fixture(); await publishHomeMirror(f.ctx, f.input);
  await f.answer({ askId: f.input.legacy.record.id, action: "answer", text: PRIVATE, at: T2 });
  const before = f.values.get(f.key); f.failPut(); await refused(closeHomeMirror(f.ctx, f.identity));
  expect(f.values.get(f.key)).toEqual(before);
  expect(take(await f.owner.query("SELECT close_receipt_json FROM feed_sitrep_mirrors")).rows).toEqual([[null]]);
  expect(take(await listFeedResponses(f.responses)).map((response) => response.kind)).toEqual(["answer"]);
});
