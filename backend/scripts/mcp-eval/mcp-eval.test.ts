import { describe, expect, test } from "bun:test";
import { createAnswerKeyBackend, elizaStubBackend } from "./backends.js";
import { evaluateGate, loadFrozenEval, runEval, type BaselineFile, type ModelResult } from "./runner.js";
import { materializeSpace, scoreCase } from "./scoring.js";
import type { EvalCase } from "./types.js";

const frozen = await loadFrozenEval();
const byId = (id: string): EvalCase => frozen.cases.find(c => c.id === id)!;

function result(overrides: Partial<ModelResult>): ModelResult {
  return { model: "m", status: "run", total: 100, passed: 100, passRate: 1, citationTotal: 0, citationInvalid: 0, coverageSections: 0, coverageExpected: 0, sizeLimitErrors: 0, sizeLimitCaseErrors: 0, failures: [], cases: {}, ...overrides };
}

describe("frozen eval set", () => {
  test("manifest hash matches and the size-limit case regenerates 501 transcript-heavy rows deterministically", () => {
    expect(frozen.manifest.sizeLimitCaseIds).toEqual(["eliza-size-limit-501-transcript-heavy-rows"]);
    const a = materializeSpace(byId(frozen.manifest.sizeLimitCaseIds[0]!).space);
    const b = materializeSpace(byId(frozen.manifest.sizeLimitCaseIds[0]!).space);
    expect(a.meetings).toHaveLength(501);
    expect(a).toEqual(b);
    expect(a.meetings.reduce((n, m) => n + (m.rawMetadata?.length ?? 0), 0)).toBeGreaterThan(20 * 1024 * 1024);
  });

  test("answer-key backend scores every case as a pass, so the scorer accepts a correct answer for each", async () => {
    const report = await runEval({ backend: createAnswerKeyBackend(frozen.cases), cases: frozen.cases, evalVersion: 1 });
    for (const model of report.models) expect(model.failures).toEqual([]);
  });
});

describe("scoring", () => {
  const case1 = byId("eliza-two-meeting-citations");
  const good = "Release delayed [M1:E1, Alice, 00:00:30] and delayed again [M2:E1, Bob, 00:01:00].\n\n### Coverage\nM1 read. M2 read.";

  test("accepts correct citations and rejects fabricated ids, wrong attribution and missing coverage", () => {
    expect(scoreCase(case1, { text: good }).passed).toBe(true);
    expect(scoreCase(case1, { text: good.replace("[M2:E1, Bob, 00:01:00]", "[M9:E1]") }).failures.join()).toContain("invalid citation [M9:E1]");
    expect(scoreCase(case1, { text: good.replace("Bob", "Alice") }).citationInvalid).toBe(1);
    expect(scoreCase(case1, { text: good.split("\n\n### Coverage")[0]! }).failures).toContain("missing ### Coverage section");
  });

  test("citation-shaped text inside a public URL is not a citation", () => {
    const withUrl = byId("eliza-public-plus-private");
    const text = "Delayed [M1:E1]. See https://vendor.example/docs/[M9:E9].\nhttps://vendor.example/docs\n\n### Coverage\nM1 read.";
    expect(scoreCase(withUrl, { text }).citationInvalid).toBe(0);
  });

  test("size-limit errors in tool errors or answer text fail the size-limit case", () => {
    const size = byId("eliza-size-limit-501-transcript-heavy-rows");
    const text = "Meeting m-0 [M1], Meeting m-1 [M2], Meeting m-2 [M3].";
    expect(scoreCase(size, { text }).passed).toBe(true);
    expect(scoreCase(size, { text, toolErrors: ["KV_RESPONSE_TOO_LARGE"] }).sizeLimitErrors).toBe(1);
    expect(scoreCase(size, { text: `${text} result_size_limit` }).passed).toBe(false);
  });

  test("a decline case fails when the answer asserts fixture facts or cites meetings", () => {
    const decline = byId("missing-meeting#0");
    expect(scoreCase(decline, { text: "No such meeting was found." }).passed).toBe(true);
    expect(scoreCase(decline, { text: "The team approved cobalt." }).passed).toBe(false);
  });
});

describe("gate", () => {
  const baseline: BaselineFile = { version: 1, backend: "b", status: "recorded", models: { m: { passRate: 0.97, cases: { a: true, b: true, c: false } } } };

  test("95% is the pass-rate boundary", () => {
    expect(evaluateGate(result({ passRate: 0.95 }), baseline).passRate.status).toBe("pass");
    expect(evaluateGate(result({ passRate: 0.9499 }), baseline).passRate.status).toBe("fail");
  });

  test("regression: a case that passed in the baseline must not fail, and the rate must not drop", () => {
    expect(evaluateGate(result({ passRate: 0.98, cases: { a: true, b: false, c: true } }), baseline).regression.status).toBe("fail");
    expect(evaluateGate(result({ passRate: 0.96, cases: { a: true, b: true, c: true } }), baseline).regression.status).toBe("fail");
    const ok = evaluateGate(result({ passRate: 0.98, cases: { a: true, b: true, c: true } }), baseline);
    expect(ok.regression.status).toBe("pass");
    expect(ok.passed).toBe(true);
  });

  test("a NOT RUN baseline makes regression not evaluable and the gate cannot pass", () => {
    const gate = evaluateGate(result({}), { version: 1, backend: "b", status: "not_run", reason: "r", models: {} });
    expect(gate.regression.status).toBe("not_evaluable");
    expect(gate.passed).toBe(false);
  });

  test("any size-limit error on the size-limit case fails the gate", () => {
    expect(evaluateGate(result({ sizeLimitCaseErrors: 1 }), baseline).sizeLimit.status).toBe("fail");
  });
});

describe("unavailable backend", () => {
  test("the Eliza stub reports NOT RUN for every model and never a pass or fail", async () => {
    const report = await runEval({ backend: elizaStubBackend, cases: frozen.cases, evalVersion: 1 });
    expect(report.models.every(m => m.status === "not_run" && m.passed === 0 && m.failures.length === 0)).toBe(true);
    expect(report.gatePassed).toBe(false);
  });
});
