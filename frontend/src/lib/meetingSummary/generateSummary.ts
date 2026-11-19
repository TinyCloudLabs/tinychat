// TC-1152 v1b-b: one summary for one combined meeting, from the combined text.
//
//   1 call            the whole transcript (the normal case: one billed call);
//   on "overflow"     the request was too long for the model: split into at most MAX_CHUNKS chunks, one call
//                     per chunk (a digest each), then one call that merges the digests;
//                     calls <= 1 (the refused whole-transcript call) + MAX_CHUNKS + 1;
//   above the cap     a transcript that needs more than MAX_CHUNKS chunks is NOT sent at all: `too_long`.
//
// Calls are sequential and stop at the first failure or when `signal` aborts. This module holds no
// transcript text beyond the call in flight and reports only a result kind and counts, never text from
// the transcript or an error message.
import type { ChatMessage } from "@/lib/chatApi";

import { CHUNK_CHARS, MAX_CHUNKS, buildChunkMessages, buildDigestMessages, buildSummaryMessages, planChunks } from "./summaryPrompt";
import { DIGEST_LIMITS, SUMMARY_LIMITS, parseSummary, type ParsedSummary } from "./summaryText";

export type SummaryFailureKind =
  | "cancelled"
  /** The backend refused for credits or plan (the app's paywall event has fired). */
  | "paywall"
  /** Needs more than MAX_CHUNKS chunks. Nothing was sent. */
  | "too_long"
  /** The combined body has no text. Nothing was sent. */
  | "empty"
  /** The model's reply was not the expected shape. */
  | "unparseable"
  | "failed";

export type SummaryResult =
  | { ok: true; summary: ParsedSummary; calls: number; chunks: number }
  | { ok: false; kind: SummaryFailureKind; calls: number };

export type CallFailure = "overflow" | "paywall" | "other";

export interface GenerateDeps {
  /** One model call (the chat route, billed to the user). */
  complete: (messages: ChatMessage[], options: { maxTokens: number; signal: AbortSignal }) => Promise<string>;
  /** What a thrown error means; never read for its message. */
  classify: (error: unknown) => CallFailure;
  signal: AbortSignal;
}

// Output caps (max_output_tokens). The cap covers the model's reasoning tokens as well as the reply's `content`,
// so each cap leaves room for thinking before the reply. The chat route accepts up to 4096 (backend chat.ts).
const WHOLE_MAX_TOKENS = 2500;
const CHUNK_MAX_TOKENS = 1500;

export async function generateSummary(lines: readonly string[], deps: GenerateDeps): Promise<SummaryResult> {
  let calls = 0;
  type Called = { ok: true; reply: string } | { ok: false; failure: CallFailure | "cancelled" };
  const call = async (messages: ChatMessage[], maxTokens: number): Promise<Called> => {
    if (deps.signal.aborted) return { ok: false, failure: "cancelled" };
    calls++;
    try {
      const reply = await deps.complete(messages, { maxTokens, signal: deps.signal });
      return deps.signal.aborted ? { ok: false, failure: "cancelled" } : { ok: true, reply };
    } catch (error) {
      return { ok: false, failure: deps.signal.aborted ? "cancelled" : deps.classify(error) };
    }
  };
  const fail = (kind: SummaryFailureKind): SummaryResult => ({ ok: false, kind, calls });
  const kindOf = (failure: CallFailure | "cancelled"): SummaryFailureKind => (failure === "paywall" ? "paywall" : failure === "cancelled" ? "cancelled" : "failed");

  if (lines.length === 0) return fail("empty");
  const plan = planChunks(lines, CHUNK_CHARS, MAX_CHUNKS);
  if (plan.tooLong) return fail("too_long");

  const whole = await call(buildSummaryMessages(lines), WHOLE_MAX_TOKENS);
  if (whole.ok) {
    const summary = parseSummary(whole.reply, SUMMARY_LIMITS);
    return summary === null ? fail("unparseable") : { ok: true, summary, calls, chunks: 0 };
  }
  if (whole.failure !== "overflow") return fail(kindOf(whole.failure));

  // Too long for one call: summarise the parts, then the summaries.
  const parts = plan.chunks;
  if (parts.length === 1) {
    // One chunk is the whole transcript (it was refused for another reason): a retry would be the same call.
    return fail("failed");
  }
  const digests: ParsedSummary[] = [];
  for (let index = 0; index < parts.length; index++) {
    const part = await call(buildChunkMessages(parts[index]!, index + 1, parts.length), CHUNK_MAX_TOKENS);
    if (!part.ok) return fail(kindOf(part.failure));
    const digest = parseSummary(part.reply, DIGEST_LIMITS);
    if (digest === null) return fail("unparseable");
    digests.push(digest);
  }
  const merged = await call(buildDigestMessages(digests), WHOLE_MAX_TOKENS);
  if (!merged.ok) return fail(kindOf(merged.failure));
  const summary = parseSummary(merged.reply, SUMMARY_LIMITS);
  return summary === null ? fail("unparseable") : { ok: true, summary, calls, chunks: parts.length };
}
