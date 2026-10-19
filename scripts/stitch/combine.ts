// TC-1152 S1: combine two captures of one meeting into a file, through the `tc` CLI.
//
//   bun scripts/stitch/combine.ts --a REF --b REF --out FILE [--force] [--profile NAME] [--tc PATH] [--space applications]
//
// REF is `source:source_id`, e.g. `fireflies:01HXYZ` or `tinycloud-transcriber:3f2a...`. The source is
// everything before the first colon. `--force` lays a pair that fails the same-meeting test end to end
// with a marked seam (otherwise a refused pair writes nothing).
//
// READ-ONLY. This slice only reads (`tc sql query`, `tc kv get`) and writes the combined meeting to the
// local file given by --out (mode 0600). `--write` is refused: nothing is written to any space.
//
// Reads, per member: the `connector_meeting` row (or the KV-only `meeting/<id>` record) and the body at
// `connectors/<source>/transcript/<source_id>`. Voice-note bodies are the exception: they are read from
// the immutable `transcript-rev` key named by the `voice_note_transcript` commit row's `body_key`, never
// the legacy mirror (voiceNoteStore.ts).
//
// stdout is one JSON line of verdict and numbers. It never carries titles, names, ids or transcript
// text; tc's own stderr is not forwarded.

import { spawnSync } from "node:child_process";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { CONNECTORS_KV_PREFIX, CONNECTORS_SQL_DB_NAME, transcriptKvKey } from "../../packages/core/src/connector-meeting";
import { StitchInputError, stitchMeetings, type KvMeetingRecord, type MeetingSnapshot, type SqlMeetingRow } from "../../packages/core/src/meeting-stitch";

export class CliError extends Error {}

export interface Tc {
  /** Runs `tc` with these args and returns stdout; throws CliError (no output echoed) on failure. */
  run(args: string[]): string;
}

export function spawnTc(bin: string, profile: string | undefined): Tc {
  return {
    run(args) {
      const full = [...(profile ? ["--profile", profile] : []), ...args];
      const r = spawnSync(bin, full, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      if (r.error || r.status !== 0) throw new CliError(`tc ${args.filter((a) => /^(sql|kv|query|get)$/.test(a)).join(" ")} failed (exit ${r.status ?? "none"})`);
      return r.stdout;
    },
  };
}

export function parseRef(ref: string): { source: string; sourceId: string } {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) throw new CliError("REF must be source:source_id");
  return { source: ref.slice(0, i), sourceId: ref.slice(i + 1) };
}

function query(tc: Tc, space: string, sql: string, params: string[]): unknown[][] {
  const out = tc.run(["--json", "sql", "query", sql, "--space", space, "--db", CONNECTORS_SQL_DB_NAME, "--params", JSON.stringify(params)]);
  const parsed = JSON.parse(out) as { rows?: unknown[][] };
  return Array.isArray(parsed.rows) ? parsed.rows : [];
}

function kvGet(tc: Tc, space: string, key: string): string {
  return tc.run(["kv", "get", "--raw", key, "--space", space]);
}

function bodyKey(tc: Tc, space: string, source: string, sourceId: string): string {
  if (source !== "exo-voice-note") return transcriptKvKey(source, sourceId);
  const rows = query(tc, space, "SELECT body_key, outcome FROM voice_note_transcript WHERE source_id = ? LIMIT 1", [sourceId]);
  const [key, outcome] = rows[0] ?? [];
  // Same checks as agent-skills/tinychat-retrieval: a transcribed commit, and the immutable rev key of THIS note.
  const prefix = `${CONNECTORS_KV_PREFIX}/exo-voice-note/transcript-rev/${sourceId}/`;
  if (outcome !== "transcribed" || typeof key !== "string" || !key.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(key.slice(prefix.length))) {
    throw new CliError("voice note has no committed transcript-rev body");
  }
  return key;
}

export function readSnapshot(tc: Tc, space: string, ref: string): MeetingSnapshot {
  const { source, sourceId } = parseRef(ref);
  const rows = query(
    tc, space,
    "SELECT title, started_at, duration_secs, participants, metadata FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1",
    [source, sourceId],
  );
  const body = kvGet(tc, space, bodyKey(tc, space, source, sourceId));
  const r = rows[0];
  if (r !== undefined) {
    const row: SqlMeetingRow = { title: r[0] as string | null, started_at: r[1] as string | null, duration_secs: r[2] as number | null, participants: r[3], metadata: r[4] };
    return { source, source_id: sourceId, row, body };
  }
  // KV-only catalog: connectors/<source>/meeting/<id>
  let record: KvMeetingRecord;
  try {
    record = JSON.parse(kvGet(tc, space, `${CONNECTORS_KV_PREFIX}/${source}/meeting/${sourceId}`)) as KvMeetingRecord;
  } catch (e) {
    if (e instanceof CliError) throw new CliError("meeting not found in either catalog");
    throw new CliError("KV meeting record is not JSON");
  }
  return { source, source_id: sourceId, kv_record: record, body };
}

function writeOut(path: string, text: string): void {
  const tmp = join(dirname(path), `.stitch-${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function runCombine(argv: string[], deps: { tc?: Tc; env?: Record<string, string | undefined> } = {}): { code: number; stdout: string; stderr: string } {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        a: { type: "string" }, b: { type: "string" }, out: { type: "string" }, force: { type: "boolean" },
        write: { type: "boolean" }, profile: { type: "string" }, tc: { type: "string" }, space: { type: "string" },
      },
      strict: true,
    }).values;
  } catch {
    return { code: 2, stdout: "", stderr: "usage: combine.ts --a REF --b REF --out FILE [--force] [--profile NAME] [--tc PATH] [--space applications]\n" };
  }
  if (args.write) {
    return { code: 2, stdout: "", stderr: "error: --write is not available in this slice: S1 writes only to --out and never to a space\n" };
  }
  if (!args.a || !args.b || !args.out) {
    return { code: 2, stdout: "", stderr: "error: --a, --b and --out are required\n" };
  }
  try {
    const env = deps.env ?? process.env;
    const tc = deps.tc ?? spawnTc(args.tc ?? env.TC_BIN ?? "tc", args.profile);
    const space = args.space ?? "applications";
    const result = stitchMeetings(readSnapshot(tc, space, args.a), readSnapshot(tc, space, args.b), { force: args.force === true });
    const summary = {
      verdict: result.verdict,
      reason: result.reason,
      forced: result.forced,
      relation: result.relation,
      offset_s: result.offset_s,
      matching_phrases: result.evidence.matching_phrases,
      anchors_per_min: result.evidence.anchors_per_min,
      span_s: result.evidence.span_s,
      time_window: result.evidence.time_window,
      segments: result.combined?.body.length ?? 0,
      duration_s: result.combined?.row.duration_secs ?? 0,
      coverage_s: result.members.map((m) => Math.round(m.coverage.reduce((n, [s, e]) => n + (e - s), 0))),
      seams: result.seams.length,
      wrote: false,
    };
    if (result.combined !== null) {
      writeOut(args.out, `${JSON.stringify(result)}\n`);
      summary.wrote = true;
    }
    return { code: result.combined === null ? 3 : 0, stdout: `${JSON.stringify(summary)}\n`, stderr: "" };
  } catch (e) {
    const safe = e instanceof CliError || e instanceof StitchInputError ? e.message : "unexpected error";
    return { code: 1, stdout: "", stderr: `error: ${safe}\n` };
  }
}

if (import.meta.main) {
  const r = runCombine(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
}
