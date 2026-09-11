/** Explicit synthetic-only evaluation. Importing this module never makes requests. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OFFERED_CHAT_MODELS } from "../../packages/core/src/chatModels.js";
import { createFixtureService, MEETING_EVAL_CALENDAR, MEETING_EVAL_SCENARIOS, scenarioScopeExpectation, type MeetingEvalScenario } from "./meeting-eval-fixtures.js";
import { validateMeetingPlan } from "../src/transcripts/meeting-turn.js";

export interface ProviderResponseDiagnostic { status: number; retryAfter?: string; receiptId?: string }
export function providerResponseDiagnostic(response: Response): ProviderResponseDiagnostic {
  const retryAfter = response.headers.get("retry-after");
  const receiptId = response.headers.get("x-receipt-id");
  const valid = retryAfter !== null && (/^\d{1,10}$/.test(retryAfter)
    || /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter)));
  return { status: response.status, ...(valid ? { retryAfter } : {}),
    ...(receiptId && /^rcpt-[a-f0-9]{24}$/.test(receiptId) ? { receiptId } : {}) };
}

export function selectScenarios(ids?: string): MeetingEvalScenario[] {
  if (ids === undefined) return MEETING_EVAL_SCENARIOS;
  const selected = ids.split(",");
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !MEETING_EVAL_SCENARIOS.some(scenario => scenario.id === id))) throw new Error("Choose distinct known scenario IDs");
  return MEETING_EVAL_SCENARIOS.filter(scenario => selected.includes(scenario.id));
}

export function evaluateScenarioScope(scenario: MeetingEvalScenario, plan: Record<string, unknown> | undefined, readRefs: string[]): string[] {
  const expected = scenarioScopeExpectation(scenario);
  if (!expected || !plan) return [];
  const issues: string[] = [];
  if (plan.scope !== expected.scope || expected.scope === "single" && (plan.selectFirst !== expected.selectFirst || plan.sort !== "newest")) issues.push("wrong_scope");
  const filters = (plan.filters ?? {}) as Record<string, unknown>;
  if (filters.source !== undefined || filters.participant !== undefined || (expected.scope === "single" ? typeof filters.title !== "string" || !filters.title.toLowerCase().includes("design") : filters.title !== undefined)) issues.push("unexpected_filter");
  if (expected.interval && (filters.from !== expected.interval.from || filters.to !== expected.interval.to || plan.timeZone !== MEETING_EVAL_CALENDAR.timeZone)
    || !expected.interval && (filters.from !== undefined || filters.to !== undefined)) issues.push("wrong_interval");
  if ([...new Set(readRefs)].sort().join(",") !== [...expected.meetingRefs].sort().join(",")) issues.push("wrong_meeting_selection");
  return issues;
}

interface ObservedAnswerStream { firstContentMs?: number; endedMs?: number; firstDeliveredMs?: number }
export function assessGeneralStreaming(streams: ObservedAnswerStream[]): "passed" | "failed" | "unobservable" {
  // A response whose content and EOF arrive together cannot demonstrate buffering.
  const observable = streams.filter(stream => stream.firstContentMs !== undefined && stream.endedMs !== undefined && stream.endedMs - stream.firstContentMs >= 25);
  if (!observable.length) return "unobservable";
  return observable.some(stream => stream.firstDeliveredMs === undefined || stream.firstDeliveredMs >= stream.endedMs! - 5) ? "failed" : "passed";
}

interface RunAssessment {
  expectedKind: MeetingEvalScenario["expectedKind"];
  answerable: boolean;
  requiredFacts: string[];
  interpretedKind?: string;
  answer: string;
  toolNames: string[];
  evidenceReads: number;
  errorCode?: string;
  elapsedMs: number;
  timeoutMs: number;
  providerHttpFailure?: boolean;
}
export function evaluateRun(run: RunAssessment): string[] {
  const issues: string[] = [];
  if (run.interpretedKind !== run.expectedKind && (run.interpretedKind !== undefined || !run.providerHttpFailure)) issues.push("wrong_intent");
  if (!run.providerHttpFailure && run.expectedKind === "meeting_content" && run.answerable && run.evidenceReads === 0) issues.push("zero_evidence_reads");
  if (run.expectedKind === "meeting_metadata" && run.evidenceReads > 0) issues.push("content_read_for_metadata");
  if (run.expectedKind === "general" && run.toolNames.some(name => name.startsWith("tinycloud_"))) issues.push("private_dispatch_on_general");
  if (!run.providerHttpFailure && run.answerable && (!run.answer.trim() || run.requiredFacts.some(fact => !run.answer.toLowerCase().includes(fact.toLowerCase())))) issues.push("missing_supported_fact");
  if (run.errorCode) issues.push("turn_failed");
  if (run.elapsedMs >= run.timeoutMs) issues.push("deadline_hit");
  return issues;
}

export interface SummaryRun {
  scenarioId?: string;
  variant?: number;
  repeat?: number;
  issues: string[];
  elapsedMs: number;
  firstAnswerMs?: number;
  baselineFirstAnswerMs?: number;
  modelCalls: number;
  baselineModelCalls?: number;
  baselineValid?: boolean;
  answerable: boolean;
  semanticReview: "pending" | "passed" | "failed";
  contextOverflow: boolean;
  timeoutMs: number;
  generalStreaming?: "passed" | "failed" | "unobservable";
}
export interface SemanticReview {
  runId: string;
  supported: boolean;
  correctMeetingCitations: boolean;
  honestCoverage: boolean;
  useful: boolean;
  noPrivateAnswerOnRevocation: boolean;
}
export interface LatencyReview {
  model: string;
  reportGeneratedAt: string;
  acceptable: boolean;
  notes: string;
}
type LatencyPolicy = "reviewed-responsiveness-v1";
export function semanticReviewIssues(review: Omit<SemanticReview, "runId">): string[] {
  return [
    ...(!review.supported ? ["unsupported_claim"] : []),
    ...(!review.correctMeetingCitations ? ["wrong_meeting_citation"] : []),
    ...(!review.honestCoverage ? ["unsupported_coverage"] : []),
    ...(!review.useful ? ["missing_supported_fact"] : []),
    ...(!review.noPrivateAnswerOnRevocation ? ["private_answer_after_revocation"] : []),
  ];
}
const percentile = (values: number[], quantile: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!;
};
export function summarizeModel(runs: SummaryRun[], options: { latencyPolicy?: LatencyPolicy; latencyReview?: LatencyReview } = {}) {
  if (options.latencyPolicy !== undefined && options.latencyPolicy !== "reviewed-responsiveness-v1") throw new Error("Unknown latency policy");
  if (options.latencyReview && (typeof options.latencyReview.acceptable !== "boolean" || typeof options.latencyReview.notes !== "string" || !options.latencyReview.notes.trim() || options.latencyReview.notes.length > 4000)) throw new Error("Latency review requires a boolean decision and bounded nonempty notes");
  const answerable = runs.filter(run => run.answerable && !run.issues.includes("evaluation_budget_exhausted"));
  const usefulAnswerRate = answerable.length ? answerable.filter(run => !run.issues.includes("missing_supported_fact") && !run.issues.includes("turn_failed") && run.semanticReview !== "failed").length / answerable.length : 0;
  const seenPairs = new Set<string>();
  const paired = runs.filter(run => {
    if (run.scenarioId !== "ordinary-conversation" || run.baselineValid !== true || run.issues.length || run.contextOverflow || run.semanticReview === "failed"
      || !Number.isFinite(run.baselineFirstAnswerMs) || !Number.isFinite(run.firstAnswerMs)
      || ![0, 1, 2].includes(run.variant!) || !Number.isInteger(run.repeat) || run.repeat! < 0) return false;
    const key = `${run.variant}:${run.repeat}`;
    if (seenPairs.has(key)) return false;
    seenPairs.add(key); return true;
  });
  const addedP95FirstAnswerMs = percentile(paired.map(run => run.firstAnswerMs! - run.baselineFirstAnswerMs!), .95);
  const ordinaryPairingPassed = paired.length >= 6 && addedP95FirstAnswerMs !== null
    && [0, 1, 2].every(variant => paired.filter(run => run.variant === variant).length >= 2)
    && paired.every(run => run.modelCalls === run.baselineModelCalls! + 1) && !runs.some(run => run.baselineValid === false);
  const legacyAddedP95Within2000Ms = addedP95FirstAnswerMs !== null && addedP95FirstAnswerMs <= 2000;
  const latencyReviewStatus = options.latencyPolicy === undefined ? "not_required"
    : options.latencyReview ? options.latencyReview.acceptable ? "passed" : "failed" : "pending";
  const ordinaryLatencyPassed = ordinaryPairingPassed && (options.latencyPolicy === undefined ? legacyAddedP95Within2000Ms : latencyReviewStatus === "passed");
  const semanticReviewComplete = runs.length > 0 && runs.every(run => run.semanticReview === "passed");
  const critical = new Set(["wrong_intent", "wrong_scope", "wrong_interval", "unexpected_filter", "wrong_meeting_selection", "zero_evidence_reads", "content_read_for_metadata", "private_dispatch_on_general", "private_answer_after_revocation", "wrong_meeting_citation", "unsupported_claim", "unsupported_coverage"]);
  const criticalErrors = runs.reduce((n, run) => n + run.issues.filter(issue => critical.has(issue)).length, 0);
  const successful = runs.filter(run => !run.issues.includes("turn_failed") && !run.issues.includes("missing_supported_fact") && !run.issues.includes("evaluation_budget_exhausted"));
  const deadlineFractionP95 = percentile(successful.map(run => run.elapsedMs / run.timeoutMs), .95);
  const observableGeneralStreamingSamples = runs.filter(run => run.generalStreaming === "passed" || run.generalStreaming === "failed").length;
  const generalStreamingPassed = observableGeneralStreamingSamples > 0 && !runs.some(run => run.generalStreaming === "failed");
  return {
    samples: runs.length, usefulAnswerRate, criticalErrors, semanticReviewComplete,
    latencyMs: { p50: percentile(runs.map(run => run.elapsedMs), .5), p95: percentile(runs.map(run => run.elapsedMs), .95) },
    ordinaryPairedSamples: paired.length, addedP95FirstAnswerMs, ordinaryPairingPassed, ordinaryLatencyPassed,
    legacyAddedP95Within2000Ms, latencyReviewStatus,
    generalStreamingPassed, observableGeneralStreamingSamples,
    deadlineFractionP95, contextOverflowCount: runs.filter(run => run.contextOverflow).length,
    releaseReady: runs.length > 0 && criticalErrors === 0 && usefulAnswerRate >= .95 && semanticReviewComplete && ordinaryLatencyPassed
      && generalStreamingPassed && deadlineFractionP95 !== null && deadlineFractionP95 <= .8 && !runs.some(run => run.contextOverflow || run.modelCalls > 4 || run.issues.includes("evaluation_budget_exhausted")),
  };
}

export interface ModelTiming {
  call: number; phase: "interpretation" | "answer"; startedMs: number;
  requestStartedAt?: string; requestSha256?: string; responseId?: string;
  headersMs?: number; firstDeltaMs?: number; firstToolDeltaMs?: number;
  finishMs?: number; protocolEndMs?: number;
}

export interface EvalRun extends SummaryRun {
  id: string;
  scenarioId: string;
  variant: number;
  repeat: number;
  model: string;
  mode: "controller" | "baseline";
  errorCode?: string;
  providerResponses: ProviderResponseDiagnostic[];
  /** Milliseconds from turn start; protocol end means [DONE], not transport EOF. */
  modelTimings?: ModelTiming[];
  interpretedPlan?: Record<string, unknown>;
  /** Accepted synthetic interpreter arguments, including relative-date input. */
  interpretationInput?: Record<string, unknown>;
  phases: Array<{ phase: string; elapsedMs: number }>;
  toolTrace: Array<{ name: string; status: string; elapsedMs: number; id?: string }>;
  evidenceReads: number;
  bodyReads: number;
  packageChars: number;
  promptTokens: number;
  completionTokens: number;
  servedModels: string[];
  answerWhileModelOpen: boolean;
  /** Synthetic output for local factual review; never populated from a real account. */
  answer: string;
  /** Synthetic fixture outcomes permit checking each citation's actual support. */
  fixtureOutcomes: ReturnType<typeof createFixtureService>["outcomes"];
  diagnostics: Record<string, unknown>[];
}

