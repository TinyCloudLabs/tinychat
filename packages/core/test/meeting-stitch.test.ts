// TC-1152 S1. Public data only: AMI ES2004a/b manual words (CC BY 4.0), see fixtures/meeting-stitch/build.ts.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  StitchInputError,
  stitchMeetings,
  stitchedSourceId,
  type MeetingSnapshot,
  type StitchResult,
  type StitchedSegment,
} from "../src/meeting-stitch";

const fx = (name: string) => readFileSync(join(import.meta.dir, "fixtures/meeting-stitch", name), "utf8");
const truth = JSON.parse(fx("es2004a-truth.json")) as {
  duration_s: number; offset_s: number; gap_s: [number, number]; hallucination_s: [number, number];
  fireflies_ends_s: number; notetaker_label_to_name: Record<string, string>; ref_words_s: [number, number][];
};
const T = truth.duration_s;
const FF = fx("es2004a-fireflies.json");
const NT = fx("es2004a-notetaker.json");
const FF_B = fx("es2004b-fireflies.json");

const START = Date.parse("2020-03-02T10:00:00Z");
const iso = (offsetS: number) => new Date(START + offsetS * 1000).toISOString();

const fireflies = (body = FF, startS = 0, id = "ff-es2004a"): MeetingSnapshot => ({
  source: "fireflies", source_id: id, body,
  row: { title: "Kick-off", started_at: iso(startS), duration_secs: 0.9 * T, participants: "[]", metadata: "{}" },
});
const notetaker = (source = "tinycloud-transcriber", startS = 0.2 * T): MeetingSnapshot => ({
  source, source_id: "nt-es2004a", body: NT,
  row: { title: "abc-defg-hij (meet.google.com)", started_at: iso(startS), duration_secs: 0.8 * T, metadata: { platform: "google_meet", meeting_url: "https://meet.google.com/abc-defg-hij" } },
});

