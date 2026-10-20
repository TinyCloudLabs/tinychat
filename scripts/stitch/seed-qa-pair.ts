// TC-1152 QA seeder: writes ONE synthetic pair of overlapping meeting captures (plus one decoy from a
// different meeting) into a QA-owned throwaway TinyCloud space, so QA can run the Combine UI on it.
//
//   bun scripts/stitch/seed-qa-pair.ts --profile QA_PROFILE [--space applications] [--tc PATH] [--start ISO]
//        (no more flags)                                  dry run: prints the plan, writes nothing
//        --write --i-know-this-is-a-qa-space              writes the three captures
//        --delete                                         dry run of the clean-up
//        --delete --write --i-know-this-is-a-qa-space     removes exactly the `qa-1152-` rows and bodies
//
// WHAT IT WRITES (all text is the public AMI Meeting Corpus ES2004a/ES2004b words, CC BY 4.0; the speaker
// names are invented; see packages/core/test/fixtures/meeting-stitch/build.ts):
//   qa-1152-ff     source `fireflies`    ES2004a as Fireflies heard it   "QA 1152 same meeting (Fireflies)"
//   qa-1152-meet   source `google-meet`  ES2004a as a notetaker heard it "QA 1152 same meeting (Meet)"
//                  (the Meet capture starts ~3.5 min into the meeting, as the fixture's notetaker does)
//   qa-1152-decoy  source `fireflies`    ES2004b, a different meeting in the same window
//                                        "QA 1152 different meeting (Fireflies)"
// Each is a `connector_meeting` row in `xyz.tinycloud.tinychat/connectors` plus the body at
// `xyz.tinycloud.tinychat/connectors/<source>/transcript/<source_id>`: the same two places, and the same
// row and body shapes, the Fireflies and Google Meet connectors write (connectorStore.ts, gmeetNormalize.ts).
// Row id = source_id = `qa-1152-...`; started_at and duration_secs are both set, which is what the Library
// needs to offer a meeting for Combine (combine/candidates.ts).
//
// SAFETY
//   * Writing or deleting needs `--write` AND `--i-know-this-is-a-qa-space`; the target space id and owner DID
//     (from `tc context`, local metadata, no network access check) are printed first. Without both nothing is
//     written and no SQL or KV call is made.
//   * The profiles that point at real data (`meeting-digest`, `connector-sync`) are refused by name.
//   * `--delete` first lists every row whose id OR source_id starts with `qa-1152-`; if any of them has another
//     source, or an id/source_id without the prefix, it refuses and deletes nothing. The DELETE statements then
//     match id AND source AND source_id exactly.
//   * stdout carries ids, sources, times and counts, never transcript text.
//
// ORDER: body first, then the row (the Google Meet connector's order: a body without a row is invisible, a
// row without a body is a broken Library entry). Re-running changes nothing: a body whose stored bytes are
// identical is not rewritten, and a row is only inserted when absent or updated when a column differs.
// Delete is the reverse: row first, then body.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { CONNECTOR_SCHEMA, CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "../../packages/core/src/connector-meeting";
import { CliError } from "./combine";

export const QA_ID_PREFIX = "qa-1152-";
/** The only sources this tool writes or deletes. */
export const QA_SOURCES = ["fireflies", "google-meet"] as const;
/** Profiles that point at real users' spaces: never usable here. */
const REFUSED_PROFILES = ["meeting-digest", "connector-sync"];
const DEFAULT_START = "2026-10-20T08:00:00.000Z";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../packages/core/test/fixtures/meeting-stitch");

export interface Tc {
  /** Runs `tc` with these args and returns stdout; throws CliError (no output echoed) on failure. */
  run(args: string[]): string;
}