export async function runScenario(options: {
  model: string; scenario: MeetingEvalScenario; variant: number; repeat: number; apiKey: string; baseUrl: string; timeoutMs: number;
  baseline?: boolean; providerFetch?: typeof fetch;
  /** Matrix-wide admission immediately before each model send; inventory is separate. */
  admitModelRequest?: () => boolean;
}): Promise<EvalRun> {
  // Lazy load the live controller so offline matrix/report checks remain usable.
  const { orchestrateToolCalling, parseSseJson, accumulateToolCalls, parseInlineToolCalls } = await import("../src/routes/agent-chat.js");
  const fixture = createFixtureService(options.scenario);
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const providerFetch = options.providerFetch ?? fetch;
  const api = new URL(options.baseUrl.replace(/\/$/, "") + "/");
  const fixtureBase = "https://meeting-fixture.invalid";
  const observers: Promise<void>[] = [];
  const activeCalls = new Set<number>();
  const answerStreams = new Map<number, ObservedAnswerStream>();
  const servedModels = new Set<string>();
  const toolNames: string[] = [];
  const trace: EvalRun["toolTrace"] = [];
  const phases: EvalRun["phases"] = [];
  const diagnostics: Record<string, unknown>[] = [];
  let modelCalls = 0, packageChars = 0;
  let interpretedPlan: Record<string, unknown> | undefined;
  let interpretationInput: Record<string, unknown> | undefined;
  let answer = "", firstAnswerMs: number | undefined, answerWhileModelOpen = false;
  let promptTokens = 0, completionTokens = 0, errorCode: string | undefined;
  let contextOverflow = false;
  let budgetExhausted = false;
  const providerResponses: ProviderResponseDiagnostic[] = [];
  const modelTimings: ModelTiming[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === fixtureBase) {
      if (url.pathname === "/capabilities") return Response.json({ meetingRetrieval: { contractVersion: 2 }, buildRevision: "synthetic-fixture-v1" });
      if (!url.pathname.startsWith("/tools/")) throw new Error("fixture_path_denied");
      const name = decodeURIComponent(url.pathname.slice("/tools/".length));
      toolNames.push(name);
      const body = JSON.parse(String(init?.body ?? "{}"));
      const result = fixture.dispatch(name, body.args ?? {}, body.context ?? {});
      return Response.json(result, { status: result.error ? 403 : 200 });
    }
    if (url.origin !== api.origin || url.pathname !== `${api.pathname}chat/completions`) throw new Error("unexpected_network_destination");
    if (providerResponses.some(response => response.status === 429)) throw new Error("provider_rate_limited");
    const request = JSON.parse(String(init?.body ?? "{}"));
    const interpreting = request.tools?.some((tool: any) => tool.function?.name === "prepare_meeting_turn");
    if (!request.tools) packageChars = Math.max(packageChars, JSON.stringify(request.messages).length);
    if (options.admitModelRequest && !options.admitModelRequest()) {
      budgetExhausted = true;
      throw new Error("evaluation_budget_exhausted");
    }
    const call = ++modelCalls;
    const timing: ModelTiming = { call, phase: interpreting ? "interpretation" : "answer", startedMs: elapsed(),
      requestStartedAt: new Date().toISOString(), requestSha256: createHash("sha256").update(String(init?.body ?? "")).digest("hex") };
    modelTimings.push(timing);
    activeCalls.add(call);
    if (!interpreting) answerStreams.set(call, {});
    const response = await providerFetch(input, init);
    timing.headersMs = elapsed();
    providerResponses.push(providerResponseDiagnostic(response));
    if (response.status === 413) contextOverflow = true;
    if (!response.body) { activeCalls.delete(call); return response; }
    // Tee the already-created body explicitly. Bun's Response.clone() can lose
    // buffered fixture bytes after the body getter has been read.
    const [forwarded, observed] = response.body.tee();
    if (!response.ok) {
      observers.push((async () => {
        const reader = observed.getReader();
        const cancel = () => { void reader.cancel().catch(() => {}); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        if (controller.signal.aborted) cancel();
        let text = "";
        try {
          while (text.length < 4096) {
            const chunk = await reader.read();
            if (chunk.done) break;
            text += new TextDecoder().decode(chunk.value);
          }
          if (/context_overflow|context.{0,12}(?:length|window)|too many tokens|maximum context/i.test(text)) contextOverflow = true;
        } finally { controller.signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); activeCalls.delete(call); }
      })());
      return new Response(forwarded, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    observers.push((async () => {
      const calls = new Map();
      let content = "";
      try {
        for await (const frame of parseSseJson(observed, controller.signal)) {
          // Early-stream relay responses may omit x-receipt-id. Only retain
          // bounded known response-id shapes for a later content-free lookup.
          if (timing.responseId === undefined && typeof frame.id === "string"
            && /^(?:(?:req_)?[a-f0-9]{32}|(?:chatcmpl-|gen-)[A-Za-z0-9_-]{1,96})$/.test(frame.id)) timing.responseId = frame.id;
          if (typeof frame.model === "string") servedModels.add(frame.model);
          const delta = (frame.choices as any)?.[0]?.delta;
          if (delta && Object.values(delta).some(value => value != null && value !== "")) timing.firstDeltaMs ??= elapsed();
          if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) timing.firstToolDeltaMs ??= elapsed();
          if ((frame.choices as any)?.[0]?.finish_reason != null) timing.finishMs ??= elapsed();
          if (typeof delta?.content === "string" && delta.content.trim() && answerStreams.has(call)) answerStreams.get(call)!.firstContentMs ??= elapsed();
          if (Array.isArray(delta?.tool_calls)) accumulateToolCalls(calls, delta.tool_calls);
          if (typeof delta?.content === "string" && content.length < 32_768) content += delta.content;
        }
        timing.protocolEndMs = elapsed();
      } catch { /* The controller owns stream failures; an absent plan fails assessment. */ }
      finally { if (answerStreams.has(call)) answerStreams.get(call)!.endedMs = elapsed(); activeCalls.delete(call); }
      // Tool-call markup is intentionally held by the application's markup guard.
      // Assess normal answer streams only, including the post-tool answer call.
      if (calls.size || parseInlineToolCalls(content).length) answerStreams.delete(call);
      if (interpreting) {
        const native = [...calls.values()].find((item: any) => item.name?.toLowerCase() === "prepare_meeting_turn");
        const inline = parseInlineToolCalls(content).find(item => item.name.toLowerCase() === "prepare_meeting_turn");
        const args = native?.args ?? inline?.args;
        if (args) try {
          const raw = JSON.parse(args);
          const validated = validateMeetingPlan(raw, MEETING_EVAL_CALENDAR, !native && Boolean(inline));
          if (validated.ok) { interpretedPlan = { ...validated.plan }; interpretationInput = raw; }
        } catch { /* Assessment records missing interpretation. */ }
      }
    })());
    return new Response(forwarded, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
  try {
    const result = await orchestrateToolCalling({
      config: {
        agentId: "synthetic-eval", entityIdFor: () => "synthetic-eval", elizaServiceUrl: fixtureBase, elizaServiceSecret: "synthetic",
        redpillApiKey: options.apiKey, redpillBaseUrl: options.baseUrl.replace(/\/$/, ""), defaultModel: () => options.model,
        isModelOffered: model => OFFERED_CHAT_MODELS.some(item => item.id === model), fetchImpl,
        streamPolicy: { heartbeatMs: 1000, turnTimeoutMs: options.timeoutMs, drainGraceMs: 1000 },
        meetingContentRetrievalEnabled: !options.baseline, meetingContentModelAllowed: () => true,
        backendRevision: "synthetic-evaluation", meetingTrace: record => diagnostics.push(record),
      },
      model: options.model, entityId: "synthetic-eval", roomId: "synthetic-eval-room",
      turnContext: MEETING_EVAL_CALENDAR, signal: controller.signal,
      messages: [...(options.scenario.history ?? []), { role: "user", content: options.scenario.prompts[options.variant]! }],
      onPhase: phase => phases.push({ phase, elapsedMs: elapsed() }),
      write(frame) {
        const line = frame.trim().replace(/^data:\s*/, "");
        if (line === "[DONE]") return;
        let value: any;
        try { value = JSON.parse(line); } catch { return; }
        if (value.tool_activity) trace.push({ ...value.tool_activity, elapsedMs: elapsed() });
        const delta = value.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          if (delta.trim()) {
            for (const call of activeCalls) if (answerStreams.has(call)) answerStreams.get(call)!.firstDeliveredMs ??= elapsed();
            if (firstAnswerMs === undefined) { firstAnswerMs = elapsed(); answerWhileModelOpen = activeCalls.size > 0; }
          }
          answer += delta;
        }
      },
    });
    promptTokens = result.promptTokens;
    completionTokens = result.completionTokens;
    errorCode = result.errorCode;
  } catch { errorCode = controller.signal.aborted ? "turn_timeout" : "evaluation_turn_failed"; }
  finally { clearTimeout(timeout); controller.abort(); await Promise.allSettled(observers); }
  const elapsedMs = elapsed();
  if (budgetExhausted) errorCode = "evaluation_budget_exhausted";
  if (providerResponses.some(response => response.status === 429)) errorCode = "provider_rate_limited";
  // A harness cutoff cannot assess missing work, but observed violations remain.
  const issues = evaluateRun({
    expectedKind: options.scenario.expectedKind, answerable: options.scenario.answerable, requiredFacts: options.scenario.requiredFacts,
    interpretedKind: options.baseline ? options.scenario.expectedKind : typeof interpretedPlan?.kind === "string" ? interpretedPlan.kind : undefined, answer, toolNames, evidenceReads: fixture.evidenceReads, errorCode: budgetExhausted ? undefined : errorCode,
    elapsedMs, timeoutMs: options.timeoutMs,
    providerHttpFailure: budgetExhausted || providerResponses.some(response => response.status >= 400),
  });
  if (budgetExhausted) issues.push("evaluation_budget_exhausted");
  if (!options.baseline && !budgetExhausted) issues.push(...evaluateScenarioScope(options.scenario, interpretedPlan, fixture.outcomes.filter(outcome => options.scenario.expectedKind === "meeting_metadata" || outcome.coverage.purpose !== "metadata").map(outcome => outcome.meetingRef)));
  if (options.scenario.dataset === "revoked" && /cobalt|marigold|saffron/i.test(answer)) issues.push("private_answer_after_revocation");
  if (modelCalls > 4) issues.push("model_call_limit");
  return {
    id: `${options.model}:${options.scenario.id}:${options.variant}:${options.repeat}`, scenarioId: options.scenario.id, variant: options.variant,
    repeat: options.repeat, model: options.model, mode: options.baseline ? "baseline" : "controller", errorCode, providerResponses, modelTimings, interpretedPlan, interpretationInput, phases, toolTrace: trace,
    evidenceReads: fixture.evidenceReads, bodyReads: fixture.bodyReads, packageChars, promptTokens, completionTokens,
    modelCalls, servedModels: [...servedModels], elapsedMs, firstAnswerMs, timeoutMs: options.timeoutMs, issues,
    answerable: options.scenario.answerable, semanticReview: "pending", contextOverflow,
    ...(options.scenario.expectedKind === "general" ? { generalStreaming: assessGeneralStreaming([...answerStreams.values()]) } : {}),
    answerWhileModelOpen, answer, fixtureOutcomes: fixture.outcomes, diagnostics,
  };
}

export interface MeetingEvalReport {
  schemaVersion: 1;
  syntheticOnly: true;
  generatedAt: string;
  revision: string;
  dirtyWorktree: boolean;
  runtime: string;
  controllerContractVersion: 2;
  scenarioCount: number;
  selectedScenarioIds?: string[];
  variantsPerScenario: 3;
  repeats: number;
  plannedControllerRuns: number;
  completedControllerRuns: number;
  realModelRequests: number;
  /** Absent only on historical reports, which retain the original fixed cutoff. */
  latencyPolicy?: LatencyPolicy;
  latencyReviews?: LatencyReview[];
  /** Optional only for legacy reports and offline runs without selected controls. */
  maxModelRequests?: number;
  inventoryRequests?: number;
  pacing?: {
    minIdleMs: number;
    /** No wait before inventory or the first turn; one record per later boundary. */
    waits: Array<{ beforeRunId: string; mode: EvalRun["mode"]; requestedMs: number; actualMs: number; idleMs: number }>;
  };
  offeredModels: string[];
  providerInventory: string[];
  providerInventoryResponse?: ProviderResponseDiagnostic;
  blocked: string[];
  releaseReady: boolean;
  models: Record<string, ReturnType<typeof summarizeModel>>;
  runs: EvalRun[];
}

function summarizeReportModel(report: MeetingEvalReport, model: string) {
  return summarizeModel(report.runs.filter(run => run.model === model && run.mode === "controller"), {
    latencyPolicy: report.latencyPolicy,
    latencyReview: report.latencyReviews?.find(review => review.model === model && review.reportGeneratedAt === report.generatedAt),
  });
}

export function isCompleteReleaseMatrix(report: Pick<MeetingEvalReport, "scenarioCount" | "selectedScenarioIds" | "plannedControllerRuns" | "repeats" | "offeredModels"> & { runs: Array<Pick<EvalRun, "model" | "scenarioId" | "variant" | "repeat" | "mode">> }): boolean {
  if (report.repeats < 2 || report.scenarioCount !== MEETING_EVAL_SCENARIOS.length || report.selectedScenarioIds && MEETING_EVAL_SCENARIOS.some(scenario => !report.selectedScenarioIds!.includes(scenario.id))) return false;
  const expected = new Set(report.offeredModels.flatMap(model => MEETING_EVAL_SCENARIOS.flatMap(scenario => Array.from({ length: 3 }, (_, variant) => Array.from({ length: report.repeats }, (_, repeat) => `${model}:${scenario.id}:${variant}:${repeat}`)).flat())));
  const actual = report.runs.filter(run => run.mode === "controller").map(run => `${run.model}:${run.scenarioId}:${run.variant}:${run.repeat}`);
  return expected.size > 0 && report.plannedControllerRuns === expected.size && actual.length === expected.size && new Set(actual).size === expected.size && actual.every(id => expected.has(id));
}

function validateInteger(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 through ${max}`);
  return value;
}

/** Sequential turns stop at the first rate limit or budget denial; no retries. */
export async function runEvaluationMatrix(report: MeetingEvalReport, options: {
  scenarios: MeetingEvalScenario[]; apiKey: string; baseUrl: string; timeoutMs: number;
  minIdleMs: number; maxModelRequests: number;
  now?: () => number; wait?: (ms: number) => Promise<void>;
  save: () => Promise<void>; providerFetch?: typeof fetch; onRun?: (run: EvalRun) => void;
}): Promise<boolean> {
  validateInteger("min-idle-ms", options.minIdleMs, 3_600_000);
  validateInteger("max-model-requests", options.maxModelRequests, 100_000);
  validateInteger("timeout-ms", options.timeoutMs, 2_147_483_647);
  validateInteger("repeats", report.repeats, 1000);
  if (report.runs.length || report.realModelRequests || report.inventoryRequests || report.blocked.length) throw new Error("Evaluation requires a fresh report; resumption is unsupported");
  report.maxModelRequests = options.maxModelRequests;
  report.pacing = { minIdleMs: options.minIdleMs, waits: [] };
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let lastTurnFinishedAt: number | undefined;
  const admitModelRequest = () => {
    if (report.realModelRequests >= options.maxModelRequests) return false;
    report.realModelRequests++;
    return true;
  };
  const stopForBudget = async () => {
    report.blocked.push("evaluation_budget_exhausted");
    report.releaseReady = false;
    await options.save();
  };
  const providerFetch = options.providerFetch ?? fetch;
  report.inventoryRequests = 1;
  const inventory = await providerFetch(`${options.baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${options.apiKey}` }, signal: AbortSignal.timeout(Math.min(options.timeoutMs, 30_000)) });
  report.providerInventoryResponse = providerResponseDiagnostic(inventory);
  if (!inventory.ok) {
    report.blocked.push(inventory.status === 429 ? "provider_rate_limited" : `provider_inventory_http_${inventory.status}`);
    report.releaseReady = false;
    await inventory.body?.cancel();
    await options.save();
    return false;
  }
  const catalog = await inventory.json() as { data?: Array<{ id?: string }> };
  report.providerInventory = (catalog.data ?? []).map(item => item.id).filter((id): id is string => typeof id === "string" && report.offeredModels.includes(id));
  const missing = report.offeredModels.filter(model => !report.providerInventory.includes(model));
  if (missing.length) report.blocked.push(`Offered models absent from current provider inventory: ${missing.join(", ")}`);
  await options.save();
  const record = async (run: EvalRun) => {
    report.runs.push(run);
    report.completedControllerRuns = report.runs.filter(item => item.mode === "controller").length;
    report.realModelRequests = report.runs.reduce((total, item) => total + item.modelCalls, 0);
    report.models[run.model] = summarizeReportModel(report, run.model);
    const stopReason = run.providerResponses.some(response => response.status === 429) ? "provider_rate_limited"
      : run.errorCode === "evaluation_budget_exhausted" ? "evaluation_budget_exhausted" : undefined;
    if (stopReason) report.blocked.push(stopReason);
    report.releaseReady = false;
    await options.save();
    options.onRun?.(run);
    return Boolean(stopReason);
  };
  const pair = (run: EvalRun, baseline: EvalRun) => {
    run.baselineFirstAnswerMs = baseline.firstAnswerMs;
    run.baselineModelCalls = baseline.modelCalls;
    run.baselineValid = baseline.issues.length === 0 && baseline.firstAnswerMs !== undefined && !baseline.contextOverflow && baseline.generalStreaming !== "failed";
  };
  const pacedTurn = async (turn: Parameters<typeof runScenario>[0]): Promise<EvalRun | undefined> => {
    if (report.realModelRequests >= options.maxModelRequests) { await stopForBudget(); return; }
    if (lastTurnFinishedAt !== undefined) {
      const waitStartedAt = now();
      const target = lastTurnFinishedAt + options.minIdleMs;
      const requestedMs = Math.max(0, target - waitStartedAt);
      // Timers may wake early; enforce the minimum against the monotonic clock.
      while (now() < target) await wait(target - now());
      const finishedAt = now();
      report.pacing!.waits.push({ beforeRunId: `${turn.model}:${turn.scenario.id}:${turn.variant}:${turn.repeat}`,
        mode: turn.baseline ? "baseline" : "controller", requestedMs, actualMs: finishedAt - waitStartedAt, idleMs: finishedAt - lastTurnFinishedAt });
    }
    const run = await runScenario({ ...turn, admitModelRequest });
    lastTurnFinishedAt = now();
    return run;
  };
  for (const model of report.providerInventory) for (const scenario of options.scenarios) for (let variant = 0; variant < 3; variant++) for (let repeat = 0; repeat < report.repeats; repeat++) {
    const turn = { model, scenario, variant, repeat, apiKey: options.apiKey, baseUrl: options.baseUrl, timeoutMs: options.timeoutMs, providerFetch };
    let baseline: EvalRun | undefined;
    // Paired baseline ordering alternates to reduce provider-warmup/order bias.
    if (scenario.expectedKind === "general" && repeat % 2 === 0) {
      baseline = await pacedTurn({ ...turn, baseline: true });
      if (!baseline) return false;
      if (await record(baseline)) return false;
    }
    const run = await pacedTurn(turn);
    if (!run) return false;
    if (baseline) pair(run, baseline);
    if (await record(run)) return false;
    if (scenario.expectedKind === "general" && repeat % 2 !== 0) {
      baseline = await pacedTurn({ ...turn, baseline: true });
      if (!baseline) return false;
      pair(run, baseline);
      if (await record(baseline)) return false;
    }
  }
  return true;
}

export async function main(args = process.argv.slice(2), providerFetch?: typeof fetch) {
  const valueFlags = new Set(["repeats", "models", "scenarios", "output", "review-file", "timeout-ms", "min-idle-ms", "max-model-requests"]);
  const seen = new Set<string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || seen.has(match[1]!) || (match[1] === "run" ? match[2] !== undefined : !valueFlags.has(match[1]!) || !match[2]?.trim())) throw new Error("Unknown, duplicate or malformed evaluation option");
    seen.add(match[1]!);
  }
  const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const integerOption = (name: string, max: number) => {
    const value = option(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must contain only integer digits`);
    return validateInteger(name, Number(value), max);
  };
  const execute = args.includes("--run");
  const repeats = integerOption("repeats", 1000) ?? 3;
  const minIdleMs = integerOption("min-idle-ms", 3_600_000);
  const maxModelRequests = integerOption("max-model-requests", 100_000);
  const explicitTimeoutMs = integerOption("timeout-ms", 2_147_483_647);
  if (execute && (minIdleMs === undefined || maxModelRequests === undefined)) throw new Error("--run requires explicit --min-idle-ms and --max-model-requests");
  const selectedIds = option("models")?.split(",");
  const scenarios = selectScenarios(option("scenarios"));
  const offered = OFFERED_CHAT_MODELS.map(model => model.id).filter(id => !selectedIds || selectedIds.includes(id));
  if (!offered.length || selectedIds && (new Set(selectedIds).size !== selectedIds.length || selectedIds.some(id => !OFFERED_CHAT_MODELS.some(model => model.id === id)))) throw new Error("Choose distinct currently offered model IDs");
  const reportPath = resolve(option("output") ?? "artifacts/meeting-evaluation.json");
  if (option("review-file")) {
    if (execute) throw new Error("Review and provider evaluation are separate commands");
    const prior: MeetingEvalReport = JSON.parse(await readFile(reportPath, "utf8"));
    if (prior.schemaVersion !== 1 || prior.syntheticOnly !== true) throw new Error("Expected a synthetic meeting evaluation report");
    const input = JSON.parse(await readFile(resolve(option("review-file")!), "utf8"));
    if (!Array.isArray(input) && (!input || typeof input !== "object" || Object.keys(input).some(key => !["semanticReviews", "latencyReviews"].includes(key))
      || !Array.isArray(input.semanticReviews) || !Array.isArray(input.latencyReviews))) throw new Error("Expected a semantic review array or { semanticReviews, latencyReviews } arrays");
    const reviews: SemanticReview[] = Array.isArray(input) ? input : input.semanticReviews;
    const latencyReviews: LatencyReview[] = Array.isArray(input) ? [] : input.latencyReviews;
    if (latencyReviews.length && prior.latencyPolicy !== "reviewed-responsiveness-v1") throw new Error("Historical reports cannot adopt a new latency policy through review");
    const seenModels = new Set<string>();
    for (const review of latencyReviews) {
      if (!review || !prior.offeredModels.includes(review.model) || seenModels.has(review.model) || review.reportGeneratedAt !== prior.generatedAt
        || typeof review.acceptable !== "boolean" || typeof review.notes !== "string" || !review.notes.trim() || review.notes.length > 4000) throw new Error("Unknown model, mismatched report, duplicate or malformed latency review");
      seenModels.add(review.model);
    }
    if (latencyReviews.length) prior.latencyReviews = [...(prior.latencyReviews ?? []).filter(review => !seenModels.has(review.model)), ...latencyReviews];
    for (const review of reviews) {
      const run = prior.runs.find(item => item.id === review.runId && item.mode === "controller");
      if (!run || !["supported", "correctMeetingCitations", "honestCoverage", "useful", "noPrivateAnswerOnRevocation"].every(key => typeof (review as any)[key] === "boolean")) throw new Error("Unknown run or incomplete semantic review");
      const issues = semanticReviewIssues(review);
      run.issues = [...new Set([...run.issues, ...issues])];
      run.semanticReview = issues.length ? "failed" : "passed";
    }
    for (const model of prior.offeredModels) prior.models[model] = summarizeReportModel(prior, model);
    const complete = isCompleteReleaseMatrix(prior);
    prior.blocked = prior.blocked.filter(reason => !reason.startsWith("Semantic review") && !reason.startsWith("Latency review"));
    if (prior.runs.some(run => run.mode === "controller" && run.semanticReview === "pending")) prior.blocked.push("Semantic review is pending for some controller runs.");
    if (prior.offeredModels.some(model => prior.models[model]?.latencyReviewStatus === "pending")) prior.blocked.push("Latency review is pending for some models.");
    prior.releaseReady = complete && !prior.blocked.length && prior.offeredModels.every(model => prior.models[model]?.releaseReady);
    await writeFile(reportPath, JSON.stringify(prior, null, 2) + "\n");
    console.log(JSON.stringify({ output: reportPath, releaseReady: prior.releaseReady, models: prior.models }));
    return;
  }
  const key = process.env.REDPILL_API_KEY;
  const baseUrl = process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1";
  const timeoutMs = explicitTimeoutMs ?? (process.env.AGENT_STREAM_TURN_TIMEOUT_MS === undefined ? undefined
    : validateInteger("AGENT_STREAM_TURN_TIMEOUT_MS", Number(process.env.AGENT_STREAM_TURN_TIMEOUT_MS), 2_147_483_647));
  const cwd = new URL("../../", import.meta.url).pathname;
  const git = (...arguments_: string[]) => execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
  const report: MeetingEvalReport = {
    schemaVersion: 1, syntheticOnly: true, generatedAt: new Date().toISOString(), revision: git("rev-parse", "HEAD"),
    dirtyWorktree: Boolean(git("status", "--porcelain")), runtime: process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.versions.node}`, controllerContractVersion: 2,
    scenarioCount: scenarios.length, selectedScenarioIds: scenarios.map(scenario => scenario.id), variantsPerScenario: 3, repeats,
    plannedControllerRuns: scenarios.length * 3 * repeats * offered.length,
    completedControllerRuns: 0, realModelRequests: 0, inventoryRequests: 0, maxModelRequests, latencyPolicy: "reviewed-responsiveness-v1",
    ...(minIdleMs === undefined ? {} : { pacing: { minIdleMs, waits: [] } }),
    offeredModels: offered, providerInventory: [], blocked: [], releaseReady: false, models: {}, runs: [],
  };
  const save = async () => {
    report.completedControllerRuns = report.runs.filter(run => run.mode === "controller").length;
    report.realModelRequests = report.runs.reduce((total, run) => total + run.modelCalls, 0);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  };
  if (!execute) report.blocked.push("Dry run only. Pass --run after deterministic acceptance to send synthetic evaluation requests.");
  if (!key) report.blocked.push("REDPILL_API_KEY is unavailable; no provider requests can be made.");
  if (timeoutMs === undefined) report.blocked.push("Supply the measured AGENT_STREAM_TURN_TIMEOUT_MS or an explicit --timeout-ms turn deadline.");
  if (report.blocked.length) { await save(); console.log(JSON.stringify({ output: reportPath, blocked: report.blocked, plannedControllerRuns: report.plannedControllerRuns })); return; }
  const completed = await runEvaluationMatrix(report, { scenarios, apiKey: key!, baseUrl, timeoutMs: timeoutMs!, minIdleMs: minIdleMs!, maxModelRequests: maxModelRequests!, save, providerFetch,
    onRun: run => console.log(JSON.stringify({ model: run.model, scenario: run.scenarioId, variant: run.variant, repeat: run.repeat, mode: run.mode, elapsedMs: run.elapsedMs, issues: run.issues, errorCode: run.errorCode, providerResponses: run.providerResponses })),
  });
  if (!completed) { console.log(JSON.stringify({ output: reportPath, releaseReady: false, blocked: report.blocked })); return; }
  report.blocked.push("Semantic review of synthetic answers and citations is pending; automated checks alone do not establish factual support.");
  report.blocked.push("Latency review is pending for some models.");
  if (scenarios.length !== MEETING_EVAL_SCENARIOS.length) report.blocked.push("Partial scenario matrix: diagnostic runs cannot establish release readiness.");
  report.releaseReady = false;
  await save();
  console.log(JSON.stringify({ output: reportPath, releaseReady: report.releaseReady, models: report.models }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
