import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CONNECTOR_SCHEMA } from "../../../packages/core/src/connector-meeting.js";
import { mcpChatFromEnv } from "../mcp-meetings/config.js";
import { orchestrateToolCalling, type AgentChatConfig } from "../routes/agent-chat.js";

// A stand-in for the hosted MCP's two read tools. It enforces what the real server enforces on these calls
// (packages/mcp/src/results.ts: any serialized read result over 100,000 chars becomes an error; kv values over
// that size cannot be returned; sql rows over maxRows/maxBytes fail) and requires the configured headers.
const CREDENTIAL_HEADER = "x-test-credential";
const OWNER_HEADER = "x-test-owner";
const CREDENTIAL = "test-credential";
const OWNER = "did:pkh:eip155:1:0xabc0000000000000000000000000000000000001";
const ADDRESS = "0xabc0000000000000000000000000000000000001";
const KV_PREFIX = "xyz.tinycloud.tinychat/connectors";

const db = new Database(":memory:");
for (const { sql } of CONNECTOR_SCHEMA) db.run(sql);
db.run("CREATE TABLE voice_note_transcript (source_id TEXT PRIMARY KEY, rev INTEGER, hash TEXT, body_key TEXT, outcome TEXT, preview TEXT)");
const kv = new Map<string, string>();
let grantMode: "ok" | "none" | "expired" | "rejected" = "ok";
let sqlCalls: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let url = "";
const seenOwners = new Set<string>();

function insertMeeting(row: { id: string; source: string; sourceId: string; title: string; startedAt: string; overview?: string; actions?: string; metadata?: object | string; participants?: object }) {
  db.run(
    "INSERT INTO connector_meeting (id, source, source_id, title, started_at, participants, summary_overview, summary_action_items, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    [row.id, row.source, row.sourceId, row.title, row.startedAt, JSON.stringify(row.participants ?? [{ name: "Ana" }, { name: "Ben" }]), row.overview ?? null, row.actions ?? null,
      typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata ?? {}), row.startedAt, row.startedAt],
  );
}
const transcript = (lines: Array<[string, string]>) => JSON.stringify(lines.map(([speaker, text], index) => ({ index, speaker_name: speaker, text, start_time: index * 10, end_time: index * 10 + 9 })));

