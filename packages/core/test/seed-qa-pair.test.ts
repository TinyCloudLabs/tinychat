// scripts/stitch/seed-qa-pair.ts against a fake `tc`: an in-memory SQLite (the real connector schema) and a Map
// for KV. No profile, no space, no network.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CONNECTOR_SCHEMA, CONNECTORS_KV_PREFIX, transcriptKvKey } from "../src/connector-meeting";
import { stitchMeetings } from "../src/meeting-stitch";
import { CliError, readSnapshot } from "../../../scripts/stitch/combine";
import { QA_ID_PREFIX, buildSeed, runSeed, type Tc } from "../../../scripts/stitch/seed-qa-pair";

function fakeTc(opts: { schema?: boolean } = {}) {
  const db = new Database(":memory:");
  if (opts.schema !== false) for (const { sql } of CONNECTOR_SCHEMA) db.exec(sql);
  const kv = new Map<string, string>();
  const calls: string[][] = [];
  const tc: Tc = {
    run(args) {
      calls.push(args);
      const sub = args.filter((a) => !a.startsWith("--"));
      if (args.includes("context")) return JSON.stringify({ spaceId: "tinycloud:pkh:eip155:1:0xQA:applications", ownerDid: "did:pkh:eip155:1:0xQA", host: "https://node.example" });
      if (args.includes("sql")) {
        const sql = sub[sub.indexOf(args.includes("query") ? "query" : "execute") + 1]!;
        const params = JSON.parse(args[args.indexOf("--params") + 1]!) as never[];
        if (args.includes("query")) return JSON.stringify({ rows: db.query(sql).values(...params) });
        const r = db.query(sql).run(...params);
        return JSON.stringify({ changes: r.changes });
      }
      const key = args.find((a) => a.startsWith(CONNECTORS_KV_PREFIX))!;
      if (args.includes("get")) {
        if (!kv.has(key)) throw new CliError("tc kv get failed (exit 1)");
        return kv.get(key)!;
      }
      if (args.includes("put")) { kv.set(key, args[args.indexOf(key) + 1]!); return "{}"; }
      if (args.includes("delete")) { kv.delete(key); return "{}"; }
      throw new Error(`unexpected tc call ${args.join(" ")}`);
    },
  };
  const writes = () => calls.filter((c) => c.includes("put") || c.includes("delete") || c.includes("execute"));
  const snapshot = () => JSON.stringify([db.query("SELECT * FROM connector_meeting ORDER BY id").values(), [...kv.entries()].sort()]);
  return { tc, db, kv, calls, writes, snapshot };
}

const QA = ["--profile", "qa-throwaway", "--i-know-this-is-a-qa-space"];
const WRITE = [...QA, "--write"];
const DELETE = [...QA, "--delete", "--write"];
const ids = (db: Database) => (db.query("SELECT id FROM connector_meeting ORDER BY id").all() as { id: string }[]).map((r) => r.id);

