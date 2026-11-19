// Test helper (bun:test only): a disposable node over SQLite files and an in-memory KV, reached through the real SDK
// services, that counts every node call. The tests use the counts to show what each mirror step costs the node.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { KVService, SQLService, ServiceContext } from "@tinycloud/sdk-services";
import type { Result, SqlValue } from "@tinycloud/sdk-services";
import { feedResourceNames, initializeFeedDatabases, initializeFeedHandoff } from "@tinycloud/sdk-services/feed";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";
import { validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord, Kind } from "@tinyboilerplate/core/feed/sitrep";
import type { HomeMirrorContext } from "./bridge-types";

export const SPACE = "tinycloud:pkh:eip155:1:0x5555555555555555555555555555555555555555:applications";
export const OWNER = "xyz.tinycloud.tinychat/home_feed";
export const SOURCE = "roci_fixture";
export const T0 = "2026-11-12T09:00:00.000Z", T1 = "2026-11-13T09:00:00.000Z", NOW = "2026-11-13T10:00:00.000Z";

export function take<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }

const context = {
  background: "This synthetic record exists only in a disposable local Home and board fixture.",
  whyNow: "The fixture needs an open card to mirror.",
  ifNoAnswer: "Nothing happens outside this fixture.", known: [], related: [],
};
export function boardRecord(kind: Kind, id: string, patch: Record<string, unknown> = {}): BoardRecord {
  const common = { kind, id, from: "SyntheticOfficer", owner: "SyntheticOwner", title: `Synthetic ${kind} ${id}`, body: "Synthetic card body.", createdAt: T0, updatedAt: T0, links: [], urgency: 2, importance: 2 };
  const shapes: Partial<Record<Kind, Record<string, unknown>>> = {
    ask: { status: "open", askedAt: T0, context, options: [{ id: "yes", label: "Proceed" }, { id: "no", label: "Wait" }] },
    task: { status: "todo", context, steps: [{ id: "one", text: "First check" }] },
    approval: { status: "open", approvalType: "go", approvalKind: "deploy", issuedAt: T0, codeExpected: false, context },
    incident: { status: "degraded", severity: "sev2", impact: "Only the fixture is affected.", startedAt: T0 },
    progress: { status: "open", ticket: "TC-1", steps: [{ name: "Build", state: "in-progress" }], currentStep: 0, important: false },
    work: { status: "waiting-sam", waitsOn: "A separate question", next: "Wait", askIds: ["other-ask"], standing: false },
    hold: { status: "active", what: "Hold the fixture", cause: "A check is open.", exit: "The owner lifts it.", releasedBy: "sam", unblockedBy: ["task:other-task"] },
  };
  const checked = validateRecord(kind, { ...common, ...shapes[kind], ...patch });
  if (!checked.ok) throw new Error(`Invalid synthetic ${kind}: ${checked.errors.join("; ")}`);
  return checked.value;
}

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const statement = z.object({ sql: z.string(), params: z.array(scalar).optional() });
const sqlRequest = z.discriminatedUnion("action", [
  statement.extend({ action: z.literal("query") }), statement.extend({ action: z.literal("execute") }),
  z.object({ action: z.literal("batch"), statements: z.array(statement) }),
]);
const etag = (text: string) => `"fixture-${createHash("sha256").update(text).digest("hex")}"`;