beforeAll(() => {
  insertMeeting({ id: "m-planning", source: "fireflies", sourceId: "ff-1", title: "Planning sync", startedAt: "2026-10-20T15:00:00Z", overview: "Planned the launch.", actions: "Ana to draft the plan", metadata: { kind: "meeting", transcript_count: 1 } });
  kv.set(`${KV_PREFIX}/fireflies/transcript/ff-1`, transcript([["Ana", "We will launch on Friday."], ["Ben", "I will write the announcement."]]));
  insertMeeting({ id: "m-long", source: "fireflies", sourceId: "ff-long", title: "Very long meeting", startedAt: "2026-10-19T15:00:00Z", overview: "Long.", metadata: {} });
  kv.set(`${KV_PREFIX}/fireflies/transcript/ff-long`, transcript(Array.from({ length: 1500 }, (_, i) => ["Ana", `Sentence number ${i} about the roadmap and other planning topics.`] as [string, string])));
  // Voice notes: only the committed transcribed revision is readable.
  insertMeeting({ id: "m-vn-ok", source: "exo-voice-note", sourceId: "vn-ok", title: "Voice note ok", startedAt: "2026-10-18T09:00:00Z", metadata: { transcription_outcome: "transcribed" } });
  insertMeeting({ id: "m-vn-none", source: "exo-voice-note", sourceId: "vn-none", title: "Voice note empty", startedAt: "2026-10-18T10:00:00Z", metadata: { transcription_outcome: "transcribed" } });
  const hash = "0123456789abcdef0123456789abcdef";
  db.run("INSERT INTO voice_note_transcript VALUES (?,?,?,?,?,?)", ["vn-ok", 1, hash, `${KV_PREFIX}/exo-voice-note/transcript-rev/vn-ok/${hash}`, "transcribed", "p"]);
  kv.set(`${KV_PREFIX}/exo-voice-note/transcript-rev/vn-ok/${hash}`, transcript([["Speaker 1", "Remember to buy milk."]]));
  // TC-2163 regression shape: many rows whose metadata embeds large transcript text.
  const bulk = "x".repeat(50_000);
  for (let i = 0; i < 120; i++) insertMeeting({ id: `bulk-${i}`, source: "google-meet", sourceId: `gm-${i}`, title: `Bulk ${i}`, startedAt: `2026-09-${String((i % 27) + 1).padStart(2, "0")}T08:00:00Z`, metadata: { transcript_text: bulk, kind: "meeting" } });

  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get(CREDENTIAL_HEADER) !== CREDENTIAL || !request.headers.get(OWNER_HEADER)) return Response.json({ error: "missing" }, { status: 401 });
      seenOwners.add(request.headers.get(OWNER_HEADER)!);
      if (grantMode === "none") return Response.json({ error: "grant_missing_test" }, { status: 401 });
      if (grantMode === "expired") return Response.json({ error: "grant_expired_test" }, { status: 401 });
      if (grantMode === "rejected") return Response.json({ error: "grant_rejected_test" }, { status: 401 });
      const { id, params } = await request.json() as { id: number; params: { name: string; arguments: Record<string, any> } };
      const respond = (structured: object) => Response.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "" }], structuredContent: structured } });
      const limited = (structured: { status: string; output?: unknown }, sqlResult: boolean) => {
        const canonical = { ...structured, operation: {}, context: {} };
        if (JSON.stringify(canonical).length > 100_000) return respond({ status: "error", error: { code: sqlResult ? "SQL_RESULT_LIMIT_EXCEEDED" : "KV_RESPONSE_TOO_LARGE" } });
        return respond(canonical);
      };
      const args = params.arguments;
      if (params.name === "tinycloud_sql_query") {
        sqlCalls.push(args.sql);
        if (args.database !== KV_PREFIX || args.space !== "applications" || !/^\s*(SELECT|WITH)\b/i.test(args.sql)) return respond({ status: "error", error: { code: "SQL_QUERY_INVALID" } });
        try {
          const statement = db.query(args.sql);
          const rows = statement.values(...(args.params as never[])) as unknown[][];
          if (rows.length > args.maxRows || Buffer.byteLength(JSON.stringify({ rows })) > args.maxBytes) return respond({ status: "error", error: { code: "SQL_RESULT_LIMIT_EXCEEDED" } });
          return limited({ status: "ok", output: { columns: [], rows } }, true);
        } catch {
          return respond({ status: "error", error: { code: "SQL_QUERY_INVALID" } });
        }
      }
      if (params.name === "tinycloud_kv_get") {
        const value = kv.get(args.key);
        if (args.representation !== "text" || args.space !== "applications") return respond({ status: "error", error: { code: "INPUT_INVALID" } });
        if (value === undefined) return respond({ status: "error", error: { code: "KV_NOT_FOUND" } });
        return limited({ status: "ok", output: { value, encoding: "text", byteLength: value.length } }, false);
      }
      return respond({ status: "error", error: { code: "INPUT_INVALID" } });
    },
  });
  url = `http://127.0.0.1:${server.port}/mcp`;
});
afterAll(() => server.stop(true));

const env = () => ({
  MCP_CHAT_ENABLED: "true", MCP_CHAT_URL: url, MCP_CHAT_SERVICE_CREDENTIAL: CREDENTIAL, MCP_CHAT_SERVICE_CREDENTIAL_HEADER: CREDENTIAL_HEADER,
  MCP_CHAT_OWNER_DID_HEADER: OWNER_HEADER, MCP_CHAT_SERVICE_DID: "did:key:z6MkServiceDidForTests", MCP_CHAT_TEST_ACCOUNTS: ADDRESS, MCP_CHAT_GRANT_EXPIRED_ERROR: "grant_expired_test", MCP_CHAT_GRANT_REJECTED_ERROR: "grant_rejected_test",
});
const tools = () => mcpChatFromEnv(env()).mcpMeetings!;
const run = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  tools().run({ name, args, owner: OWNER, roomId: "room-1", ...extra });