describe("seed-qa-pair", () => {
  test("default is a dry run: prints the plan and target, writes and reads nothing", () => {
    const f = fakeTc({ schema: false });
    const r = runSeed(["--profile", "qa-throwaway"], { tc: f.tc });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("target space: tinycloud:pkh:eip155:1:0xQA:applications");
    expect(r.stdout).toContain("owner DID:    did:pkh:eip155:1:0xQA");
    for (const id of ["qa-1152-ff", "qa-1152-meet", "qa-1152-decoy"]) expect(r.stdout).toContain(id);
    expect(r.stdout).toMatch(/source=google-meet/);
    expect(r.stdout).toContain("DRY RUN");
    expect(r.stdout).not.toMatch(/Ava Chen|Ben Ortiz|Hmm hmm|lights/);
    expect(f.calls.every((c) => c.includes("context"))).toBe(true);
    expect(f.kv.size).toBe(0);
    // an explicit --dry-run, even with the QA flag, is the same
    expect(runSeed([...QA, "--dry-run"], { tc: fakeTc().tc }).code).toBe(0);
    expect(runSeed([...WRITE, "--dry-run"], { tc: f.tc }).code).toBe(2);
  });

  test("--write without the QA flag prints the target, then refuses with no SQL or KV call", () => {
    const f = fakeTc();
    const r = runSeed(["--profile", "qa-throwaway", "--write"], { tc: f.tc });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("target space:");
    expect(r.stderr).toContain("--i-know-this-is-a-qa-space");
    expect(f.calls.every((c) => c.includes("context"))).toBe(true);
    const d = runSeed(["--profile", "qa-throwaway", "--delete", "--write"], { tc: f.tc });
    expect(d.code).toBe(2);
    expect(f.writes()).toEqual([]);
    expect(f.calls.some((c) => c.includes("sql") || c.includes("kv"))).toBe(false);
  });

  test("profiles that point at real data are refused before any tc call", () => {
    for (const profile of ["meeting-digest", "connector-sync", "Meeting-Digest"]) {
      const f = fakeTc();
      expect(runSeed(["--profile", profile, ...WRITE.slice(2)], { tc: f.tc }).code).toBe(2);
      expect(f.calls).toEqual([]);
    }
    expect(runSeed(WRITE.slice(2), { tc: fakeTc().tc }).code).toBe(2); // no --profile
  });

  test("writes body before row, with the shapes the Library needs", () => {
    const f = fakeTc();
    const r = runSeed(WRITE, { tc: f.tc });
    expect(r.code).toBe(0);
    expect(ids(f.db)).toEqual(["qa-1152-decoy", "qa-1152-ff", "qa-1152-meet"]);
    // per item: the kv put comes before that item's INSERT
    const order = f.calls.flatMap((c) => (c.includes("put") ? [`put:${c.find((a) => a.startsWith(CONNECTORS_KV_PREFIX))}`] : c.includes("execute") && String(c[3]).startsWith("INSERT") ? [`insert:${JSON.parse(c[c.indexOf("--params") + 1]!)[0]}`] : []));
    expect(order).toEqual([
      `put:${transcriptKvKey("fireflies", "qa-1152-ff")}`, "insert:qa-1152-ff",
      `put:${transcriptKvKey("google-meet", "qa-1152-meet")}`, "insert:qa-1152-meet",
      `put:${transcriptKvKey("fireflies", "qa-1152-decoy")}`, "insert:qa-1152-decoy",
    ]);
    const rows = f.db.query("SELECT id, source, source_id, title, started_at, duration_secs, metadata FROM connector_meeting ORDER BY id").all() as Record<string, unknown>[];
    for (const row of rows) {
      expect(row.source_id).toBe(row.id);
      expect(Date.parse(String(row.started_at))).toBeGreaterThan(0);
      expect(row.duration_secs as number).toBeGreaterThan(0);
      expect(Array.isArray(JSON.parse(f.kv.get(transcriptKvKey(String(row.source), String(row.source_id)))!))).toBe(true);
    }
    expect(rows.map((x) => [x.source, x.title])).toEqual([
      ["fireflies", "QA 1152 different meeting (Fireflies)"], ["fireflies", "QA 1152 same meeting (Fireflies)"], ["google-meet", "QA 1152 same meeting (Meet)"],
    ]);
    expect(r.stdout).not.toMatch(/Ava Chen|Ben Ortiz|Hmm hmm|lights/);
  });

  test("every KV body fits one tc argv value, and is passed as a value (not stdin)", () => {
    const f = fakeTc();
    runSeed(WRITE, { tc: f.tc });
    for (const c of f.calls.filter((x) => x.includes("put"))) {
      expect(c.some((a) => a === "--stdin" || a === "--file")).toBe(false);
      expect(Math.max(...c.map((a) => Buffer.byteLength(a)))).toBeLessThan(128 * 1024);
    }
  });

  test("creates the connector tables only when they are missing", () => {
    const f = fakeTc({ schema: false });
    expect(runSeed(WRITE, { tc: f.tc }).code).toBe(0);
    expect(ids(f.db).length).toBe(3);
    const g = fakeTc();
    runSeed(WRITE, { tc: g.tc });
    expect(g.calls.some((c) => c.some((a) => a.startsWith("CREATE TABLE")))).toBe(false);
  });

  test("re-running changes nothing: no KV put, no SQL write, identical state", () => {
    const f = fakeTc();
    runSeed(WRITE, { tc: f.tc });
    const before = f.snapshot();
    const writesBefore = f.writes().length;
    const r = runSeed(WRITE, { tc: f.tc });
    expect(r.code).toBe(0);
    expect(f.writes().length).toBe(writesBefore);
    expect(f.snapshot()).toBe(before);
    expect(r.stdout).toContain("body unchanged, row unchanged");
  });

  test("a row that drifted is updated, a missing body is repaired, created_at survives", () => {
    const f = fakeTc();
    runSeed(WRITE, { tc: f.tc });
    const created = f.db.query("SELECT created_at FROM connector_meeting WHERE id = 'qa-1152-ff'").get();
    f.db.query("UPDATE connector_meeting SET duration_secs = 5 WHERE id = 'qa-1152-ff'").run();
    f.kv.delete(transcriptKvKey("google-meet", "qa-1152-meet"));
    expect(runSeed(WRITE, { tc: f.tc }).code).toBe(0);
    expect(f.db.query("SELECT duration_secs FROM connector_meeting WHERE id = 'qa-1152-ff'").get()).toEqual({ duration_secs: buildSeed()[0]!.durationSecs });
    expect(f.db.query("SELECT created_at FROM connector_meeting WHERE id = 'qa-1152-ff'").get()).toEqual(created as never);
    expect(f.kv.has(transcriptKvKey("google-meet", "qa-1152-meet"))).toBe(true);
    expect(ids(f.db).length).toBe(3);
  });

  test("--delete is a dry run without --write", () => {
    const f = fakeTc();
    runSeed(WRITE, { tc: f.tc });
    const before = f.snapshot();
    const r = runSeed([...QA, "--delete"], { tc: f.tc });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY RUN (delete)");
    expect(f.snapshot()).toBe(before);
  });

  test("--delete removes exactly the qa-1152- rows and bodies, never a non-prefixed row", () => {
    const f = fakeTc();
    runSeed(WRITE, { tc: f.tc });
    // real-looking neighbours, including same sources and an id that merely contains the prefix
    for (const [id, source, sid] of [["keep-1", "fireflies", "ff-real"], ["keep-2", "google-meet", "conf-real"], ["x-qa-1152-ff", "fireflies", "x-qa-1152-ff"]] as const) {
      f.db.query("INSERT INTO connector_meeting (id, source, source_id, created_at, updated_at) VALUES (?, ?, ?, 'c', 'u')").run(id, source, sid);
      f.kv.set(transcriptKvKey(source, sid), "[]");
    }
    f.kv.set(transcriptKvKey("fireflies", "ff-real"), "[]");
    const r = runSeed(DELETE, { tc: f.tc });
    expect(r.code).toBe(0);
    expect(ids(f.db)).toEqual(["keep-1", "keep-2", "x-qa-1152-ff"]);
    expect([...f.kv.keys()].sort()).toEqual([
      transcriptKvKey("fireflies", "ff-real"), transcriptKvKey("fireflies", "x-qa-1152-ff"), transcriptKvKey("google-meet", "conf-real"),
    ].sort());
    // every DELETE the tool issued names an exact id, source and source_id; every kv delete is a qa key
    for (const c of f.calls.filter((x) => x.includes("execute"))) {
      if (!String(c[3]).startsWith("DELETE")) continue;
      const p = JSON.parse(c[c.indexOf("--params") + 1]!) as string[];
      expect(p[0]!.startsWith(QA_ID_PREFIX) && p[2]!.startsWith(QA_ID_PREFIX)).toBe(true);
      expect(["fireflies", "google-meet"]).toContain(p[1]!);
    }
    for (const c of f.calls.filter((x) => x.includes("delete"))) expect(c.find((a) => a.startsWith(CONNECTORS_KV_PREFIX))).toMatch(/\/transcript\/qa-1152-/);
    // idempotent
    expect(runSeed(DELETE, { tc: f.tc }).code).toBe(0);
    expect(ids(f.db).length).toBe(3);
  });

  test("--delete refuses, and deletes nothing, when any other row matches the prefix", () => {
    for (const [id, source, sid] of [
      ["qa-1152-other", "exo-voice-note", "qa-1152-other"], // prefix, wrong source
      ["qa-1152-ff2", "fireflies", "real-source-id"], // id prefix only
      ["real-id", "fireflies", "qa-1152-sid"], // source_id prefix only
      ["QA-1152-upper", "fireflies", "QA-1152-upper"], // LIKE is case-insensitive; the tool is not
    ] as const) {
      const f = fakeTc();
      runSeed(WRITE, { tc: f.tc });
      f.db.query("INSERT INTO connector_meeting (id, source, source_id, created_at, updated_at) VALUES (?, ?, ?, 'c', 'u')").run(id, source, sid);
      const before = f.snapshot();
      const writesBefore = f.writes().length;
      const r = runSeed(DELETE, { tc: f.tc });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("refusing");
      expect(f.writes().length).toBe(writesBefore);
      expect(f.snapshot()).toBe(before);
    }
  });

  test("the pair read back through the fake passes the real stitcher; the decoy is refused", () => {
    const f = fakeTc();
    runSeed(WRITE, { tc: f.tc });
    const snap = (source: string, id: string) => readSnapshot(f.tc, "applications", `${source}:${id}`);
    const same = stitchMeetings(snap("fireflies", "qa-1152-ff"), snap("google-meet", "qa-1152-meet"));
    expect(same.verdict).toBe("same-meeting");
    expect(same.combined).not.toBeNull();
    for (const [a, b] of [
      [snap("fireflies", "qa-1152-decoy"), snap("google-meet", "qa-1152-meet")],
      [snap("fireflies", "qa-1152-ff"), snap("fireflies", "qa-1152-decoy")],
    ] as const) {
      const wrong = stitchMeetings(a, b);
      expect(wrong.verdict).toBe("not-same-meeting");
      expect(wrong.combined).toBeNull();
    }
  });

  test("the decoy overlaps the pair in time, so the Library offers it as a candidate", () => {
    const [ff, meet, decoy] = buildSeed();
    const win = (x: { startedAt: string; durationSecs: number }) => [Date.parse(x.startedAt), Date.parse(x.startedAt) + x.durationSecs * 1000] as const;
    for (const other of [ff!, meet!]) {
      const [a0, a1] = win(decoy!);
      const [b0, b1] = win(other);
      expect(a0 < b1 && b0 < a1).toBe(true);
    }
  });
});