/** A local SQLite FeedDatabase, as `run.ts watch` opens its handoff ledger. Its calls are not node calls. */
export function localDatabase(path: string): { handle: FeedDatabase; close(): void } {
  const database = new Database(path);
  const run = (sql: string, params: SqlValue[] = []) => { const value = database.query(sql).run(...params); return { changes: Number(value.changes), lastInsertRowId: Number(value.lastInsertRowid) }; };
  const handle: FeedDatabase = {
    query: async <T>(sql: string, params: SqlValue[] = []) => { const query = database.query(sql), rows = query.values(...params) as T[][]; return { ok: true, data: { columns: query.columnNames, rows, rowCount: rows.length } }; },
    execute: async (sql, params) => ({ ok: true, data: run(sql, params) }),
    batch: async (statements) => { database.exec("BEGIN IMMEDIATE"); try { const results = statements.map((item) => run(item.sql, item.params)); database.exec("COMMIT"); return { ok: true, data: { results } }; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
  return { handle, close: () => database.close() };
}

export async function mirrorNode(options: { space?: string } = {}) {
  const space = options.space ?? SPACE;
  const directory = await mkdtemp(join(tmpdir(), "home-mirror-node-"));
  const resources = take(feedResourceNames("xyz.tinycloud.tinychat/feed", SOURCE));
  const files = new Map([OWNER, resources.outputResource, resources.responseResource].map((resource, index) => [resource, new Database(join(directory, `${index}.sqlite`))]));
  const values = new Map<string, { text: string; etag: string }>();
  const calls: string[] = [];
  let putFilter: ((key: string, text: string) => string) | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const service = request.headers.get("X-Fixture-Service"), path = request.headers.get("X-Fixture-Path") ?? "";
    const action = request.headers.get("X-Fixture-Action")?.split("/").at(-1) ?? "";
    try {
      if (service === "sql") {
        const file = files.get(path); if (!file) return Response.json({ error: "Unknown fixture SQL resource" }, { status: 403 });
        const body = sqlRequest.parse(await request.json());
        calls.push(`sql:${body.action}:${path.split("/").at(-1)}`);
        const execute = (entry: z.infer<typeof statement>) => { const result = file.query(entry.sql).run(...(entry.params ?? [])); return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) }; };
        if (body.action === "query") { const query = file.query(body.sql), rows = query.values(...(body.params ?? [])); return Response.json({ columns: query.columnNames, rows, rowCount: rows.length }); }
        if (body.action === "execute") return Response.json(execute(body));
        file.exec("BEGIN");
        try { const results = body.statements.map(execute); file.exec("COMMIT"); return Response.json({ results }); }
        catch (error) { file.exec("ROLLBACK"); throw error; }
      }
      if (service !== "kv") return new Response(null, { status: 400 });
      calls.push(`kv:${action}`);
      const current = values.get(path);
      if (action === "get") return current ? new Response(current.text, { headers: { etag: current.etag, "content-type": "application/json" } }) : Response.json({ error: "absent" }, { status: 404 });
      if (action === "del") {
        const match = request.headers.get("if-match");
        if (!current) return Response.json({ error: "absent" }, { status: 404 });
        if (match !== null && match !== current.etag) return new Response(null, { status: 412 });
        values.delete(path); return new Response(null, { status: 204 });
      }
      if (action !== "put") return new Response(null, { status: 405 });
      const match = request.headers.get("if-match");
      if ((match !== null && match !== current?.etag) || (request.headers.get("if-none-match") === "*" && current)) return new Response(null, { status: 412 });
      const text = putFilter ? putFilter(path, await request.text()) : await request.text();
      values.set(path, { text, etag: etag(text) });
      return new Response(null, { headers: { etag: etag(text) } });
    } catch { return Response.json({ error: "fixture failure" }, { status: 400 }); }
  } });
  const serviceContext = new ServiceContext({
    hosts: [server.url.href], retryPolicy: { maxAttempts: 1 },
    invoke: (_session, service, path, action) => ({ Authorization: "synthetic-fixture", "X-Fixture-Service": service, "X-Fixture-Path": path, "X-Fixture-Action": action ?? "" }),
    session: { delegationHeader: { Authorization: "synthetic-fixture" }, delegationCid: "synthetic-cid", spaceId: space, verificationMethod: "did:key:synthetic-owner", jwk: {} },
  });
  const sql = new SQLService(); sql.initialize(serviceContext);
  const legacy = new KVService(); legacy.initialize(serviceContext);
  const owner = sql.db(OWNER), output = sql.db(resources.outputResource), responses = sql.db(resources.responseResource);
  take(await owner.execute("CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY,agent_did TEXT NOT NULL,label TEXT NOT NULL,output_resource TEXT NOT NULL UNIQUE,response_resource TEXT NOT NULL UNIQUE,authorization_json TEXT NOT NULL)"));
  take(await owner.execute("INSERT INTO feed_agents VALUES (?,?,?,?,?,?)", [SOURCE, "did:key:synthetic-publisher", "Rocinante", resources.outputResource, resources.responseResource, "{}"]));
  take(await owner.execute("CREATE TABLE feed_sitrep_mirrors (source_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,binding_json TEXT NOT NULL,close_receipt_json TEXT,PRIMARY KEY(source_id,card_id,revision,issuance_id))"));
  take(await owner.execute("CREATE TABLE feed_owner_events (event_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL)"));
  take(await initializeFeedDatabases({ output, responses }));
  const ledger = localDatabase(join(directory, "handoff.sqlite"));
  take(await initializeFeedHandoff(ledger.handle));
  calls.length = 0;
  const ctx: HomeMirrorContext = { ownerSpaceId: space, sql, legacySpaceId: space, legacy, now: () => NOW };
  return {
    ctx, space, owner, output, responses, legacy, values, resources, ledger: ledger.handle, directory,
    source: { sourceId: SOURCE, agentDid: "did:key:synthetic-publisher", output: { spaceId: space, database: resources.outputResource }, responses: { spaceId: space, database: resources.responseResource } },
    /** Node calls since the last `resetCalls`, as `service:action[:database]`. */
    calls: () => [...calls],
    resetCalls: () => { calls.length = 0; },
    filterPuts: (filter: (key: string, text: string) => string) => { putFilter = filter; },
    async close() { server.stop(true); ledger.close(); for (const file of files.values()) file.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
export type MirrorNode = Awaited<ReturnType<typeof mirrorNode>>;
