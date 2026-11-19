import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { z } from "zod";
import { HooksService, KVService, SQLService, ServiceContext } from "@tinycloud/sdk-services";
import type { FetchFunction, Result } from "@tinycloud/sdk-services";
import { appendFeedResponse, feedResourceNames, initializeFeedDatabases, initializeFeedHandoff } from "@tinycloud/sdk-services/feed";
import type { FeedCardIdentity, FeedDatabase, FeedResponse } from "@tinycloud/sdk-services/feed";
import { validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import { publishHomeMirror, watchHomeMirrors } from "./bridge";
import type { HomeMirrorContext, HomeMirrorPublishInput } from "./bridge-types";

const SPACE = "tinycloud:pkh:eip155:1:0x4444444444444444444444444444444444444444:applications";
const OWNER = "xyz.tinycloud.tinychat/home_feed", HANDOFF = "watch_fixture_handoff", RECIPIENT = "synthetic-watch-runtime";
const T0 = "2026-10-28T12:00:00.000Z", T2 = "2026-10-29T11:00:00.000Z", NOW = "2026-10-29T12:00:00.000Z";
const PRIVATE = "SYNTHETIC224WATCHPRIVATE";
const ready = 'event: ready\ndata: {"type":"ready"}\n\n';
const encoder = new TextEncoder();
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function take<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function gate() { return { arrived: deferred<void>(), release: deferred<void>(), arrivals: 0 }; }
function slot<T>(values: Map<string, ReturnType<typeof deferred<T>>>, key: string) {
  let value = values.get(key); if (!value) { value = deferred<T>(); values.set(key, value); } return value;
}
function tuple(value: FeedCardIdentity): FeedCardIdentity { return { cardId: value.cardId, revision: value.revision, issuanceId: value.issuanceId }; }
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const statement = z.object({ sql: z.string(), params: z.array(scalar).optional() });
const sqlRequest = z.discriminatedUnion("action", [statement.extend({ action: z.literal("query") }), statement.extend({ action: z.literal("execute") }), z.object({ action: z.literal("batch"), statements: z.array(statement) })]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const etag = (value: string) => `"watch-${digest(value)}"`;
type Stream = {
  ticket: string;
  send(value: string): void;
  end(): void;
  signal?: AbortSignal;
  transportReady: ReturnType<typeof deferred<void>>;
  closed: ReturnType<typeof deferred<"cancel" | "abort" | "eof" | "error">>;
  returnHeaders: ReturnType<typeof deferred<void>>;
};

async function fixture(options: { holdFirstHeaders?: boolean; ignoreStreamAbort?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "home-watch-consumer-"));
  const resources = take(feedResourceNames("xyz.tinycloud.tinychat/feed", "watch_fixture"));
  const paths = new Map([OWNER, resources.outputResource, resources.responseResource, HANDOFF].map((resource, index) => [resource, join(directory, `${index}.sqlite`)]));
  const native = new Map([...paths].map(([resource, path]) => [resource, new Database(path)]));
  for (const database of native.values()) database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  const nativeOwner = native.get(OWNER)!, nativeHandoff = native.get(HANDOFF)!;
  cleanup.push(async () => { for (const database of native.values()) database.close(); await rm(directory, { recursive: true, force: true }); });
  const tickets = new Set<string>(), streams: Stream[] = [], streamsByTicket = new Map<string, Stream>();
  const firstOpen = deferred<Stream>(), secondOpen = deferred<Stream>();
  const values = new Map<string, { text: string; etag: string }>(), boardFiles = new Map<string, string>();
  const committed = new Map<string, ReturnType<typeof deferred<void>>>(), childExits = new Map<string, ReturnType<typeof deferred<number | null>>>();
  const children = new Set<ChildProcess>();
  const attemptsFile = join(directory, "external-acceptances.jsonl"), runner = join(directory, "external-runner.mjs");
  let readGate: ReturnType<typeof gate> | undefined, closeGate: ReturnType<typeof gate> | undefined;
  const emptyRead = deferred<void>();
  let observing = false, responseQueries = 0, activeReads = 0, maxReads = 0;
  const noteCommitted = () => {
    for (const row of nativeHandoff.query("SELECT response_id,state FROM feed_handoffs").values()) {
      if (row[1] === "delivered") slot(committed, String(row[0])).resolve();
    }
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/fixture/barrier") return new Response(null, { status: 204 });
      if (url.pathname === "/hooks/tickets") {
        if (request.headers.get("authorization") !== "synthetic-watch") return new Response(null, { status: 401 });
        z.object({ subscriptions: z.array(z.object({ space: z.literal(SPACE), service: z.literal("sql"), pathPrefix: z.literal(resources.responseResource), abilities: z.array(z.string()).optional() })).min(1), ttlSeconds: z.number().int().min(60).max(300) }).parse(await request.json());
        const ticket = randomUUID(); tickets.add(ticket); return Response.json({ ticket });
      }
      if (url.pathname === "/hooks/events") {
        const ticket = url.searchParams.get("ticket");
        if (!ticket || !tickets.delete(ticket)) return new Response(null, { status: 401 });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; controller.enqueue(encoder.encode(": fixture stream open; not ready\n\n")); } });
        const stream: Stream = { ticket, send: (value) => controller.enqueue(encoder.encode(value)), end: () => { try { controller.close(); } catch { /* Already cancelled. */ } }, transportReady: deferred<void>(), closed: deferred(), returnHeaders: deferred<void>() };
        streamsByTicket.set(ticket, stream); streams.push(stream);
        if (streams.length !== 1 || !options.holdFirstHeaders) stream.returnHeaders.resolve();
        if (streams.length === 1) firstOpen.resolve(stream); else if (streams.length === 2) secondOpen.resolve(stream);
        return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
      const service = request.headers.get("X-Fixture-Service"), path = request.headers.get("X-Fixture-Path") ?? "";
      if (service === "sql") {
        const database = native.get(path); if (!database) return Response.json({ error: "Unknown fixture database" }, { status: 403 });
        const body = sqlRequest.parse(await request.json());
        const execute = (entry: z.infer<typeof statement>) => { const result = database.query(entry.sql).run(...(entry.params ?? [])); return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) }; };
        if (body.action === "query") {
          const responseRead = observing && path === resources.responseResource;
          if (responseRead) { responseQueries++; activeReads++; maxReads = Math.max(maxReads, activeReads); }
          try {
            const held = responseRead ? readGate : undefined;
            if (held) { held.arrivals++; held.arrived.resolve(); await held.release.promise; }
            const query = database.query(body.sql), rows = query.values(...(body.params ?? []));
            if (responseRead && database.query("SELECT COUNT(*) FROM feed_responses").values()[0][0] === 0) emptyRead.resolve();
            return Response.json({ columns: query.columnNames, rows, rowCount: rows.length });
          } finally { if (responseRead) activeReads--; }
        }
        if (body.action === "execute") return Response.json(execute(body));
        database.exec("BEGIN IMMEDIATE");
        try { const results = body.statements.map(execute); database.exec("COMMIT"); return Response.json({ results }); }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      }
      if (service !== "kv") return new Response(null, { status: 400 });
      const action = request.headers.get("X-Fixture-Action")?.split("/").at(-1);
      if (action === "get") { const value = values.get(path); return value ? new Response(value.text, { headers: { etag: value.etag, "content-type": "application/json" } }) : Response.json({ error: "Absent fixture key" }, { status: 404 }); }
      if (action !== "put") return new Response(null, { status: 405 });
      const held = request.headers.has("if-match") ? closeGate : undefined;
      if (held) { closeGate = undefined; held.arrivals++; held.arrived.resolve(); await held.release.promise; }
      const previous = values.get(path), expected = request.headers.get("if-match");
      if ((expected !== null && previous?.etag !== expected) || (request.headers.get("if-none-match") === "*" && previous)) return new Response(null, { status: 412 });
      const text = await request.text(); values.set(path, { text, etag: etag(text) });
      const boardFile = boardFiles.get(path); if (!boardFile) return new Response(null, { status: 400 });
      writeFileSync(boardFile, text, { mode: 0o600 });
      return new Response(null, { headers: { etag: etag(text) } });
    } catch { return Response.json({ error: PRIVATE, cause: { secret: PRIVATE } }, { status: 400 }); }
  } });
  cleanup.push(() => server.stop(true));
  // Real HTTP passthrough. A body wrapper observes CLIENT cancellation, not Bun's
  // incidental server TCP-close notification. Only the stale-open case ignores abort.
  const transport: FetchFunction = async (url, init) => {
    const isEvents = new URL(url).pathname === "/hooks/events";
    const response = await fetch(url, isEvents && options.ignoreStreamAbort ? { ...init, signal: undefined } : init);
    if (!isEvents) return response;
    const stream = streamsByTicket.get(new URL(url).searchParams.get("ticket") ?? "");
    if (!stream || !response.body) throw new Error("Missing actual fixture stream");
    stream.signal = init?.signal;
    const reader = response.body.getReader(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read(); if (cancelled) return;
          if (next.done) { stream.closed.resolve("eof"); controller.close(); } else controller.enqueue(next.value);
        } catch (error) {
          if (!cancelled) { stream.closed.resolve(stream.signal?.aborted ? "abort" : "error"); controller.error(error); }
        }
      },
      async cancel() { cancelled = true; try { await reader.cancel(); } finally { stream.closed.resolve("cancel"); } },
    });
    stream.transportReady.resolve();
    await stream.returnHeaders.promise;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const context = new ServiceContext({ hosts: [server.url.origin], fetch: transport, retryPolicy: { maxAttempts: 1 },
    invoke: (_session, service, path, action) => ({ Authorization: "synthetic-watch", "X-Fixture-Service": service, "X-Fixture-Path": path, "X-Fixture-Action": action ?? "" }),
    session: { delegationHeader: { Authorization: "synthetic-watch" }, delegationCid: "synthetic-cid", spaceId: SPACE, verificationMethod: "did:key:synthetic-owner", jwk: {} },
  });
  const sql = new SQLService(); sql.initialize(context);
  const legacy = new KVService(); legacy.initialize(context);
  const hooks = new HooksService(); hooks.initialize(context);
  const owner = sql.db(OWNER), output = sql.db(resources.outputResource), responses = sql.db(resources.responseResource), rawHandoff = sql.db(HANDOFF);
  const handoff: FeedDatabase = {
    query: <T>(...args: Parameters<FeedDatabase["query"]>) => rawHandoff.query<T>(...args),
    execute: async (...args) => {
      const result = await rawHandoff.execute(...args);
      if (result.ok && observing) noteCommitted();
      return result;
    },
    batch: async (...args) => {
      const result = await rawHandoff.batch(...args);
      if (result.ok && observing) noteCommitted();
      return result;
    },
  };
  take(await owner.execute("CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY,agent_did TEXT NOT NULL,label TEXT NOT NULL,output_resource TEXT NOT NULL UNIQUE,response_resource TEXT NOT NULL UNIQUE,authorization_json TEXT NOT NULL)"));
  take(await owner.execute("INSERT INTO feed_agents VALUES (?,?,?,?,?,?)", ["watch_fixture", "did:key:synthetic-publisher", "Presentation only", resources.outputResource, resources.responseResource, "{}"]));
  // Test-owned provisioning only; no production schema or authorization operation.
  take(await owner.execute("CREATE TABLE feed_sitrep_mirrors (source_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,binding_json TEXT NOT NULL,close_receipt_json TEXT,PRIMARY KEY(source_id,card_id,revision,issuance_id))"));
  take(await owner.execute("CREATE TABLE feed_owner_events (event_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)"));
  take(await initializeFeedDatabases({ output, responses })); take(await initializeFeedHandoff(handoff));
  const ctx: HomeMirrorContext = { ownerSpaceId: SPACE, sql, legacySpaceId: SPACE, legacy, now: () => NOW };
  const abort = new AbortController();
  const subscriptions: AbortController[] = [], watches: Promise<void>[] = [];
  cleanup.push(async () => {
    abort.abort(); for (const subscription of subscriptions) subscription.abort();
    readGate?.release.resolve(); closeGate?.release.resolve();
    for (const stream of streams) { stream.returnHeaders.resolve(); stream.end(); }
    hooks.onSignOut(); for (const child of children) child.kill("SIGKILL");
    await Promise.all(watches.map((watch) => watch.catch(() => undefined)));
  });
  writeFileSync(runner, `import { Database } from 'bun:sqlite';
import { readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
const [boardFile, ownerFile, attemptsFile] = process.argv.slice(2);
let input = ''; for await (const chunk of process.stdin) input += chunk;
const header = JSON.parse(input), board = JSON.parse(readFileSync(boardFile, 'utf8'));
const owner = new Database(ownerFile, { readonly: true });
const row = owner.query('SELECT close_receipt_json FROM feed_sitrep_mirrors WHERE card_id=? AND revision=? AND issuance_id=?').get(header.cardId, header.revision, header.issuanceId);
owner.close();
if (!row || typeof row.close_receipt_json !== 'string') process.exit(2);
const receipt = JSON.parse(row.close_receipt_json);
if (board.status !== 'answered' || board.cardUuid !== header.cardId || receipt.responseId !== header.responseId) process.exit(3);
const fd = openSync(attemptsFile, 'a', 0o600);
try { writeSync(fd, JSON.stringify({ header, boardStatus: board.status, cardUuid: board.cardUuid, receiptResponseId: receipt.responseId }) + '\\n'); fsyncSync(fd); } finally { closeSync(fd); }
`, { mode: 0o600 });
  const deliver = async (response: FeedResponse): Promise<"delivered" | "unconfirmed"> => {
    const key = `xyz.tinycloud.rocinante/board/ask/${response.cardId}.json`, boardFile = boardFiles.get(key);
    if (!boardFile) throw new Error("Unknown actual child mirror");
    const exit = slot(childExits, response.responseId);
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [runner, boardFile, paths.get(OWNER)!, attemptsFile], { shell: false, stdio: ["pipe", "ignore", "ignore"] });
      children.add(child);
      child.once("error", () => { children.delete(child); exit.resolve(null); resolve("unconfirmed"); });
      child.once("close", (code) => { children.delete(child); exit.resolve(code); resolve(code === 0 ? "delivered" : "unconfirmed"); });
      child.stdin.on("error", () => undefined); child.stdin.end(`${JSON.stringify(response)}\n`);
    });
  };
  async function saveQuestion() {
    const cardId = randomUUID(), key = `xyz.tinycloud.rocinante/board/ask/${cardId}.json`;
    const checked = validateRecord("ask", { kind: "ask", id: cardId, from: "SyntheticOfficer", owner: "SyntheticOwner", title: "Synthetic watcher question", body: "Only a disposable local fixture.", createdAt: T0, updatedAt: T0, links: [], urgency: 2, importance: 2, status: "open", askedAt: T0,
      context: { background: "A synthetic local watch check with no production accounts, data, grants, or actors.", whyNow: "Verify durable ordering through the actual SSE consumer.", ifNoAnswer: "No external action is authorized by silence.", known: [], related: [] } });
    if (!checked.ok) throw new Error("Invalid actual model fixture");
    const record = checked.value; boardFiles.set(key, join(directory, `${cardId}.board.json`));
    const input: HomeMirrorPublishInput = { source: { sourceId: "watch_fixture", agentDid: "did:key:synthetic-publisher", label: "Presentation only", output: { spaceId: SPACE, database: resources.outputResource }, responses: { spaceId: SPACE, database: resources.responseResource } },
      card: { cardId, revision: 1, issuanceId: randomUUID(), kind: "ask", title: record.title, body: record.body ?? "", urgency: 2, needsResponse: true, createdAt: T0, payload: { sitrep: { version: 1, record } } }, legacy: { spaceId: SPACE, fullKey: key, record } };
    await publishHomeMirror(ctx, input);
    return take(await appendFeedResponse(output, responses, { ...tuple(input.card), responseId: randomUUID(), kind: "answer", text: "Safe Home answer summary", createdAt: T2 }, { type: "sitrep.answer", version: 1, data: { askId: cardId, action: "answer", text: PRIVATE, at: T2 } }));
  }
  const attempts = (): unknown[] => existsSync(attemptsFile) ? readFileSync(attemptsFile, "utf8").trim().split("\n").filter(Boolean).map((line): unknown => JSON.parse(line)) : [];
  const reset = () => { responseQueries = 0; maxReads = 0; observing = true; };
  const start = () => {
    reset();
    const watch = watchHomeMirrors(ctx, { sourceId: "watch_fixture", recipient: RECIPIENT, hooks, handoff, deliver, signal: abort.signal });
    // Observe rejection immediately while keeping it available to the consumer assertion.
    void watch.catch(() => undefined); watches.push(watch); return watch;
  };
  const flush = async () => { await new Promise<void>((done) => setImmediate(done)); await fetch(new URL("/fixture/barrier", server.url)); await new Promise<void>((done) => setImmediate(done)); };
  const opened = async (watch: Promise<void>, second = false): Promise<Stream> => await Promise.race([
    second ? secondOpen.promise : firstOpen.promise,
    watch.then(() => { throw new Error("Actual watch ended before opening its authorized SSE connection"); }),
  ]);
  const emit = (stream: Stream, ids: string[], space = SPACE) => stream.send(ids.map((id, index) => `event: write\ndata: ${JSON.stringify({ type: "write", id, space, service: "sql", databasePath: resources.responseResource, path: `db/p${Buffer.from(resources.responseResource).toString("hex")}/table/${Buffer.from("feed_responses").toString("hex")}`, ability: "tinycloud.sql/write", actor: "did:key:synthetic-owner", epoch: "synthetic-epoch", eventIndex: index + 1, timestamp: T2 })}\n\n`).join(""));
  const probe = (ttlSeconds = 300) => { const controller = new AbortController(); subscriptions.push(controller); return hooks.subscribe([{ space: SPACE, service: "sql", pathPrefix: resources.responseResource }], { signal: controller.signal, ttlSeconds })[Symbol.asyncIterator](); };
  const accepted = async (response: FeedResponse) => {
    const code = await slot(childExits, response.responseId).promise; expect(code).toBe(0);
    if (code !== 0) throw new Error("Actual child refused an unconfirmed mirror close");
    await slot(committed, response.responseId).promise;
    expect(nativeHandoff.query("SELECT state FROM feed_handoffs WHERE response_id=? AND recipient=?").values(response.responseId, RECIPIENT)).toEqual([["delivered"]]);
  };
  const noClaim = () => { expect(nativeHandoff.query("SELECT * FROM feed_handoffs").values()).toEqual([]); expect(attempts()).toEqual([]); };
  return { firstOpen: firstOpen.promise, secondOpen: secondOpen.promise, opened, responseResource: resources.responseResource, abort, start, saveQuestion, attempts, noClaim, flush, emit, probe, accepted, reset,
    emptyRead: emptyRead.promise, queries: () => responseQueries, maxReads: () => maxReads,
    holdReads: () => { const held = gate(); readGate = held; cleanup.push(() => held.release.resolve()); return { ...held, count: () => held.arrivals, unblock: () => { readGate = undefined; held.release.resolve(); } }; },
    holdClose: () => { const held = gate(); closeGate = held; cleanup.push(() => held.release.resolve()); return held; },
    receiptRows: () => nativeOwner.query("SELECT close_receipt_json FROM feed_sitrep_mirrors").values(),
    ledgerRows: () => nativeHandoff.query("SELECT response_json,state FROM feed_handoffs").values() };
}