export function spawnTc(bin: string, profile: string): Tc {
  return {
    run(args) {
      const r = spawnSync(bin, ["--profile", profile, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      if (r.error || r.status !== 0) throw new CliError(`tc ${args.filter((a) => /^(sql|kv|query|execute|get|put|delete|context)$/.test(a)).join(" ")} failed (exit ${r.status ?? "none"})`);
      return r.stdout;
    },
  };
}

export interface SeedItem {
  id: string;
  source: (typeof QA_SOURCES)[number];
  title: string;
  startedAt: string;
  durationSecs: number;
  participants: { name: string; email: string | null }[];
  metadata: Record<string, unknown>;
  body: string;
  segments: number;
}

interface Sentence { speaker_name: string | null; end_time: number }

/**
 * `tc kv put KEY VALUE` JSON-parses VALUE and stores it as JSON (application/json), like the app's own string put;
 * `--stdin`/`--file` would store octet-stream bytes, which the Library's reader may not accept [inference from the
 * SDK's serializeValue]. One argv value is capped at 128 KiB, so a longer fixture is cut to its first sentences
 * that fit; the sentences keep the fixture's times, and the row's length follows the last one kept.
 */
const MAX_BODY_BYTES = 100_000;

function loadBody(file: string): { body: string; sentences: Sentence[] } {
  const all = JSON.parse(readFileSync(join(FIXTURES, file), "utf8")) as Sentence[];
  if (!Array.isArray(all) || all.length === 0) throw new CliError("fixture is not a non-empty sentence array");
  let sentences = all;
  while (Buffer.byteLength(JSON.stringify(sentences)) > MAX_BODY_BYTES) sentences = sentences.slice(0, Math.floor(sentences.length * 0.95));
  return { body: JSON.stringify(sentences), sentences };
}

function namedSpeakers(sentences: Sentence[]): { name: string; email: string | null }[] {
  const names = new Set<string>();
  for (const s of sentences) if (s.speaker_name) names.add(s.speaker_name);
  return [...names].map((name) => ({ name, email: null }));
}

/** The three captures. Windows mirror the S1 tests: Fireflies from 0 to 0.9T, the notetaker from 0.2T for 0.8T. */
export function buildSeed(startIso: string = DEFAULT_START): SeedItem[] {
  const t0 = Date.parse(startIso);
  if (!Number.isFinite(t0)) throw new CliError("--start must be an ISO-8601 time");
  const truth = JSON.parse(readFileSync(join(FIXTURES, "es2004a-truth.json"), "utf8")) as { duration_s: number };
  const T = truth.duration_s;
  const iso = (s: number) => new Date(t0 + s * 1000).toISOString();
  const ff = loadBody("es2004a-fireflies.json");
  const meet = loadBody("es2004a-notetaker.json");
  const decoy = loadBody("es2004b-fireflies.json");
  const qa = { qa_seed: "tc-1152" };
  return [
    {
      id: `${QA_ID_PREFIX}ff`, source: "fireflies", title: "QA 1152 same meeting (Fireflies)",
      startedAt: iso(0), durationSecs: Math.round(0.9 * T), participants: namedSpeakers(ff.sentences),
      metadata: { ...qa }, body: ff.body, segments: ff.sentences.length,
    },
    {
      id: `${QA_ID_PREFIX}meet`, source: "google-meet", title: "QA 1152 same meeting (Meet)",
      startedAt: iso(0.2 * T), durationSecs: Math.round(0.8 * T), participants: [],
      metadata: {
        ...qa, conference_record: `conferenceRecords/${QA_ID_PREFIX}meet`, participant_count: 4, entry_count: meet.sentences.length,
        transcript_count: 1, speaker_join_misses: 0, timestamp_anchor: "record",
        datetime_source: "meet_conference_start", datetime_exact: true, datetime_resolution_version: 1,
      },
      body: meet.body, segments: meet.sentences.length,
    },
    {
      id: `${QA_ID_PREFIX}decoy`, source: "fireflies", title: "QA 1152 different meeting (Fireflies)",
      startedAt: iso(0), durationSecs: Math.round(decoy.sentences[decoy.sentences.length - 1]!.end_time), participants: namedSpeakers(decoy.sentences),
      metadata: { ...qa }, body: decoy.body, segments: decoy.sentences.length,
    },
  ];
}

function sqlQuery(tc: Tc, space: string, sql: string, params: unknown[]): unknown[][] {
  const out = tc.run(["--json", "sql", "query", sql, "--space", space, "--db", CONNECTORS_SQL_DB_NAME, "--params", JSON.stringify(params)]);
  const parsed = JSON.parse(out) as { rows?: unknown[][] };
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function sqlExec(tc: Tc, space: string, sql: string, params: unknown[] = []): void {
  tc.run(["--json", "sql", "execute", sql, "--space", space, "--db", CONNECTORS_SQL_DB_NAME, "--params", JSON.stringify(params)]);
}

/** The stored bytes, or null when the key cannot be read (absent; `tc` does not tell the two apart). */
function kvRead(tc: Tc, space: string, key: string): string | null {
  try {
    return tc.run(["kv", "get", "--raw", key, "--space", space]);
  } catch {
    return null;
  }
}

/** Mirrors ensureConnectorSchema: probe read-only, create only the tables that are missing. */
function ensureSchema(tc: Tc, space: string, log: string[]): void {
  const tables = CONNECTOR_SCHEMA.map(({ table }) => table);
  const existing = new Set(sqlQuery(tc, space, `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map(() => "?").join(", ")})`, tables).map((r) => r[0]));
  for (const { sql, table } of CONNECTOR_SCHEMA) {
    if (existing.has(table)) continue;
    sqlExec(tc, space, sql);
    log.push(`created table ${table}`);
  }
}

const LOOKUP = "SELECT id, title, started_at, duration_secs, participants, metadata FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1";

function writeItem(tc: Tc, space: string, item: SeedItem): { body: string; row: string } {
  const key = transcriptKvKey(item.source, item.id);
  let body = "unchanged";
  if (kvRead(tc, space, key) !== item.body) {
    tc.run(["kv", "put", key, item.body, "--space", space]);
    if (kvRead(tc, space, key) !== item.body) throw new CliError("body read back differs from what was written");
    body = "written";
  }
  const participants = JSON.stringify(item.participants);
  const metadata = JSON.stringify(item.metadata);
  const found = sqlQuery(tc, space, LOOKUP, [item.source, item.id])[0];
  if (found === undefined) {
    const now = new Date().toISOString();
    sqlExec(tc, space,
      `INSERT INTO connector_meeting
        (id, source, source_id, title, started_at, duration_secs, organizer_email,
         participants, summary_overview, summary_action_items, keywords, meeting_type,
         metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [item.id, item.source, item.id, item.title, item.startedAt, item.durationSecs, null, participants, null, null, null, null, metadata, now, now]);
    return { body, row: "inserted" };
  }
  if (found[0] !== item.id) throw new CliError("a row for this source_id exists under a different id");
  const same = found[1] === item.title && found[2] === item.startedAt && found[3] === item.durationSecs && found[4] === participants && found[5] === metadata;
  if (same) return { body, row: "unchanged" };
  sqlExec(tc, space,
    "UPDATE connector_meeting SET title = ?, started_at = ?, duration_secs = ?, participants = ?, metadata = ?, updated_at = ? WHERE id = ? AND source = ? AND source_id = ?",
    [item.title, item.startedAt, item.durationSecs, participants, metadata, new Date().toISOString(), item.id, item.source, item.id]);
  return { body, row: "updated" };
}

function inQaScope(id: unknown, source: unknown, sourceId: unknown): id is string {
  return typeof id === "string" && id.startsWith(QA_ID_PREFIX)
    && typeof sourceId === "string" && sourceId.startsWith(QA_ID_PREFIX)
    && typeof source === "string" && (QA_SOURCES as readonly string[]).includes(source);
}

/** Every row the prefix touches, or throws when one of them is not unmistakably ours. Deletes nothing. */
function matchingRows(tc: Tc, space: string): { id: string; source: string; sourceId: string }[] {
  const rows = sqlQuery(tc, space, "SELECT id, source, source_id FROM connector_meeting WHERE id LIKE ? OR source_id LIKE ?", [`${QA_ID_PREFIX}%`, `${QA_ID_PREFIX}%`]);
  const out: { id: string; source: string; sourceId: string }[] = [];
  for (const [id, source, sourceId] of rows) {
    if (!inQaScope(id, source, sourceId)) throw new CliError(`refusing: ${rows.length} row(s) match the qa-1152- prefix and at least one is outside the QA scope (id, source_id or source); nothing deleted`);
    out.push({ id, source: source as string, sourceId: sourceId as string });
  }
  return out;
}

export interface Result { code: number; stdout: string; stderr: string }

function context(tc: Tc, space: string): { spaceId: string; ownerDid: string; host: string } {
  const raw = JSON.parse(tc.run(["--json", "context", "--space", space])) as { spaceId?: unknown; ownerDid?: unknown; host?: unknown };
  if (typeof raw.spaceId !== "string" || raw.spaceId.length === 0) throw new CliError("the profile resolves no space");
  return { spaceId: raw.spaceId, ownerDid: typeof raw.ownerDid === "string" ? raw.ownerDid : "unknown", host: typeof raw.host === "string" ? raw.host : "unknown" };
}

const USAGE = "usage: seed-qa-pair.ts --profile NAME [--write] [--delete] [--i-know-this-is-a-qa-space] [--dry-run] [--space applications] [--tc PATH] [--start ISO]\n";

export function runSeed(argv: string[], deps: { tc?: Tc; env?: Record<string, string | undefined> } = {}): Result {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        profile: { type: "string" }, write: { type: "boolean" }, delete: { type: "boolean" }, "dry-run": { type: "boolean" },
        "i-know-this-is-a-qa-space": { type: "boolean" }, space: { type: "string" }, tc: { type: "string" }, start: { type: "string" },
      },
      strict: true,
    }).values;
  } catch {
    return { code: 2, stdout: "", stderr: USAGE };
  }
  if (!a.profile) return { code: 2, stdout: "", stderr: `error: --profile is required\n${USAGE}` };
  if (a.write && a["dry-run"]) return { code: 2, stdout: "", stderr: "error: --write and --dry-run contradict each other\n" };
  if (REFUSED_PROFILES.includes(a.profile.toLowerCase())) return { code: 2, stdout: "", stderr: "error: that profile points at real data; use the QA account's own profile\n" };

  const space = a.space ?? "applications";
  const mode = a.delete ? "delete" : "write";
  const live = a.write === true;
  let out = "";
  const say = (line: string) => { out += `${line}\n`; };
  try {
    const env = deps.env ?? process.env;
    const tc = deps.tc ?? spawnTc(a.tc ?? env.TC_BIN ?? "tc", a.profile);
    const items = buildSeed(a.start);

    const target = context(tc, space);
    say(`target space: ${target.spaceId}`);
    say(`owner DID:    ${target.ownerDid}`);
    say(`host:         ${target.host}`);
    say(`db:           ${CONNECTORS_SQL_DB_NAME}`);

    if (live && a["i-know-this-is-a-qa-space"] !== true) {
      return { code: 2, stdout: out, stderr: "error: refusing to touch the space without --i-know-this-is-a-qa-space (confirm the space above is the QA account's); nothing written\n" };
    }

    if (mode === "write") {
      say(live ? "WRITE (body first, then row)" : "DRY RUN: nothing is written; add --write --i-know-this-is-a-qa-space to write");
      for (const it of items) {
        say(`  ${it.id}  source=${it.source}  started_at=${it.startedAt}  ends=${new Date(Date.parse(it.startedAt) + it.durationSecs * 1000).toISOString()}  duration_secs=${it.durationSecs}  segments=${it.segments}  body_bytes=${Buffer.byteLength(it.body)}`);
        say(`    kv ${transcriptKvKey(it.source, it.id)}`);
      }
      if (!live) return { code: 0, stdout: out, stderr: "" };
      const log: string[] = [];
      ensureSchema(tc, space, log);
      for (const line of log) say(`  ${line}`);
      for (const it of items) {
        const r = writeItem(tc, space, it);
        say(`  wrote ${it.id}: body ${r.body}, row ${r.row}`);
      }
      return { code: 0, stdout: out, stderr: "" };
    }

    // delete
    if (!live) {
      say("DRY RUN (delete): nothing is removed; add --write --i-know-this-is-a-qa-space to delete");
      say(`  would remove rows whose id and source_id start with ${QA_ID_PREFIX} and whose source is ${QA_SOURCES.join(" or ")}, and their bodies:`);
      for (const it of items) say(`  ${it.id}  source=${it.source}  kv ${transcriptKvKey(it.source, it.id)}`);
      say("  it refuses, and removes nothing, if any other row matches the prefix");
      return { code: 0, stdout: out, stderr: "" };
    }
    const rows = matchingRows(tc, space);
    say(`DELETE: ${rows.length} matching row(s)`);
    for (const r of rows) {
      sqlExec(tc, space, "DELETE FROM connector_meeting WHERE id = ? AND source = ? AND source_id = ?", [r.id, r.source, r.sourceId]);
      say(`  removed row ${r.id} (source=${r.source})`);
    }
    // Bodies of the removed rows, plus the three known bodies in case an earlier run died between body and row.
    const bodies = new Map<string, { id: string; source: string }>();
    for (const r of rows) bodies.set(transcriptKvKey(r.source, r.sourceId), { id: r.id, source: r.source });
    for (const it of items) bodies.set(transcriptKvKey(it.source, it.id), { id: it.id, source: it.source });
    for (const [key, { id, source }] of bodies) {
      if (kvRead(tc, space, key) === null) { say(`  body ${id} (source=${source}): absent`); continue; }
      tc.run(["kv", "delete", key, "--space", space]);
      say(`  removed body ${id} (source=${source})`);
    }
    return { code: 0, stdout: out, stderr: "" };
  } catch (e) {
    const safe = e instanceof CliError ? e.message : "unexpected error";
    return { code: 1, stdout: out, stderr: `error: ${safe}\n` };
  }
}

if (import.meta.main) {
  const r = runSeed(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
}
