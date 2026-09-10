import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const evalModel = "z-ai/glm-5.3";
function matrixReport(scenarios: import("./meeting-eval-fixtures.js").MeetingEvalScenario[]): import("./meeting-eval.js").MeetingEvalReport {
  return {
    schemaVersion: 1, syntheticOnly: true, generatedAt: "synthetic", revision: "synthetic", dirtyWorktree: false, runtime: "synthetic", controllerContractVersion: 2,
    scenarioCount: scenarios.length, selectedScenarioIds: scenarios.map(item => item.id), variantsPerScenario: 3, repeats: 2,
    plannedControllerRuns: scenarios.length * 6, completedControllerRuns: 0, realModelRequests: 0,
    offeredModels: [evalModel], providerInventory: [], blocked: [], releaseReady: false, models: {}, runs: [],
  };
}
const sse = (delta: object) => new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
const interpretation = (content = false) => sse({ tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: JSON.stringify(content
  ? { kind: "meeting_content", scope: "single", title: "Design", selectFirst: true, purpose: "summary", evidenceRequirement: "overview" }
  : { kind: "general" }) } }] });
const latencySamples = (): import("./meeting-eval.js").SummaryRun[] => Array.from({ length: 6 }, (_, index) => ({
  scenarioId: "ordinary-conversation", variant: index % 3, repeat: Math.floor(index / 3), issues: [], elapsedMs: 3200,
  firstAnswerMs: 3000, baselineFirstAnswerMs: 500, baselineValid: true, modelCalls: 2, baselineModelCalls: 1,
  answerable: true, semanticReview: "passed", contextOverflow: false, timeoutMs: 300000, generalStreaming: "passed",
}));

