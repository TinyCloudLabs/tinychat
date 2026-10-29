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
import { feedResourceNames, initializeFeedDatabases } from "@tinycloud/sdk-services/feed";
import { validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import { publishHomeMirror } from "./bridge";
import type { HomeMirrorContext, HomeMirrorPublishInput } from "./bridge-types";

const SPACE = "tinycloud:pkh:eip155:1:0x6666666666666666666666666666666666666666:applications";
const OWNER = "xyz.tinycloud.tinychat/home_feed", PREFIX = "xyz.tinycloud.tinychat/feed";
const AT = "2026-10-29T10:00:00.000Z", PRIVATE = "SYNTHETIC224BINDINGPRIVATE";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function take<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const statement = z.object({ sql: z.string(), params: z.array(scalar).optional() });
const sqlRequest = z.discriminatedUnion("action", [statement.extend({ action: z.literal("query") }), statement.extend({ action: z.literal("execute") }), z.object({ action: z.literal("batch"), statements: z.array(statement) })]);
const etag = (text: string) => `"binding-${createHash("sha256").update(text).digest("hex")}"`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "home-binding-race-"));
  const agents = ["race_a", "race_b"].map((sourceId) => ({ sourceId, did: `did:key:synthetic-${sourceId}`, resources: take(feedResourceNames(PREFIX, sourceId)) }));
  const native = new Map([OWNER, ...agents.flatMap((agent) => [agent.resources.outputResource, agent.resources.responseResource])].map((resource, index) => [resource, new Database(join(directory, `${index}.sqlite`))]));
  for (const database of native.values()) database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  const ownerFile = native.get(OWNER)!;
  cleanup.push(async () => { for (const database of native.values()) database.close(); await rm(directory, { recursive: true, force: true }); });
  const values = new Map<string, { text: string; etag: string }>();
  const writes: Array<{ key: string; ifMatch: string | null; ifNoneMatch: string | null }> = [];
  const gates = [0, 1].map(() => ({ arrived: deferred(), release: deferred() }));
  let holding = false, ownerWrites = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const service = request.headers.get("X-Fixture-Service"), path = request.headers.get("X-Fixture-Path") ?? "";
    try {
      if (service === "sql") {
        const database = native.get(path); if (!database) return Response.json({ error: "Unknown fixture resource" }, { status: 403 });
        const body = sqlRequest.parse(await request.json());
        if (holding && path === OWNER && body.action !== "query") {
          const held = gates[ownerWrites++];
          if (!held) throw new Error("Unexpected extra owner mutation in publication");
          // Pause the actual owner write before SQLite executes it, not a mocked
          // precheck/result. Both publishers have already read an empty binding set.
          held.arrived.resolve(); await held.release.promise;
        }
        const execute = (entry: z.infer<typeof statement>) => { const result = database.query(entry.sql).run(...(entry.params ?? [])); return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) }; };
        if (body.action === "query") { const query = database.query(body.sql), rows = query.values(...(body.params ?? [])); return Response.json({ columns: query.columnNames, rows, rowCount: rows.length }); }
        if (body.action === "execute") return Response.json(execute(body));
        database.exec("BEGIN IMMEDIATE");
        try { const results = body.statements.map(execute); database.exec("COMMIT"); return Response.json({ results }); }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      }
      if (service !== "kv") return new Response(null, { status: 400 });
      const action = request.headers.get("X-Fixture-Action")?.split("/").at(-1);
      if (action === "get") { const value = values.get(path); return value ? new Response(value.text, { headers: { etag: value.etag, "content-type": "application/json" } }) : Response.json({ error: "Absent fixture mirror" }, { status: 404 }); }
      if (action !== "put") return new Response(null, { status: 405 });
      const old = values.get(path), match = request.headers.get("if-match"), absent = request.headers.get("if-none-match");
      if ((match !== null && match !== old?.etag) || (absent === "*" && old)) return new Response(null, { status: 412 });
      const text = await request.text(); values.set(path, { text, etag: etag(text) }); writes.push({ key: path, ifMatch: match, ifNoneMatch: absent });
      return new Response(null, { headers: { etag: etag(text) } });
    } catch { return Response.json({ error: PRIVATE, cause: { secret: PRIVATE } }, { status: 400 }); }
  } });
  cleanup.push(() => server.stop(true));
  function client() {
    const context = new ServiceContext({ hosts: [server.url.href], retryPolicy: { maxAttempts: 1 },
      invoke: (_session, service, path, action) => ({ Authorization: "synthetic-binding-owner", "X-Fixture-Service": service, "X-Fixture-Path": path, "X-Fixture-Action": action ?? "" }),
      session: { delegationHeader: { Authorization: "synthetic-binding-owner" }, delegationCid: "synthetic-cid", spaceId: SPACE, verificationMethod: "did:key:synthetic-owner", jwk: {} },
    });
    const sql = new SQLService(); sql.initialize(context); const legacy = new KVService(); legacy.initialize(context);
    const ctx: HomeMirrorContext = { ownerSpaceId: SPACE, sql, legacySpaceId: SPACE, legacy, now: () => AT };
    return { ctx, owner: sql.db(OWNER) };
  }
  const firstClient = client(), owner = firstClient.owner;
  take(await owner.execute("CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY,agent_did TEXT NOT NULL,label TEXT NOT NULL,output_resource TEXT NOT NULL UNIQUE,response_resource TEXT NOT NULL UNIQUE,authorization_json TEXT NOT NULL)"));
  take(await owner.execute("CREATE TABLE feed_sitrep_mirrors (source_id TEXT NOT NULL,card_id TEXT NOT NULL,revision INTEGER NOT NULL,issuance_id TEXT NOT NULL,binding_json TEXT NOT NULL,close_receipt_json TEXT,PRIMARY KEY(source_id,card_id,revision,issuance_id))"));
  for (const agent of agents) {
    take(await owner.execute("INSERT INTO feed_agents VALUES (?,?,?,?,?,?)", [agent.sourceId, agent.did, "Presentation is not publisher authority", agent.resources.outputResource, agent.resources.responseResource, "{}"]));
    take(await initializeFeedDatabases({ output: firstClient.ctx.sql.db(agent.resources.outputResource), responses: firstClient.ctx.sql.db(agent.resources.responseResource) }));
  }
  const cardId = randomUUID(), issuanceId = randomUUID(), key = `xyz.tinycloud.rocinante/board/ask/${cardId}.json`;
  const checked = validateRecord("ask", { kind: "ask", id: cardId, from: "SyntheticOfficer", owner: "SyntheticOwner", title: "Same-byte publication ownership", body: "Only this synthetic publication is shared.", createdAt: AT, updatedAt: AT, links: [], urgency: 2, importance: 2, status: "open", askedAt: AT,
    context: { background: "Two separately registered synthetic publishers contend for one exact local mirror.", whyNow: "Prove immutable binding ownership without any external actor or production board.", ifNoAnswer: "No external effect follows from this isolated fixture.", known: [], related: [] } });
  if (!checked.ok) throw new Error("Invalid synthetic model record");
  const record = checked.value;
  const inputs: HomeMirrorPublishInput[] = agents.map((agent) => ({ source: { sourceId: agent.sourceId, agentDid: agent.did, label: "Presentation only", output: { spaceId: SPACE, database: agent.resources.outputResource }, responses: { spaceId: SPACE, database: agent.resources.responseResource } },
    card: { cardId, revision: 1, issuanceId, kind: "ask", title: record.title, body: record.body ?? "", urgency: 2, needsResponse: true, createdAt: AT, payload: { sitrep: { version: 1, record } } }, legacy: { spaceId: SPACE, fullKey: key, record } }));
  const work: Promise<unknown>[] = [];
  cleanup.push(async () => { holding = false; for (const held of gates) held.release.resolve(); await Promise.all(work.map((promise) => promise.catch(() => undefined))); });
  const publish = (index: number, input = inputs[index]) => { const result = publishHomeMirror(client().ctx, input); void result.catch(() => undefined); work.push(result); return result; };
  return { owner, inputs, key, values, writes, gates, client, publish,
    hold: () => { holding = true; }, release: () => { holding = false; for (const held of gates) held.release.resolve(); },
    snapshot: () => ownerFile.query("SELECT source_id,card_id,revision,issuance_id,binding_json FROM feed_sitrep_mirrors ORDER BY source_id,revision,issuance_id").values() };
}

