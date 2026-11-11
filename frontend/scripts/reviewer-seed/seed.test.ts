import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { PortableDelegation } from "@tinycloud/node-sdk";
import { libraryRowTitle } from "../../src/capture/library/LibraryRow";
import { listMeetingsRead } from "../../src/lib/connectors/meetingExplorer";
import { VOICE_NOTE_SOURCE } from "../../src/lib/voiceNotes/voiceNoteStore";
import { CHAT_THREAD_ID, feedCards, SEED_MARKER_KEY, SEED_REVISION, VOICE_NOTE } from "./content";
import { assertGrant, parseSeedArgs, UsageError } from "./args";
import { readBackSeed, ReviewerSeedRefusal, runReviewerSeed, seedPermissions, type SeedSpace } from "./seed";

const open: Database[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
const failed = (error: unknown): Result => ({ ok: false, error: { code: "SQL_ERROR", message: String(error) } });

/**
 * A space backed by in-memory SQLite (one database per resource, as the node keeps them)
 * and a KV map. It records every database and key touched, and every write.
 */
function fakeSpace(options: { failAfterWrites?: number } = {}) {
  let failAfterWrites = options.failAfterWrites;
  // Home's stores memoize their schema per owner DID, so each fake space is its own owner.
  const address = `0x${randomBytes(20).toString("hex")}`;
  const ownerDid = `did:pkh:eip155:1:${address}`;
  const spaceId = `tinycloud:pkh:eip155:1:${address}:applications`;
  const databases = new Map<string, Database>();
  const kvValues = new Map<string, string>();
  const touched = { sql: new Set<string>(), kv: new Set<string>() };
  let writes = 0;
  const write = () => {
    writes++;
    if (failAfterWrites !== undefined && writes > failAfterWrites) throw new Error("simulated interruption");
  };
  const database = (name: string) => {
    let existing = databases.get(name);
    if (!existing) {
      existing = new Database(":memory:");
      open.push(existing);
      databases.set(name, existing);
    }
    return existing;
  };
  const sql = {
    db(name: string) {
      touched.sql.add(name);
      const sqlite = database(name);
      const run = (statement: string, params: unknown[] = []) => {
        const result = sqlite.query(statement).run(...params as never[]);
        return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
      };
      return {
        async query(statement: string, params: unknown[] = []): Promise<Result> {
          try {
            const prepared = sqlite.query(statement);
            const rows = prepared.values(...params as never[]);
            return { ok: true, data: { columns: prepared.columnNames, rows, rowCount: rows.length } };
          } catch (error) { return failed(error); }
        },
        async execute(statement: string, params: unknown[] = []): Promise<Result> {
          write();
          try { return { ok: true, data: run(statement, params) }; } catch (error) { return failed(error); }
        },
        async batch(statements: { sql: string; params?: unknown[] }[]): Promise<Result> {
          write();
          sqlite.exec("BEGIN");
          try {
            const results = statements.map((statement) => run(statement.sql, statement.params));
            sqlite.exec("COMMIT");
            return { ok: true, data: { results } };
          } catch (error) { sqlite.exec("ROLLBACK"); return failed(error); }
        },
      };
    },
  };
  const kv = {
    async put(key: string, value: string, putOptions: { ifNoneMatch?: string } = {}): Promise<Result> {
      touched.kv.add(key);
      write();
      if (putOptions.ifNoneMatch === "*" && kvValues.has(key)) return { ok: false, error: { code: "PRECONDITION_FAILED", message: "412" } };
      kvValues.set(key, value);
      return { ok: true, data: {} };
    },
    async get(key: string): Promise<Result> {
      touched.kv.add(key);
      return kvValues.has(key) ? { ok: true, data: { data: kvValues.get(key) } } : { ok: false, error: { code: "KV_NOT_FOUND", message: "404" } };
    },
  };
  const space = { did: ownerDid, spaceId, sql, kv } as unknown as SeedSpace;
  const target = { spaceId, ownerDid, allowlist: [ownerDid] };
  const rows = (name: string, table: string) => {
    const sqlite = databases.get(name);
    return sqlite?.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").values(table).length
      ? Number(sqlite.query(`SELECT COUNT(*) FROM ${table}`).values()[0]?.[0]) : 0;
  };
  const marker = () => databases.get("xyz.tinycloud.tinychat/threads")?.query("SELECT value FROM settings WHERE key = ?").values(SEED_MARKER_KEY)[0]?.[0];
  return { space, target, spaceId, ownerDid, databases, kvValues, touched, rows, marker, writes: () => writes, heal: () => { failAfterWrites = undefined; } };
}

const write = (spaceId: string) => ({ dryRun: false as const, confirm: spaceId });

test("a space with existing chats is refused before anything is written", async () => {
  const fake = fakeSpace();
  const threads = fake.space.sql.db("xyz.tinycloud.tinychat/threads");
  await threads.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)", []);
  await threads.execute("INSERT INTO threads VALUES ('t1', 'Mine', 'auto', '2026-01-01', '2026-01-01')", []);
  const before = fake.writes();
  const refusal = await runReviewerSeed(fake.space, fake.target, write(fake.spaceId)).catch((error) => error);
  expect(refusal).toBeInstanceOf(ReviewerSeedRefusal);
  expect(refusal.code).toBe("NOT_FRESH");
  expect(refusal.message).toContain("xyz.tinycloud.tinychat/threads.threads has 1 row(s)");
  expect(fake.writes()).toBe(before);
});