function deepFreeze<V>(v: V): V {
  if (typeof v === "object" && v !== null) {
    Object.freeze(v);
    for (const k of Object.values(v)) deepFreeze(k);
  }
  return v;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
const body = (r: StitchResult): StitchedSegment[] => r.combined!.body;
const chosen = (s: StitchedSegment) => s.sources.find((x) => x.chosen)!;

/** Reference words (spoken in the true meeting) that fall into an uncovered stretch longer than 2 s. */
function wordsInHoles(segs: StitchedSegment[], from: number, to: number): number {
  const cover = [...segs].sort((a, b) => a.start_time - b.start_time);
  const holes: [number, number][] = [];
  let at = from;
  for (const s of cover) {
    if (s.start_time - at > 2) holes.push([at, s.start_time]);
    at = Math.max(at, s.end_time);
  }
  if (to - at > 2) holes.push([at, to]);
  // 1 s margins: sentence times inside a segment are interpolated
  return truth.ref_words_s.filter(([t]) => holes.some(([a, b]) => t >= a + 1 && t < b - 1)).length;
}

/** Words repeated across a seam between two different sources: runs of 3+ words shared by the 25 words either side. */
function seamDuplicates(segs: StitchedSegment[]): number {
  let dup = 0;
  for (let i = 1; i < segs.length; i++) {
    if (chosen(segs[i]!).source === chosen(segs[i - 1]!).source) continue;
    const prev = words(segs[i - 1]!.text).slice(-25);
    const next = words(segs[i]!.text).slice(0, 25);
    const hit = new Set<number>();
    for (let a = 0; a + 3 <= next.length; a++) {
      for (let b = 0; b + 3 <= prev.length; b++) {
        let k = 0;
        while (a + k < next.length && b + k < prev.length && next[a + k] === prev[b + k]) k++;
        if (k >= 3) for (let j = 0; j < k; j++) hit.add(a + j);
      }
    }
    dup += hit.size;
  }
  return dup;
}

describe("stitchMeetings: 90% Fireflies + 80% Notetaker (AMI ES2004a)", () => {
  const a = deepFreeze(fireflies());
  const b = deepFreeze(notetaker());
  const result = stitchMeetings(a, b);

  test("verdict, relation and offset", () => {
    expect(result.verdict).toBe("same-meeting");
    expect(result.relation).toBe("partial");
    expect(result.reason).toBeNull();
    // members sort by ref: fireflies:... < tinycloud-transcriber:..., so time(fireflies) = time(notetaker) + offset
    expect(Math.abs(result.offset_s! - truth.offset_s)).toBeLessThan(1);
    expect(result.evidence.passed).toBe(true);
    expect(result.evidence.anchors_per_min).toBeGreaterThanOrEqual(1.25);
    expect(result.evidence.matching_phrases).toBeGreaterThan(50);
  });

  test("covers 0-100% with no hole over 2 s and under 2% duplicated words at seams", () => {
    const segs = body(result);
    expect(segs[0]!.start_time).toBeLessThan(2);
    expect(segs[segs.length - 1]!.end_time).toBeGreaterThan(T - 3);
    expect(wordsInHoles(segs, 0, T)).toBe(0);
    const total = segs.reduce((n, s) => n + words(s.text).length, 0);
    expect(seamDuplicates(segs) / total).toBeLessThan(0.02);
    expect(result.seams.length).toBeGreaterThan(0);
  });

  test("every segment is verbatim from one source and carries sources", () => {
    const texts = { fireflies: JSON.parse(FF), "tinycloud-transcriber": JSON.parse(NT) } as Record<string, { index: number; text: string }[]>;
    for (const s of body(result)) {
      expect(s.sources.filter((x) => x.chosen).length).toBe(1);
      const c = chosen(s);
      expect(texts[c.source]![c.index]!.text.includes(s.text)).toBe(true);
      expect(s.speaker_name).not.toBeNull();
    }
    expect(body(result).map((s) => s.index)).toEqual(body(result).map((_, i) => i));
  });

  test("tail speakers carry the Fireflies names", () => {
    const tail = body(result).filter((s) => s.start_time >= truth.fireflies_ends_s + 5);
    expect(tail.length).toBeGreaterThan(5);
    expect(tail.every((s) => chosen(s).source === "tinycloud-transcriber")).toBe(true);
    const right = tail.filter((s) => s.speaker_name === truth.notetaker_label_to_name[chosen(s).speaker_label!]);
    expect(right.length / tail.length).toBeGreaterThanOrEqual(0.9);
    expect(tail.some((s) => /^Speaker \d/.test(s.speaker_name!))).toBe(false);
    // original labels stay in provenance, and the person split over two labels maps to one name
    expect(new Set(tail.map((s) => chosen(s).speaker_label)).size).toBeGreaterThan(3);
    const named = result.speaker_map.filter((e) => e.name === truth.notetaker_label_to_name.speaker_1);
    expect(named.map((e) => e.label).sort()).toEqual(["speaker_1", "speaker_4"]);
  });

  test("byte-identical re-run, either argument order; inputs untouched", () => {
    const again = stitchMeetings(fireflies(), notetaker());
    const swapped = stitchMeetings(notetaker(), fireflies());
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
    expect(JSON.stringify(swapped)).toBe(JSON.stringify(result));
    expect(result.members.map((m) => m.body_sha256)).toEqual([sha(FF), sha(NT)]);
    expect(result.combined!.row.source_id).toBe(stitchedSourceId(["fireflies:ff-es2004a", "tinycloud-transcriber:nt-es2004a"]));
  });
});

describe("stitchMeetings: lower-priority source falls back per 30 s span", () => {
  // A higher-priority Notetaker (Google Meet source) is chosen, but its gap and hallucination are filled from Fireflies.
  const result = stitchMeetings(fireflies(), notetaker("google-meet"));
  const segs = body(result);
  const overlapping = (range: [number, number]) => segs.filter((s) => s.end_time > range[0] && s.start_time < range[1]);

  test("the 20 s gap is filled from Fireflies", () => {
    const filled = overlapping(truth.gap_s);
    expect(filled.length).toBeGreaterThan(1);
    expect(filled.some((s) => chosen(s).source === "fireflies")).toBe(true);
    expect(wordsInHoles(segs, 0, T)).toBe(0);
  });

  test("the 'Thank you.' hallucination is replaced by Fireflies text", () => {
    expect(overlapping(truth.hallucination_s).some((s) => chosen(s).source === "fireflies")).toBe(true);
    expect(segs.some((s) => s.text === "Thank you." && s.start_time >= truth.hallucination_s[0] - 1 && s.end_time <= truth.hallucination_s[1] + 1)).toBe(false);
  });

  test("the unshown text is kept as an alternate with chosen:false provenance", () => {
    const withAlt = segs.filter((s) => s.alternate !== undefined);
    expect(withAlt.length).toBeGreaterThan(10);
    for (const s of withAlt.slice(0, 20)) expect(s.sources.some((x) => !x.chosen)).toBe(true);
  });
});

describe("stitchMeetings: refusals", () => {
  test("ES2004a vs ES2004b (same people, next meeting) is not the same meeting", () => {
    const r = stitchMeetings(fireflies(), fireflies(FF_B, 0, "ff-es2004b"));
    expect(r.verdict).toBe("not-same-meeting");
    expect(r.reason).toBe("anchor-rule");
    expect(r.combined).toBeNull();
    expect(r.evidence.anchors_per_min).toBeLessThan(1.25);
  });

  test("a forced combine lays the two end to end with a marked seam", () => {
    const r = stitchMeetings(fireflies(), fireflies(FF_B, 0, "ff-es2004b"), { force: true });
    expect(r.forced).toBe(true);
    expect(r.relation).toBe("none");
    const segs = body(r);
    expect(segs.filter((s) => s.seam === "forced").length).toBe(1);
    expect(segs.length).toBe(JSON.parse(FF).length + JSON.parse(FF_B).length);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start_time).toBeGreaterThanOrEqual(segs[i - 1]!.start_time);
  });

  test("two bodies more than 15 min apart are refused even though the text matches", () => {
    const r = stitchMeetings(fireflies(), notetaker("tinycloud-transcriber", 0.9 * T + 20 * 60));
    expect(r.verdict).toBe("not-same-meeting");
    expect(r.reason).toBe("no-time-overlap");
    expect(r.evidence.time_window).toBe("no-overlap");
    expect(r.combined).toBeNull();
  });

  test("Gemini notes are refused as a member", () => {
    const gem: MeetingSnapshot = { ...notetaker("google-meet"), row: { started_at: iso(0), metadata: { notes_kind: "gemini", notes_association: "standalone" } } };
    expect(() => stitchMeetings(fireflies(), gem)).toThrow(StitchInputError);
  });
});

