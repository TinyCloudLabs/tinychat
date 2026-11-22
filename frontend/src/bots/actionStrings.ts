// Every owner-visible word of a proposal from the owner's main bot (TC-3793): the card on Home and in its chat, what
// the card collapses to, and the chat lines after a decision. Monica's words; nothing else in the app writes these.
import { BOTS_STRINGS } from "./botsStrings";

const BOT = BOTS_STRINGS.mainName;

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const ACTION_STRINGS = {
  title: (names: string) => `${BOT} wants to send this message to ${names}:`,
  label: `Written by ${BOT}`,
  footer: "Each bot gets the message exactly as written and replies in its own chat. Sending uses your daily allowance.",
  /** Shown only when the bot read a web page or another bot's message first. */
  outside: `${BOT} read a web page or someone else’s message before writing this, so send only if it is what you expect.`,
  /** A recipient that is no longer one of the owner's bots. */
  missing: "a deleted bot",
  send: "Send",
  decline: "Don’t send",
  sendFailed: "Couldn’t send that. Try again.",

  /** What a card collapses to. */
  sending: "Sending…",
  sent: (sent: string) => `Sent to ${sent}.`,
  partly: (sent: string, failed: string) => `Sent to ${sent}. Couldn’t reach ${failed}.`,
  notSent: "Couldn’t send it. Nothing was sent.",
  declined: "You chose not to send it.",
  expired: "This request expired. Nothing was sent.",

  /** App-originated lines in the chat. Without names (a reload), the line says "other bots". */
  lineSent: (names: string) => `You sent ${BOT}’s message to ${names}.`,
  lineDeclined: (names: string) => `You chose not to send ${BOT}’s message to ${names}.`,
  otherBots: "other bots",
} as const;
