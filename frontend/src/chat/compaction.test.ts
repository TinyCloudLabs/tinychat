import { describe, expect, it } from "bun:test";
import {
  MIN_TAIL,
  applyCheckpoint,
  buildSummarizationMessages,
  estimatePayloadTokens,
  estimateTokens,
  isCheckpointValid,
  planCompaction,
  summaryBlock,
  type CompactionCheckpoint,
  type PayloadMsgWithId,
} from "./compaction";
import { latestCompaction } from "../lib/threadStore";

// Spec §D.1/§D.2 pure-core coverage. The DB-bound threadStore fns
// (appendCompaction/getLatestCompaction) stay thin and audited (§E.T2 — no fake
// tcw harness this milestone); `latestCompaction(rows)` is the pure helper we test.

const cp = (over: Partial<CompactionCheckpoint>): CompactionCheckpoint => ({
  id: "cp",
  threadId: "t",
  coversThroughMessageId: "m0",
  summary: "SUM",
  createdAt: "2026-07-02T00:00:00.000Z",
  ...over,
});

describe("compaction core (spec §D.1)", () => {
  it("estimate_tokens_chars_over_four_including_memory_block", () => {
    // estimateTokens == ceil(len/4).
    expect(estimateTokens("hello")).toBe(2); // ceil(5/4) = 2
    expect(estimateTokens("x".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(0);

    // estimatePayloadTokens counts the memory block's chars too — it is just
    // another message in the outgoing payload (§C.5).
    const memoryBlock = { role: "system", content: "x".repeat(400) }; // 100 tokens
    const userMsg = { role: "user", content: "hello" }; // 2 tokens
    expect(estimatePayloadTokens([userMsg])).toBe(2);
    expect(estimatePayloadTokens([memoryBlock, userMsg])).toBe(102);
  });

  it("plan_noop_under_threshold", () => {
    const messages: PayloadMsgWithId[] = [
      { id: "m0", role: "user", content: "hi" },
      { id: "m1", role: "assistant", content: "hello there" },
      { id: "m2", role: "user", content: "how are you" },
    ];
    const plan = planCompaction({
      messages,
      memoryBlockChars: 100,
      contextTokens: 64000,
      targetRatio: 0.5,
    });
    expect(plan.needed).toBe(false);
    expect(plan.tail).toBeUndefined();
    expect(plan.coversThroughMessageId).toBeUndefined();
  });

  it("plan_selects_covers_through_min_tail_and_target", () => {
    const big = "b".repeat(130000); // ceil(130000/4) = 32500 tokens each
    const small = "s".repeat(40); // 10 tokens each
    const messages: PayloadMsgWithId[] = [
      { id: "m0", role: "user", content: big },
      { id: "m1", role: "assistant", content: big },
      { id: "m2", role: "user", content: big },
      { id: "m3", role: "assistant", content: big },
      { id: "m4", role: "user", content: small },
      { id: "m5", role: "assistant", content: small },
      { id: "m6", role: "user", content: small },
      { id: "m7", role: "user", content: small }, // in-flight user message (newest)
    ];
    const contextTokens = 64000;
    const targetRatio = 0.5;
    const targetTokens = targetRatio * contextTokens; // 32000

    const plan = planCompaction({
      messages,
      memoryBlockChars: 0,
      contextTokens,
      targetRatio,
    });

    expect(plan.needed).toBe(true);
    // Any tail still holding a big message blows the target, so every foldable
    // message must fold → coversThrough is the NEWEST foldable message (m3).
    expect(plan.coversThroughMessageId).toBe("m3");

    // The last MIN_TAIL messages (incl. the in-flight user msg m7) stay verbatim.
    expect(plan.tail).toHaveLength(MIN_TAIL);
    expect(plan.tail!.map((m) => m.content)).toEqual([small, small, small, small]);
    expect(plan.tail![MIN_TAIL - 1].content).toBe(small); // in-flight msg preserved

    // Post-compaction estimate (memory + real summary block + tail) ≤ target.
    const post = [
      { role: "system" as const, content: "z".repeat(6000) }, // ~1500-token summary
      ...plan.tail!,
    ];
    expect(estimatePayloadTokens(post)).toBeLessThanOrEqual(targetTokens);
  });

  it("plan_truncates_oversize_tail_when_min_tail_exceeds_budget", () => {
    // §C.6 fallback: even [memory + summary + MIN_TAIL] blows the budget because
    // an individual tail message is huge. The plan must NOT fail — it truncates
    // that oversize tail message TEXT (head 6000 + tail 2000 + marker) instead.
    const oversizeTail = "H".repeat(6000) + "M".repeat(200000) + "T".repeat(2000);
    const small = "s".repeat(40);
    const messages: PayloadMsgWithId[] = [
      { id: "m0", role: "user", content: "o".repeat(200000) },
      { id: "m1", role: "assistant", content: "o".repeat(200000) },
      { id: "m2", role: "user", content: oversizeTail }, // oversize, inside MIN_TAIL
      { id: "m3", role: "assistant", content: small },
      { id: "m4", role: "user", content: small },
      { id: "m5", role: "user", content: small }, // in-flight user message (newest)
    ];
    const plan = planCompaction({
      messages,
      memoryBlockChars: 0,
      contextTokens: 64000,
      targetRatio: 0.5,
    });

    expect(plan.needed).toBe(true);
    // All foldable messages fold; the last MIN_TAIL stay in the tail (m2..m5).
    expect(plan.tail).toHaveLength(MIN_TAIL);
    // The oversize tail message m2 was truncated with the marker rather than
    // passed through verbatim (which would re-overflow the model).
    const truncated = plan.tail![0].content;
    expect(truncated).toContain("[...truncated...]");
    expect(truncated.length).toBeLessThan(oversizeTail.length);
    expect(truncated.startsWith("H".repeat(6000))).toBe(true);
    expect(truncated.endsWith("T".repeat(2000))).toBe(true);
    // The in-flight small tail messages are untouched (verbatim).
    expect(plan.tail![MIN_TAIL - 1].content).toBe(small);
  });

  it("apply_checkpoint_rewrites_payload_with_summary_block", () => {
    const payload: PayloadMsgWithId[] = [
      { id: "a", role: "user", content: "old1" },
      { id: "b", role: "assistant", content: "old2" },
      { id: "c", role: "user", content: "keep1" },
      { id: "d", role: "assistant", content: "keep2" },
    ];
    const out = applyCheckpoint(payload, cp({ coversThroughMessageId: "b", summary: "SUM" }));

    // [summary system block with the EXACT wrapper, ...verbatim tail]
    expect(out[0]).toEqual({
      role: "system",
      content: "<conversation_summary>\nSUM\n</conversation_summary>",
    });
    expect(out.slice(1)).toEqual([
      { role: "user", content: "keep1" },
      { role: "assistant", content: "keep2" },
    ]);
    // summaryBlock helper produces the same exact shape.
    expect(out[0]).toEqual(summaryBlock("SUM"));
  });

  it("checkpoint_ignored_when_covers_through_not_in_chain", () => {
    const stale = cp({ coversThroughMessageId: "gone" });
    // Absent from the chain → invalid (caller sends full history, never crashes).
    expect(isCheckpointValid(stale, ["a", "b", "c"])).toBe(false);
    // Present in the chain → valid.
    expect(isCheckpointValid(stale, ["a", "gone", "c"])).toBe(true);
    // Missing/empty anchors and null checkpoints are invalid, never throw.
    expect(isCheckpointValid(cp({ coversThroughMessageId: "" }), ["a"])).toBe(false);
    expect(isCheckpointValid(null, ["a"])).toBe(false);
    expect(isCheckpointValid(undefined, ["a"])).toBe(false);
  });

  it("summarization_input_rolls_prev_summary_and_truncates_oversize", () => {
    const big = "a".repeat(130000);
    const oversize = "o".repeat(20000); // > head(6000)+tail(2000) → truncated per §C.6
    const small = "s".repeat(40);
    const messages: PayloadMsgWithId[] = [
      { id: "m0", role: "user", content: "ZERO " + big },
      { id: "m1", role: "assistant", content: "ONE " + big },
      { id: "m2", role: "user", content: "TWO " + oversize },
      { id: "m3", role: "assistant", content: "THREE " + big },
      { id: "m4", role: "user", content: small },
      { id: "m5", role: "assistant", content: small },
      { id: "m6", role: "user", content: small },
      { id: "m7", role: "user", content: small },
    ];
    // Previous checkpoint already covers m0+m1 → rolling fold starts at m2.
    const prev = cp({ coversThroughMessageId: "m1", summary: "PREV" });
    const plan = planCompaction({
      messages,
      memoryBlockChars: 0,
      contextTokens: 64000,
      targetRatio: 0.5,
      prevCheckpoint: prev,
    });

    expect(plan.needed).toBe(true);
    // Only messages AFTER the previous coversThrough are re-summarized.
    expect(plan.toSummarize).toHaveLength(2);
    const folded = plan.toSummarize!.map((m) => m.content).join("\n");
    expect(folded).toContain("TWO");
    expect(folded).toContain("THREE");
    expect(folded).not.toContain("ZERO");
    expect(folded).not.toContain("ONE ");
    // The oversize m2 was truncated with the marker.
    expect(folded).toContain("[...truncated...]");

    const built = buildSummarizationMessages(plan, prev.summary);
    // A system prompt + a single user message carrying the rolled input.
    expect(built[0].role).toBe("system");
    expect(built[1].role).toBe("user");
    // Rolls the previous summary into the input.
    expect(built[1].content).toContain("PREV");
    // Carries the (truncated) folded messages.
    expect(built[1].content).toContain("[...truncated...]");
    expect(built[1].content).toContain("TWO");
    // Without a prior summary, nothing is rolled in.
    const noPrev = buildSummarizationMessages(plan);
    expect(noPrev[1].content).not.toContain("PREV");
  });
});

describe("checkpoint persistence helper (spec §D.2)", () => {
  it("latest_compaction_row_wins", () => {
    const rows: CompactionCheckpoint[] = [
      cp({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
      cp({ id: "c", createdAt: "2026-01-03T00:00:00.000Z" }),
      cp({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];
    // Newest created_at wins.
    expect(latestCompaction(rows)!.id).toBe("c");

    // Tie on created_at → higher id wins.
    const tie: CompactionCheckpoint[] = [
      cp({ id: "aaa", createdAt: "2026-01-05T00:00:00.000Z" }),
      cp({ id: "zzz", createdAt: "2026-01-05T00:00:00.000Z" }),
    ];
    expect(latestCompaction(tie)!.id).toBe("zzz");

    // Empty → null.
    expect(latestCompaction([])).toBeNull();
  });
});