describe("stitchMeetings: short clips and bad inputs", () => {
  // Two boilerplate sentences (each one yields several 4-word anchors) shared with a long meeting.
  const long = JSON.parse(FF) as { index: number; speaker_name: string; text: string; start_time: number; end_time: number }[];
  const boiler = long.filter((s) => s.text.split(/\s+/).length >= 8 && s.end_time - s.start_time < 12).slice(40, 42);
  const clip = JSON.stringify([
    { index: 0, speaker_name: "Me", text: boiler[0]!.text, start_time: 1, end_time: 6 },
    { index: 1, speaker_name: "Me", text: boiler[1]!.text, start_time: 8, end_time: 14 },
    { index: 2, speaker_name: "Me", text: "Completely unrelated closing remark about lunch.", start_time: 15, end_time: 19 },
  ]);
  const short = (): MeetingSnapshot => ({
    source: "exo-voice-note", source_id: "vn-clip", body: clip,
    row: { started_at: iso(boiler[0]!.start_time - 1), duration_secs: 19, metadata: {} },
  });

  test("a 19 s clip sharing two sentences with a meeting is not the same meeting", () => {
    const r = stitchMeetings(fireflies(), short());
    expect(r.evidence.shared_phrases).toBeGreaterThanOrEqual(6);
    expect(r.verdict).toBe("not-same-meeting");
    expect(r.reason).toBe("anchor-rule");
    expect(r.evidence.shorter_capture_s).toBeLessThan(120);
    expect(r.combined).toBeNull();
  });

  test("anchors from fewer than 3 segments per side are not enough, whatever the capture length", () => {
    // a 3-minute capture that repeats only two sentences of the meeting
    const padded = JSON.stringify([
      { index: 0, speaker_name: "Me", text: boiler[0]!.text, start_time: 1, end_time: 6 },
      { index: 1, speaker_name: "Me", text: boiler[1]!.text, start_time: 8, end_time: 14 },
      { index: 2, speaker_name: "Me", text: "Completely unrelated closing remark about lunch.", start_time: 170, end_time: 180 },
    ]);
    const r = stitchMeetings(fireflies(), { ...short(), body: padded });
    expect(r.evidence.shorter_capture_s).toBeGreaterThan(120);
    expect(r.verdict).toBe("not-same-meeting");
  });

  test("a clock without a zone is untrusted and the result does not depend on TZ", () => {
    const script = `
      import { readFileSync } from "node:fs";
      import { stitchMeetings } from ${JSON.stringify(join(import.meta.dir, "../src/meeting-stitch"))};
      const d = ${JSON.stringify(join(import.meta.dir, "fixtures/meeting-stitch"))};
      const mk = (source, id, file, started_at) => ({ source, source_id: id, body: readFileSync(d + "/" + file, "utf8"), row: { started_at, duration_secs: 800 } });
      const r = stitchMeetings(mk("fireflies", "a", "es2004a-fireflies.json", "2026-10-19 10:00:00"), mk("tinycloud-transcriber", "b", "es2004a-notetaker.json", "2026-10-19 10:03:30"));
      process.stdout.write(JSON.stringify(r));`;
    const run = (tz: string) => spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz }, encoding: "utf8", maxBuffer: 64 << 20 });
    const utc = run("UTC");
    const la = run("America/Los_Angeles");
    expect(utc.status).toBe(0);
    expect(la.stdout).toBe(utc.stdout);
    const parsed = JSON.parse(utc.stdout) as StitchResult;
    expect(parsed.evidence.time_window).toBe("untrusted");
    expect(parsed.combined!.row.started_at).toBeNull();
  });

  test.each([["empty string", ""], ["array", []], ["boolean", true]])("a segment time that is a %s is rejected, not read as 0 or 1", (_name, bad) => {
    const body = JSON.stringify([{ index: 0, speaker_name: "Me", text: "Hello there everyone.", start_time: bad, end_time: 3 }]);
    expect(() => stitchMeetings(fireflies(), { ...notetaker(), body })).toThrow(StitchInputError);
  });

  test("a numeric string time is accepted", () => {
    const body = JSON.stringify([{ index: 0, speaker_name: "Me", text: "Hello there everyone.", start_time: "1.5", end_time: "3" }]);
    expect(stitchMeetings(fireflies(), { ...notetaker(), body }).verdict).toBe("not-same-meeting");
  });

  test("a trusted clock on the other member still dates the combined meeting", () => {
    const noClock: MeetingSnapshot = { ...fireflies(), row: { title: "Kick-off", duration_secs: 0.9 * T } };
    const r = stitchMeetings(noClock, notetaker());
    expect(r.verdict).toBe("same-meeting");
    // the Notetaker's capture starts offset_s after the Fireflies capture, which is the combined start
    const expected = START + (0.2 * T - r.offset_s!) * 1000;
    expect(Math.abs(Date.parse(r.combined!.row.started_at!) - expected)).toBeLessThan(1500);
  });

  test("a combined meeting cannot be a member", () => {
    const merged: MeetingSnapshot = { ...fireflies(), source: "exo-merged", source_id: "m-1" };
    expect(() => stitchMeetings(merged, notetaker())).toThrow(StitchInputError);
  });
});

