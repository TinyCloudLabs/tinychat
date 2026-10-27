import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { scoreCase, type CaseScore } from "./scoring.js";
import { BackendUnavailableError, type CasesFile, type ChatBackend, type EvalCase, type Manifest } from "./types.js";

export const MCP_EVAL_DIR = resolve(import.meta.dir);

/** The plan's cutover gate (docs/plans/mcp-chat-cutover.md, TC-2196). */
export const GATE_THRESHOLDS = { minPassRate: 0.95, maxSizeLimitErrors: 0 } as const;

export interface ModelResult {
  model: string;
  status: "run" | "not_run";
  /** Why a model was not run (backend unavailable). Never a pass or fail. */
  reason?: string;
  total: number;
  passed: number;
  passRate: number;
  citationTotal: number;
  citationInvalid: number;
  coverageSections: number;
  coverageExpected: number;
  sizeLimitErrors: number;
  sizeLimitCaseErrors: number;
  failures: Array<{ caseId: string; failures: string[] }>;
  cases: Record<string, boolean>;
}

export interface BaselineFile {
  version: number;
  backend: string;
  /** `recorded`: numbers below were produced by running the frozen eval. `not_run`: no frozen-eval numbers exist. */
  status: "recorded" | "not_run";
  reason?: string;
  models: Record<string, { passRate: number; cases: Record<string, boolean> }>;
}

export type GateCheck = { status: "pass" | "fail" | "not_evaluable"; detail: string };

export interface ModelGate {
  model: string;
  passRate: GateCheck;
  regression: GateCheck;
  sizeLimit: GateCheck;
  passed: boolean;
}

export interface EvalReport {
  evalVersion: number;
  backend: string;
  models: ModelResult[];
  gates: ModelGate[];
  gatePassed: boolean;
}

export async function loadFrozenEval(dir = MCP_EVAL_DIR): Promise<{ cases: EvalCase[]; manifest: Manifest }> {
  const raw = await readFile(resolve(dir, "cases.json"));
  const manifest = JSON.parse(await readFile(resolve(dir, "manifest.json"), "utf8")) as Manifest;
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha !== manifest.casesSha256) throw new Error(`frozen eval cases.json changed (sha256 ${sha} != manifest ${manifest.casesSha256}); cut a new version instead of editing v${manifest.version}`);
  const file = JSON.parse(raw.toString("utf8")) as CasesFile;
  if (file.version !== manifest.version || file.cases.length !== manifest.caseCount) throw new Error("frozen eval manifest does not match cases.json");
  return { cases: file.cases, manifest };
}

export async function loadBaseline(path: string): Promise<BaselineFile> {
  return JSON.parse(await readFile(path, "utf8")) as BaselineFile;
}

function emptyResult(model: string, cases: EvalCase[], reason: string): ModelResult {
  return { model, status: "not_run", reason, total: cases.length, passed: 0, passRate: 0, citationTotal: 0, citationInvalid: 0, coverageSections: 0, coverageExpected: 0, sizeLimitErrors: 0, sizeLimitCaseErrors: 0, failures: [], cases: {} };
}

