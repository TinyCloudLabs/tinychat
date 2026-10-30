import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { KVService, SQLService, ServiceContext } from "@tinycloud/sdk-services";
import type { Result } from "@tinycloud/sdk-services";
import {
  appendFeedMessage, appendFeedResponse, feedResourceNames, getFeedHandoff,
  initializeFeedDatabases, initializeFeedHandoff, listFeedResponses, readFeedResponsePayload,
} from "@tinycloud/sdk-services/feed";
import type { FeedCardIdentity, FeedDeliveryOptions, FeedResponse, FeedResponsePayload } from "@tinycloud/sdk-services/feed";
import { decodeOwnerThreadMessage, validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import { closeHomeMirror, forwardHomeMirrorResponse, publishHomeMirror } from "./bridge";
import type { HomeMirrorContext, HomeMirrorIdentity, HomeMirrorPublishInput } from "./bridge-types";

const SPACE = "tinycloud:pkh:eip155:1:0x3333333333333333333333333333333333333333:applications";
const OWNER = "xyz.tinycloud.tinychat/home_feed", HANDOFF = "ordering_fixture_handoff";
const T0 = "2026-10-28T12:00:00.000Z", T2 = "2026-10-29T11:00:00.000Z", NOW = "2026-10-29T12:00:00.000Z";
const PRIVATE = "SYNTHETIC224ORDERINGPRIVATE", RECIPIENT = "synthetic-runtime";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function take<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function tuple(value: FeedCardIdentity): FeedCardIdentity { return { cardId: value.cardId, revision: value.revision, issuanceId: value.issuanceId }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const statement = z.object({ sql: z.string(), params: z.array(scalar).optional() });
const sqlRequest = z.discriminatedUnion("action", [
  statement.extend({ action: z.literal("query") }), statement.extend({ action: z.literal("execute") }),
  z.object({ action: z.literal("batch"), statements: z.array(statement) }),
]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const stamp = (value: string) => `"ordering-${digest(value)}"`;

async function fixture(kind: "ask" | "task" | "hold" = "ask") {
  const directory = await mkdtemp(join(tmpdir(), "home-close-ordering-"));
  const resources = take(feedResourceNames("xyz.tinycloud.tinychat/feed", "ordering_fixture"));
  const databases = new Map([OWNER, resources.outputResource, resources.responseResource, HANDOFF].map((resource, index) => [resource, new Database(join(directory, `${index}.sqlite`))]));
  cleanup.push(async () => { for (const database of databases.values()) database.close(); await rm(directory, { recursive: true, force: true }); });
  const boardFile = join(directory, "legacy-board.json"), attemptsFile = join(directory, "external-attempts.jsonl");
  const values = new Map<string, { text: string; etag: string }>();
  let closeGate: { arrived: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let failClose = false, failResponseRead = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const service = request.headers.get("X-Fixture-Service"), path = request.headers.get("X-Fixture-Path") ?? "";
    try {
      if (service === "sql") {
        const database = databases.get(path); if (!database) return Response.json({ error: PRIVATE }, { status: 403 });
        const body = sqlRequest.parse(await request.json());
        if (failResponseRead && path === resources.responseResource && body.action === "query") { failResponseRead = false; return Response.json({ error: PRIVATE, cause: { secret: PRIVATE } }, { status: 400 }); }
        const execute = (entry: z.infer<typeof statement>) => { const value = database.query(entry.sql).run(...(entry.params ?? [])); return { changes: value.changes, lastInsertRowId: Number(value.lastInsertRowid) }; };
        if (body.action === "query") { const query = database.query(body.sql), rows = query.values(...(body.params ?? [])); return Response.json({ columns: query.columnNames, rows, rowCount: rows.length }); }
        if (body.action === "execute") return Response.json(execute(body));
        database.exec("BEGIN");
        try { const results = body.statements.map(execute); database.exec("COMMIT"); return Response.json({ results }); }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      }
      if (service !== "kv") return new Response(null, { status: 400 });
      const action = request.headers.get("X-Fixture-Action")?.split("/").at(-1);
      if (action === "get") { const value = values.get(path); return value ? new Response(value.text, { headers: { etag: value.etag, "content-type": "application/json" } }) : Response.json({ error: "Absent fixture mirror" }, { status: 404 }); }
      if (action !== "put") return new Response(null, { status: 405 });
      const isClose = request.headers.has("if-match");
      if (isClose && closeGate) { const gate = closeGate; closeGate = undefined; gate.arrived.resolve(); await gate.release.promise; }
      if (isClose && failClose) { failClose = false; return Response.json({ error: PRIVATE, cause: { private: PRIVATE } }, { status: 500 }); }
      const old = values.get(path), expected = request.headers.get("if-match");
      if ((expected !== null && expected !== old?.etag) || (request.headers.get("if-none-match") === "*" && old)) return new Response(null, { status: 412 });
      const text = await request.text(); values.set(path, { text, etag: stamp(text) });
      writeFileSync(boardFile, text, { mode: 0o600 });
      return new Response(null, { headers: { etag: stamp(text) } });
    } catch { return Response.json({ error: PRIVATE, cause: { private: PRIVATE } }, { status: 400 }); }
  } });
  cleanup.push(() => server.stop(true));
  const serviceContext = new ServiceContext({
    hosts: [server.url.href], retryPolicy: { maxAttempts: 1 },
    invoke: (_session, service, path, action) => ({ Authorization: "synthetic-fixture", "X-Fixture-Service": service, "X-Fixture-Path": path, "X-Fixture-Action": action ?? "" }),
    session: { delegationHeader: { Authorization: "synthetic-fixture" }, delegationCid: "synthetic-cid", spaceId: SPACE, verificationMethod: "did:key:synthetic-owner", jwk: {} },
  });
  const sql = new SQLService(); sql.initialize(serviceContext);
  const legacy = new KVService(); legacy.initialize(serviceContext);
  const owner = sql.db(OWNER), output = sql.db(resources.outputResource), responses = sql.db(resources.responseResource), handoff = sql.db(HANDOFF);
  take(await owner.execute("CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY,agent_did TEXT NOT NULL,label TEXT NOT NULL,output_resource TEXT NOT NULL UNIQUE,response_resource TEXT NOT NULL UNIQUE,authorization_json TEXT NOT NULL)"));
  take(await owner.execute("INSERT INTO feed_agents VALUES (?,?,?,?,?,?)", ["ordering_fixture", "did:key:synthetic-publisher", "Untrusted presentation label", resources.outputResource, resources.responseResource, "{}"]));
  // Provisioning is test-local. The deployed owner table remains a HomeDeployGo effect.
  take(await owner.execute("CREATE TABLE feed_sitrep_mirrors (source_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,binding_json TEXT NOT NULL,close_receipt_json TEXT,PRIMARY KEY(source_id,card_id,revision,issuance_id))"));
  take(await owner.execute("CREATE TABLE feed_owner_events (event_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)"));
  take(await initializeFeedDatabases({ output, responses })); take(await initializeFeedHandoff(handoff));
  const cardId = randomUUID();
  const common = { kind, id: cardId, from: "SyntheticOfficer", owner: "SyntheticOwner", title: "Synthetic close ordering", body: "An isolated, reversible fixture.", createdAt: T0, updatedAt: T0, links: [], urgency: 2, importance: 2 };
  const context = { background: "This isolated fixture has no production board, account, grant, or external actor.", whyNow: "Check durable ordering without running a real agent.", ifNoAnswer: "Nothing is authorized by an unanswered synthetic fixture.", known: [], related: [] };
  const checked = validateRecord(kind, { ...common, ...(kind === "ask" ? { status: "open", askedAt: T0, context } : kind === "task" ? { status: "todo", context, steps: [{ id: "one", text: "Synthetic first step" }] } : { status: "active", what: "Hold a synthetic action", cause: "A synthetic requirement is incomplete.", exit: "Explicit owner lift", releasedBy: "sam" }) });
  if (!checked.ok) throw new Error("Invalid synthetic business fixture");
  const record = checked.value, key = `xyz.tinycloud.rocinante/board/${kind}/${record.id}.json`;
  const input: HomeMirrorPublishInput = {
    source: { sourceId: "ordering_fixture", agentDid: "did:key:synthetic-publisher", label: "Synthetic display label", output: { spaceId: SPACE, database: resources.outputResource }, responses: { spaceId: SPACE, database: resources.responseResource } },
    card: { cardId, revision: 1, issuanceId: randomUUID(), kind, title: record.title, body: record.body ?? "", urgency: 2, createdAt: T0, needsResponse: kind === "ask", payload: { sitrep: { version: 1, record } } },
    legacy: { spaceId: SPACE, fullKey: key, record },
  };
  const ctx: HomeMirrorContext = { ownerSpaceId: SPACE, sql, legacySpaceId: SPACE, legacy, now: () => NOW };
  const identity: HomeMirrorIdentity = { sourceId: input.source.sourceId, cardId, revision: 1, issuanceId: input.card.issuanceId };
  await publishHomeMirror(ctx, input);
  const runner = join(directory, "external-runner.mjs");
  writeFileSync(runner, `import { readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
const [boardFile, attemptsFile, exitCode] = process.argv.slice(2);
let input = ''; for await (const chunk of process.stdin) input += chunk;
const header = JSON.parse(input), board = JSON.parse(readFileSync(boardFile, 'utf8'));
const fd = openSync(attemptsFile, 'a', 0o600);
try { writeSync(fd, JSON.stringify({ header, boardStatus: board.status, liftReason: board.liftReason ?? null, liftedBy: board.liftedBy ?? null }) + '\\n'); fsyncSync(fd); } finally { closeSync(fd); }
process.exit(Number(exitCode));
`, { mode: 0o600 });
  function deliver(exitCode = 0): FeedDeliveryOptions["deliver"] {
    return async (response) => await new Promise<"delivered" | "unconfirmed">((resolve, reject) => {
      const child = spawn(process.execPath, [runner, boardFile, attemptsFile, String(exitCode)], { shell: false, stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", reject); child.once("close", (code) => resolve(code === 0 ? "delivered" : "unconfirmed"));
      child.stdin.on("error", () => undefined); child.stdin.end(JSON.stringify(response));
    });
  }
  const attempts = () => existsSync(attemptsFile) ? readFileSync(attemptsFile, "utf8").trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line)) : [];
  async function answer(data: FeedResponsePayload["data"] = { askId: record.id, action: "answer", text: PRIVATE, at: T2 }) {
    return take(await appendFeedResponse(output, responses, { ...tuple(identity), responseId: randomUUID(), kind: "answer", text: "Safe durable Home decision", createdAt: T2 }, { type: "sitrep.answer", version: 1, data }));
  }
  async function command(data: FeedResponsePayload["data"], intent?: FeedResponsePayload["data"]) {
    const responseId = randomUUID();
    if (intent) take(await owner.execute("INSERT INTO feed_owner_events VALUES (?,?,?,?,?,?,?,?)", [responseId, identity.sourceId, identity.cardId, identity.revision, identity.issuanceId, "state", JSON.stringify(intent), T2]));
    return take(await appendFeedMessage(output, responses, { ...tuple(identity), responseId, kind: "message", text: "Safe explicit Home command", createdAt: T2 }, { type: "sitrep.state", version: 1, data }));
  }
  const forward = (response: FeedResponse, callback = deliver()) => forwardHomeMirrorResponse(ctx, { identity, responseId: response.responseId, handoff, recipient: RECIPIENT, deliver: callback });
  const noDelivery = async (response: FeedResponse) => { expect(take(await getFeedHandoff(handoff, response.responseId, RECIPIENT))).toBeNull(); expect(attempts()).toEqual([]); };
  return { ctx, input, identity, owner, output, responses, handoff, legacy, values, key, answer, command, forward, deliver, attempts, noDelivery,
    holdClose: () => { const gate = { arrived: deferred(), release: deferred() }; closeGate = gate; cleanup.push(() => gate.release.resolve()); return gate; },
    failClose: () => { failClose = true; }, failRead: () => { failResponseRead = true; } };
}
async function blocked(operation: Promise<unknown>) {
  const result = await operation.then((value) => ({ value }), (error: unknown) => ({ error }));
  expect(inspect(result, { depth: 20 })).not.toContain(PRIVATE);
  if ("value" in result) expect(result.value).toBeNull();
}

test("a held conditional mirror close cannot claim a handoff or start a real child before confirmation", async () => {
  const f = await fixture(), response = await f.answer(), gate = f.holdClose();
  expect(take(await listFeedResponses(f.responses))).toEqual([response]);
  const forwarding = f.forward(response);
  try { await gate.arrived.promise; await f.noDelivery(response); }
  finally { gate.release.resolve(); }
  expect(await forwarding).toMatchObject({ responseId: response.responseId, state: "delivered" });
  expect(f.attempts()).toEqual([{ header: response, boardStatus: "answered", liftReason: null, liftedBy: null }]);
  expect(take(await f.output.query("SELECT * FROM feed_handling")).rows).toEqual([]);
  expect(take(await readFeedResponsePayload(f.responses, response))?.data).toEqual({ askId: f.input.legacy.record.id, action: "answer", text: PRIVATE, at: T2 });
  expect(inspect(take(await f.handoff.query("SELECT * FROM feed_handoffs")).rows, { depth: 20 })).not.toContain(PRIVATE);
});

test("a failed close retains the saved answer but leaves no ledger or child effect; explicit same-ID retry can proceed", async () => {
  const f = await fixture(), response = await f.answer(), before = f.values.get(f.key); f.failClose();
  await blocked(f.forward(response)); await f.noDelivery(response);
  expect(f.values.get(f.key)).toEqual(before);
  expect(take(await f.owner.query("SELECT close_receipt_json FROM feed_sitrep_mirrors")).rows).toEqual([[null]]);
  expect(take(await listFeedResponses(f.responses))).toEqual([response]);
  expect(await f.forward(response)).toMatchObject({ responseId: response.responseId, state: "delivered" });
  expect(f.attempts()).toEqual([{ header: response, boardStatus: "answered", liftReason: null, liftedBy: null }]);
});

test("a replaced legacy publication cannot be closed or forwarded by an old bound answer", async () => {
  const f = await fixture(), response = await f.answer();
  const newer = { ...f.input.legacy.record, title: "Newer publication must survive", cardUuid: f.identity.cardId };
  take(await f.legacy.put(f.key, newer)); const before = f.values.get(f.key);
  await blocked(f.forward(response)); await f.noDelivery(response); expect(f.values.get(f.key)).toEqual(before);
});

test("a close receipt is not delivery; confirmed close followed by child acceptance is durable and is not repeated", async () => {
  const f = await fixture(), response = await f.answer();
  expect(await closeHomeMirror(f.ctx, f.identity)).toMatchObject({ responseId: response.responseId, status: "answered" });
  await f.noDelivery(response);
  expect(await f.forward(response)).toMatchObject({ state: "delivered" });
  const accepted = f.attempts();
  expect(accepted).toEqual([{ header: response, boardStatus: "answered", liftReason: null, liftedBy: null }]);
  expect(await f.forward(response)).toMatchObject({ state: "delivered" }); expect(f.attempts()).toEqual(accepted);
});

test("confirmed close cannot turn an ambiguous external child result into delivery or authorize a resend", async () => {
  const f = await fixture(), response = await f.answer();
  expect(await f.forward(response, f.deliver(1))).toMatchObject({ responseId: response.responseId, state: "unconfirmed" });
  const attempted = f.attempts();
  expect(attempted).toEqual([{ header: response, boardStatus: "answered", liftReason: null, liftedBy: null }]);
  expect(await f.forward(response)).toMatchObject({ responseId: response.responseId, state: "unconfirmed" });
  expect(f.attempts()).toEqual(attempted);
});

test("a task completion message without its exact durable owner event is held, not treated as an ordinary note", async () => {
  const f = await fixture("task"), response = await f.command({ kind: "task", id: f.input.legacy.record.id, steps: {}, updatedAt: T2, doneAt: T2 });
  await blocked(f.forward(response)); await f.noDelivery(response);
  expect(JSON.parse(f.values.get(f.key)!.text).status).toBe("todo");
});

test("an exactly correlated durable task completion closes its own task before child acceptance", async () => {
  const f = await fixture("task"), state = { kind: "task", id: f.input.legacy.record.id, steps: {}, updatedAt: T2, doneAt: T2 };
  const response = await f.command(state, { ...state, dismissedAt: T2 });
  expect(await f.forward(response)).toMatchObject({ state: "delivered" });
  expect(f.attempts()).toEqual([{ header: response, boardStatus: "done", liftReason: null, liftedBy: null }]);
});

test("a durable hold lift closes first with a static public reason and no private payload in actual stdin", async () => {
  const f = await fixture("hold"), state = { kind: "hold", id: f.input.legacy.record.id, steps: {}, updatedAt: T2, lift: { at: T2, reason: PRIVATE } };
  const response = await f.command(state, { ...state, dismissedAt: T2 });
  expect(await f.forward(response)).toMatchObject({ state: "delivered" });
  expect(f.attempts()).toEqual([{ header: response, boardStatus: "lifted", liftReason: "Lift requested in Home", liftedBy: "sam" }]);
  expect(inspect({ attempts: f.attempts(), ledger: take(await f.handoff.query("SELECT * FROM feed_handoffs")).rows, receipt: take(await f.owner.query("SELECT close_receipt_json FROM feed_sitrep_mirrors")).rows }, { depth: 20 })).not.toContain(PRIVATE);
});

test("an explicit valid thread note retains normal handoff without closing its unanswered question", async () => {
  const f = await fixture(), messageId = `20261029T110000000Z-${randomUUID().replaceAll("-", "")}`;
  const data = { kind: "ask", id: f.input.legacy.record.id, side: "sam", messageId, at: T2, text: "An explicit nonclosing follow-up note." };
  expect(decodeOwnerThreadMessage(f.input.legacy.record, data).message.text).toBe(data.text);
  const response = take(await appendFeedMessage(f.output, f.responses, { ...tuple(f.identity), responseId: randomUUID(), kind: "message", text: "Card message saved", createdAt: T2 }, { type: "sitrep.thread", version: 1, data }));
  const before = f.values.get(f.key);
  expect(await f.forward(response)).toMatchObject({ state: "delivered" });
  expect(f.values.get(f.key)).toEqual(before);
  expect(f.attempts()).toEqual([{ header: response, boardStatus: "open", liftReason: null, liftedBy: null }]);
  expect(take(await f.owner.query("SELECT close_receipt_json FROM feed_sitrep_mirrors")).rows).toEqual([[null]]);
});

test("malformed claimed closing payloads never fall through to ordinary message delivery", async () => {
  const f = await fixture(), response = take(await appendFeedMessage(f.output, f.responses, { ...tuple(f.identity), responseId: randomUUID(), kind: "message", text: "Not a valid decision", createdAt: T2 }, { type: "sitrep.answer", version: 1, data: { askId: f.input.legacy.record.id, action: "answer", at: T2, unknownPrivate: PRIVATE } }));
  await blocked(f.forward(response)); await f.noDelivery(response);
  expect(JSON.parse(f.values.get(f.key)!.text).status).toBe("open");
});

test("a failed durable response read cannot be treated as an ordinary note or a confirmed close", async () => {
  const f = await fixture(), response = await f.answer(); f.failRead();
  await blocked(f.forward(response)); await f.noDelivery(response);
  expect(JSON.parse(f.values.get(f.key)!.text).status).toBe("open");
});

test("the full durable response identity and selected close receipt must match before any handoff claim", async () => {
  const f = await fixture(), response = await f.answer();
  await blocked(forwardHomeMirrorResponse(f.ctx, { identity: { ...f.identity, issuanceId: randomUUID() }, responseId: response.responseId, handoff: f.handoff, recipient: RECIPIENT, deliver: f.deliver() }));
  await f.noDelivery(response);
  await blocked(forwardHomeMirrorResponse(f.ctx, { identity: f.identity, responseId: randomUUID(), handoff: f.handoff, recipient: RECIPIENT, deliver: f.deliver() }));
  await f.noDelivery(response);
});
