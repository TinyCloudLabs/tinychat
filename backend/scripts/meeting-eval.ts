/** Fixed synthetic contract screen through /api/agent/chat. This is not live model admission. */
import express from "express";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createAgentChatHandler,
  type AgentChatConfig,
} from "../src/routes/agent-chat.js";
import type {
  MeetingIntent,
  MeetingResult,
  SourceReference,
} from "@tinyboilerplate/core";
import { loadAdmittedMeetingProvider } from "../src/transcripts/meeting-provider.js";
import type { MeetingProviderAdmission } from "../src/transcripts/meeting-turn.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ref = (id: string): SourceReference => ({
  source: "fireflies",
  sourceId: id,
  meetingRef: id,
  revision: hash("snapshot:" + id),
});
const part = (id: string) => ({ id, question: id });
const refs = [ref("a"), ref("b"), ref("c")];
const texts = [
  "Ava chose COBALT_47.",
  "Ben owns PINE_21.",
  "Cy rejected AMBER_13.",
];
const baseIntent = (references = refs.slice(0, 1)): MeetingIntent => ({
  mode: "analysis",
  parts: [part("summary")],
  references,
});
const envelope = (reference: SourceReference, options: any = {}) => {
  const i = Math.max(
    0,
    refs.findIndex((r) => r.sourceId === reference.sourceId),
  );
  const text = texts[i];
  return {
    contractVersion: 3,
    kind: "evidence",
    reference,
    basis: "transcript",
    state: "complete",
    metadata: {
      title: reference.sourceId,
      startedAt: "2026-09-13T12:00:00Z",
      organizerEmail: null,
      participants: [],
      metadata: {},
    },
    original: {
      digest: hash(text),
      byteLength: Buffer.byteLength(text),
      recordCount: 1,
      extent: "known",
      captureComplete: null,
    },
    coverage: {
      fetched: true,
      decodedRecords: 1,
      totalRecords: 1,
      suppliedRecords: 1,
      processedRecords: null,
    },
    spans: [{ text, recordIndex: 0, start: 0, end: text.length }],
    omissions: [],
    overviewProvenance: null,
    ...options,
  };
};
interface Scenario {
  id: string;
  expected: MeetingResult["status"];
  intent?: MeetingIntent;
  parent?: any;
  providerFault?: "429" | "400" | "length" | "repair" | "empty";
  readFault?: "notes" | "partial" | "revoked";
  page?: boolean;
  omitSubjects?: boolean;
  requiredPoints: string[];
}
export const corpus: Scenario[] = [
  {
    id: "selected-complete-positional",
    expected: "completed",
    intent: baseIntent(),
    requiredPoints: ["COBALT_47"],
  },
  {
    id: "abc-two-parts",
    expected: "completed",
    intent: { ...baseIntent(refs), parts: [part("summary"), part("actions")] },
    requiredPoints: ["COBALT_47", "PINE_21", "AMBER_13"],
  },
  {
    id: "abc-omitted-bc-stays-partial",
    expected: "partial",
    intent: baseIntent(refs),
    omitSubjects: true,
    requiredPoints: ["COBALT_47", "PINE_21", "AMBER_13"],
  },
  {
    id: "notes-not-transcript",
    expected: "unavailable",
    intent: baseIntent(),
    readFault: "notes",
    requiredPoints: [],
  },
  {
    id: "parent-cab-second",
    expected: "completed",
    intent: { mode: "analysis", parts: [part("summary")], ordinal: 2 },
    parent: {
      messageId: "parent",
      turnId: "prior",
      sources: [refs[2], refs[0], refs[1]],
    },
    requiredPoints: ["COBALT_47"],
  },
  {
    id: "decoder-omission",
    expected: "unavailable",
    intent: baseIntent(),
    readFault: "partial",
    requiredPoints: [],
  },
  {
    id: "literal-search-row501",
    expected: "completed",
    intent: {
      mode: "search",
      parts: [part("search")],
      terms: ["COBALT_47"],
      filters: { participant: "Needle" },
      scope: "observed",
    },
    page: true,
    requiredPoints: ["COBALT_47"],
  },
  {
    id: "free-text-transient-synthesis",
    expected: "completed",
    providerFault: "429",
    requiredPoints: ["COBALT_47"],
  },
  {
    id: "shared-structural-repair",
    expected: "completed",
    intent: baseIntent(),
    providerFault: "repair",
    requiredPoints: ["COBALT_47"],
  },
  {
    id: "ordinary-400-terminal",
    expected: "failed",
    intent: baseIntent(),
    providerFault: "400",
    requiredPoints: [],
  },
  {
    id: "length-terminal",
    expected: "failed",
    intent: baseIntent(),
    providerFault: "length",
    requiredPoints: [],
  },
  {
    id: "revocation-after-read",
    expected: "unavailable",
    intent: baseIntent(refs.slice(0, 2)),
    readFault: "revoked",
    requiredPoints: [],
  },
];
const frame = (content: string, finish = "stop") =>
  new Response(
    `data: ${JSON.stringify({ id: "synthetic-provider", choices: [{ delta: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`,
  );
