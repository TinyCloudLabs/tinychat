/** One synthetic interpreter request; never continues to a provider answer call. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runScenario, providerResponseDiagnostic, type ProviderResponseDiagnostic } from "./meeting-eval.js";
import { MEETING_EVAL_SCENARIOS } from "./meeting-eval-fixtures.js";
import { parseSseJson } from "../src/routes/agent-chat.js";
import { isOfferedChatModel } from "../../packages/core/src/chatModels.js";

interface ProbeTiming {
  requestStartedAt?: string;
  headersMs?: number;
  firstDeltaMs?: number;
  firstToolDeltaMs?: number;
  finishMs?: number;
  /** Provider [DONE], not TCP EOF: the application cancels after [DONE]. */
  protocolEndMs?: number;
  observationEndedMs?: number;
}

export async function probeInterpretation(options: {
  apiKey: string; baseUrl: string; timeoutMs: number; model?: string; providerFetch?: typeof fetch;
}) {
  const model = options.model ?? "z-ai/glm-5.2";
  if (!isOfferedChatModel(model)) throw new Error("Choose an offered model");
  const timing: ProbeTiming = {};
  const providerFetch = options.providerFetch ?? fetch;
  let providerRequestCount = 0;
  let providerResponse: ProviderResponseDiagnostic | undefined;
  let requestSha256: string | undefined;
  let observation: Promise<void> | undefined;
  let transportFailed = false;
  const observerAbort = new AbortController();
  const run = await runScenario({
    ...options, model,
    scenario: MEETING_EVAL_SCENARIOS.find(scenario => scenario.id === "ordinary-conversation")!,
    variant: 0, repeat: 0,
    providerFetch: (async (input, init) => {
      const request = JSON.parse(String(init?.body));
      // The real controller builds the prompt, schema, budget and tool choice.
      // Stop locally on any continuation; no fabricated answer enters a score.
      if (providerRequestCount || request.tool_choice?.function?.name !== "prepare_meeting_turn") throw new Error("probe_continuation_disabled");
      delete request.reasoning_effort;
      request.reasoning = { enabled: false };
      const body = JSON.stringify(request);
      requestSha256 = createHash("sha256").update(body).digest("hex");
      providerRequestCount++;
      timing.requestStartedAt = new Date().toISOString();
      const start = performance.now();
      const elapsed = () => Math.round(performance.now() - start);
      let response: Response;
      try { response = await providerFetch(input, { ...init, body }); }
      catch { transportFailed = true; throw new Error("probe_transport_failed"); }
      timing.headersMs = elapsed();
      providerResponse = providerResponseDiagnostic(response);
      if (!response.ok || !response.body) return response;
      const [forwarded, observed] = response.body.tee();
      observation = (async () => {
        try {
          const signal = init?.signal ? AbortSignal.any([init.signal, observerAbort.signal]) : observerAbort.signal;
          for await (const frame of parseSseJson(observed, signal)) {
            const choice = (frame.choices as Array<{ delta?: Record<string, unknown>; finish_reason?: unknown }> | undefined)?.[0];
            if (choice?.delta && Object.values(choice.delta).some(value => value != null && value !== "")) timing.firstDeltaMs ??= elapsed();
            if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length) timing.firstToolDeltaMs ??= elapsed();
            if (choice?.finish_reason != null) timing.finishMs ??= elapsed();
          }
          timing.protocolEndMs = elapsed();
        } catch { /* The real controller determines validity; no raw error is retained. */ }
        finally { timing.observationEndedMs = elapsed(); }
      })();
      return new Response(forwarded, { status: response.status, statusText: response.statusText, headers: response.headers });
    }) as typeof fetch,
  }).finally(async () => {
    // Interpretation's child signal is detached on an early parser rejection.
    // The diagnostic must stop too, even when the provider leaves its body open.
    observerAbort.abort();
    await observation;
  });
  const controllerAcceptedGeneral = run.diagnostics.some(trace => trace.intent === "general");
  const compatible = providerResponse?.status === 200 && controllerAcceptedGeneral && timing.protocolEndMs !== undefined;
  return {
    syntheticOnly: true as const, diagnosticOnly: true as const, releaseReady: false as const,
    model, interpretationReasoning: { enabled: false },
    timeoutMs: options.timeoutMs, maxOutputTokens: 1024, providerRequestCount, providerResponse,
    requestSha256, timing, interpretedPlan: run.interpretedPlan, controllerAcceptedGeneral, compatible,
    // Controller continuation is intentionally stopped, so its final error is
    // not an interpretation failure and this cannot count as an ordinary pair.
    errorCode: providerResponse?.status === 429 ? "provider_rate_limited"
      : transportFailed ? "probe_transport_failed" : compatible ? undefined : "probe_interpretation_failed",
  };
}

async function main() {
  const args = process.argv.slice(2);
  const output = args.find(arg => arg.startsWith("--output="))?.slice(9);
  const model = args.find(arg => arg.startsWith("--model="))?.slice(8) ?? "z-ai/glm-5.2";
  if (!args.includes("--run") || !output || args.some(arg => arg !== "--run" && !arg.startsWith("--output=") && !arg.startsWith("--model="))) throw new Error("Use --run --output=<new-artifact.json> [--model=<offered-model>]");
  if (!isOfferedChatModel(model)) throw new Error("Choose an offered model");
  const apiKey = process.env.REDPILL_API_KEY;
  const timeoutMs = Number(process.env.AGENT_STREAM_TURN_TIMEOUT_MS);
  if (!apiKey || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Relay key and actual deployment deadline are required");
  // Reserve exclusively before any paid request; earlier evidence is immutable.
  const destination = await open(resolve(output), "wx");
  try {
    const sourceFiles = ["backend/scripts/meeting-interpretation-probe.ts", "backend/scripts/meeting-eval.ts", "backend/scripts/meeting-eval-fixtures.ts", "backend/src/routes/agent-chat.ts", "backend/src/transcripts/meeting-turn.ts"];
    const sourceHashes: Record<string, string> = {};
    for (const file of sourceFiles) sourceHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const result = await probeInterpretation({ apiKey, baseUrl: process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1", timeoutMs, model });
    const report = { generatedAt: new Date().toISOString(), revision, sourceHashes, bunVersion: process.versions.bun ?? "unavailable", ...result };
    await destination.writeFile(JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ output, model, providerRequestCount: result.providerRequestCount, providerResponse: result.providerResponse, compatible: result.compatible, errorCode: result.errorCode, timing: result.timing }));
  } finally { await destination.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Interpretation probe failed; check prerequisites and use a new output path. No raw error was logged."); process.exitCode = 1; });
}
