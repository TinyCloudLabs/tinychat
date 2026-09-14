import { expect, test } from "bun:test";
import { runMeetingTurn } from "../transcripts/meeting-turn.js";
import type { SourceReference } from "../../../packages/core/src/meeting-contract.js";

const ref = (id = "a"): SourceReference => ({
  source: "fireflies",
  sourceId: id,
  meetingRef: id,
  revision: id.padEnd(64, "0"),
});
const evidence = (reference = ref(), basis = "transcript") => ({
  contractVersion: 3,
  kind: "evidence",
  reference,
  basis,
  state: "complete",
  metadata: {
    title: reference.meetingRef,
    startedAt: null,
    organizerEmail: null,
    participants: [],
    metadata: {},
  },
  original: {
    digest: "d".repeat(64),
    byteLength: 31,
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
  spans: [
    {
      text: "Ava approved the cobalt launch.",
      recordIndex: 0,
      start: 0,
      end: 31,
      speaker: "Ava",
    },
  ],
  omissions: [],
  overviewProvenance: null,
});
function draft(sourceCount = 1, parts = ["summary"]) {
  return {
    answers: Array.from({ length: sourceCount }, (_, i) =>
      parts.map((part) => ({
        obligationId: `M${i + 1}:${part}`,
        text: "Ava approved the cobalt launch.",
        citationIds: [`M${i + 1}:E1`],
      })),
    ).flat(),
  };
}
const modelReply = (content: unknown) => ({
  content: JSON.stringify(content),
  calls: [],
  complete: true,
  finishReason: "stop",
  completionId: "fixture",
  promptTokens: 12,
  completionTokens: 5,
});
async function run(opts: any = {}) {
  const frames: string[] = [],
    calls: any[] = [],
    reads: any[] = [];
  let attempt = 0;
  const params: any = {
    config: {
      streamPolicy: { turnTimeoutMs: 120000 },
      meetingTrace: () => {},
      meetingProvider: {
        model: "z-ai/glm-5.3",
        admitted: true,
        countInputTokens: () => 100,
        contextTokens: 1048576,
      },
    },
    model: "z-ai/glm-5.3",
    entityId: "synthetic",
    roomId: "room",
    messages: [
      { role: "system", content: "PRIVATE MEMORY SENTINEL" },
      { role: "user", content: "Summarize meeting A." },
    ],
    turn: {
      turnId: "turn",
      sentAt: Date.now(),
      intent: {
        mode: "analysis",
        parts: [{ id: "summary", question: "Summarize" }],
        references: [ref()],
      },
    },
    turnContext: { localDate: "2026-09-14", timeZone: "Europe/Lisbon" },
    contextWindowTokens: 1048576,
    capability: async () => ({
      meetingRetrieval: { contractVersion: 3 },
      buildRevision: "fixture-v3",
    }),
    modelCall: async (request: any) => {
      calls.push(request);
      return opts.reply
        ? opts.reply(request, calls.length)
        : modelReply(draft());
    },
    dispatch: async (name: string, args: any) => {
      reads.push({ name, args });
      attempt++;
      return opts.dispatch
        ? opts.dispatch(name, args, attempt)
        : { status: "done", text: "", data: evidence(args.reference) };
    },
    write: async (frame: string) => {
      frames.push(frame);
    },
    contentFrame: (text: string) => text,
    toolActivityFrame: () => "",
    delegationErrorFrame: () => "",
    streamErrorCode: () => undefined,
    runGeneral: async () => ({
      promptTokens: 0,
      completionTokens: 0,
      completionId: "general",
    }),
    ...opts.params,
  };
  const result = await runMeetingTurn(params);
  return { result: result as any, calls, reads, frames };
}
test("explicit selected request reads exact revision then synthesizes once, without memory", async () => {
  const r = await run();
  expect(r.result.meetingResult?.status).toBe("completed");
  expect(r.calls).toHaveLength(1);
  expect(r.reads[0].args.reference).toEqual(ref());
  expect(JSON.stringify(r.calls)).not.toContain("PRIVATE MEMORY SENTINEL");
  expect(r.calls[0].messages).toHaveLength(2);
});
test("every meeting times part remains required when synthesis omits B and C", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "turn",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          parts: [
            { id: "summary", question: "Summary" },
            { id: "actions", question: "Actions" },
          ],
          references: [ref(), ref("b"), ref("c")],
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("partial");
  expect(r.result.meetingResult.obligations).toHaveLength(6);
  expect(
    r.result.meetingResult.obligations.filter((o: any) => o.state === "unmet"),
  ).toHaveLength(5);
});
test("notes never fulfill transcript obligations", async () => {
  const r = await run({
    dispatch: (_n: any, args: any) => ({
      status: "done",
      text: "",
      data: evidence(args.reference, "notes"),
    }),
  });
  expect(r.result.meetingResult.status).toBe("unavailable");
  expect(r.calls).toHaveLength(0);
});
test("oversize total exact input rejects all synthesis without fitting evidence", async () => {
  const r = await run({
    params: {
      config: {
        streamPolicy: { turnTimeoutMs: 120000 },
        meetingProvider: {
          model: "z-ai/glm-5.3",
          admitted: true,
          countInputTokens: () => 24001,
          contextTokens: 1048576,
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("unavailable");
  expect(r.calls).toHaveLength(0);
});
test("missing tokenizer admission is unavailable without invoking a provider", async () => {
  const r = await run({
    params: { config: { streamPolicy: { turnTimeoutMs: 120000 } } },
  });
  expect(r.result.meetingResult.status).toBe("unavailable");
  expect(r.calls).toHaveLength(0);
});
test("parent ordinal resolves stored displayed order and exact revision", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        parentMessageId: "p",
        parent: {
          messageId: "p",
          turnId: "prior",
          sources: [ref("c"), ref("a"), ref("b")],
        },
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summarize" }],
          ordinal: 2,
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("completed");
  expect(r.reads[0].args.reference).toEqual(ref("a"));
});
test("missing parent mapping clarifies without room fallback", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summarize" }],
          ordinal: 2,
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("clarification_required");
  expect(r.reads).toHaveLength(0);
});
test("one transient synthesis recovery and structural repair share allowance", async () => {
  const r = await run({
    reply: (_request: any, n: number) => {
      if (n === 1)
        throw Object.assign(new Error("network"), { transient: true });
      return modelReply({ answers: [] });
    },
  });
  expect(r.calls).toHaveLength(2);
  expect(r.result.meetingResult.status).toBe("failed");
  expect(r.result.meetingResult.receipts.recovery).toBe("transient");
});
test.each(["length", "empty", "reasoning"])(
  "%s output is terminal without repair",
  async (kind) => {
    const r = await run({
      reply: () => ({
        ...modelReply(draft()),
        ...(kind === "length"
          ? { complete: false, finishReason: "length" }
          : { content: "" }),
      }),
    });
    expect(r.calls).toHaveLength(1);
    expect(r.result.meetingResult.status).toBe("failed");
  },
);
test("incomplete original decode cannot become completed", async () => {
  const r = await run({
    dispatch: (_n: any, args: any) => ({
      status: "done",
      text: "",
      data: {
        ...evidence(args.reference),
        state: "partial",
        omissions: [{ code: "unrecognized_record" }],
      },
    }),
  });
  expect(r.result.meetingResult.status).toBe("unavailable");
  expect(r.calls).toHaveLength(0);
});
test("cancelled read never publishes a late answer", async () => {
  const stop = new AbortController();
  const r = await run({
    params: { signal: stop.signal },
    dispatch: (_n: any, args: any) => {
      stop.abort();
      return { status: "done", text: "", data: evidence(args.reference) };
    },
  });
  expect(r.result.meetingResult.status).toBe("cancelled");
  expect(r.calls).toHaveLength(0);
  expect(r.result.meetingResult.text).not.toContain("cobalt");
});
const catalogRow = (i: number) => ({
  ...ref(i.toString(16)),
  meetingRef: `meeting-${String(i).padStart(4, "0")}`,
  sourceId: String(i),
  readiness: "published",
  title: `Design ${i}`,
  startedAt: "2026-09-10T12:00:00Z",
  organizerEmail: null,
  participants: [{ name: i === 501 ? "Needle" : "Other" }],
  basis: "transcript",
});
function catalogDispatch(name: string, args: any) {
  if (name === "tinycloud_read_meeting")
    return { status: "done", text: "", data: evidence(args.reference) };
  const start = args.after ? Number(String(args.after).split("-")[1]) + 1 : 1;
  const rows = Array.from({ length: Math.min(100, 601 - start + 1) }, (_, j) =>
    catalogRow(start + j),
  );
  return {
    status: "done",
    text: "",
    data: {
      contractVersion: 3,
      kind: "page",
      rows,
      nextCursor: rows.at(-1)?.meetingRef ?? null,
      exhausted: start + rows.length > 601,
      examinedRows: rows.length,
      observedAt: "2026-09-14T12:00:00Z",
      scope: "observed",
      omissions: [],
    },
  };
}
test("participant-only discovery finds sole match at row 501 with filters before selection", async () => {
  const r = await run({
    dispatch: catalogDispatch,
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summarize" }],
          filters: { participant: "Needle" },
          scope: "observed",
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("completed");
  expect(
    r.reads.filter((r: any) => r.name === "tinycloud_find_meetings"),
  ).toHaveLength(7);
  expect(
    r.reads.find((r: any) => r.name === "tinycloud_read_meeting").args.reference
      .sourceId,
  ).toBe("501");
});
test("listing Continue resumes exactly before next unread source after reload", async () => {
  const first = await run({
    dispatch: catalogDispatch,
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "listing",
          parts: [{ id: "list", question: "List" }],
          scope: "observed",
        },
      },
    },
  });
  const c = JSON.parse(JSON.stringify(first.result.meetingResult.continuation));
  expect(first.calls).toHaveLength(0);
  expect(first.result.meetingResult.status).toBe("partial");
  expect(c.pending[0].sourceId).toBe("101");
  const second = await run({
    dispatch: catalogDispatch,
    params: { turn: { turnId: "next", sentAt: Date.now(), continuation: c } },
  });
  expect(second.result.meetingResult.sources[100].sourceId).toBe("101");
  expect(
    new Set(second.result.meetingResult.sources.map((r: any) => r.sourceId))
      .size,
  ).toBe(200);
});
test("exhaustion cannot turn exhaustive calendar request into completed observed scope", async () => {
  const r = await run({
    dispatch: catalogDispatch,
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summary" }],
          filters: { participant: "Needle" },
          scope: "exhaustive",
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("partial");
  expect(r.result.meetingResult.limitations).toContainEqual({
    code: "observed_scope_only",
  });
});
test("literal search includes neighboring records with original citations beyond old row 12", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["COBALT"],
          references: Array.from({ length: 13 }, (_, i) =>
            ref((i + 1).toString(16)),
          ),
        },
      },
    },
    dispatch: (_n: any, args: any) => {
      const text =
        args.reference.sourceId === "d"
          ? "Before. Cobalt won. After."
          : "Nothing relevant.";
      return {
        status: "done",
        text: "",
        data: {
          ...evidence(args.reference),
          spans: [{ text, recordIndex: 0, start: 0, end: text.length }],
          original: { ...evidence().original, byteLength: text.length },
        },
      };
    },
  });
  expect(r.result.meetingResult.status).toBe("completed");
  expect(r.result.meetingResult.text).toContain("Before. Cobalt won. After.");
  expect(r.reads).toHaveLength(13);
  expect(r.calls).toHaveLength(0);
});
test("failed first discovery consumes only one shared IO retry then performs required exact read", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summary" }],
          filters: { participant: "Needle" },
          scope: "observed",
        },
      },
    },
    dispatch: (name: any, args: any, attempt: number) =>
      attempt === 1
        ? { status: "error", text: "", code: "503" }
        : catalogDispatch(name, args),
  });
  expect(r.result.meetingResult.status).toBe("completed");
  expect(r.calls).toHaveLength(1);
  expect(r.reads[0].name).toBe("tinycloud_find_meetings");
  expect(r.reads[1].name).toBe("tinycloud_find_meetings");
});
test("free-text resolution uses one interpretation plus one synthesis and no historical prose", async () => {
  const r = await run({
    params: { turn: { turnId: "t", sentAt: Date.now() } },
    reply: (_req: any, n: number) =>
      n === 1
        ? modelReply({
            kind: "meeting",
            intent: {
              mode: "analysis",
              parts: [{ id: "summary", question: "Summary" }],
              references: [ref()],
            },
          })
        : modelReply(draft()),
  });
  expect(r.result.meetingResult.status).toBe("completed");
  expect(r.calls).toHaveLength(2);
  expect(JSON.stringify(r.calls)).not.toContain("PRIVATE MEMORY SENTINEL");
});
test("search returns matching sentence and neighbors, excluding distant text in the same raw record", async () => {
  const text = "Distant private detail. Before. Cobalt won. After. Far away.";
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["cobalt"],
          references: [ref()],
        },
      },
    },
    dispatch: (_n: any, args: any) => ({
      status: "done",
      text: "",
      data: {
        ...evidence(args.reference),
        spans: [{ text, recordIndex: 0, start: 0, end: text.length }],
      },
    }),
  });
  expect(r.result.meetingResult.text).toContain("Before.");
  expect(r.result.meetingResult.text).toContain("After.");
  expect(r.result.meetingResult.text).not.toContain("Distant private detail");
  expect(r.result.meetingResult.text).not.toContain("Far away");
});
test("search supplies adjacent records with their original speaker and offsets", async () => {
  const texts = ["Before.", "Cobalt won.", "After."];
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["cobalt"],
          references: [ref()],
        },
      },
    },
    dispatch: (_n: any, args: any) => ({
      status: "done",
      text: "",
      data: {
        ...evidence(args.reference),
        original: { ...evidence().original, recordCount: 3 },
        coverage: {
          fetched: true,
          decodedRecords: 3,
          totalRecords: 3,
          suppliedRecords: 3,
          processedRecords: null,
        },
        spans: texts.map((text, i) => ({
          text,
          recordIndex: i,
          start: 0,
          end: text.length,
          speaker: ["Ava", "Ben", "Ava"][i],
        })),
      },
    }),
  });
  expect(r.result.meetingResult.citations).toHaveLength(3);
  expect(r.result.meetingResult.text).toContain("Before.");
  expect(r.result.meetingResult.text).toContain("After.");
  expect(r.result.meetingResult.citations[1].speaker).toBe("Ben");
});
test("access revocation after first read prevents synthesis and emits reconnect code", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summary" }],
          references: [ref(), ref("b")],
        },
      },
    },
    dispatch: (_n: any, args: any, n: number) =>
      n === 1
        ? { status: "done", text: "", data: evidence(args.reference) }
        : { status: "error", text: "", code: "delegation_revoked" },
  });
  expect(r.calls).toHaveLength(0);
  expect(r.result.meetingResult.status).toBe("unavailable");
  expect(r.result.meetingResult.citations).toHaveLength(0);
  expect(r.result.meetingResult.limitations).toContainEqual({
    code: "delegation_revoked",
  });
});
test("duplicate-title single meeting request clarifies instead of answering arbitrary candidates", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          selection: "one",
          parts: [{ id: "summary", question: "Summarize design meeting" }],
          filters: { title: "Design" },
          scope: "observed",
        },
      },
    },
    dispatch: catalogDispatch,
  });
  expect(r.result.meetingResult.status).toBe("clarification_required");
  expect(r.calls).toHaveLength(0);
  expect(r.reads.every((x: any) => x.name === "tinycloud_find_meetings")).toBe(
    true,
  );
});
test("backend calendar preserves previous Monday-Sunday across DST", async () => {
  const { resolveMeetingRelativeDates } =
    await import("../transcripts/meeting-turn.js");
  expect(
    resolveMeetingRelativeDates("last_week", {
      localDate: "2026-03-30",
      timeZone: "Europe/Lisbon",
    }),
  ).toEqual({ from: "2026-03-23", to: "2026-03-29" });
  expect(
    resolveMeetingRelativeDates("last_week", {
      localDate: "2026-11-02",
      timeZone: "America/New_York",
    }),
  ).toEqual({ from: "2026-10-26", to: "2026-11-01" });
});
test("search retains useful matches when a later source read fails", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["cobalt"],
          references: [ref(), ref("b")],
        },
      },
    },
    dispatch: (_name: any, args: any) => {
      if (args.reference.sourceId === "b") throw new Error("later read failed");
      return { status: "done", text: "", data: evidence(args.reference) };
    },
  });
  expect(r.result.meetingResult.status).toBe("partial");
  expect(r.result.meetingResult.text).toContain("cobalt");
  expect(r.result.meetingResult.citations).toHaveLength(1);
  expect(r.result.meetingResult.continuation.pending[0]).toEqual(ref("b"));
});
test("unpublished catalog identities remain explicit unavailable scope", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "listing",
          parts: [{ id: "list", question: "List" }],
          scope: "observed",
        },
      },
    },
    dispatch: () => ({
      status: "done",
      text: "",
      data: {
        contractVersion: 3,
        kind: "page",
        rows: [
          {
            ...catalogRow(1),
            revision: null,
            readiness: "unverified",
            title: "Legacy original missing",
          },
        ],
        nextCursor: "meeting-0001",
        exhausted: true,
        examinedRows: 1,
        observedAt: "2026-09-14T12:00:00Z",
        scope: "observed",
        omissions: [],
      },
    }),
  });
  expect(r.result.meetingResult.text).toContain("Legacy original missing");
  expect(
    r.result.meetingResult.obligations.some(
      (o: any) => o.state === "unmet" && o.reason === "source_unavailable",
    ),
  ).toBe(true);
  expect(r.result.meetingResult.status).not.toBe("completed");
});
test("a missing frozen listing revision never fulfills a metadata obligation", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "listing",
          parts: [{ id: "list", question: "List" }],
          references: [ref()],
        },
      },
    },
    dispatch: () => ({
      status: "done",
      text: "",
      data: {
        ...evidence(),
        state: "missing",
        metadata: null,
        original: null,
        spans: [],
        coverage: {
          fetched: false,
          decodedRecords: 0,
          totalRecords: null,
          suppliedRecords: 0,
          processedRecords: null,
        },
        omissions: [{ code: "revision_unavailable" }],
      },
    }),
  });
  expect(r.result.meetingResult.status).toBe("unavailable");
  expect(
    r.result.meetingResult.obligations.every((o: any) => o.state === "unmet"),
  ).toBe(true);
});
test("invalid continuation terminates without restarting enumeration", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        continuation: {
          version: 3,
          intent: {
            mode: "listing",
            parts: [{ id: "list", question: "List" }],
          },
          pending: [],
          encountered: [],
          cursor: 7,
          exhausted: false,
          examinedSources: 0,
          matchedSources: 0,
        },
      },
    },
    dispatch: catalogDispatch,
  });
  expect(r.reads).toHaveLength(0);
  expect(r.result.meetingResult.status).toBe("clarification_required");
  expect(r.result.meetingResult.continuation).toBeUndefined();
});
test("a later failed body read preserves supported earlier answer and unmet source", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summary" }],
          references: [ref(), ref("b")],
        },
      },
    },
    dispatch: (_name: any, args: any) => {
      if (args.reference.sourceId === "b") throw new Error("later failure");
      return { status: "done", text: "", data: evidence(args.reference) };
    },
  });
  expect(r.calls).toHaveLength(1);
  expect(r.result.meetingResult.status).toBe("partial");
  expect(r.result.meetingResult.obligations.map((o: any) => o.state)).toEqual([
    "fulfilled",
    "unmet",
  ]);
});
test("oldest cannot select a meeting with unknown chronology", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          select: "oldest",
          parts: [{ id: "summary", question: "Summary" }],
          scope: "observed",
        },
      },
    },
    dispatch: () => ({
      status: "done",
      text: "",
      data: {
        contractVersion: 3,
        kind: "page",
        rows: [{ ...catalogRow(1), startedAt: null }, catalogRow(2)],
        nextCursor: "meeting-0002",
        exhausted: true,
        examinedRows: 2,
        observedAt: "2026-09-14T12:00:00Z",
        scope: "observed",
        omissions: [],
      },
    }),
  });
  expect(r.calls).toHaveLength(0);
  expect(r.result.meetingResult.status).toBe("clarification_required");
});
test("ordinal beyond 100 resolves the displayed continued order", async () => {
  const sources = Array.from({ length: 101 }, (_, i) => ref(i.toString(16)));
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        parentMessageId: "p",
        parent: { messageId: "p", turnId: "prior", sources },
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summary" }],
          ordinal: 101,
        },
      },
    },
  });
  expect(r.reads[0].args.reference).toEqual(sources[100]);
  expect(r.result.meetingResult.status).toBe("completed");
});
test("Continue preserves actual matched source totals independently of scanned sources and parts", async () => {
  const makeDispatch =
    (fail: string, match: string) => (_name: any, args: any) => {
      if (args.reference.sourceId === fail) throw new Error("interrupted");
      const text =
        args.reference.sourceId === match ? "Cobalt won." : "No matching term.";
      return {
        status: "done",
        text: "",
        data: {
          ...evidence(args.reference),
          spans: [{ text, recordIndex: 0, start: 0, end: text.length }],
        },
      };
    };
  const first = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["cobalt"],
          references: [ref(), ref("b"), ref("c")],
        },
      },
    },
    dispatch: makeDispatch("b", "c"),
  });
  expect(first.result.meetingResult.continuation.matchedSources).toBe(0);
  const second = await run({
    params: {
      turn: {
        turnId: "next",
        sentAt: Date.now(),
        continuation: JSON.parse(
          JSON.stringify(first.result.meetingResult.continuation),
        ),
      },
    },
    dispatch: makeDispatch("c", "b"),
  });
  expect(second.result.meetingResult.continuation.examinedSources).toBe(2);
  expect(second.result.meetingResult.continuation.matchedSources).toBe(1);
});
test("metadata listing includes organizer, participants and readiness without synthesis", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "listing",
          parts: [{ id: "participants", question: "List attendees and dates" }],
          scope: "observed",
        },
      },
    },
    dispatch: () => ({
      status: "done",
      text: "",
      data: {
        contractVersion: 3,
        kind: "page",
        rows: [
          {
            ...catalogRow(1),
            organizerEmail: "host@example.test",
            participants: [{ name: "Ava", email: "ava@example.test" }],
          },
        ],
        nextCursor: "meeting-0001",
        exhausted: true,
        examinedRows: 1,
        observedAt: "2026-09-14T12:00:00Z",
        scope: "observed",
        omissions: [],
      },
    }),
  });
  expect(r.result.meetingResult.status).toBe("completed");
  expect(r.result.meetingResult.text).toContain("Ava");
  expect(r.result.meetingResult.text).toContain("host@example.test");
  expect(r.result.meetingResult.text).toContain("published");
  expect(r.calls).toHaveLength(0);
});
test("interpretation receives only whitelisted parent identity fields", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        parentMessageId: "p",
        parent: {
          messageId: "p",
          turnId: "prior",
          sources: [{ ...ref(), secret: "PRIVATE EXTRA SENTINEL" }],
          summary: "PRIVATE EXTRA SENTINEL",
        },
      },
    },
    reply: (_req: any, n: number) =>
      n === 1
        ? modelReply({
            kind: "meeting",
            intent: {
              mode: "analysis",
              parts: [{ id: "summary", question: "Summary" }],
              ordinal: 1,
            },
          })
        : modelReply(draft()),
  });
  expect(r.result.meetingResult.status).toBe("completed");
  expect(JSON.stringify(r.calls)).not.toContain("PRIVATE EXTRA SENTINEL");
});
test("malformed parent mapping clarifies without reading or invoking a model", async () => {
  const r = await run({
    params: {
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        parentMessageId: "p",
        parent: { messageId: "p", turnId: "prior" },
        intent: {
          mode: "analysis",
          parts: [{ id: "summary", question: "Summary" }],
          ordinal: 1,
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("clarification_required");
  expect(r.calls).toHaveLength(0);
  expect(r.reads).toHaveLength(0);
});
test("early provider rejection preserves every explicit source and part as unmet", async () => {
  const r = await run({
    params: {
      config: { streamPolicy: { turnTimeoutMs: 120000 } },
      turn: {
        turnId: "t",
        sentAt: Date.now(),
        intent: {
          mode: "analysis",
          references: [ref(), ref("b")],
          parts: [
            { id: "summary", question: "Summary" },
            { id: "actions", question: "Actions" },
          ],
        },
      },
    },
  });
  expect(r.result.meetingResult.status).toBe("unavailable");
  expect(r.result.meetingResult.sources).toEqual([ref(), ref("b")]);
  expect(r.result.meetingResult.obligations).toHaveLength(4);
  expect(
    r.result.meetingResult.obligations.every((o: any) => o.state === "unmet"),
  ).toBe(true);
});
test.each(["sentence_limit", "byte_limit"])(
  "search capacity omissions stay partial and never become a false miss: %s",
  async (kind) => {
    const text =
      kind === "sentence_limit"
        ? "Cobalt won. ".repeat(103)
        : "Cobalt " + "x".repeat(140000) + ".";
    const r = await run({
      params: {
        turn: {
          turnId: "t",
          sentAt: Date.now(),
          intent: {
            mode: "search",
            parts: [{ id: "search", question: "Find cobalt" }],
            terms: ["cobalt"],
            references: [ref()],
          },
        },
      },
      dispatch: (_n: any, args: any) => ({
        status: "done",
        text: "",
        data: {
          ...evidence(args.reference),
          original: { ...evidence().original, byteLength: text.length },
          spans: [{ text, recordIndex: 0, start: 0, end: text.length }],
        },
      }),
    });
    expect(r.result.meetingResult.status).toBe("partial");
    expect(r.result.meetingResult.text).not.toContain("No literal matches");
    expect(r.result.meetingResult.limitations).toContainEqual({
      code:
        kind === "sentence_limit" ? "omitted_matches:2" : "omitted_matches:1",
    });
  },
);

const listingIntent = {
  mode: "listing",
  parts: [{ id: "list", question: "List" }],
  scope: "observed",
};
function shortListingDispatch(omissions: Array<{ code: string }> = []) {
  return (name: string, args: any) => {
    if (name === "tinycloud_read_meeting")
      return {
        status: "done",
        text: "",
        data: {
          ...evidence(args.reference, "overview"),
          overviewProvenance: {
            provider: null,
            generatedAt: null,
            sourceDigest: null,
            freshness: "unknown",
          },
        },
      };
    const last = Boolean(args.after);
    return {
      status: "done",
      text: "",
      data: {
        contractVersion: 3,
        kind: "page",
        rows: last
          ? [catalogRow(101)]
          : Array.from({ length: 100 }, (_, i) => catalogRow(i + 1)),
        nextCursor: last ? "meeting-0101" : "meeting-0100",
        exhausted: last,
        examinedRows: last ? 1 : 100,
        observedAt: "2026-09-14T12:00:00Z",
        scope: "observed",
        omissions: last ? omissions : [],
      },
    };
  };
}
async function listingContinuation(omissions: Array<{ code: string }> = []) {
  const first = await run({
    dispatch: shortListingDispatch(omissions),
    params: {
      turn: { turnId: "first", sentAt: Date.now(), intent: listingIntent },
    },
  });
  const continuation = JSON.parse(
    JSON.stringify(first.result.meetingResult.continuation),
  );
  expect(continuation.exhausted).toBe(true);
  expect(continuation.pending).toHaveLength(1);
  return { first, continuation };
}
test("exhausted Continue retains earlier unresolved catalog scope after reload", async () => {
  const { first, continuation } = await listingContinuation([
    { code: "invalid_catalog_record" },
  ]);
  expect(first.result.meetingResult.limitations).toContainEqual({
    code: "invalid_catalog_record",
  });
  const last = await run({
    dispatch: shortListingDispatch(),
    params: {
      turn: { turnId: "last", sentAt: Date.now(), continuation },
    },
  });
  expect(last.result.meetingResult.sources).toHaveLength(101);
  expect(last.result.meetingResult.continuation).toBeUndefined();
  expect(last.result.meetingResult.status).toBe("partial");
  expect(last.result.meetingResult.limitations).toContainEqual({
    code: "invalid_catalog_record",
  });
});
test("resolved listing pagination capacity does not permanently prevent completion", async () => {
  const { continuation } = await listingContinuation();
  const last = await run({
    dispatch: shortListingDispatch(),
    params: {
      turn: { turnId: "last", sentAt: Date.now(), continuation },
    },
  });
  expect(last.result.meetingResult.status).toBe("completed");
  expect(last.result.meetingResult.limitations).toEqual([]);
});
test("Continue retains unresolved unpublished source obligations from prior catalog pages", async () => {
  const dispatch = (name: string, args: any) => {
    const response = shortListingDispatch()(name, args);
    if (name === "tinycloud_find_meetings" && args.after) {
      (response.data as any).rows.push({
        ...catalogRow(102),
        revision: null,
        readiness: "unavailable",
      });
      (response.data as any).examinedRows++;
    }
    return response;
  };
  const first = await run({
    dispatch,
    params: {
      turn: { turnId: "first", sentAt: Date.now(), intent: listingIntent },
    },
  });
  expect(
    first.result.meetingResult.obligations.some(
      (o: any) => o.state === "unmet" && o.reason === "source_unavailable",
    ),
  ).toBe(true);
  const last = await run({
    dispatch,
    params: {
      turn: {
        turnId: "last",
        sentAt: Date.now(),
        continuation: JSON.parse(
          JSON.stringify(first.result.meetingResult.continuation),
        ),
      },
    },
  });
  expect(last.result.meetingResult.status).toBe("partial");
  expect(last.result.meetingResult.limitations).toContainEqual({
    code: "source_unavailable",
  });
});
test.each([false, true])(
  "Continue recovers a pending read while preserving consumed evidence omissions: %s",
  async (partial) => {
    const first = await run({
      params: {
        turn: {
          turnId: "first",
          sentAt: Date.now(),
          intent: {
            mode: "search",
            parts: [{ id: "search", question: "Find cobalt" }],
            terms: ["cobalt"],
            references: [ref(), ref("b")],
          },
        },
      },
      dispatch: (_name: string, args: any) => {
        if (args.reference.sourceId === "b") throw Error("later read failed");
        return {
          status: "done",
          text: "",
          data: {
            ...evidence(args.reference),
            ...(partial
              ? {
                  state: "partial",
                  omissions: [{ code: "unrecognized_record" }],
                }
              : {}),
          },
        };
      },
    });
    const last = await run({
      params: {
        turn: {
          turnId: "last",
          sentAt: Date.now(),
          continuation: JSON.parse(
            JSON.stringify(first.result.meetingResult.continuation),
          ),
        },
      },
    });
    expect(last.result.meetingResult.status).toBe(
      partial ? "partial" : "completed",
    );
    expect(last.result.meetingResult.limitations).not.toContainEqual({
      code: "retrieval_failed",
    });
    if (partial) {
      expect(last.result.meetingResult.limitations).toContainEqual({
        code: "unrecognized_record",
      });
      expect(last.result.meetingResult.limitations).toContainEqual({
        code: "partial_scan",
      });
    }
  },
);
test("Continue sums omitted literal matches across consumed artifacts", async () => {
  const text = "Cobalt won. ".repeat(103);
  const data = (reference: SourceReference) => ({
    ...evidence(reference),
    original: { ...evidence().original, byteLength: text.length },
    spans: [{ text, recordIndex: 0, start: 0, end: text.length }],
  });
  const first = await run({
    params: {
      turn: {
        turnId: "first",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["cobalt"],
          references: [ref(), ref("b")],
        },
      },
    },
    dispatch: (_name: string, args: any) => {
      if (args.reference.sourceId === "b") throw Error("later read failed");
      return { status: "done", text: "", data: data(args.reference) };
    },
  });
  expect(first.result.meetingResult.limitations).toContainEqual({
    code: "omitted_matches:2",
  });
  const last = await run({
    params: {
      turn: {
        turnId: "last",
        sentAt: Date.now(),
        continuation: JSON.parse(
          JSON.stringify(first.result.meetingResult.continuation),
        ),
      },
    },
    dispatch: (_name: string, args: any) => ({
      status: "done",
      text: "",
      data: data(args.reference),
    }),
  });
  expect(last.result.meetingResult.status).toBe("partial");
  expect(last.result.meetingResult.limitations).toContainEqual({
    code: "omitted_matches:4",
  });
  expect(last.result.meetingResult.limitations).not.toContainEqual({
    code: "omitted_matches:2",
  });
});
test("a consumed failed source stays unresolved after a later pending read recovers", async () => {
  const first = await run({
    params: {
      turn: {
        turnId: "first",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["cobalt"],
          references: [ref(), ref("b")],
        },
      },
    },
    dispatch: (_name: string, args: any) => {
      if (args.reference.sourceId === "b") throw Error("pending read failed");
      return { status: "error", text: "", code: "execution_failed" };
    },
  });
  const last = await run({
    params: {
      turn: {
        turnId: "last",
        sentAt: Date.now(),
        continuation: JSON.parse(
          JSON.stringify(first.result.meetingResult.continuation),
        ),
      },
    },
  });
  expect(last.result.meetingResult.status).toBe("partial");
  expect(last.result.meetingResult.limitations).toContainEqual({
    code: "execution_failed",
  });
});
test("consumed failure provenance survives more than one Continue", async () => {
  const first = await run({
    params: {
      turn: {
        turnId: "first",
        sentAt: Date.now(),
        intent: {
          mode: "search",
          parts: [{ id: "search", question: "Find cobalt" }],
          terms: ["cobalt"],
          references: [ref(), ref("b"), ref("c")],
        },
      },
    },
    dispatch: (_name: string, args: any) => {
      if (args.reference.sourceId === "a")
        return { status: "error", text: "", code: "execution_failed" };
      throw Error("pending read failed");
    },
  });
  const second = await run({
    params: {
      turn: {
        turnId: "second",
        sentAt: Date.now(),
        continuation: JSON.parse(
          JSON.stringify(first.result.meetingResult.continuation),
        ),
      },
    },
    dispatch: (_name: string, args: any) => {
      if (args.reference.sourceId === "c")
        throw Error("pending read failed again");
      return { status: "done", text: "", data: evidence(args.reference) };
    },
  });
  const last = await run({
    params: {
      turn: {
        turnId: "last",
        sentAt: Date.now(),
        continuation: JSON.parse(
          JSON.stringify(second.result.meetingResult.continuation),
        ),
      },
    },
  });
  expect(last.result.meetingResult.status).toBe("partial");
  expect(last.result.meetingResult.limitations).toContainEqual({
    code: "execution_failed",
  });
});
test("legacy continuation without scope provenance cannot imply complete scope", async () => {
  const { continuation } = await listingContinuation();
  delete continuation.scope;
  const last = await run({
    dispatch: shortListingDispatch(),
    params: {
      turn: { turnId: "last", sentAt: Date.now(), continuation },
    },
  });
  expect(last.result.meetingResult.status).toBe("partial");
  expect(last.result.meetingResult.limitations).toContainEqual({
    code: "continuation_scope_unknown",
  });
});
test.each([
  null,
  { codes: ["invalid_catalog_record"], omittedMatches: -1 },
  {
    codes: ["invalid_catalog_record"],
    omittedMatches: Number.MAX_SAFE_INTEGER + 1,
  },
  { codes: Array(65).fill("invalid_catalog_record"), omittedMatches: 0 },
  { codes: ["x".repeat(129)], omittedMatches: 0 },
  { codes: ["private prose\nwith controls"], omittedMatches: 0 },
])(
  "malformed durable Continue scope is rejected before reading: %j",
  async (scope) => {
    const { continuation } = await listingContinuation();
    continuation.scope = scope;
    const last = await run({
      dispatch: shortListingDispatch(),
      params: {
        turn: { turnId: "last", sentAt: Date.now(), continuation },
      },
    });
    expect(last.result.meetingResult.status).toBe("clarification_required");
    expect(last.result.meetingResult.limitations).toContainEqual({
      code: "invalid_continuation",
    });
    expect(last.reads).toHaveLength(0);
  },
);
test("bounded Continue omission provenance stays incomplete when distinct codes exceed capacity", async () => {
  const { continuation } = await listingContinuation(
    Array.from({ length: 100 }, (_, i) => ({ code: `missing_record_${i}` })),
  );
  expect(continuation.scope.codes.length).toBeLessThanOrEqual(64);
  expect(continuation.scope.codes).toContain("continuation_scope_incomplete");
  const last = await run({
    dispatch: shortListingDispatch(),
    params: {
      turn: { turnId: "last", sentAt: Date.now(), continuation },
    },
  });
  expect(last.result.meetingResult.status).toBe("partial");
  expect(last.result.meetingResult.limitations).toContainEqual({
    code: "continuation_scope_incomplete",
  });
});