export async function runFixedScreen(provider?: {
  admission: MeetingProviderAdmission;
  apiKey: string;
  baseUrl: string;
}) {
  const attempts: any[] = [];
  for (let repeat = 0; repeat < 3; repeat++)
    for (const scenario of corpus) {
      const started = performance.now();
      let models = 0,
        syntheses = 0,
        reads = 0,
        upstreamRequests = 0,
        injectedProviderFrames = 0;
      const upstream = (url: string | URL | Request, init?: RequestInit) => {
        upstreamRequests++;
        return fetch(url, init);
      };
      const requests: any[] = [];
      const config: AgentChatConfig = {
        agentId: "synthetic",
        entityIdFor: () => "synthetic-entity",
        streamPolicy: {
          heartbeatMs: 20,
          turnTimeoutMs: 120000,
          drainGraceMs: 100,
        },
        streamRuntime: {
          now: () => performance.now(),
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (id) => clearTimeout(id as any),
          log: () => {},
        },
        elizaServiceUrl: "http://companion.invalid",
        elizaServiceSecret: "synthetic",
        redpillBaseUrl:
          provider?.baseUrl ?? "http://synthetic-provider.invalid",
        redpillApiKey: provider?.apiKey ?? "synthetic",
        defaultModel: () => "z-ai/glm-5.3",
        isModelOffered: () => true,
        meetingProvider: provider?.admission ?? {
          model: "z-ai/glm-5.3",
          admitted: true,
          contextTokens: 1048576,
          countInputTokens: () => 100,
        },
        fetchImpl: (async (url, init) => {
          const name = String(url),
            request = init?.body ? JSON.parse(String(init.body)) : {};
          requests.push({
            endpoint: name.split("/").at(-1),
            payloadDigest: hash(JSON.stringify(request)),
            privateMemorySupplied: JSON.stringify(request).includes(
              "FROZEN PRIVATE MEMORY MUST NOT ENTER MODEL",
            ),
          });
          if (name.endsWith("/capabilities"))
            return Response.json({
              meetingRetrieval: { contractVersion: 3 },
              buildRevision: "synthetic-v3",
            });
          if (name.endsWith("tinycloud_find_meetings")) {
            const start = request.args.after
              ? Number(request.args.after) + 1
              : 1;
            let rows = Array.from(
              { length: Math.min(100, 501 - start + 1) },
              (_, i) => ({
                source: "fireflies",
                sourceId: String(start + i),
                meetingRef: String(start + i),
                revision: hash("row:" + String(start + i)),
                readiness: "published",
                title: "Duplicate title",
                startedAt: "2026-09-13T12:00:00Z",
                participants: [
                  { name: start + i === 501 ? "Needle" : "Other" },
                ],
                organizerEmail: null,
                basis: "transcript",
              }),
            );
            if (!scenario.page)
              rows = refs.map((reference, index) => ({
                ...reference,
                readiness: "published",
                title: `Design ${String.fromCharCode(65 + index)} review`,
                startedAt: "2026-09-13T12:00:00Z",
                participants: [],
                organizerEmail: null,
                basis: "transcript",
              }));
            return Response.json({
              result: {
                data: {
                  contractVersion: 3,
                  kind: "page",
                  rows,
                  nextCursor: rows.at(-1)?.meetingRef ?? null,
                  exhausted: !scenario.page || start + rows.length > 501,
                  examinedRows: rows.length,
                  observedAt: "2026-09-14T12:00:00Z",
                  scope: "observed",
                  omissions: [],
                },
              },
            });
          }
          if (name.endsWith("tinycloud_read_meeting")) {
            reads++;
            if (scenario.readFault === "revoked" && reads === 2)
              return Response.json(
                { error: "delegation_revoked" },
                { status: 403 },
              );
            return Response.json({
              result: {
                data: envelope(
                  request.args.reference,
                  scenario.readFault === "notes"
                    ? { basis: "notes" }
                    : scenario.readFault === "partial"
                      ? {
                          state: "partial",
                          omissions: [{ code: "unknown_record" }],
                        }
                      : {},
                ),
              },
            });
          }
          models++;
          if (request.messages[0].content.startsWith("Interpret only"))
            return provider
              ? upstream(String(url), init)
              : frame(
                  JSON.stringify({ kind: "meeting", intent: baseIntent() }),
                );
          syntheses++;
          if (
            provider &&
            !scenario.omitSubjects &&
            !(
              scenario.providerFault === "400" ||
              scenario.providerFault === "length" ||
              (syntheses === 1 &&
                ["429", "repair"].includes(scenario.providerFault ?? ""))
            )
          )
            return upstream(String(url), init);
          injectedProviderFrames++;
          if (scenario.providerFault === "400")
            return new Response("synthetic bad request", { status: 400 });
          if (scenario.providerFault === "429" && syntheses === 1)
            return new Response("synthetic rate limit", { status: 429 });
          if (scenario.providerFault === "length")
            return frame('{"answers":', "length");
          if (scenario.providerFault === "repair" && syntheses === 1)
            return frame('{"answers":[]}');
          const payload = JSON.parse(
            request.messages[1].content.split(
              "\nServer validation feedback:",
            )[0],
          );
          const obligations = scenario.omitSubjects
            ? payload.obligations.slice(0, 1)
            : payload.obligations;
          return frame(
            JSON.stringify({
              answers: obligations.map((o: any) => {
                const source = payload.evidence.find(
                  (e: any) => e.reference.sourceId === o.source.sourceId,
                );
                return {
                  obligationId: o.id,
                  text: source.spans[0].text,
                  citationIds: [source.spans[0].id],
                };
              }),
            }),
          );
        }) as typeof fetch,
      };
      const app = express();
      app.use(express.json({ limit: "2mb" }));
      app.use((req, _res, next) => {
        (req as any).user = { address: "0xsynthetic" };
        next();
      });
      app.post("/api/agent/chat", createAgentChatHandler(config));
      const server = await new Promise<any>((resolve) => {
        const server = app.listen(0, "127.0.0.1", () => resolve(server));
      });
      let result: MeetingResult | undefined;
      let transportComplete: boolean;
      try {
        const response = await fetch(
          `http://127.0.0.1:${server.address().port}/api/agent/chat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "z-ai/glm-5.3",
              messages: [
                {
                  id: "question",
                  role: "user",
                  content:
                    scenario.intent?.mode === "search"
                      ? "Find literal COBALT_47"
                      : scenario.intent
                        ? "Answer every requested part from the specified meetings."
                        : "Summarize the meeting titled Design A review.",
                },
              ],
              publicTools: false,
              clientContext: {
                localDate: "2026-09-14",
                timeZone: "Europe/Lisbon",
              },
              preparation: {
                memory: "FROZEN PRIVATE MEMORY MUST NOT ENTER MODEL",
                checkpoint: null,
              },
              turn: {
                turnId: `${scenario.id}-${repeat}`,
                sentAt: Date.now(),
                ...(scenario.intent ? { intent: scenario.intent } : {}),
                ...(scenario.parent
                  ? { parent: scenario.parent, parentMessageId: "parent" }
                  : {}),
              },
            }),
          },
        );
        const text = await response.text();
        transportComplete = text.includes("data: [DONE]");
        for (const line of text.split("\n"))
          if (line.startsWith("data: {")) {
            const value = JSON.parse(line.slice(6));
            if (value.meeting_result) result = value.meeting_result;
          }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const output = (result?.text ?? "").replace(
        /\\([\\`*_{}[\]<>#|])/g,
        "$1",
      );
      const recalled = scenario.requiredPoints.filter((point) =>
        output.includes(point),
      );
      const unsupported = texts
        .map((text) => text.match(/[A-Z]+_\d+/)?.[0])
        .filter(
          (point) =>
            point &&
            output.includes(point) &&
            !result?.citations.some((c) => c.text.includes(point)),
        );
      const expectedModelCalls = scenario.readFault
        ? 0
        : scenario.intent?.mode === "search"
          ? 0
          : scenario.providerFault === "429"
            ? 3
            : scenario.providerFault === "repair"
              ? 2
              : 1;
      const sameSource = (a: SourceReference, b: SourceReference) =>
        a.source === b.source &&
        a.sourceId === b.sourceId &&
        a.meetingRef === b.meetingRef &&
        a.revision === b.revision;
      const structuralChecks = {
        terminalStatus:
          transportComplete && result?.status === scenario.expected,
        citationsMatchSources:
          !!result &&
          result.citations.every((citation) =>
            result!.sources.some((source) => sameSource(source, citation)),
          ),
        fulfilledHaveCitations:
          !!result &&
          result.obligations
            .filter((o) => o.state === "fulfilled")
            .every(
              (o) =>
                o.source &&
                result!.citations.some((c) => sameSource(o.source!, c)),
            ),
        completedHasNoUnmetScope:
          !!result &&
          (result.status !== "completed" ||
            (result.obligations.every((o) => o.state === "fulfilled") &&
              result.limitations.length === 0 &&
              !result.continuation)),
        attemptBudget:
          models <= 3 &&
          (!provider ? models === expectedModelCalls : true) &&
          result?.receipts.modelCalls === models,
        noPrivateMemory: requests.every(
          (request) => request.privateMemorySupplied !== true,
        ),
      };
      attempts.push({
        scenario: scenario.id,
        repeat,
        route: "/api/agent/chat",
        syntheticProvider: !provider,
        upstreamRequests,
        injectedProviderFrames,
        output: result ?? null,
        expectedStatus: scenario.expected,
        status: result?.status ?? "interrupted",
        transportComplete,
        structuralChecks,
        structuralPass: Object.values(structuralChecks).every(Boolean),
        factualSupport: {
          supported: unsupported.length === 0,
          unsupportedMarkers: unsupported.length,
          method:
            "fixed synthetic marker annotations; not human semantic judgment",
        },
        requiredPointRecall: {
          required: scenario.requiredPoints.length,
          recalled: recalled.length,
          ratio: scenario.requiredPoints.length
            ? recalled.length / scenario.requiredPoints.length
            : null,
        },
        modelCalls: models,
        exactReads: reads,
        recovery: result?.receipts.recovery ?? "none",
        elapsedMs: Math.round(performance.now() - started),
        sourceDigests: result?.sources.map((r) => r.revision) ?? [],
        requests,
      });
    }
  const revision = (cwd: string) =>
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  return {
    kind: provider
      ? "admitted-provider-composite-screen"
      : "synthetic-contract-screen",
    liveProviderAdmitted: Boolean(provider),
    provider: {
      model: "z-ai/glm-5.3",
      reasoning_effort: "low",
      stream: true,
      include_usage: true,
      maxOutputTokens: 4096,
    },
    doesNotEstablish99PercentReliability: true,
    calendar: { localDate: "2026-09-14", timeZone: "Europe/Lisbon" },
    revisions: {
      tinychat: revision(process.cwd()),
      companion: revision("../tinycloud-agents"),
    },
    corpusDigest: hash(JSON.stringify(corpus)),
    attempts,
    totals: {
      attempts: attempts.length,
      structuralPasses: attempts.filter((a) => a.structuralPass).length,
      cleanCompleted: attempts.filter(
        (a) => a.status === "completed" && a.recovery === "none",
      ).length,
      internalRecoveries: attempts.filter((a) => a.recovery !== "none").length,
      partials: attempts.filter((a) => a.status === "partial").length,
      unavailable: attempts.filter((a) => a.status === "unavailable").length,
      failures: attempts.filter((a) => a.status === "failed").length,
      userRetries: 0,
      legacyControls: 0,
    },
    unperformed: [
      ...(!provider ? ["admitted-provider 36-attempt evaluation"] : []),
      "human semantic factual support and required-point review",
      "representative 99% reliability cohort",
      "production rollout",
    ],
  };
}
if (import.meta.main) {
  const live = process.argv[3] === "--admitted-provider";
  if (process.argv.length > 4 || (process.argv[3] && !live))
    throw new Error(
      "Usage: bun backend/scripts/meeting-eval.ts <output.json> [--admitted-provider]",
    );
  let provider: Parameters<typeof runFixedScreen>[0];
  if (live) {
    const admission = await loadAdmittedMeetingProvider(
      process.env.MEETING_TOKENIZER_DIRECTORY,
      process.env.MEETING_PROVIDER_GATE_RECEIPT,
    );
    if (!admission) throw new Error("meeting_provider_not_admitted");
    if (!process.env.REDPILL_API_KEY)
      throw new Error("provider_credential_missing");
    provider = {
      admission,
      apiKey: process.env.REDPILL_API_KEY,
      baseUrl: process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1",
    };
  }
  const report = await runFixedScreen(provider);
  const output = process.argv[2] ?? "../evidence/evaluation-synthetic.json";
  await Bun.write(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report.totals));
  if (report.totals.structuralPasses !== 36) process.exitCode = 1;
}
