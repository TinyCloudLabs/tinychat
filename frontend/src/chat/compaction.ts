// ── Chat compaction pure core (spec §D.1) ────────────────────────────
//
// All logic here is pure and injectable — no DOM, no network, no storage —
// so it can be unit-tested in isolation. The adapter (chatModelAdapter.ts)
// wires these into the request path; persistence lives in threadStore.ts.
//
// Strategy (spec §C.1): older messages fold into a persistent per-thread
// summary checkpoint; the OUTGOING payload becomes
//   [memory block] + [summary block] + [recent tail verbatim]
// Stored messages are NEVER mutated — compaction only rewrites the request.
//
// NOTE (§H.1): the token estimate is chars/4, which drifts vs a real
// tokenizer (CJK, code). The 0.7 proactive trigger margin plus the reactive
// retry absorb that drift; no tokenizer dependency is added (§F.9).
//
// NOTE (T2/T3 sequencing): this module is the spec's T2 deliverable. It was
// absent from the working tree when T3 was implemented, so it is authored here
// to the exact §D.1 signatures the adapter imports.

export const COMPACT_TRIGGER_RATIO = 0.7;
export const COMPACT_TARGET_RATIO = 0.5;
export const RETRY_TARGET_RATIO = 0.4;
export const MIN_TAIL = 4;
export const COMPACTION_SUMMARY_MAX_TOKENS = 2000;
export const DEFAULT_CONTEXT_TOKENS = 64000;

// Oversize single-message truncation (spec §C.6): keep the head + tail, drop
// the middle behind a marker rather than fail the whole compaction.
const TRUNCATE_HEAD_CHARS = 6000;
const TRUNCATE_TAIL_CHARS = 2000;
const TRUNCATE_MARKER = "\n\n[...truncated...]\n\n";
const OVERSIZE_THRESHOLD = TRUNCATE_HEAD_CHARS + TRUNCATE_TAIL_CHARS;

// Planning reserve for the not-yet-generated summary block. The system prompt
// asks for ~1500 tokens, but the API call hard-caps output at
// COMPACTION_SUMMARY_MAX_TOKENS, so reserve that hard cap when choosing how much
// history to fold. Reserving the cap (not the softer prompt target) keeps the
// post-compaction payload ≤ the chosen target even if the model maxes its
// output — preserving the §C.6 deterministic-estimate guarantee.
const SUMMARY_RESERVE_TOKENS = COMPACTION_SUMMARY_MAX_TOKENS;

export type PayloadRole = "user" | "assistant" | "system";
export interface PayloadMsg {
  role: PayloadRole;
  content: string;
}
export interface PayloadMsgWithId extends PayloadMsg {
  id: string;
}

export interface CompactionCheckpoint {
  id: string;
  threadId: string;
  coversThroughMessageId: string;
  summary: string;
  createdAt: string;
}

export interface CompactionPlan {
  needed: boolean;
  /** Newest message folded into the summary (its id anchors chain validity). */
  coversThroughMessageId?: string;
  /** [prevSummary?] + folded messages (older→newer), oversize-truncated. */
  toSummarize?: PayloadMsg[];
  /** Messages kept verbatim after the fold boundary. */
  tail?: PayloadMsg[];
}

/** chars/4 heuristic (spec §C.5). No tokenizer dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Estimate the full outgoing payload — memory + summary + messages (§C.5). */
export function estimatePayloadTokens(msgs: { role: string; content: string }[]): number {
  let total = 0;
  for (const m of msgs) total += estimateTokens(m.content);
  return total;
}

/** Truncate a single oversize message body per §C.6 (head + tail + marker). */
export function truncateOversizeText(text: string): string {
  if (text.length <= OVERSIZE_THRESHOLD) return text;
  return text.slice(0, TRUNCATE_HEAD_CHARS) + TRUNCATE_MARKER + text.slice(text.length - TRUNCATE_TAIL_CHARS);
}

/**
 * A checkpoint applies ONLY if its `coversThroughMessageId` is present in the
 * current linear chain (spec §C.8). After an edit/branch the anchor disappears
 * → the checkpoint is ignored and full history is sent; the reactive path
 * re-compacts if needed. Never throws on a bad checkpoint.
 */
export function isCheckpointValid(
  cp: CompactionCheckpoint | null | undefined,
  messageIds: string[],
): boolean {
  if (!cp || typeof cp.coversThroughMessageId !== "string" || cp.coversThroughMessageId.length === 0) {
    return false;
  }
  return messageIds.includes(cp.coversThroughMessageId);
}

/**
 * Deterministic planner (spec §C.6). Compact so the post-compaction estimate
 * is ≤ targetRatio × contextTokens, ALWAYS keeping the last MIN_TAIL messages
 * (the in-flight user message is the newest, so it is always in the tail).
 * `coversThrough` = the newest fold boundary that meets the target while
 * folding as few messages as possible. Rolls a previous checkpoint: only
 * messages AFTER the previous coversThrough are re-summarized.
 */