describe("stitchMeetings: seams on offset sentence starts (synthetic)", () => {
  // 80 sentences of 8 unique tokens, 5 s apart. A holds the first 300 s as one sentence per segment; B holds
  // 100-400 s as two sentences per segment, with starts 1.3 s off A's and its own clock (skew 7.5 s).
  const words8 = (i: number) => Array.from({ length: 8 }, (_, k) => `s${i}w${k}`);
  const sentence = (i: number) => `${words8(i).join(" ")}.`;
  const A = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ index: i, speaker_name: "Ana", text: sentence(i), start_time: i * 5, end_time: i * 5 + 4.5 })));
  const B = JSON.stringify(Array.from({ length: 30 }, (_, j) => {
    const i = 20 + 2 * j;
    return { index: j, speaker_name: "speaker_0", text: `${sentence(i)} ${sentence(i + 1)}`, start_time: i * 5 + 1.3 - 100 + 7.5, end_time: (i + 1) * 5 + 4.8 - 100 + 7.5 };
  }));
  const mk = (source: string, id: string, body: string, startS: number): MeetingSnapshot => ({ source, source_id: id, body, row: { started_at: iso(startS), duration_secs: 400, metadata: {} } });

  test("no sentence is lost or repeated by more than a couple of words per seam", () => {
    const r = stitchMeetings(mk("fireflies", "syn-a", A, 0), mk("tinycloud-transcriber", "syn-b", B, 100));
    expect(r.verdict).toBe("same-meeting");
    expect(r.seams.length).toBeGreaterThan(0);
    expect(r.seams.every((x) => Math.abs(x.gap_s) <= 2)).toBe(true);
    const seen = new Map<string, number>();
    for (const seg of body(r)) for (const w of words(seg.text)) seen.set(w, (seen.get(w) ?? 0) + 1);
    let missing = 0;
    let repeated = 0;
    for (let i = 0; i < 80; i++) for (const w of words8(i)) {
      const n = seen.get(w) ?? 0;
      if (n === 0) missing++;
      if (n > 1) repeated += n - 1;
    }
    // every sentence is whole or absent, so the loss at a seam is a whole sentence (8 words) at most
    expect(missing).toBeLessThanOrEqual(8 * r.seams.length);
    expect(repeated).toBeLessThanOrEqual(8 * r.seams.length);
    expect(missing + repeated).toBeLessThan(0.02 * 640);
  });
});

describe("stitchMeetings: input shapes", () => {
  test("the KV-only record shape is read like an SQL row", () => {
    const kv: MeetingSnapshot = {
      source: "fireflies", source_id: "ff-es2004a", body: FF,
      kv_record: { title: "Kick-off", startedAt: iso(0), v: 1, source: "fireflies", sourceId: "ff-es2004a" },
    };
    const r = stitchMeetings(kv, notetaker());
    expect(r.verdict).toBe("same-meeting");
    expect(r.combined!.row.source).toBe("exo-merged");
  });

  test("an upload's clock is not trusted", () => {
    const r = stitchMeetings(fireflies(), { ...notetaker("exo-upload", 9 * 24 * 3600) });
    expect(r.verdict).toBe("same-meeting");
    expect(r.evidence.time_window).toBe("untrusted");
  });
});