describe("mcp chat configuration", () => {
  test("stays off without the flag, without any header or credential setting, or without a named account", () => {
    expect(mcpChatFromEnv({})).toEqual({});
    expect(mcpChatFromEnv({ ...env(), MCP_CHAT_ENABLED: "1" })).toEqual({});
    for (const key of ["MCP_CHAT_URL", "MCP_CHAT_SERVICE_CREDENTIAL", "MCP_CHAT_SERVICE_CREDENTIAL_HEADER", "MCP_CHAT_OWNER_DID_HEADER", "MCP_CHAT_SERVICE_DID", "MCP_CHAT_TEST_ACCOUNTS"]) {
      expect(mcpChatFromEnv({ ...env(), [key]: "" })).toEqual({});
    }
  });
  test("admits only listed accounts and derives the owner DID from the session address", () => {
    const wiring = mcpChatFromEnv(env());
    expect(wiring.mcpChatAccountAllowed!(ADDRESS.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(wiring.mcpChatAccountAllowed!("0xdef")).toBe(false);
    expect(wiring.mcpOwnerDidFor!(ADDRESS)).toBe(OWNER);
    // The MCP canonicalizes the address to lowercase; a checksummed session address must produce the same DID.
    expect(wiring.mcpOwnerDidFor!("0xABC0000000000000000000000000000000000001")).toBe(OWNER);
  });
});

describe("meeting tools over the MCP", () => {
  test("find lists metadata with the owner header and never selects raw metadata", async () => {
    sqlCalls = [];
    const result = await run("tinycloud_find_meetings", { title: "Planning" });
    expect(result.status).toBe(200);
    const outcomes = (result.body as any).result.data.outcomes;
    expect(outcomes.map((o: any) => o.meeting.title)).toContain("Planning sync");
    expect(seenOwners.has(OWNER)).toBe(true);
    expect(sqlCalls.length).toBeGreaterThan(0);
    // Raw metadata may embed whole transcripts: it may only appear inside the bounded json_* projections.
    for (const sql of sqlCalls) expect(sql.replace(/json_(extract|valid|type)\(metadata/g, "")).not.toMatch(/\bmetadata\b/);
  });

  test("read returns cited transcript evidence", async () => {
    const found = await run("tinycloud_find_meetings", { title: "Planning" });
    const ref = (found.body as any).result.data.outcomes[0].meetingRef;
    const read = await run("tinycloud_read_meeting", { meetingRef: ref, focus: "transcript", includeBody: true });
    expect(read.status).toBe(200);
    const data = (read.body as any).result.data;
    expect(data.outcomes[0].state).toBe("read");
    expect(JSON.stringify(data)).toContain("launch on Friday");
  });

  test("search finds literal passages across meetings", async () => {
    const result = await run("tinycloud_search_transcripts", { query: "announcement" });
    expect(result.status).toBe(200);
    expect(JSON.stringify((result.body as any).result.data)).toContain("announcement");
  });

  test("a listing over rows that embed 50 KB of text each stays under the MCP result cap (TC-2163 shape)", async () => {
    const result = await run("tinycloud_find_meetings", { source: "google-meet", limit: 12 });
    expect(result.status).toBe(200);
    expect((result.body as any).result.data.outcomes.length).toBeGreaterThan(0);
  });

  test("a transcript body over the MCP's 100,000-character result cap reports size_limit, not a failure", async () => {
    const found = await run("tinycloud_find_meetings", { title: "Very long" });
    const ref = (found.body as any).result.data.outcomes[0].meetingRef;
    const read = await run("tinycloud_read_meeting", { meetingRef: ref, focus: "transcript", includeBody: true });
    expect(read.status).toBe(200);
    const outcome = (read.body as any).result.data.outcomes[0];
    expect(outcome.body.state).toBe("size_limit");
  });

  test("voice notes are readable only through the committed transcribed revision", async () => {
    const ok = await run("tinycloud_read_meeting", { meetingRef: "m-vn-ok", focus: "transcript", includeBody: true });
    expect(JSON.stringify((ok.body as any).result.data)).toContain("buy milk");
    const none = await run("tinycloud_read_meeting", { meetingRef: "m-vn-none", focus: "transcript", includeBody: true });
    expect(none.status === 404 || (none.body as any).result?.data?.outcomes?.[0]?.state !== "read").toBe(true);
  });

  test("a missing grant maps to delegation_required, expired to delegation_expired and rejected to delegation_revoked (409)", async () => {
    grantMode = "none";
    const missing = await run("tinycloud_find_meetings", {});
    grantMode = "expired";
    const expired = await run("tinycloud_find_meetings", {});
    grantMode = "rejected";
    const rejected = await run("tinycloud_find_meetings", {});
    grantMode = "ok";
    expect(missing).toEqual({ status: 409, body: { error: "delegation_required" } });
    expect(expired).toEqual({ status: 409, body: { error: "delegation_expired" } });
    expect(rejected).toEqual({ status: 409, body: { error: "delegation_revoked" } });
  });

  test("a wrong service credential never yields meeting data", async () => {
    const wrong = mcpChatFromEnv({ ...env(), MCP_CHAT_SERVICE_CREDENTIAL: "wrong" }).mcpMeetings!;
    const result = await wrong.run({ name: "tinycloud_find_meetings", args: {}, owner: OWNER });
    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).not.toContain("Planning");
  });

  test("invalid arguments and unknown tools are rejected without an MCP call", async () => {
    sqlCalls = [];
    expect((await run("tinycloud_find_meetings", { bogus: true })).status).toBe(400);
    expect((await run("not_a_tool", { query: "x" })).status).toBe(404);
    expect(sqlCalls).toHaveLength(0);
  });
});

const sse = (frames: unknown[]): AsyncIterable<Uint8Array> => {
  const enc = new TextEncoder();
  return { async *[Symbol.asyncIterator]() { for (const f of frames) yield enc.encode(`data: ${JSON.stringify(f)}\n\n`); yield enc.encode("data: [DONE]\n\n"); } };
};

describe("chat loop with MCP chat enabled", () => {
  test("a meeting tool call is served by the MCP, never by eliza-service, and the model receives the result", async () => {
    const urls: string[] = [];
    const modelRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let round = 0;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      urls.push(String(input));
      modelRequests.push(JSON.parse(init!.body as string));
      round += 1;
      const delta = round === 1
        ? { tool_calls: [{ index: 0, id: "call_1", function: { name: "tinycloud_find_meetings", arguments: '{"title":"Planning"}' } }] }
        : { content: "You had a Planning sync." };
      return { ok: true, status: 200, body: sse([{ choices: [{ delta, finish_reason: round === 1 ? "tool_calls" : "stop" }] }]) } as unknown as Response;
    }) as unknown as typeof fetch;
    const wiring = mcpChatFromEnv(env());
    const config: AgentChatConfig = {
      agentId: "agent", streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: 10000, drainGraceMs: 100 }, entityIdFor: () => "entity-1",
      elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "svc", redpillApiKey: "rp", redpillBaseUrl: "https://redpill.test/v1",
      defaultModel: () => "phala/gpt-oss-120b", isModelOffered: () => true, fetchImpl, maxRounds: 3,
      ...wiring, mcpOwner: wiring.mcpOwnerDidFor!(ADDRESS),
    };
    const frames: string[] = [];
    seenOwners.clear();
    await orchestrateToolCalling({
      config, model: "phala/gpt-oss-120b", messages: [{ role: "user", content: "when was my planning meeting?" }],
      entityId: "entity-1", roomId: "thread-1", turnContext: { localDate: "2026-10-28", timeZone: "UTC" }, write: frame => frames.push(frame),
    });
    expect(urls.some(u => u.startsWith("https://eliza.test"))).toBe(false);
    expect([...seenOwners]).toEqual([OWNER]);
    const toolMessage = modelRequests[1]!.messages.find(message => message.role === "tool")!;
    expect(toolMessage.content).toContain("Planning sync");
  });
});
