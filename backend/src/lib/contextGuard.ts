// Deterministic (NO-LLM) context guard for the agent tool-calling path.
//
// The agent orchestrator re-sends a GROWING conversation each round (assistant
// tool-calls + role:"tool" results accumulate), which can overrun the model's
// context window mid-loop. These pure helpers shrink the outgoing convo before
// each round's upstream fetch WITHOUT any model call: first cap oversize tool
// results, then drop the oldest droppable messages until the estimate fits.
//
// Estimator is the same chars/4 heuristic used everywhere in this milestone —
// no real tokenizer dependency (§C.5 / §I.2). The chars/4 drift is documented as
// a known limitation (§H.1); the 0.7 ratio margin absorbs it.

/** Per-message char cap for role:"tool" results (§C.11). */
export const TOOL_RESULT_MAX_CHARS = 4000;

/** Always keep at least this many trailing messages when trimming (§C.11). */
export const AGENT_MIN_TAIL = 6;

/** Trim once the convo estimate exceeds this fraction of the context window (§C.11). */
export const AGENT_TRIM_RATIO = 0.7;

/** Marker appended to a truncated tool result. */
const TRUNCATION_MARKER = "\n[...truncated...]";

/** Minimal message shape the guard operates on (mirrors agent-chat ChatMsg). */
export interface GuardMsg {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/** chars/4 token estimate (§C.5). Empty string → 0. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Summed chars/4 estimate across a conversation's message contents. */
function estimateConvoTokens(convo: GuardMsg[]): number {
  let total = 0;
  for (const m of convo) total += estimateTokens(m.content ?? "");
  return total;
}

/**
 * Return a copy of `convo` in which any role:"tool" message whose content
 * exceeds `maxChars` is head-truncated to `maxChars` chars plus a
 * `[...truncated...]` marker. Non-tool messages and small tool results are
 * returned untouched (same reference). Pure — never mutates the input.
 */
export function truncateToolResults(
  convo: GuardMsg[],
  maxChars: number = TOOL_RESULT_MAX_CHARS,
): GuardMsg[] {
  return convo.map((m) => {
    if (m.role !== "tool") return m;
    const content = m.content ?? "";
    if (content.length <= maxChars) return m;
    return { ...m, content: content.slice(0, maxChars) + TRUNCATION_MARKER };
  });
}

/**
 * Drop the oldest droppable messages until the convo estimate is within
 * `ratio × contextTokens`, or nothing more can be dropped. ALWAYS keeps:
 *   - every system message,
 *   - the FIRST user message,
 *   - the LAST user message (§F.7),
 *   - the last `minTail` messages.
 * Noop when already under budget. Pure — returns a new array, never mutates.
 */
export function trimConvoToBudget(
  convo: GuardMsg[],
  contextTokens: number,
  opts?: { minTail?: number; ratio?: number },
): GuardMsg[] {
  const minTail = opts?.minTail ?? AGENT_MIN_TAIL;
  const ratio = opts?.ratio ?? AGENT_TRIM_RATIO;
  const budget = ratio * contextTokens;

  const result = [...convo];
  while (estimateConvoTokens(result) > budget) {
    const firstUserIdx = result.findIndex((m) => m.role === "user");
    let lastUserIdx = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const tailStart = result.length - minTail;

    let dropIdx = -1;
    for (let i = 0; i < result.length; i++) {
      if (i >= tailStart) break; // protected tail (and everything after)
      if (result[i].role === "system") continue; // keep all system messages
      if (i === firstUserIdx) continue; // keep the first user message
      if (i === lastUserIdx) continue; // keep the last user message (§F.7)
      dropIdx = i;
      break; // lowest eligible index = oldest droppable message
    }
    if (dropIdx === -1) break; // nothing left to drop
    result.splice(dropIdx, 1);
  }
  return result;
}
