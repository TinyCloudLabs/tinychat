// Every owner-visible word of Main's questions to the owner (TC-3595): the card in Main's chat and on Home, the
// chat lines after a decision, and the Settings toggle. Nothing else in the app writes these words.
// Monica's words (agent-ask-owner-words); Sam reviews them in parallel, and changes come as fast follow-ups.

import { MAIN_BOT_NAME } from "./botsStrings";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "less than a minute", "5 minutes", "3 hours", "1 hour 5 minutes": spelled out, as the card says "Asked … ago". */
export function askedAgo(elapsedMs: number): string {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 1) return "Asked less than a minute ago";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [hours > 0 ? plural(hours, "hour", "hours") : "", rest > 0 || hours === 0 ? plural(rest, "minute", "minutes") : ""];
  return `Asked ${parts.filter(Boolean).join(" ")} ago`;
}

export const ASK_STRINGS = {
  /** The Settings toggle. */
  toggleLabel: `Let ${MAIN_BOT_NAME} ask you questions`,
  toggleHelp: `${MAIN_BOT_NAME} can ask you a question in chat when it needs something from you. Off until you turn it on.`,
  toggleFailed: "Couldn’t save that, so the setting is unchanged. Try again.",

  /** The card. */
  asking: `${MAIN_BOT_NAME} is asking:`,
  quote: (question: string) => `“${question}”`,
  footer: `Your answer goes to ${MAIN_BOT_NAME} and the AI model service, like everything else in this chat.`,
  answerLabel: "Your answer",
  answerHint: `Don’t paste passwords or keys here. To give ${MAIN_BOT_NAME} access to an account, use Connectors.`,
  /** Shown under the answer box only while Web access is on. */
  webAccessOn: `Web access is on, so a page ${MAIN_BOT_NAME} reads could try to get it to send your answer to a website.`,
  /** Shown above the answer box only when the request says Main read something from outside the chat. */
  outside: `${MAIN_BOT_NAME} read a web page or someone else’s message before asking, so answer only if this question is what you expect.`,
  answer: "Answer",
  notNow: "Not now",
  stop: `Stop ${MAIN_BOT_NAME} from asking`,
  stopped: `${MAIN_BOT_NAME} won’t ask you questions. You can turn this back on in Settings.`,
  sendFailed: "Couldn’t send that. Try again.",
  gone: "This question can’t be answered any more.",

  /** What a card collapses to. */
  declined: "You said not now.",
  expired: "This question expired.",

  /** App-originated lines in the chat: shown to the owner, never taken for words the owner typed. */
  lineAnswered: `You answered ${MAIN_BOT_NAME}’s question.`,
  lineDeclined: `You said not now to ${MAIN_BOT_NAME}’s question.`,
  /** UI only: nothing is sent to Main when a question expires. */
  lineExpired: `${MAIN_BOT_NAME}’s question expired without an answer.`,
  /** UI only: shown once when the owner turns questions off, however many open questions were closed. */
  lineStopped: `You turned off questions from ${MAIN_BOT_NAME}, so its open questions were closed.`,
} as const;
