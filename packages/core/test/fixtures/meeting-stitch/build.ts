// Builds the public-data fixtures for meeting-stitch.test.ts from the AMI Meeting Corpus manual
// words (ES2004a, ES2004b; CC BY 4.0, https://groups.inf.ed.ac.uk/ami/corpus/). Run once:
//   bun packages/core/test/fixtures/meeting-stitch/build.ts <dir with ES2004*.words.xml>
// Output is committed; the PRNG is seeded so a re-run reproduces it byte for byte.
// No user data is involved. The speaker names below are invented.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
if (!dir) throw new Error("usage: build.ts <AMI words dir>");

interface W { t0: number; t1: number; text: string; punc: boolean; agent: string }

function words(meeting: string): W[] {
  const all: W[] = [];
  for (const agent of ["A", "B", "C", "D"]) {
    let xml: string;
    try { xml = readFileSync(join(dir, `${meeting}.${agent}.words.xml`), "latin1"); } catch { continue; }
    for (const m of xml.matchAll(/<w\s([^>]*)>([^<]*)<\/w>/g)) {
      const attrs = m[1]!;
      const s = /starttime="([\d.]+)"/.exec(attrs);
      const e = /endtime="([\d.]+)"/.exec(attrs);
      const text = m[2]!.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).trim();
      if (!s || !e || !text) continue;
      all.push({ t0: Number(s[1]), t1: Number(e[1]), text, punc: /punc="true"/.test(attrs), agent });
    }
  }
  return all.sort((x, y) => x.t0 - y.t0 || (x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0));
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES: Record<string, string> = { A: "Ava Chen", B: "Ben Ortiz", C: "Cleo Park", D: "Dev Rao" };
const r2 = (x: number) => Math.round(x * 100) / 100;

interface Seg { agent: string; text: string; t0: number; t1: number }

/** Cut words into segments at speaker change, gaps, sentence ends (optional) and a length cap. */
function segment(ws: W[], opts: { gap: number; cap: number; atSentence: boolean }): Seg[] {
  const segs: Seg[] = [];
  let cur: W[] = [];
  const flush = () => {
    const spoken = cur.filter((w) => !w.punc);
    if (spoken.length > 0) {
      segs.push({
        agent: cur[0]!.agent,
        text: cur.map((w, i) => (w.punc && /^[.,?!;:]+$/.test(w.text) ? w.text : (i ? " " : "") + w.text)).join(""),
        t0: spoken[0]!.t0,
        t1: spoken[spoken.length - 1]!.t1,
      });
    }
    cur = [];
  };
  for (const w of ws) {
    const last = cur[cur.length - 1];
    if (last && (w.agent !== last.agent || (!w.punc && w.t0 - last.t1 > opts.gap) || (!w.punc && w.t1 - cur[0]!.t0 > opts.cap))) flush();
    cur.push(w);
    if (opts.atSentence && w.punc && /^[.?!]$/.test(w.text)) flush();
  }
  flush();
  return segs;
}

const body = (segs: { name: string; text: string; t0: number; t1: number }[]) =>
  segs.map((s, index) => ({ index, speaker_name: s.name, text: s.text, start_time: r2(s.t0), end_time: r2(s.t1) }));

// ── ES2004a ──
const refA = words("ES2004a");
const T = Math.max(...refA.map((w) => w.t1));
const S0 = 0.2 * T;
const SKEW = 47.3;

const aSegs = segment(refA.filter((w) => w.t1 <= 0.9 * T), { gap: 1, cap: 15, atSentence: true });
writeFileSync(join(out, "es2004a-fireflies.json"), JSON.stringify(body(aSegs.map((s) => ({ name: NAMES[s.agent]!, text: s.text, t0: s.t0, t1: s.t1 })))));