export async function runModel(backend: ChatBackend, model: string, cases: EvalCase[]): Promise<ModelResult> {
  const scores: CaseScore[] = [];
  for (const testCase of cases) {
    try {
      const answer = await backend.answer({ text: testCase.question, history: testCase.history ?? [], model }, testCase.space);
      scores.push(scoreCase(testCase, answer));
    } catch (error) {
      if (error instanceof BackendUnavailableError) return emptyResult(model, cases, error.message);
      scores.push({ caseId: testCase.id, passed: false, failures: [`backend error: ${error instanceof Error ? error.message : String(error)}`], citationInvalid: 0, citationTotal: 0, coveragePresent: false, sizeLimitErrors: 0 });
    }
  }
  const passed = scores.filter(s => s.passed).length;
  const sizeIds = new Set(cases.filter(c => c.sizeLimit).map(c => c.id));
  return {
    model, status: "run", total: cases.length, passed, passRate: cases.length ? passed / cases.length : 0,
    citationTotal: scores.reduce((n, s) => n + s.citationTotal, 0), citationInvalid: scores.reduce((n, s) => n + s.citationInvalid, 0),
    coverageSections: scores.filter(s => s.coveragePresent).length, coverageExpected: cases.filter(c => c.expect.coverage.required).length,
    sizeLimitErrors: scores.reduce((n, s) => n + s.sizeLimitErrors, 0), sizeLimitCaseErrors: scores.filter(s => sizeIds.has(s.caseId)).reduce((n, s) => n + s.sizeLimitErrors, 0),
    failures: scores.filter(s => !s.passed).map(s => ({ caseId: s.caseId, failures: s.failures })),
    cases: Object.fromEntries(scores.map(s => [s.caseId, s.passed])),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Encodes the plan's gate: >=95% pass per model, no regression vs the recorded baseline, 0 size-limit errors on the size-limit case. */
export function evaluateGate(result: ModelResult, baseline?: BaselineFile): ModelGate {
  if (result.status === "not_run") {
    const not: GateCheck = { status: "not_evaluable", detail: `not run: ${result.reason}` };
    return { model: result.model, passRate: not, regression: not, sizeLimit: not, passed: false };
  }
  const passRate: GateCheck = result.passRate >= GATE_THRESHOLDS.minPassRate
    ? { status: "pass", detail: `${pct(result.passRate)} >= ${pct(GATE_THRESHOLDS.minPassRate)}` }
    : { status: "fail", detail: `${pct(result.passRate)} < ${pct(GATE_THRESHOLDS.minPassRate)}` };
  const sizeLimit: GateCheck = result.sizeLimitCaseErrors <= GATE_THRESHOLDS.maxSizeLimitErrors
    ? { status: "pass", detail: `${result.sizeLimitCaseErrors} size-limit errors on the size-limit case` }
    : { status: "fail", detail: `${result.sizeLimitCaseErrors} size-limit errors on the size-limit case` };
  const recorded = baseline?.status === "recorded" ? baseline.models[result.model] : undefined;
  let regression: GateCheck;
  if (!recorded) {
    regression = { status: "not_evaluable", detail: baseline?.status === "recorded" ? `baseline has no numbers for ${result.model}` : `baseline NOT RUN${baseline?.reason ? `: ${baseline.reason}` : ""}` };
  } else {
    const regressed = Object.entries(recorded.cases).filter(([id, passed]) => passed && result.cases[id] === false).map(([id]) => id);
    regression = regressed.length === 0 && result.passRate >= recorded.passRate
      ? { status: "pass", detail: `${pct(result.passRate)} vs baseline ${pct(recorded.passRate)}, no previously passing case fails` }
      : { status: "fail", detail: `${pct(result.passRate)} vs baseline ${pct(recorded.passRate)}${regressed.length ? `; regressed: ${regressed.join(", ")}` : ""}` };
  }
  return { model: result.model, passRate, regression, sizeLimit, passed: [passRate, regression, sizeLimit].every(c => c.status === "pass") };
}

export async function runEval(options: { backend: ChatBackend; models?: readonly string[]; cases: EvalCase[]; evalVersion: number; baseline?: BaselineFile }): Promise<EvalReport> {
  const models = options.models ?? options.backend.models();
  const results: ModelResult[] = [];
  for (const model of models) results.push(await runModel(options.backend, model, options.cases));
  const gates = results.map(r => evaluateGate(r, options.baseline));
  return { evalVersion: options.evalVersion, backend: options.backend.id, models: results, gates, gatePassed: gates.length > 0 && gates.every(g => g.passed) };
}

export function formatReport(report: EvalReport): string {
  const lines = [`frozen eval v${report.evalVersion}, backend: ${report.backend}`];
  for (const model of report.models) {
    if (model.status === "not_run") {
      lines.push(`\n${model.model}: NOT RUN (${model.reason})`);
      continue;
    }
    lines.push(`\n${model.model}: ${model.passed}/${model.total} passed (${pct(model.passRate)})`,
      `  citations: ${model.citationTotal - model.citationInvalid}/${model.citationTotal} valid; coverage sections present: ${model.coverageSections} (expected on ${model.coverageExpected} cases); size-limit errors: ${model.sizeLimitErrors} (size-limit case: ${model.sizeLimitCaseErrors})`);
    for (const failure of model.failures) lines.push(`  FAIL ${failure.caseId}: ${failure.failures.join("; ")}`);
  }
  lines.push("\ngate (>=95% pass per model, no regression vs baseline, 0 size-limit errors):");
  for (const gate of report.gates) {
    lines.push(`  ${gate.model}: ${gate.passed ? "PASS" : "NOT PASSED"}`, `    pass rate: ${gate.passRate.status} (${gate.passRate.detail})`, `    regression: ${gate.regression.status} (${gate.regression.detail})`, `    size limit: ${gate.sizeLimit.status} (${gate.sizeLimit.detail})`);
  }
  lines.push(`\noverall gate: ${report.gatePassed ? "PASSED" : "NOT PASSED"}`);
  return lines.join("\n");
}