async function observeLast(iterator: AsyncIterator<{ id: string }>, last: string) {
  for (;;) { const next = await iterator.next(); if (next.done) throw new Error("Actual hook observer stopped"); if (next.value.id === last) return; }
}
function acceptance(response: FeedResponse) { return { header: response, boardStatus: "answered", cardUuid: response.cardId, receiptResponseId: response.responseId }; }

test("the actual public hook consumer accepts its registered space and excludes a different space", async () => {
  const f = await fixture(), observer = f.probe(), next = observer.next();
  const stream = await f.firstOpen; await stream.transportReady.promise;
  stream.send(ready); f.emit(stream, ["wrong-space"], SPACE.replace("44444444", "55555555")); f.emit(stream, ["registered-space"]);
  const received = await next;
  expect(received.done).toBe(false);
  expect(received.value).toMatchObject({ id: "registered-space", space: SPACE, service: "sql", databasePath: f.responseResource });
  f.noClaim();
});

test("HTTP-open and pre-ready writes cannot drain; authorized ready reconciles durable answers and closes before the actual child", async () => {
  const f = await fixture(), response = await f.saveQuestion(), close = f.holdClose(), stopped = f.start();
  const stream = await f.opened(stopped); await stream.transportReady.promise;
  const observer = f.probe(), observed = observeLast(observer, "before-ready");
  f.emit(stream, ["before-ready"]); await observed; await f.flush();
  expect(f.queries()).toBe(0); f.noClaim(); expect(f.receiptRows()).toEqual([[null]]);
  stream.send(ready); await close.arrived.promise;
  f.noClaim(); expect(f.receiptRows()).toEqual([[null]]);
  close.release.resolve(); await f.accepted(response);
  expect(f.attempts()).toEqual([acceptance(response)]);
  expect(inspect({ attempts: f.attempts(), ledger: f.ledgerRows(), receipt: f.receiptRows() }, { depth: 20 })).not.toContain(PRIVATE);
  f.abort.abort(); await stopped;
});