test("a space with a Feed agent or a voice note is refused too", async () => {
  for (const [database, statements] of [
    ["xyz.tinycloud.tinychat/home_feed", ["CREATE TABLE feed_agents (agent_id TEXT PRIMARY KEY)", "INSERT INTO feed_agents VALUES ('someone')"]],
    ["xyz.tinycloud.tinychat/connectors", ["CREATE TABLE connector_meeting (id TEXT PRIMARY KEY)", "INSERT INTO connector_meeting VALUES ('vn-1')"]],
  ] as const) {
    const fake = fakeSpace();
    for (const statement of statements) await fake.space.sql.db(database).execute(statement, []);
    const before = fake.writes();
    await expect(runReviewerSeed(fake.space, fake.target, write(fake.spaceId))).rejects.toMatchObject({ code: "NOT_FRESH" });
    expect(fake.writes()).toBe(before);
  }
});

test("a write without the confirmation is refused before any storage request", async () => {
  const fake = fakeSpace();
  for (const confirm of [undefined, "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000000:applications"]) {
    await expect(runReviewerSeed(fake.space, fake.target, { dryRun: false, confirm })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  }
  expect(fake.touched.sql.size + fake.touched.kv.size).toBe(0);
  const base = ["--space", fake.spaceId, "--owner", fake.ownerDid, "--allow-owner", fake.ownerDid, "--request-out", "request.json"];
  expect(() => parseSeedArgs(base)).toThrow(UsageError);
  expect(() => parseSeedArgs([...base, "--dry-run", "--confirm", fake.spaceId])).toThrow(UsageError);
  expect(parseSeedArgs([...base, "--confirm", fake.spaceId]).mode).toEqual({ dryRun: false, confirm: fake.spaceId });
});

test("an owner off the operator's allowlist, or a handle for another space, is refused", async () => {
  const fake = fakeSpace();
  await expect(runReviewerSeed(fake.space, { ...fake.target, allowlist: ["did:pkh:eip155:1:0x1111111111111111111111111111111111111111"] }, write(fake.spaceId)))
    .rejects.toMatchObject({ code: "OWNER_NOT_ALLOWLISTED" });
  const other = fakeSpace();
  await expect(runReviewerSeed(other.space, fake.target, write(fake.spaceId))).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
  const wrongSpace = fake.spaceId.replace(":applications", ":default");
  await expect(runReviewerSeed(fake.space, { ...fake.target, spaceId: wrongSpace }, write(wrongSpace))).rejects.toMatchObject({ code: "TARGET_MISMATCH" });
  expect(fake.touched.sql.size + other.touched.sql.size).toBe(0);
});

test("a dry run prints the plan and writes nothing", async () => {
  const fake = fakeSpace();
  const report = await runReviewerSeed(fake.space, fake.target, { dryRun: true }, () => new Date("2026-11-11T12:00:00Z"));
  expect(report.status).toBe("planned");
  expect(report.writes.map((entry) => entry.surface)).toEqual([
    "settings", "feed", "feed", "feed", "feed", "feed", "feed", "feed", "chat", "chat", "chat", "chat", "voice-note", "voice-note", "voice-note", "settings"]);
  expect(fake.writes()).toBe(0);
  expect(fake.kvValues.size).toBe(0);
  expect([...fake.touched.sql].sort()).toEqual(seedPermissions({ dryRun: true }).map((entry) => entry.path).sort());
  for (const database of fake.databases.values()) expect(database.query("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
});

test("seeding writes through Home's paths, and Home's own readers show every item", async () => {
  const fake = fakeSpace();
  const report = await runReviewerSeed(fake.space, fake.target, write(fake.spaceId), () => new Date("2026-11-11T12:00:00Z"));
  expect(report.status).toBe("seeded");

  const readBack = await readBackSeed(fake.space);
  expect(readBack.chats).toEqual([{ id: CHAT_THREAD_ID, title: "What can I do in TinyCloud Home?", messages: 4 }]);
  expect(readBack.feedCards).toEqual(feedCards(report.seededAt).map((card) => card.cardId).sort());
  expect(readBack.voiceNotes).toEqual([{ sourceId: VOICE_NOTE.sourceId, title: VOICE_NOTE.title, transcriptSegments: 3 }]);

  // The Library row the reviewer sees.
  const library = await listMeetingsRead(fake.space as never, [VOICE_NOTE_SOURCE]);
  expect(library.status).toBe("ok");
  if (library.status === "ok") {
    expect(library.meetings).toHaveLength(1);
    expect(libraryRowTitle(library.meetings[0]!)).toBe(VOICE_NOTE.title);
    expect(library.meetings[0]!.metadata).toMatchObject({ capture: "pasted", transcription_outcome: "transcribed" });
  }
  expect([...fake.kvValues.keys()].some((key) => key.includes("/audio/"))).toBe(false);
  expect(JSON.parse(String(fake.marker()))).toEqual({ seed: "tinychat-reviewer-seed", revision: SEED_REVISION, state: "complete", seededAt: "2026-11-11T12:00:00.000Z" });
});

test("a rerun of a seeded space is a no-op", async () => {
  const fake = fakeSpace();
  await runReviewerSeed(fake.space, fake.target, write(fake.spaceId));
  const counts = () => [fake.rows("xyz.tinycloud.tinychat/threads", "messages"), fake.rows("xyz.tinycloud.tinychat/connectors", "connector_meeting"),
    fake.rows("xyz.tinycloud.tinychat/feed/feed_output_home_tour", "feed_cards"), fake.rows("xyz.tinycloud.tinychat/home_feed", "feed_agents")];
  expect(counts()).toEqual([4, 1, 4, 1]);
  const before = fake.writes();
  const again = await runReviewerSeed(fake.space, fake.target, write(fake.spaceId));
  expect(again).toMatchObject({ status: "already-seeded", writes: [] });
  expect(fake.writes()).toBe(before);
  expect(counts()).toEqual([4, 1, 4, 1]);
});

test("an interrupted run resumes to the same content, and another revision is refused", async () => {
  const fake = fakeSpace({ failAfterWrites: 12 });
  await expect(runReviewerSeed(fake.space, fake.target, write(fake.spaceId), () => new Date("2026-11-11T12:00:00Z"))).rejects.toThrow("simulated interruption");
  expect(JSON.parse(String(fake.marker()))).toMatchObject({ state: "in-progress", seededAt: "2026-11-11T12:00:00.000Z" });
  expect(fake.rows("xyz.tinycloud.tinychat/connectors", "connector_meeting")).toBe(0);

  fake.heal();
  const resumed = await runReviewerSeed(fake.space, fake.target, write(fake.spaceId), () => new Date("2026-11-12T09:00:00Z"));
  expect(resumed).toMatchObject({ status: "resumed", seededAt: "2026-11-11T12:00:00.000Z" });
  const readBack = await readBackSeed(fake.space);
  expect(readBack.chats).toEqual([{ id: CHAT_THREAD_ID, title: "What can I do in TinyCloud Home?", messages: 4 }]);
  expect(readBack.feedCards).toHaveLength(4);
  expect(readBack.voiceNotes).toHaveLength(1);

  fake.databases.get("xyz.tinycloud.tinychat/threads")!.query("UPDATE settings SET value = json_set(value, '$.revision', 99) WHERE key = ?").run(SEED_MARKER_KEY);
  await expect(runReviewerSeed(fake.space, fake.target, write(fake.spaceId))).rejects.toMatchObject({ code: "OTHER_REVISION" });
});

test("the capability request covers exactly what the seed and its read-back touch", async () => {
  const fake = fakeSpace();
  await runReviewerSeed(fake.space, fake.target, write(fake.spaceId));
  await readBackSeed(fake.space);
  const permissions = seedPermissions(write(fake.spaceId));
  const sqlPaths = permissions.filter((entry) => entry.service === "tinycloud.sql").map((entry) => entry.path);
  expect([...fake.touched.sql].sort()).toEqual([...sqlPaths].sort());
  const kvPaths = permissions.filter((entry) => entry.service === "tinycloud.kv").map((entry) => entry.path);
  for (const key of fake.touched.kv) expect(kvPaths.some((path) => path.endsWith("/") ? key.startsWith(path) : key === path)).toBe(true);
  expect(permissions.every((entry) => entry.space === "applications")).toBe(true);
});

test("a grant is accepted only from the target owner, for the target space, to this run's key, no wider than asked", () => {
  const fake = fakeSpace();
  const options = parseSeedArgs(["--space", fake.spaceId, "--owner", fake.ownerDid, "--allow-owner", fake.ownerDid, "--request-out", "r.json", "--dry-run"]);
  const address = fake.ownerDid.split(":").at(-1)!;
  const now = Date.parse("2026-11-11T12:00:00Z");
  const grant: PortableDelegation = {
    cid: "bafy-grant", delegationHeader: { Authorization: "Bearer redacted" }, spaceId: fake.spaceId, path: "", actions: [],
    delegateDID: "did:key:z6MkSeed", ownerAddress: address, chainId: 1, host: options.host, expiry: new Date(now + 3_600_000),
    resources: seedPermissions(options.mode).map((entry) => ({ service: entry.service.replace("tinycloud.", ""), space: fake.spaceId, path: entry.path, actions: entry.actions })),
  } as unknown as PortableDelegation;
  expect(() => assertGrant(grant, options, "did:key:z6MkSeed", now)).not.toThrow();
  const refusals: [Partial<PortableDelegation>, string][] = [
    [{ delegateDID: "did:key:z6MkSomeoneElse" }, "not addressed to this run"],
    [{ spaceId: fake.spaceId.replace(":applications", ":default") }, "different space"],
    [{ ownerAddress: "0x1111111111111111111111111111111111111111" }, "not issued by the target owner"],
    [{ host: "https://elsewhere.example" }, "different node"],
    [{ expiry: new Date(now - 1) }, "expired"],
    [{ expiry: new Date(now + 48 * 3_600_000) }, "longer than 24 hours"],
    [{ resources: [{ service: "kv", space: fake.spaceId, path: "", actions: ["tinycloud.kv/get"] }] }, "wider than the request"],
    [{ resources: [{ service: "sql", space: fake.spaceId, path: "xyz.tinycloud.tinychat/threads", actions: ["tinycloud.sql/write"] }] }, "wider than the request"],
  ];
  for (const [change, message] of refusals) expect(() => assertGrant({ ...grant, ...change }, options, "did:key:z6MkSeed", now)).toThrow(message);
});