describe("controlled meeting evaluation", () => {
  test("reviewed responsiveness replaces the fixed cutoff only for new-policy reports", async () => {
    const { summarizeModel } = await import("./meeting-eval.js");
    const samples = latencySamples();
    const policy = { latencyPolicy: "reviewed-responsiveness-v1" as const };
    const accepted = { model: evalModel, reportGeneratedAt: "synthetic", acceptable: true, notes: "First answers within three seconds; no substantial controller stalls." };
    expect(summarizeModel(samples)).toMatchObject({ ordinaryLatencyPassed: false, releaseReady: false });
    expect(summarizeModel(samples, policy)).toMatchObject({ ordinaryPairingPassed: true, latencyReviewStatus: "pending", ordinaryLatencyPassed: false, releaseReady: false });
    expect(summarizeModel(samples.map(run => ({ ...run, firstAnswerMs: 600 })), policy)).toMatchObject({ latencyReviewStatus: "pending", releaseReady: false });
    expect(summarizeModel(samples, { ...policy, latencyReview: accepted })).toMatchObject({
      addedP95FirstAnswerMs: 2500, legacyAddedP95Within2000Ms: false, latencyReviewStatus: "passed", ordinaryLatencyPassed: true, releaseReady: true,
    });
    expect(summarizeModel(samples, { ...policy, latencyReview: { ...accepted, acceptable: false } })).toMatchObject({ latencyReviewStatus: "failed", releaseReady: false });
    expect(() => summarizeModel(samples, { latencyPolicy: "typo" } as any)).toThrow();
  });

  test("accepted responsiveness cannot bypass the other model gates", async () => {
    const { summarizeModel } = await import("./meeting-eval.js");
    const options = { latencyPolicy: "reviewed-responsiveness-v1" as const,
      latencyReview: { model: evalModel, reportGeneratedAt: "synthetic", acceptable: true, notes: "Reviewed ordinary timings and outliers." } };
    const samples = latencySamples();
    const invalid = [samples.slice(1), [...samples.slice(1), samples[1]!],
      ...[{ baselineValid: false }, { modelCalls: 3 }, { generalStreaming: "failed" as const }, { semanticReview: "failed" as const },
        { issues: ["wrong_intent"] }, { contextOverflow: true }, { elapsedMs: 250000 }, { issues: ["evaluation_budget_exhausted"] }]
        .map(change => [{ ...samples[0]!, ...change }, ...samples.slice(1)])];
    for (const runs of invalid) expect(summarizeModel(runs, options).releaseReady).toBe(false);
  });

  test("offline review binds qualitative decisions to the report and keeps legacy scoring", async () => {
    const evaluation = await import("./meeting-eval.js");
    const scenarios = evaluation.selectScenarios("ordinary-conversation");
    const report = { ...matrixReport(scenarios), latencyPolicy: "reviewed-responsiveness-v1" as const };
    report.runs = latencySamples().flatMap(sample => {
      const base = { ...sample, id: `${evalModel}:ordinary-conversation:${sample.variant}:${sample.repeat}`, model: evalModel,
        scenarioId: "ordinary-conversation", variant: sample.variant!, repeat: sample.repeat!, providerResponses: [], phases: [], toolTrace: [],
        evidenceReads: 0, bodyReads: 0, packageChars: 0, promptTokens: 0, completionTokens: 0, servedModels: [], answerWhileModelOpen: true,
        answer: "Hello!", fixtureOutcomes: [], diagnostics: [] };
      return [{ ...base, mode: "controller" as const }, { ...base, mode: "baseline" as const, modelCalls: 1, firstAnswerMs: 500 }];
    });
    const latency = { model: evalModel, reportGeneratedAt: report.generatedAt, acceptable: true, notes: "All six controller responses started within three seconds; baseline comparisons inspected." };
    const dir = await mkdtemp(join(import.meta.dir, ".latency-review-test-"));
    const output = join(dir, "report.json"), input = join(dir, "review.json");
    let requests = 0;
    const providerFetch = (async () => { requests++; throw new Error("unexpected network request"); }) as typeof fetch;
    const apply = async (body: unknown, target: unknown = report) => {
      await writeFile(output, JSON.stringify(target)); await writeFile(input, JSON.stringify(body));
      return evaluation.main([`--output=${output}`, `--review-file=${input}`], providerFetch);
    };
    const logging = spyOn(console, "log").mockImplementation(() => {});
    try {
      await apply([]);
      expect(JSON.parse(await readFile(output, "utf8")).models[evalModel]).toMatchObject({ latencyReviewStatus: "pending", releaseReady: false });
      await apply({ semanticReviews: [], latencyReviews: [latency] });
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(saved.latencyReviews).toEqual([latency]);
      expect(saved.models[evalModel]).toMatchObject({ ordinaryLatencyPassed: true, legacyAddedP95Within2000Ms: false });
      expect(saved.releaseReady).toBe(false); // Partial ordinary matrix remains incomplete.
      await apply([], { ...report, latencyPolicy: undefined });
      expect(JSON.parse(await readFile(output, "utf8")).models[evalModel].ordinaryLatencyPassed).toBe(false);
      for (const body of [
        { semanticReviews: [], latencyReviews: [{ ...latency, acceptable: "yes" }] },
        { semanticReviews: [], latencyReviews: [{ ...latency, notes: " " }] },
        { semanticReviews: [], latencyReviews: [{ ...latency, model: "unknown" }] },
        { semanticReviews: [], latencyReviews: [{ ...latency, reportGeneratedAt: "another batch" }] },
        { semanticReviews: [], latencyReviews: [latency, latency] },
        { semanticReviews: [], latencyReview: [latency] },
      ]) await expect(apply(body)).rejects.toThrow();
      await expect(apply({ semanticReviews: [], latencyReviews: [latency] }, { ...report, latencyPolicy: undefined })).rejects.toThrow();
      await expect(apply([], { ...report, latencyPolicy: "typo" })).rejects.toThrow();
      expect(requests).toBe(0);
    } finally { logging.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });

  test("paces every boundary in both pair orders without changing internal requests or turn clocks", async () => {
    const evaluation = await import("./meeting-eval.js");
    const scenarios = evaluation.selectScenarios("ordinary-conversation");
    const report = matrixReport(scenarios);
    let clock = 0;
    const monotonic = spyOn(performance, "now").mockImplementation(() => clock);
    const wallClock = spyOn(Date, "now").mockImplementation(() => 1_800_000_000_000 + clock);
    const events: string[] = [];
    const budgets: number[] = [];
    try {
    const completed = await evaluation.runEvaluationMatrix(report, { scenarios, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      minIdleMs: 60_000, maxModelRequests: 18, now: () => clock,
      wait: async ms => { events.push("wait"); clock += ms; },
      save: async () => { clock += 10; },
      providerFetch: (async (input, init) => {
        if (String(input).endsWith("/models")) { events.push("inventory"); return Response.json({ data: [{ id: evalModel }] }); }
        const request = JSON.parse(String(init?.body));
        const interpreting = request.tools?.some((tool: any) => tool.function.name === "prepare_meeting_turn");
        clock += 5;
        events.push(interpreting ? "interpretation" : "answer");
        if (interpreting) {
          expect(request.reasoning).toEqual({ enabled: false });
          expect(request.reasoning_effort).toBeUndefined();
          budgets.push(request.max_tokens);
        }
        expect(init?.signal?.aborted).toBe(false);
        return interpreting ? interpretation() : sse({ content: "Hello!" });
      }) as typeof fetch });
    expect(completed).toBe(true);
    expect(events).toEqual(["inventory", ...Array.from({ length: 3 }, (_, index) => [
      ...(index ? ["wait"] : []), "answer", "wait", "interpretation", "answer", "wait", "interpretation", "answer", "wait", "answer",
    ]).flat()]);
    expect(budgets).toEqual(Array(6).fill(1024));
    expect(report.runs.map(run => run.mode)).toEqual(Array(3).fill(["baseline", "controller", "controller", "baseline"]).flat());
    expect(report).toMatchObject({ inventoryRequests: 1, realModelRequests: 18, maxModelRequests: 18, blocked: [], pacing: { minIdleMs: 60_000 } });
    expect(report.pacing?.waits).toHaveLength(11);
    for (const [index, wait] of report.pacing!.waits.entries()) {
      expect(wait).toMatchObject({ beforeRunId: report.runs[index + 1]!.id, mode: report.runs[index + 1]!.mode, requestedMs: 59_990, actualMs: 59_990, idleMs: 60_000 });
    }
    for (const run of report.runs) {
      expect(run.issues).toEqual([]);
      expect(run.timeoutMs).toBe(5000);
      expect(run.elapsedMs).toBe(run.mode === "baseline" ? 5 : 10);
      expect(run.firstAnswerMs).toBe(run.mode === "baseline" ? 5 : 10);
      expect(run.modelTimings?.every(timing => timing.startedMs < 5000)).toBe(true);
    }
    } finally { monotonic.mockRestore(); wallClock.mockRestore(); }
  });

  test("pacing counts persistence as idle and rechecks an early timer wake", async () => {
    const evaluation = await import("./meeting-eval.js");
    for (const persistenceMs of [0, 70_000]) {
      const scenarios = evaluation.selectScenarios("ordinary-conversation");
      const report = matrixReport(scenarios);
      let clock = 0;
      const waits: number[] = [];
      await evaluation.runEvaluationMatrix(report, { scenarios, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
        minIdleMs: 60_000, maxModelRequests: 3, now: () => clock,
        wait: async ms => { waits.push(ms); clock += waits.length === 1 ? ms - 10 : ms; },
        save: async () => { clock += persistenceMs; },
        providerFetch: (async (input, init) => {
          if (String(input).endsWith("/models")) return Response.json({ data: [{ id: evalModel }] });
          const request = JSON.parse(String(init?.body));
          return request.tools?.some((tool: any) => tool.function.name === "prepare_meeting_turn") ? interpretation() : sse({ content: "Hello!" });
        }) as typeof fetch });
      expect(waits).toEqual(persistenceMs ? [] : [60_000, 10]);
      expect(report.pacing?.waits).toEqual([{ beforeRunId: report.runs[1]!.id, mode: "controller", requestedMs: persistenceMs ? 0 : 60_000, actualMs: persistenceMs ? 0 : 60_000, idleMs: persistenceMs || 60_000 }]);
    }
  });

  test("direct matrix calls validate controls and refuse resumption before inventory", async () => {
    const evaluation = await import("./meeting-eval.js");
    const scenarios = evaluation.selectScenarios("ordinary-conversation");
    let requests = 0;
    const options = { scenarios, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000, minIdleMs: 60_000, maxModelRequests: 18,
      save: async () => {}, providerFetch: (async () => { requests++; throw new Error("unexpected network request"); }) as typeof fetch };
    for (const key of ["minIdleMs", "maxModelRequests", "timeoutMs"] as const) {
      for (const value of [undefined, NaN, Infinity, -1, 0, .5, Number.MAX_SAFE_INTEGER]) {
        await expect(evaluation.runEvaluationMatrix(matrixReport(scenarios), { ...options, [key]: value } as typeof options)).rejects.toThrow();
      }
    }
    for (const prior of [{ realModelRequests: 1 }, { inventoryRequests: 1 }, { blocked: ["provider_rate_limited"] }]) {
      await expect(evaluation.runEvaluationMatrix({ ...matrixReport(scenarios), ...prior }, options)).rejects.toThrow("fresh report");
    }
    expect(requests).toBe(0);
  });

  test("the hard model budget stops at turn boundaries and between interpretation, synthesis and repair", async () => {
    const evaluation = await import("./meeting-eval.js");
    for (const [scenarioId, limit, expectedTurns, expectedWaits] of [
      ["ordinary-conversation", 1, 1, 0], ["ordinary-conversation", 2, 2, 1], ["ordinary-conversation", 3, 2, 1],
      ["single-overview", 1, 1, 0], ["single-overview", 2, 1, 0], ["single-overview", 3, 1, 0],
    ] as const) {
      const scenarios = evaluation.selectScenarios(scenarioId);
      const report = matrixReport(scenarios);
      const saved: typeof report[] = [];
      let clock = 0, requests = 0, waits = 0;
      const completed = await evaluation.runEvaluationMatrix(report, { scenarios, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
        minIdleMs: 60_000, maxModelRequests: limit, now: () => clock, wait: async ms => { waits++; clock += ms; },
        save: async () => { saved.push(structuredClone(report)); },
        providerFetch: (async (input, init) => {
          requests++;
          if (String(input).endsWith("/models")) return Response.json({ data: [{ id: evalModel }] });
          const request = JSON.parse(String(init?.body));
          if (request.tools?.some((tool: any) => tool.function.name === "prepare_meeting_turn")) return interpretation(scenarioId === "single-overview");
          // Invalid synthesis exercises the controller's real repair request.
          return sse({ content: scenarioId === "single-overview" ? "invalid synthesis" : "Hello!" });
        }) as typeof fetch });
      expect(completed).toBe(false);
      expect(requests).toBe(limit + 1);
      expect(waits).toBe(expectedWaits);
      expect(report.runs).toHaveLength(expectedTurns);
      expect(report.runs.reduce((n, run) => n + run.modelCalls, 0)).toBe(limit);
      expect(saved.at(-1)).toMatchObject({ realModelRequests: limit, inventoryRequests: 1, maxModelRequests: limit, releaseReady: false, blocked: ["evaluation_budget_exhausted"] });
      if (limit === 1 && scenarioId === "single-overview" || limit === 2) {
        expect(report.runs.at(-1)?.errorCode).toBe("evaluation_budget_exhausted");
        expect(report.runs.at(-1)?.issues).toEqual(["evaluation_budget_exhausted"]);
        expect(report.models[evalModel]).toMatchObject({ criticalErrors: 0, releaseReady: false });
      }
      if (scenarioId === "ordinary-conversation" && limit !== 2) expect(report.runs.at(-1)?.answer).toBe("Hello!");
    }
  });

  test("429 stops pacing and sends at inventory, baseline, interpretation, synthesis and repair", async () => {
    const evaluation = await import("./meeting-eval.js");
    for (const [scenarioId, limitedAt] of [["ordinary-conversation", 1], ["ordinary-conversation", 2], ["ordinary-conversation", 3], ["single-overview", 3], ["single-overview", 4]] as const) {
      const scenarios = evaluation.selectScenarios(scenarioId);
      const report = matrixReport(scenarios);
      let requests = 0, clock = 0, waits = 0;
      const saved: typeof report[] = [];
      expect(await evaluation.runEvaluationMatrix(report, { scenarios, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
        minIdleMs: 60_000, maxModelRequests: limitedAt - 1 || 1, now: () => clock, wait: async ms => { waits++; clock += ms; },
        save: async () => { saved.push(structuredClone(report)); },
        providerFetch: (async (input, init) => {
          if (++requests === limitedAt) return new Response(null, { status: 429, headers: { "retry-after": "120" } });
          if (String(input).endsWith("/models")) return Response.json({ data: [{ id: evalModel }] });
          const request = JSON.parse(String(init?.body));
          return request.tools?.some((tool: any) => tool.function.name === "prepare_meeting_turn") ? interpretation(scenarioId === "single-overview") : sse({ content: scenarioId === "single-overview" ? "invalid synthesis" : "Hello!" });
        }) as typeof fetch })).toBe(false);
      expect(requests).toBe(limitedAt);
      expect(waits).toBe(scenarioId === "ordinary-conversation" && limitedAt === 3 ? 1 : 0);
      expect(saved.at(-1)).toMatchObject({ releaseReady: false, blocked: ["provider_rate_limited"], inventoryRequests: 1, realModelRequests: limitedAt - 1 });
      expect(limitedAt === 1 ? report.providerInventoryResponse : report.runs.at(-1)?.providerResponses.at(-1)).toEqual({ status: 429, retryAfter: "120" });
    }
  });

  test("budget cutoff preserves an observed wrong intent without inventing missing-answer failures", async () => {
    const evaluation = await import("./meeting-eval.js");
    let admissions = 0, requests = 0;
    const run = await evaluation.runScenario({ model: evalModel, scenario: evaluation.selectScenarios("single-overview")[0]!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      admitModelRequest: () => ++admissions <= 1,
      providerFetch: (async () => { requests++; return interpretation(); }) as typeof fetch });
    expect(requests).toBe(1);
    expect(run.errorCode).toBe("evaluation_budget_exhausted");
    expect(run.issues).toEqual(["wrong_intent", "evaluation_budget_exhausted"]);
  });

  test("the final admitted stream finishes before stopping at the request ceiling", async () => {
    const evaluation = await import("./meeting-eval.js");
    const scenarios = evaluation.selectScenarios("ordinary-conversation");
    const report = matrixReport(scenarios);
    let stream: ReadableStreamDefaultController<Uint8Array>;
    let admittedSignal: AbortSignal | undefined;
    let announceAdmission!: () => void;
    const admitted = new Promise<void>(resolve => { announceAdmission = resolve; });
    const encode = (content: string) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    const pending = evaluation.runEvaluationMatrix(report, { scenarios, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      minIdleMs: 60_000, maxModelRequests: 1, save: async () => {}, wait: async () => { throw new Error("unexpected cooldown after ceiling"); },
      providerFetch: (async (input, init) => {
        if (String(input).endsWith("/models")) return Response.json({ data: [{ id: evalModel }] });
        admittedSignal = init?.signal ?? undefined;
        const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(encode("Hello")); } }));
        announceAdmission();
        return response;
      }) as typeof fetch });
    await admitted;
    expect(report.realModelRequests).toBe(1);
    expect(report.runs).toEqual([]);
    expect(admittedSignal?.aborted).toBe(false);
    stream!.enqueue(encode("!"));
    stream!.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
    stream!.close();
    expect(await pending).toBe(false);
    expect(report.runs[0]).toMatchObject({ answer: "Hello!", modelCalls: 1, issues: [] });
    expect(report.blocked).toEqual(["evaluation_budget_exhausted"]);
  });

  test("CLI rejects unsafe or misspelled controls before any network access", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(typeof evaluation.main).toBe("function");
    let requests = 0;
    const providerFetch = (async () => { requests++; throw new Error("unexpected network request"); }) as typeof fetch;
    const controls = ["--run", "--min-idle-ms=60000", "--max-model-requests=18"];
    const invalid = [
      ["--run"], controls.filter(arg => !arg.startsWith("--min-idle-ms=")), controls.filter(arg => !arg.startsWith("--max-model-requests=")),
      ...["--min-idle-ms", "--max-model-requests"].flatMap(flag => ["", "NaN", "Infinity", "-1", "0", "1.5", "9007199254740992"].map(value => [...controls.filter(arg => !arg.startsWith(`${flag}=`)), `${flag}=${value}`])),
      [...controls, "--min-idle-ms=60000"], [...controls, "--max-model-requests=18"], [...controls, "--run"],
      [...controls, "--min-idel-ms=60000"], [...controls, "--max-model-request=18"], [...controls, "--run=true"], [...controls, "unexpected"],
      [...controls, "--timeout-ms=Infinity"], [...controls, "--timeout-ms=2147483648"], [...controls, "--repeats=1001"],
      [...controls, "--models="], [...controls, "--models=z-ai/glm-5.3,z-ai/glm-5.3"], [...controls, "--scenarios=typo"], [...controls, "--output="], [...controls, "--review-file=x.json"],
      ["--run", "--min-idle-ms=3600001", "--max-model-requests=18"], ["--run", "--min-idle-ms=60000", "--max-model-requests=100001"],
    ];
    for (const args of invalid) await expect(evaluation.main(args, providerFetch)).rejects.toThrow();
    expect(requests).toBe(0);
  });

  test("captures bounded receipt correlation without unrelated response headers or raw stream text", async () => {
    const evaluation = await import("./meeting-eval.js");
    const receiptId = "rcpt-0123456789abcdef01234567";
    expect(evaluation.providerResponseDiagnostic(new Response(null, { headers: {
      "x-receipt-id": receiptId, "set-cookie": "DO_NOT_RETAIN_COOKIE", "server-timing": "DO_NOT_RETAIN_ARBITRARY_HEADER",
    } }))).toEqual({ status: 200, receiptId });
    for (const value of ["rcpt-short", "rcpt-" + "a".repeat(1000), "DO_NOT_RETAIN_HEADER"]) {
      expect(evaluation.providerResponseDiagnostic(new Response(null, { headers: { "x-receipt-id": value } }))).toEqual({ status: 200 });
    }
    const run = await evaluation.runScenario({ model: "z-ai/glm-5.3", scenario: evaluation.selectScenarios("ordinary-conversation")[0]!,
      variant: 0, repeat: 0, baseline: true, apiKey: "DO_NOT_RETAIN_KEY", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => new Response([
        'data: {"id":"DO_NOT_RETAIN_RESPONSE_ID","choices":[{"delta":{}}]}\n\n',
        'data: {"id":"chatcmpl-synthetic-route-check","choices":[{"delta":{"reasoning_content":"DO_NOT_RETAIN_REASONING"}}]}\n\n',
        'data: {"id":"chatcmpl-synthetic-route-check","choices":[{"delta":{"content":"Hello!"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join(""))) as typeof fetch });
    expect(run.modelTimings?.[0]).toMatchObject({ responseId: "chatcmpl-synthetic-route-check" });
    expect(run.modelTimings?.[0]?.requestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isFinite(Date.parse(run.modelTimings![0]!.requestStartedAt!))).toBe(true);
    expect(run.answer).toBe("Hello!");
    expect(JSON.stringify(run)).not.toContain("DO_NOT_RETAIN");
  });

  test("runs the real controller and parser against a synthetic provider without counting discovery as content", async () => {
    const { runScenario } = await import("./meeting-eval.js");
    const { MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    let requests = 0;
    const run = await runScenario({
      model: "moonshotai/kimi-k3", scenario: MEETING_EVAL_SCENARIOS[0]!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => {
        requests++;
        const delta = requests === 1
          ? { tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: JSON.stringify({ kind: "meeting_content", scope: "single", title: "Design", selectFirst: true, purpose: "summary", evidenceRequirement: "overview" }) } }] }
          : { content: JSON.stringify({ claims: [{ text: "The team approved the cobalt rollout.", meetingIds: ["M1"], evidenceIds: ["M1:E1"] }] }) };
        return new Response(`data: ${JSON.stringify({ model: "synthetic-served-model", choices: [{ delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    });
    expect(run.modelCalls).toBe(2);
    expect(run.interpretedPlan).toMatchObject({ kind: "meeting_content", scope: "single" });
    expect(run.interpretedPlan).toMatchObject({ filters: { title: "Design" }, timeZone: "Europe/Lisbon", sort: "newest", selectFirst: true });
    expect(run.interpretationInput).toMatchObject({ title: "Design", evidenceRequirement: "overview" });
    expect(run.evidenceReads).toBe(1);
    expect(run.bodyReads).toBe(0);
    expect(run.answer).toContain("cobalt");
    expect(run.issues).toEqual([]);
    expect(run.promptTokens).toBe(20);
    expect(run.servedModels).toEqual(["synthetic-served-model"]);
  });

  test("retains the observed gateway req response-id format when the receipt header is absent", async () => {
    const evaluation = await import("./meeting-eval.js");
    const responseId = "req_0123456789abcdef0123456789abcdef";
    const run = await evaluation.runScenario({ model: "z-ai/glm-5.3", scenario: evaluation.selectScenarios("ordinary-conversation")[0]!,
      variant: 0, repeat: 0, baseline: true, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => new Response(`data: ${JSON.stringify({ id: responseId, choices: [{ delta: { content: "Hello!" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)) as typeof fetch });
    expect(run.providerResponses).toEqual([{ status: 200 }]);
    expect(run.modelTimings?.[0]?.responseId).toBe(responseId);
  });

  test("records a context overflow even when the relay returns a generic turn failure", async () => {
    const { runScenario } = await import("./meeting-eval.js");
    const { MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    const run = await runScenario({
      model: "moonshotai/kimi-k3", scenario: MEETING_EVAL_SCENARIOS[0]!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => Response.json({ error: { code: "context_overflow" } }, { status: 413 })) as typeof fetch,
    });
    expect(run.contextOverflow).toBe(true);
  });
  test("synthetic discovery never counts as an evidence read", async () => {
    const fixtures = await import("./meeting-eval-fixtures.js");
    const fixture = fixtures.createFixtureService(fixtures.MEETING_EVAL_SCENARIOS[0]!);
    const found = fixture.dispatch("tinycloud_find_meetings", { selectFirst: true }, { retrievalMode: "single" });
    expect(found?.result?.data?.outcomes?.[0]?.state).toBe("metadata");
    expect(fixture.evidenceReads).toBe(0);
    const read = fixture.dispatch("tinycloud_read_meeting", { meetingRef: "synthetic-1", focus: "summary" }, { retrievalMode: "single" });
    expect(read?.result?.data?.outcomes?.[0]?.evidence?.[0]?.text).toContain("cobalt");
    expect(fixture.evidenceReads).toBe(1);
  });

  test("every synthetic service response respects the real v2 parser and complete response limit", async () => {
    const { createFixtureService, MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    const { parseMeetingToolData } = await import("../src/transcripts/meeting-evidence.js");
    for (const scenario of MEETING_EVAL_SCENARIOS) {
      const fixture = createFixtureService(scenario);
      for (const name of ["tinycloud_find_meetings", "tinycloud_list_meeting_actions"]) {
        const response = fixture.dispatch(name, { includeBody: true }, { retrievalMode: "range" });
        if (response.error) continue;
        expect(parseMeetingToolData(response.result.data)).not.toBeNull();
        expect(JSON.stringify(response).length).toBeLessThanOrEqual(16000);
      }
    }
  });
  test("covers at least twenty scenarios with three distinct paraphrases each", async () => {
    const { MEETING_EVAL_SCENARIOS: scenarios } = await import("./meeting-eval-fixtures.js");
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
    for (const scenario of scenarios) {
      expect(new Set(scenario.prompts).size).toBe(3);
      expect(scenario.prompts.every((prompt: string) => prompt.trim().length > 0)).toBe(true);
    }
  });

  test("rejects a content turn classified as general even if it never dispatches tools", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(evaluation.evaluateRun({
      expectedKind: "meeting_content", answerable: true, requiredFacts: ["cobalt"],
      interpretedKind: "general", answer: "Hello", toolNames: [], evidenceReads: 0,
      errorCode: undefined, elapsedMs: 100, timeoutMs: 1000,
    })).toEqual(expect.arrayContaining(["wrong_intent", "zero_evidence_reads", "missing_supported_fact"]));
  });

  test("does not count a safe refusal as a useful answer for an answerable case", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(evaluation.evaluateRun({
      expectedKind: "meeting_content", answerable: true, requiredFacts: ["cobalt"],
      interpretedKind: "meeting_content", answer: "Please specify a meeting.", toolNames: [], evidenceReads: 1,
      errorCode: undefined, elapsedMs: 100, timeoutMs: 1000,
    })).toContain("missing_supported_fact");
  });

  test("holds release readiness until semantic review and ordinary-chat latency gates pass", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(evaluation.summarizeModel([
      { issues: [], elapsedMs: 100, firstAnswerMs: 50, baselineFirstAnswerMs: 25, modelCalls: 2, baselineModelCalls: 1, answerable: true, semanticReview: "pending", contextOverflow: false, timeoutMs: 1000 },
    ])).toMatchObject({ releaseReady: false, semanticReviewComplete: false, usefulAnswerRate: 1 });
    expect(evaluation.summarizeModel([
      { issues: [], elapsedMs: 100, firstAnswerMs: 3050, baselineFirstAnswerMs: 25, modelCalls: 2, baselineModelCalls: 1, answerable: true, semanticReview: "passed", contextOverflow: false, timeoutMs: 1000 },
    ])).toMatchObject({ releaseReady: false, ordinaryLatencyPassed: false });
  });

  test("semantic review cannot approve unsupported facts or wrong-meeting attribution", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(evaluation.semanticReviewIssues({ supported: false, correctMeetingCitations: false, honestCoverage: true, useful: true, noPrivateAnswerOnRevocation: true }))
      .toEqual(["unsupported_claim", "wrong_meeting_citation"]);
  });

  test("fixture discovery applies title, participant, source and local calendar filters", async () => {
    const { createFixtureService, MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    const fixture = createFixtureService(MEETING_EVAL_SCENARIOS[0]!);
    for (const filters of [{ title: "absent" }, { participant: "absent" }, { source: "google-meet" }, { from: "2026-09-02" }, { to: "2026-08-31" }]) {
      expect(fixture.dispatch("tinycloud_find_meetings", filters, { retrievalMode: "range", timeZone: "Europe/Lisbon" }).result.data.discovery.matchedCount).toBe(0);
    }
    expect(fixture.dispatch("tinycloud_find_meetings", { participant: "example.invalid", title: "DESIGN", from: "2026-09-01", to: "2026-09-01" }, { retrievalMode: "range", timeZone: "Europe/Lisbon" }).result.data.discovery.matchedCount).toBe(1);
  });

  test("fixture orders discovery by instant and respects inclusive local date boundaries", async () => {
    const fixture = await import("./meeting-eval-fixtures.js");
    expect(typeof fixture.selectFixtureRows).toBe("function");
    const row = (meetingRef: string, startedAt: string | null) => ({ meetingRef, startedAt, source: "fireflies", title: "Design", participants: ["Ava"], organizerEmail: null });
    const rows = [row("older", "2026-09-01T22:59:00Z"), row("late", "2026-09-01T23:01:00Z"), row("undated", null)];
    expect(fixture.selectFixtureRows(rows, { from: "2026-09-02", to: "2026-09-02" }, "Europe/Lisbon").map(item => item.meetingRef)).toEqual(["late"]);
    expect(fixture.selectFixtureRows(rows, { sort: "oldest" }, "UTC").map(item => item.meetingRef)).toEqual(["older", "late", "undated"]);
    expect(fixture.selectFixtureRows(rows, {}, "UTC").map(item => item.meetingRef)).toEqual(["late", "older", "undated"]);
  });

  test("fixture content applies topic, speaker and assignee filters", async () => {
    const { createFixtureService, MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    for (const args of [{ focus: "speaker", speaker: "Ben" }, { focus: "topic", query: "violet" }, { focus: "actions", assignee: "Zoe" }]) {
      const fixture = createFixtureService(MEETING_EVAL_SCENARIOS[0]!);
      const result = fixture.dispatch(args.focus === "topic" ? "tinycloud_search_transcripts" : "tinycloud_read_meeting", { meetingRef: "synthetic-1", ...args });
      const evidence = result.result.data.outcomes[0].evidence;
      expect(args.focus === "actions" ? evidence.filter((item: { kind: string }) => item.kind === "action") : evidence).toEqual([]);
    }
  });

  test("assessment rejects wrong selected scope, relative interval and missing admitted reads", async () => {
    const evaluation = await import("./meeting-eval.js");
    const { MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    expect(typeof evaluation.evaluateScenarioScope).toBe("function");
    const selected = MEETING_EVAL_SCENARIOS.find(item => item.id === "selected-actions")!;
    expect(evaluation.evaluateScenarioScope(selected, { kind: "meeting_content", scope: "single", filters: {}, sort: "newest", selectFirst: true }, ["synthetic-1"])).toContain("wrong_scope");
    const range = MEETING_EVAL_SCENARIOS.find(item => item.id === "range-eight")!;
    const plan = { kind: "meeting_content", scope: "range", filters: { from: "2026-09-01", to: "2026-09-04" }, timeZone: "Europe/Lisbon", sort: "newest", selectFirst: false };
    expect(evaluation.evaluateScenarioScope(range, plan, ["synthetic-1"])).toEqual(expect.arrayContaining(["wrong_interval", "wrong_meeting_selection"]));
    plan.filters = { from: "2026-08-31", to: "2026-09-06" };
    expect(evaluation.evaluateScenarioScope(range, plan, Array.from({ length: 8 }, (_, i) => `synthetic-${i + 1}`))).toEqual([]);
    const metadata = MEETING_EVAL_SCENARIOS.find(item => item.id === "metadata-selected")!;
    expect(evaluation.evaluateScenarioScope(metadata, { kind: "meeting_metadata", scope: "selected", filters: {} }, ["synthetic-2"])).toContain("wrong_meeting_selection");
    expect(evaluation.evaluateScenarioScope(range, { ...plan, filters: { ...plan.filters, source: "fireflies" } }, Array.from({ length: 8 }, (_, i) => `synthetic-${i + 1}`))).toContain("unexpected_filter");
  });

  test("bounded scenario runs cannot qualify as a full release matrix", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(typeof evaluation.selectScenarios).toBe("function");
    const selected = evaluation.selectScenarios("single-overview,ordinary-conversation");
    expect(selected.map(item => item.id)).toEqual(["single-overview", "ordinary-conversation"]);
    expect(() => evaluation.selectScenarios("typo")).toThrow();
    expect(typeof evaluation.isCompleteReleaseMatrix).toBe("function");
    expect(evaluation.isCompleteReleaseMatrix({ scenarioCount: 2, selectedScenarioIds: selected.map(item => item.id), plannedControllerRuns: 12, repeats: 2, offeredModels: ["m"], runs: [] })).toBe(false);
    const all = evaluation.selectScenarios();
    const runs = all.flatMap(scenario => Array.from({ length: 3 }, (_, variant) => Array.from({ length: 2 }, (_, repeat) => ({ model: "m", scenarioId: scenario.id, variant, repeat, mode: "controller" as const }))).flat());
    const complete = { scenarioCount: all.length, selectedScenarioIds: all.map(item => item.id), plannedControllerRuns: runs.length, repeats: 2, offeredModels: ["m"], runs };
    expect(evaluation.isCompleteReleaseMatrix(complete)).toBe(true);
    expect(evaluation.isCompleteReleaseMatrix({ ...complete, runs: [...runs.slice(1), runs[1]!] })).toBe(false);
  });

  test("observable general answer buffering fails readiness while instant responses stay unobservable", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(typeof evaluation.assessGeneralStreaming).toBe("function");
    expect(evaluation.assessGeneralStreaming([{ firstContentMs: 20, endedMs: 25, firstDeliveredMs: 26 }])).toBe("unobservable");
    expect(evaluation.assessGeneralStreaming([{ firstContentMs: 20, endedMs: 120, firstDeliveredMs: 30 }])).toBe("passed");
    expect(evaluation.assessGeneralStreaming([{ firstContentMs: 20, endedMs: 120, firstDeliveredMs: 121 }])).toBe("failed");
    const runs = Array.from({ length: 6 }, () => ({ issues: [], elapsedMs: 100, firstAnswerMs: 50, baselineFirstAnswerMs: 25, modelCalls: 2, baselineModelCalls: 1, answerable: true, semanticReview: "passed" as const, contextOverflow: false, timeoutMs: 1000, generalStreaming: "failed" as const }));
    expect(evaluation.summarizeModel(runs).releaseReady).toBe(false);
  });

  test("unobservable streams cannot pass the streaming release gate", async () => {
    const { summarizeModel } = await import("./meeting-eval.js");
    const runs = Array.from({ length: 6 }, (_, index) => ({ scenarioId: "ordinary-conversation", variant: index % 3, repeat: Math.floor(index / 3), issues: [], elapsedMs: 100, firstAnswerMs: 50, baselineFirstAnswerMs: 25, baselineValid: true, modelCalls: 2, baselineModelCalls: 1, answerable: true, semanticReview: "passed" as const, contextOverflow: false, timeoutMs: 1000, generalStreaming: "unobservable" as const }));
    expect(summarizeModel(runs)).toMatchObject({ observableGeneralStreamingSamples: 0, generalStreamingPassed: false, releaseReady: false });
    expect(summarizeModel(runs.map(run => ({ ...run, generalStreaming: "passed" as const })))).toMatchObject({ generalStreamingPassed: true, releaseReady: true });
  });

  test("ordinary latency requires six successful distinct pairs across all three paraphrases", async () => {
    const { summarizeModel } = await import("./meeting-eval.js");
    const runs = Array.from({ length: 6 }, (_, index) => ({ scenarioId: "ordinary-conversation", variant: index % 3, repeat: Math.floor(index / 3), issues: [] as string[], elapsedMs: 100, firstAnswerMs: 50, baselineFirstAnswerMs: 25, baselineValid: true, modelCalls: 2, baselineModelCalls: 1, answerable: true, semanticReview: "passed" as const, contextOverflow: false, timeoutMs: 1000, generalStreaming: "passed" as const }));
    expect(summarizeModel(runs)).toMatchObject({ ordinaryPairedSamples: 6, ordinaryLatencyPassed: true });
    for (const invalid of [
      { ...runs[5], issues: ["turn_failed"] },
      { ...runs[5], scenarioId: "public-web" },
      { ...runs[5], baselineValid: undefined },
      { ...runs[5], contextOverflow: true },
      { ...runs[5], firstAnswerMs: Number.NaN },
      { ...runs[0] },
    ]) expect(summarizeModel([...runs.slice(0, 5), invalid])).toMatchObject({ ordinaryPairedSamples: 5, ordinaryLatencyPassed: false });
    const oneParaphrase = runs.map((run, repeat) => ({ ...run, variant: 0, repeat }));
    expect(summarizeModel(oneParaphrase)).toMatchObject({ ordinaryPairedSamples: 6, ordinaryLatencyPassed: false });
  });

  test("records each model request's timing without retaining reasoning text", async () => {
    const { runScenario, selectScenarios } = await import("./meeting-eval.js");
    let calls = 0;
    const run = await runScenario({
      model: "z-ai/glm-5.2", scenario: selectScenarios("ordinary-conversation")[0]!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => {
        const interpretation = ++calls === 1;
        const delta = interpretation ? { tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: '{"kind":"general"}' } }] } : { content: "Hello!" };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "DO_NOT_RETAIN_REASONING_TIMING" } }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ delta, finish_reason: interpretation ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
      }) as typeof fetch,
    });
    expect(run.modelTimings).toHaveLength(2);
    expect(run.modelTimings?.map(timing => timing.phase)).toEqual(["interpretation", "answer"]);
    for (const timing of run.modelTimings!) {
      expect(timing.headersMs).toBeGreaterThanOrEqual(timing.startedMs);
      expect(timing.firstDeltaMs).toBeGreaterThanOrEqual(timing.headersMs!);
      expect(timing.finishMs).toBeGreaterThanOrEqual(timing.firstDeltaMs!);
      expect(timing.protocolEndMs).toBeGreaterThanOrEqual(timing.finishMs!);
    }
    expect(run.modelTimings?.[0].firstToolDeltaMs).toBeDefined();
    expect(run.modelTimings?.[1].firstToolDeltaMs).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain("DO_NOT_RETAIN_REASONING_TIMING");
  });

  test("failed baseline calls remain failures and cannot qualify latency pairs", async () => {
    const evaluation = await import("./meeting-eval.js");
    const { MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    const run = await evaluation.runScenario({ model: "moonshotai/kimi-k3", scenario: MEETING_EVAL_SCENARIOS.find(item => item.id === "ordinary-conversation")!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000, baseline: true,
      providerFetch: (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch });
    expect(run.issues).toContain("turn_failed");
    expect(run.errorCode).toBe("upstream_failed");
    const pairs = Array.from({ length: 6 }, () => ({ issues: [], elapsedMs: 100, firstAnswerMs: 50, baselineFirstAnswerMs: 25, baselineValid: false, modelCalls: 2, baselineModelCalls: 1, answerable: true, semanticReview: "passed" as const, contextOverflow: false, timeoutMs: 1000 }));
    expect(evaluation.summarizeModel(pairs)).toMatchObject({ ordinaryPairedSamples: 0, ordinaryLatencyPassed: false, releaseReady: false });
  });

  test("a streamed inline tool call is not mistaken for a buffered general answer", async () => {
    const evaluation = await import("./meeting-eval.js");
    const { MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    let requests = 0;
    const run = await evaluation.runScenario({ model: "moonshotai/kimi-k3", scenario: MEETING_EVAL_SCENARIOS.find(item => item.id === "public-web")!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => {
        requests++;
        const delta = requests === 1 ? { tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: '{"kind":"general"}' } }] }
          : { content: requests === 2 ? "<tool_call>web_search<arg_key>query</arg_key><arg_value>Juniper museum</arg_value></tool_call>" : "The Juniper museum opens at 09:00." };
        const chunk = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
        return new Response(new ReadableStream({ async start(controller) {
          controller.enqueue(chunk({ choices: [{ delta }] }));
          if (requests > 1) await new Promise(resolve => setTimeout(resolve, 60));
          controller.enqueue(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        } }), { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch });
    expect(run.issues).toEqual([]);
    expect(run.generalStreaming).toBe("passed");
    expect(run.modelCalls).toBe(3);
  });

  test("provider HTTP failures record safe diagnostics without invented semantic failures", async () => {
    const evaluation = await import("./meeting-eval.js");
    const { MEETING_EVAL_SCENARIOS } = await import("./meeting-eval-fixtures.js");
    const run = await evaluation.runScenario({ model: "moonshotai/kimi-k3", scenario: MEETING_EVAL_SCENARIOS[0]!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => Response.json({ secret: "must-not-appear-in-report" }, { status: 429, headers: { "retry-after": "60", "x-private": "must-not-appear-in-report" } })) as typeof fetch });
    expect(run.providerResponses).toEqual([{ status: 429, retryAfter: "60" }]);
    expect(run.errorCode).toBe("provider_rate_limited");
    expect(run.issues).toEqual(["turn_failed"]);
    expect(JSON.stringify(run)).not.toContain("must-not-appear-in-report");
    expect(typeof evaluation.providerResponseDiagnostic).toBe("function");
    expect(evaluation.providerResponseDiagnostic(new Response(null, { status: 429, headers: { "retry-after": "credential-like arbitrary value" } }))).toEqual({ status: 429 });
    expect(evaluation.providerResponseDiagnostic(new Response(null, { status: 429, headers: { "retry-after": "Wed, 09 Sep 2026 21:00:00 GMT" } }))).toEqual({ status: 429, retryAfter: "Wed, 09 Sep 2026 21:00:00 GMT" });
  });

  test("a rate-limited matrix persists and schedules no later baseline, controller or model", async () => {
    const evaluation = await import("./meeting-eval.js");
    expect(typeof evaluation.runEvaluationMatrix).toBe("function");
    for (const scenarioIds of ["ordinary-conversation", "single-overview", "inventory"]) {
      const inventoryLimited = scenarioIds === "inventory";
      const scenarios = evaluation.selectScenarios(inventoryLimited ? "single-overview" : scenarioIds);
      const report: import("./meeting-eval.js").MeetingEvalReport = {
        schemaVersion: 1, syntheticOnly: true, generatedAt: "synthetic", revision: "synthetic", dirtyWorktree: false, runtime: "synthetic", controllerContractVersion: 2,
        scenarioCount: scenarios.length, selectedScenarioIds: scenarios.map(item => item.id), variantsPerScenario: 3, repeats: 2, plannedControllerRuns: 12,
        completedControllerRuns: 0, realModelRequests: 0, offeredModels: ["moonshotai/kimi-k3", "z-ai/glm-5.3"], providerInventory: [], blocked: [], releaseReady: false, models: {}, runs: [],
      };
      let requests = 0;
      const saved: typeof report[] = [];
      await evaluation.runEvaluationMatrix(report, { scenarios, apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
        minIdleMs: 1, maxModelRequests: 18,
        save: async () => { saved.push(structuredClone(report)); },
        providerFetch: (async () => ++requests === 1 && !inventoryLimited ? Response.json({ data: report.offeredModels.map(id => ({ id })) }) : new Response(null, { status: 429, headers: { "retry-after": "120" } })) as typeof fetch });
      expect(requests).toBe(inventoryLimited ? 1 : 2);
      expect(report.runs).toHaveLength(inventoryLimited ? 0 : 1);
      if (!inventoryLimited) expect(report.runs[0]!.mode).toBe(scenarioIds === "ordinary-conversation" ? "baseline" : "controller");
      expect(report.blocked).toContain("provider_rate_limited");
      expect(saved.at(-1)).toMatchObject({ releaseReady: false, realModelRequests: inventoryLimited ? 0 : 1, completedControllerRuns: scenarioIds === "single-overview" ? 1 : 0 });
      expect(evaluation.isCompleteReleaseMatrix(report)).toBe(false);
    }
  });

  test("a rate-limited synthesis cannot send another provider request for repair", async () => {
    const evaluation = await import("./meeting-eval.js");
    let requests = 0;
    const run = await evaluation.runScenario({ model: "moonshotai/kimi-k3", scenario: evaluation.selectScenarios("single-overview")[0]!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => {
        if (++requests > 1) return new Response(null, { status: 429 });
        const delta = { tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: JSON.stringify({ kind: "meeting_content", scope: "single", title: "Design", selectFirst: true, purpose: "summary", evidenceRequirement: "overview" }) } }] };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch });
    expect(requests).toBe(2);
    expect(run.modelCalls).toBe(2);
    expect(run.errorCode).toBe("provider_rate_limited");
    expect(run.issues).toEqual(["turn_failed"]);
  });

  test("first answer timing ignores delivered leading whitespace", async () => {
    const evaluation = await import("./meeting-eval.js");
    let requests = 0;
    const run = await evaluation.runScenario({ model: "moonshotai/kimi-k3", scenario: evaluation.selectScenarios("ordinary-conversation")[0]!, variant: 0, repeat: 0,
      apiKey: "synthetic", baseUrl: "https://provider.invalid/v1", timeoutMs: 5000,
      providerFetch: (async () => {
        if (++requests === 1) {
          const delta = { tool_calls: [{ index: 0, id: "prepare", function: { name: "prepare_meeting_turn", arguments: '{"kind":"general"}' } }] };
          return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(new ReadableStream({ async start(controller) {
        const frame = (content: string) => new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        controller.enqueue(frame("\n\n"));
        await new Promise(resolve => setTimeout(resolve, 60));
        controller.enqueue(frame("Hello!"));
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch });
    expect(run.answer).toBe("\n\nHello!");
    expect(run.firstAnswerMs).toBeGreaterThanOrEqual(50);
    expect(run.generalStreaming).toBe("unobservable");
  });
});
