// scripts/stitch/combine.ts end to end on the public AMI fixture, with a fake `tc` (no profile, no space).
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCombine, parseRef, type Tc } from "../../../scripts/stitch/combine";

const fx = (n: string) => readFileSync(join(import.meta.dir, "fixtures/meeting-stitch", n), "utf8");
const FF = fx("es2004a-fireflies.json");
const NT = fx("es2004a-notetaker.json");
const T = (JSON.parse(fx("es2004a-truth.json")) as { duration_s: number }).duration_s;
const START = Date.parse("2020-03-02T10:00:00Z");
const iso = (s: number) => new Date(START + s * 1000).toISOString();
const PREFIX = "xyz.tinycloud.tinychat/connectors";

/** A fake `tc`: serves two SQL rows and bodies, and records every call. */
function fakeTc(opts: { voiceKeyTail?: string; voiceOutcome?: string } = {}) {
  const voiceKeyTail = opts.voiceKeyTail ?? "vn-1/0123456789abcdef0123456789abcdef";
  const voiceOutcome = opts.voiceOutcome ?? "transcribed";
  const calls: string[][] = [];
  const kv: Record<string, string> = {
    [`${PREFIX}/fireflies/transcript/ff-1`]: FF,
    [`${PREFIX}/tinycloud-transcriber/transcript/nt-1`]: NT,
    [`${PREFIX}/exo-voice-note/transcript/vn-1`]: "[]", // the legacy mirror must never be read
    [`${PREFIX}/exo-voice-note/transcript-rev/vn-1/0123456789abcdef0123456789abcdef`]: NT,
  };
  const tc: Tc = {
    run(args) {
      calls.push(args);
      if (args.includes("sql")) {
        const sql = args[args.indexOf("query") + 1]!;
        const [, id] = JSON.parse(args[args.indexOf("--params") + 1]!) as string[] & [string, string];
        if (sql.includes("voice_note_transcript")) return JSON.stringify({ rows: [[`${PREFIX}/exo-voice-note/transcript-rev/${voiceKeyTail}`, voiceOutcome]] });
        if (id === "ff-1") return JSON.stringify({ rows: [["Kick-off", iso(0), 0.9 * T, "[]", "{}"]] });
        if (id === "nt-1" || id === "vn-1") return JSON.stringify({ rows: [[null, iso(0.2 * T), 0.8 * T, null, JSON.stringify({ platform: "google_meet" })]] });
        return JSON.stringify({ rows: [] });
      }
      const key = args[args.indexOf("get") + 2]!;
      if (kv[key] === undefined) throw new Error("missing");
      return kv[key]!;
    },
  };
  return { tc, calls };
}

const dir = mkdtempSync(join(tmpdir(), "stitch-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("combine.ts", () => {
  test("writes the combined meeting to --out (0600) and prints numbers only", () => {
    const { tc, calls } = fakeTc();
    const out = join(dir, "combined.json");
    const r = runCombine(["--a", "fireflies:ff-1", "--b", "tinycloud-transcriber:nt-1", "--out", out], { tc });
    expect(r.code).toBe(0);
    const summary = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(summary.verdict).toBe("same-meeting");
    expect(summary.relation).toBe("partial");
    expect(Object.keys(summary).sort()).toEqual(["anchors_per_min", "coverage_s", "duration_s", "forced", "matching_phrases", "offset_s", "reason", "relation", "seams", "segments", "span_s", "time_window", "verdict", "wrote"]);
    expect(r.stdout).not.toMatch(/Kick-off|Ava Chen|Ben Ortiz/);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(out, "utf8")) as { combined: { row: { source: string }; body: unknown[] } };
    expect(written.combined.row.source).toBe("exo-merged");
    expect(written.combined.body.length).toBe(summary.segments as number);
    // read-only: only sql query and kv get
    expect(calls.every((c) => c.includes("query") || c.includes("get"))).toBe(true);
    expect(calls.some((c) => c.includes("execute") || c.includes("put") || c.includes("delete"))).toBe(false);
    // byte-identical re-run
    const out2 = join(dir, "again.json");
    runCombine(["--a", "tinycloud-transcriber:nt-1", "--b", "fireflies:ff-1", "--out", out2], { tc });
    expect(createHash("sha256").update(readFileSync(out2)).digest("hex")).toBe(createHash("sha256").update(readFileSync(out)).digest("hex"));
  });

  test("--write is refused and nothing is read or written", () => {
    const { tc, calls } = fakeTc();
    const r = runCombine(["--a", "fireflies:ff-1", "--b", "tinycloud-transcriber:nt-1", "--out", join(dir, "w.json"), "--write"], { tc });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--write is not available");
    expect(calls.length).toBe(0);
    expect(existsSync(join(dir, "w.json"))).toBe(false);
  });

  test("a voice note body comes from transcript-rev, never the legacy mirror", () => {
    const { tc, calls } = fakeTc();
    const r = runCombine(["--a", "fireflies:ff-1", "--b", "exo-voice-note:vn-1", "--out", join(dir, "vn.json")], { tc });
    expect(r.code).toBe(0);
    const keys = calls.filter((c) => c.includes("kv")).map((c) => c[c.indexOf("get") + 2]);
    expect(keys).toContain(`${PREFIX}/exo-voice-note/transcript-rev/vn-1/0123456789abcdef0123456789abcdef`);
    expect(keys).not.toContain(`${PREFIX}/exo-voice-note/transcript/vn-1`);
  });

  test("a voice note commit that is not transcribed, or points at another note's key, is refused", () => {
    for (const opts of [{ voiceOutcome: "no_speech" }, { voiceKeyTail: "vn-2/0123456789abcdef0123456789abcdef" }, { voiceKeyTail: "vn-1/abc" }]) {
      const { tc } = fakeTc(opts);
      const r = runCombine(["--a", "fireflies:ff-1", "--b", "exo-voice-note:vn-1", "--out", join(dir, "bad.json")], { tc });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no committed transcript-rev body");
    }
  });

  test("a refused pair writes nothing, errors never carry content", () => {
    const { tc } = fakeTc();
    const out = join(dir, "none.json");
    const r = runCombine(["--a", "fireflies:ff-1", "--b", "fireflies:missing", "--out", out], { tc });
    expect(r.code).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(parseRef("fireflies:a:b")).toEqual({ source: "fireflies", sourceId: "a:b" });
  });
});
