import { describe, expect, test } from "bun:test";
import {
  CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  contextLengthFor,
} from "../billing/catalog.js";
import {
  AGENT_MIN_TAIL,
  TOOL_RESULT_MAX_CHARS,
  estimateTokens,
  truncateToolResults,
  trimConvoToBudget,
  type GuardMsg,
} from "../lib/contextGuard.js";

describe("catalog contextLengthFor", () => {
  test("context_length_for_known_model_and_fallback", () => {
    // Every id present in the static in-code map resolves to exactly its mapped
    // number (the map may be empty today per §C.4c — no verifiable upstream
    // window for the offered model — in which case this loop is a vacuous, still
    // valid, assertion of the mapping mechanism).
    for (const [id, tokens] of Object.entries(CONTEXT_TOKENS)) {
      expect(contextLengthFor(id)).toBe(tokens);
    }
    // The production map is empty today, so exercise the known-model branch
    // explicitly by injecting a synthetic entry, asserting it resolves to its
    // mapped number, then restoring the map. This guards the non-fallback path
    // even while no real id carries a verifiable upstream window (§C.4c).
    const SYNTHETIC_ID = "test/synthetic-window";
    CONTEXT_TOKENS[SYNTHETIC_ID] = 12345;
    try {
      expect(contextLengthFor(SYNTHETIC_ID)).toBe(12345);
    } finally {
      delete CONTEXT_TOKENS[SYNTHETIC_ID];
    }
    // Any id NOT in the map falls back to DEFAULT_CONTEXT_TOKENS (64000).
    expect(contextLengthFor("nope/unknown")).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(DEFAULT_CONTEXT_TOKENS).toBe(64000);
  });
});

/** Pad a label to a fixed length so each message is a known token size. */
const pad = (s: string): string => s.padEnd(40, ".");

describe("agent context guard — truncateToolResults", () => {
  test("agent_trim_truncates_oversize_tool_results", () => {
    const big = "x".repeat(5000);
    const convo: GuardMsg[] = [
      { role: "tool", content: big, tool_call_id: "t1" },
      { role: "tool", content: "small result", tool_call_id: "t2" },
      { role: "user", content: "hi" },
    ];

    const out = truncateToolResults(convo);

    // The oversize tool result is head-kept + marked.
    expect(out[0].content.length).toBeLessThan(big.length);
    expect(out[0].content).toContain("[...truncated...]");
    expect(out[0].content.startsWith("x".repeat(TOOL_RESULT_MAX_CHARS))).toBe(true);
    expect(out[0].content.slice(0, TOOL_RESULT_MAX_CHARS)).toBe("x".repeat(TOOL_RESULT_MAX_CHARS));
    // The small tool result and the user message are untouched (same reference).
    expect(out[1]).toBe(convo[1]);
    expect(out[1].content).toBe("small result");
    expect(out[2]).toBe(convo[2]);
    // Input array is not mutated.
    expect(convo[0].content).toBe(big);
  });
});

describe("agent context guard — trimConvoToBudget", () => {
  test("agent_trim_drops_oldest_keeps_system_first_user_and_tail", () => {
    // 10 messages, each 40 chars (10 tokens) → 100 tokens total. contextTokens=100,
    // default ratio 0.7 → budget 70 tokens. Only idx2 + idx3 are droppable (not
    // system, not first user, not last user, before the last AGENT_MIN_TAIL tail).
    const convo: GuardMsg[] = [
      { role: "system", content: pad("SYS") }, // 0 — kept (system)
      { role: "user", content: pad("U-FIRST") }, // 1 — kept (first user)
      { role: "assistant", content: pad("A-DROP-1") }, // 2 — droppable (oldest)
      { role: "tool", content: pad("T-DROP-2"), tool_call_id: "t1" }, // 3 — droppable
      { role: "assistant", content: pad("A-TAIL-1") }, // 4 — in last 6
      { role: "user", content: pad("U-MID") }, // 5
      { role: "assistant", content: pad("A-TAIL-2") }, // 6
      { role: "tool", content: pad("T-TAIL"), tool_call_id: "t2" }, // 7
      { role: "assistant", content: pad("A-TAIL-3") }, // 8
      { role: "user", content: pad("U-LAST") }, // 9 — kept (last user + tail)
    ];
    expect(AGENT_MIN_TAIL).toBe(6);

    const out = trimConvoToBudget(convo, 100);
    const kept = out.map((m) => m.content);

    // Dropped the two oldest droppable messages.
    expect(kept).not.toContain(pad("A-DROP-1"));
    expect(kept).not.toContain(pad("T-DROP-2"));
    // Kept: all system, the first user, the last user, and the last 6 originals.
    expect(kept).toContain(pad("SYS"));
    expect(kept).toContain(pad("U-FIRST"));
    for (const label of ["A-TAIL-1", "U-MID", "A-TAIL-2", "T-TAIL", "A-TAIL-3", "U-LAST"]) {
      expect(kept).toContain(pad(label));
    }
    // Stops at 8 messages (80 tokens) even though that still exceeds the 70-token
    // budget: once only protected messages remain (system, first/last user, tail),
    // nothing is droppable and the guard yields the smallest safe convo (§F.7).
    expect(out.length).toBe(8);
    // Input array is not mutated.
    expect(convo.length).toBe(10);
  });

  test("agent_trim_noop_under_budget", () => {
    const convo: GuardMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "bye" },
    ];
    // Well under 0.7 × 64000 tokens.
    const out = trimConvoToBudget(convo, 64000);
    expect(out).toEqual(convo);
    expect(out.length).toBe(convo.length);
  });
});

describe("estimateTokens (chars/4)", () => {
  test("ceil of length over four", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