const rand = rng(1152);
const vocab = [...new Set(refA.filter((w) => !w.punc).map((w) => w.text.toLowerCase()))].sort();
// The Notetaker's first word opens the overlap; the stitcher judges it in 30 s spans from there.
// The gap and the hallucination sit inside one span each, as a batch recogniser's dropouts do.
const GRID0 = refA.find((w) => !w.punc && w.t0 >= S0)!.t0;
const spanAt = (frac: number) => GRID0 + 30 * Math.round((frac * T - GRID0) / 30);
const GAP: [number, number] = [spanAt(0.5) + 2, spanAt(0.5) + 22];
const HALLUC: [number, number] = [spanAt(0.65) + 1, spanAt(0.65) + 29];
const noisy = refA
  .filter((w) => w.t0 >= S0 && !(w.t0 >= GAP[0] && w.t0 < GAP[1]))
  .flatMap((w): W[] => {
    if (w.punc) return [w];
    const [ps, pd, pi] = w.t0 < 0.9 * T ? [0.12, 0.1, 0.03] : [0.04, 0.03, 0.01];
    const r = rand();
    if (r < pd) return [];
    const kept = r < pd + ps ? { ...w, text: vocab[Math.floor(rand() * vocab.length)]! } : w;
    return rand() < pi ? [kept, { ...w, text: vocab[Math.floor(rand() * vocab.length)]! }] : [kept];
  });
const bRegions = segment(noisy.filter((w) => !(w.t0 >= HALLUC[0] && w.t0 < HALLUC[1])), { gap: 2, cap: 30, atSentence: false });
const turn = new Map<string, number>();
const bShown = bRegions.map((s) => {
  const n = turn.get(s.agent) ?? 0;
  turn.set(s.agent, n + 1);
  // one person (agent B) is split over two labels, as the batch diarizer does (TC-1111)
  const label = s.agent === "B" && n % 2 === 1 ? "speaker_4" : `speaker_${"ABCD".indexOf(s.agent)}`;
  return { ...s, label };
});
// one 28 s region of speech came back as "Thank you."
const halluc = { agent: "A", text: "Thank you.", t0: HALLUC[0], t1: HALLUC[1], label: "speaker_0" };
bShown.push(halluc);
bShown.sort((x, y) => x.t0 - y.t0);
const bBody = body(bShown.map((s) => ({
  name: s.label,
  text: s.text,
  t0: s.t0 - S0 + SKEW,
  t1: s.t1 - S0 + SKEW,
})));
writeFileSync(join(out, "es2004a-notetaker.json"), JSON.stringify(bBody));

writeFileSync(join(out, "es2004a-truth.json"), JSON.stringify({
  duration_s: r2(T),
  b_capture_start_s: r2(S0),
  skew_s: SKEW,
  // time(fireflies) = time(notetaker) + offset_s
  offset_s: r2(S0 - SKEW),
  gap_s: [r2(GAP[0]), r2(GAP[1])],
  hallucination_s: [r2(HALLUC[0]), r2(HALLUC[1])],
  fireflies_ends_s: r2(0.9 * T),
  speakers: NAMES,
  // person B is labelled speaker_1 and speaker_4 in the Notetaker body
  notetaker_label_to_name: { speaker_0: NAMES.A, speaker_1: NAMES.B, speaker_2: NAMES.C, speaker_3: NAMES.D, speaker_4: NAMES.B },
  ref_words_s: refA.filter((w) => !w.punc).map((w) => [r2(w.t0), r2(w.t1)]),
}));

// ── ES2004b (the same people's next meeting): named body for the negative ──
const bSegs = segment(words("ES2004b"), { gap: 1, cap: 15, atSentence: true });
writeFileSync(join(out, "es2004b-fireflies.json"), JSON.stringify(body(bSegs.map((s) => ({ name: NAMES[s.agent]!, text: s.text, t0: s.t0, t1: s.t1 })))));
console.log("segments", { a: aSegs.length, notetaker: bBody.length, es2004b: bSegs.length, T });