for (const firstCommit of [0, 1] as const) {
  test(`concurrent same-byte publishers have one immutable mirror owner when contender ${firstCommit} commits first`, async () => {
    const f = await fixture(); expect(f.snapshot()).toEqual([]); f.hold();
    const a = f.publish(0); await f.gates[0].arrived.promise;
    // A has published the real conditional KV body, but its binding is not yet inserted.
    expect(f.snapshot()).toEqual([]);
    expect(JSON.parse(f.values.get(f.key)!.text)).toMatchObject({ cardUuid: f.inputs[0].card.cardId, kind: "ask", id: f.inputs[0].legacy.record.id, status: "open" });
    const b = f.publish(1); await f.gates[1].arrived.promise;
    // B's real precheck also observed no binding and its identical bytes reused A's KV version.
    expect(f.snapshot()).toEqual([]);
    expect(f.writes).toEqual([{ key: f.key, ifMatch: null, ifNoneMatch: "*" }]);
    const results = [a, b], winner = firstCommit, loser = firstCommit === 0 ? 1 : 0;
    f.gates[winner].release.resolve();
    const won = await results[winner];
    expect(won).toMatchObject({ source: { sourceId: f.inputs[winner].source.sourceId }, cardUuid: f.inputs[winner].card.cardId, legacy: { spaceId: SPACE, fullKey: f.key, publishedETag: f.values.get(f.key)!.etag } });
    f.gates[loser].release.resolve();
    const settled = await Promise.allSettled(results); f.release();
    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(inspect(settled, { depth: 20 })).not.toContain(PRIVATE);
    const fresh = f.client();
    const rows = take(await fresh.owner.query<string>("SELECT source_id,binding_json FROM feed_sitrep_mirrors")).rows;
    expect(rows.map((row) => row[0])).toEqual([f.inputs[winner].source.sourceId]);
    expect(JSON.parse(rows[0][1])).toEqual(won);
    const before = f.snapshot(), wire = f.values.get(f.key), writes = [...f.writes];
    const retriedLoser = await publishHomeMirror(fresh.ctx, f.inputs[loser]).then((value) => ({ value }), (error: unknown) => ({ error }));
    expect("error" in retriedLoser).toBe(true);
    expect(inspect(retriedLoser, { depth: 20 })).not.toContain(PRIVATE);
    expect(f.snapshot()).toEqual(before); expect(f.values.get(f.key)).toEqual(wire); expect(f.writes).toEqual(writes);
    expect(await publishHomeMirror(fresh.ctx, f.inputs[winner])).toEqual(won);
  });
}

test("one registered publisher retains distinct issuance history and exact replay for the same shared UUID", async () => {
  const f = await fixture(), first = await f.publish(0);
  const secondInput = structuredClone(f.inputs[0]); secondInput.card.revision = 2; secondInput.card.issuanceId = randomUUID();
  const second = await f.publish(0, secondInput);
  expect(second).toMatchObject({ source: first.source, identity: { cardId: first.identity.cardId, revision: 2, issuanceId: secondInput.card.issuanceId }, cardUuid: first.cardUuid, legacy: first.legacy });
  const rows = take(await f.client().owner.query<string>("SELECT binding_json FROM feed_sitrep_mirrors ORDER BY revision")).rows.map((row) => JSON.parse(row[0]));
  expect(rows).toEqual([first, second]);
  const before = f.snapshot(), writes = [...f.writes];
  expect(await publishHomeMirror(f.client().ctx, secondInput)).toEqual(second);
  expect(f.snapshot()).toEqual(before); expect(f.writes).toEqual(writes);
});
