// Everything that leaves over Courier is either one of these fixed sentences or text the copy guard issued.
// The guard catches literal runs from this turn's read results only (12+ words or 80+ characters after
// normalization). Re-encoded, translated or interleaved copies pass; it limits accidental verbatim leaks, nothing more.
// Details: TC-4058
export const COURIER_REFUSAL = "TrustBot doesn't take requests or tasks over Courier. It can answer questions with what its owner lets it read.";
export const COURIER_SUMMARY_REFUSAL = "TrustBot can share a summary of this but not the original text, and it couldn't write one this time. Ask a narrower question.";
export const COURIER_BUSY = "TrustBot is busy and couldn't answer. Send your question in a few minutes.";
export const COURIER_ANSWER_BUDGET = "TrustBot has used today's answering allowance. Try tomorrow.";
export type FixedReply = typeof COURIER_REFUSAL | typeof COURIER_SUMMARY_REFUSAL | typeof COURIER_BUSY | typeof COURIER_ANSWER_BUDGET;
const FIXED_REPLIES: ReadonlySet<string> = new Set<FixedReply>([COURIER_REFUSAL, COURIER_SUMMARY_REFUSAL, COURIER_BUSY, COURIER_ANSWER_BUDGET]);

/** Text that passed the copy guard. Only guardReply makes one; the send path refuses anything else. */
export interface GuardedReply { readonly kind: "guarded"; readonly text: string }
export type CourierReplyText = GuardedReply | FixedReply;
const issued = new WeakSet<GuardedReply>();

/** A model failure that has a fixed answer for the asking agent instead of silence. */
export class CourierFixedReply extends Error {
  constructor(readonly reply: FixedReply) { super("courier_fixed_reply"); }
}

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** Check both thresholds: a short twelve-word phrase, or a long run without word boundaries. */
export function copiesReadRecord(reply: string, records: readonly string[]): boolean {
  const answer = normalize(reply);
  const words = answer.split(" ");
  for (const record of records) {
    const source = normalize(record);
    for (let i = 0; i + 80 <= answer.length; i++) if (source.includes(answer.slice(i, i + 80))) return true;
    const sourceWords = ` ${source} `;
    for (let i = 0; i + 12 <= words.length; i++) if (sourceWords.includes(` ${words.slice(i, i + 12).join(" ")} `)) return true;
  }
  return false;
}

/** What one Courier turn read. Only courierTurn opens one (openTurnReadLog), so a reply is always checked against real reads. */
class TurnReadLog {
  readonly #records: string[] = [];
  record(texts: readonly string[]): void { this.#records.push(...texts); }
  get records(): readonly string[] { return this.#records; }
}
export type { TurnReadLog };
const opened = new WeakSet<TurnReadLog>();
/** For courierTurn only: one log per turn, filled with every successful read result. */
export function openTurnReadLog(): TurnReadLog {
  const log = new TurnReadLog();
  opened.add(log);
  return log;
}

/** The only producer of GuardedReply: undefined when the text copies a read this turn made. Refuses a log courierTurn did not open. */
export function guardReply(text: string, log: TurnReadLog): GuardedReply | undefined {
  if (!opened.has(log)) throw new Error("courier_guard_unissued");
  if (copiesReadRecord(text, log.records)) return undefined;
  const reply: GuardedReply = Object.freeze({ kind: "guarded", text });
  issued.add(reply);
  return reply;
}

export const isCourierReply = (value: unknown): value is CourierReplyText =>
  typeof value === "string" ? FIXED_REPLIES.has(value) : typeof value === "object" && value !== null && issued.has(value as GuardedReply);
export const replyText = (reply: CourierReplyText): string => typeof reply === "string" ? reply : reply.text;