test("real encoded SQL write wakeups coalesce while a drain is pending and later writes wake the idle consumer", async () => {
  const f = await fixture(), stopped = f.start(), stream = await f.opened(stopped);
  await stream.transportReady.promise; stream.send(ready); await f.emptyRead; await f.flush();
  const first = await f.saveQuestion(); await f.flush(); f.reset();
  f.noClaim();
  const held = f.holdReads(), observer = f.probe(), ids = Array.from({ length: 32 }, (_, index) => `burst-${index}`);
  const observed = observeLast(observer, ids[ids.length - 1]);
  f.emit(stream, ids); await observed; await held.arrived.promise; await f.flush();
  expect(held.count()).toBe(1); expect(f.maxReads()).toBe(1); f.noClaim();
  held.unblock(); await f.accepted(first); await f.flush();
  const second = await f.saveQuestion(); await f.flush();
  expect(f.attempts()).toEqual([acceptance(first)]);
  const secondObserved = observeLast(observer, "later-commit"); f.emit(stream, ["later-commit"]); await secondObserved;
  await f.accepted(second);
  expect(f.attempts()).toEqual([acceptance(first), acceptance(second)]);
  f.abort.abort(); await stopped;
});

test("stopping an unready watch aborts and closes its actual pending SSE body without any handoff", async () => {
  const f = await fixture(); await f.saveQuestion();
  const stopped = f.start(), stream = await f.opened(stopped); await stream.transportReady.promise; await f.flush();
  expect(f.queries()).toBe(0); f.noClaim();
  f.abort.abort(); await stopped;
  expect(stream.signal?.aborted).toBe(true);
  expect(["cancel", "abort"]).toContain(await stream.closed.promise);
  await f.flush(); expect(f.queries()).toBe(0); f.noClaim(); expect(f.receiptRows()).toEqual([[null]]);
});

test("a superseded real connection's late ready is discarded; only the replacement authorized ready may claim or dispatch", async () => {
  const f = await fixture({ holdFirstHeaders: true, ignoreStreamAbort: true }), response = await f.saveQuestion(), stopped = f.start();
  const old = await f.opened(stopped); await old.transportReady.promise;
  // A real second subscriber changes the public TTL plan, superseding the open.
  const observer = f.probe(299), observed = observeLast(observer, "replacement-write");
  const replacement = await f.opened(stopped, true); await replacement.transportReady.promise;
  expect(old.signal?.aborted).toBe(true); expect(f.queries()).toBe(0); f.noClaim();
  old.send(ready); f.emit(old, ["stale-write"]); old.returnHeaders.resolve();
  expect(await old.closed.promise).toBe("cancel");
  await f.flush(); expect(f.queries()).toBe(0); f.noClaim(); expect(f.receiptRows()).toEqual([[null]]);
  replacement.send(ready); f.emit(replacement, ["replacement-write"]); await observed; await f.accepted(response);
  expect(f.attempts()).toEqual([acceptance(response)]);
  f.abort.abort(); await stopped;
});