export function planCompaction(opts: {
  messages: PayloadMsgWithId[];
  memoryBlockChars: number;
  contextTokens: number;
  targetRatio: number;
  prevCheckpoint?: CompactionCheckpoint | null;
}): CompactionPlan {
  const { messages, memoryBlockChars, contextTokens, targetRatio, prevCheckpoint } = opts;
  const memoryTokens = Math.ceil(Math.max(0, memoryBlockChars) / 4);
  const targetTokens = Math.floor(targetRatio * contextTokens);

  const fullEstimate = memoryTokens + estimatePayloadTokens(messages);
  if (fullEstimate <= targetTokens) {
    return { needed: false };
  }

  // Never fold the last MIN_TAIL messages (includes the in-flight user msg).
  const maxFold = Math.max(0, messages.length - MIN_TAIL);
  if (maxFold === 0) {
    return { needed: false };
  }

  // Where does previously-summarized history end? Only re-summarize messages
  // newer than the previous coversThrough (rolling; §C.9).
  let prevCoveredCount = 0;
  if (prevCheckpoint) {
    const idx = messages.findIndex((m) => m.id === prevCheckpoint.coversThroughMessageId);
    if (idx >= 0) prevCoveredCount = idx + 1;
  }

  // Smallest fold (fold the fewest oldest messages) that meets the target.
  let chosenFold = maxFold;
  let budgetMet = false;
  for (let fold = 1; fold <= maxFold; fold++) {
    const tail = messages.slice(fold);
    const tailTokens = estimatePayloadTokens(tail);
    if (memoryTokens + SUMMARY_RESERVE_TOKENS + tailTokens <= targetTokens) {
      chosenFold = fold;
      budgetMet = true;
      break;
    }
  }

  const coversThroughMessageId = messages[chosenFold - 1]!.id;
  const foldStart = Math.min(prevCoveredCount, chosenFold);
  const toSummarize: PayloadMsg[] = messages
    .slice(foldStart, chosenFold)
    .map((m) => ({ role: m.role, content: truncateOversizeText(m.content) }));
  // §C.6 fallback: if even [memory + summary + MIN_TAIL] exceeds budget (no fold
  // met the target), truncate oversize tail message TEXT (head 6000 + tail 2000 +
  // marker) rather than fail. Otherwise the tail is kept verbatim.
  const tail: PayloadMsg[] = messages
    .slice(chosenFold)
    .map((m) => ({ role: m.role, content: budgetMet ? m.content : truncateOversizeText(m.content) }));

  return { needed: true, coversThroughMessageId, toSummarize, tail };
}

const SUMMARIZATION_SYSTEM_PROMPT =
  "You compress an ongoing conversation into a compact running summary. " +
  "Preserve all facts, decisions, names, numbers, code snippets, and open " +
  "questions. Write a dense summary of at most ~1500 tokens. Do not add a " +
  "preamble, greeting, or meta commentary — output only the summary.";

/**
 * Build the single-shot summarization request (spec §C.9). Input rolls the
 * previous checkpoint summary (if any) plus the messages to fold. The system
 * prompt caps length and forbids preamble.
 */
export function buildSummarizationMessages(
  plan: CompactionPlan,
  prevSummary?: string | null,
): PayloadMsg[] {
  const parts: string[] = [];
  if (prevSummary && prevSummary.trim().length > 0) {
    parts.push("Summary so far:\n" + prevSummary.trim());
  }
  const folded = (plan.toSummarize ?? [])
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");
  if (folded.length > 0) {
    parts.push("New messages to fold into the summary:\n" + folded);
  }
  return [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** Wrap a summary string as the on-wire summary system block (spec §C.10). */
export function summaryBlock(summary: string): PayloadMsg {
  return {
    role: "system",
    content: "<conversation_summary>\n" + summary + "\n</conversation_summary>",
  };
}

/**
 * Rewrite the conversation messages for a valid checkpoint (spec §C.8/§C.10):
 * returns [summary block, ...tail] where tail = messages after the checkpoint
 * boundary. The memory block stays caller-side (prepended by the adapter). If
 * the anchor is not found, returns the messages unchanged (defensive; callers
 * validate first).
 */
export function applyCheckpoint(
  payload: PayloadMsgWithId[],
  cp: CompactionCheckpoint,
): PayloadMsg[] {
  const idx = payload.findIndex((m) => m.id === cp.coversThroughMessageId);
  if (idx < 0) {
    return payload.map((m) => ({ role: m.role, content: m.content }));
  }
  const tail = payload.slice(idx + 1).map((m) => ({ role: m.role, content: m.content }));
  return [summaryBlock(cp.summary), ...tail];
}
