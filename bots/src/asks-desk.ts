// The gateway's side of `ask_owner`: the `app` MCP server's tool, the owner's setting as pushed by the supervisor,
// and the limits. Every call is checked here, so the sandbox cannot get past the setting or the caps by anything it
// sends. The gateway only holds a new question until the supervisor collects it; the records are the supervisor's.
// Log lines carry counts by outcome and nothing the model or the owner wrote.

import { randomBytes } from "node:crypto";
import {
  ASK_ERRORS, type AsksPush, DECLINE_COOLDOWN_MS, MAX_CHOICE_CHARS, MAX_CHOICES, MAX_PENDING, MAX_PER_DAY, MAX_QUESTION_CHARS, type NewAsk,
  plainAskText, questionHash, utcDay,
} from "./asks";
import { toolText } from "./web";

export const APP_TOOLS = [
  {
    name: "ask_owner",
    description:
      "Ask the owner one short question when you need something only they can give. It returns an id and the state \"pending\" at once; " +
      "do not wait for it. If the owner answers, the answer arrives later as a new message from the app. The question is shown to the owner as plain text. " +
      "Never ask for passwords or keys. The owner may have turned this off, and may say not now.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: MAX_QUESTION_CHARS, description: `The question, plain text, at most ${MAX_QUESTION_CHARS} characters.` },
        choices: {
          type: "array", maxItems: MAX_CHOICES, items: { type: "string", minLength: 1, maxLength: MAX_CHOICE_CHARS },
          description: `Optional answers to offer, at most ${MAX_CHOICES}, each at most ${MAX_CHOICE_CHARS} characters.`,
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
] as const;

interface Ledger {
  enabled: boolean;
  /** The supervisor's counts at its last push (they include every question it has collected). */
  pending: number;
  day: string;
  today: number;
  declined: Map<string, number>;
  /** Questions asked since the supervisor last collected. */
  outbox: NewAsk[];
  /** Something from outside the owner's own words has reached Main's conversation: asks from now on say so. */
  outside: boolean;
}

export class AskDesk {
  readonly #now: () => number;
  readonly #ownerOf: (botId: string) => string;
  readonly #ledgers = new Map<string, Ledger>();

  constructor(now: () => number, ownerOf: (botId: string) => string) {
    this.#now = now;
    this.#ownerOf = ownerOf;
  }

  #ledger(botId: string): Ledger {
    let ledger = this.#ledgers.get(botId);
    if (!ledger) this.#ledgers.set(botId, (ledger = { enabled: false, pending: 0, day: "", today: 0, declined: new Map(), outbox: [], outside: false }));
    return ledger;
  }

  /** The supervisor's setting, counts and cooldowns for this bot. Applies from the bot's next call. */
  push(botId: string, push: AsksPush): void {
    const ledger = this.#ledger(botId);
    ledger.enabled = push.enabled;
    ledger.pending = push.pending;
    ledger.day = push.day;
    ledger.today = push.today;
    ledger.declined = new Map(push.declined.map(entry => [entry.hash, entry.until]));
    // Only ever turned on here: a later push cannot say the conversation is clean again. The supervisor keeps the truth.
    if (push.turn?.outside) ledger.outside = true;
  }

  /**
   * Hands the supervisor the questions asked since its last collection. They count as the supervisor's from now,
   * until its next push says what it holds, so the limits never dip between the two.
   */
  drain(botId: string): NewAsk[] {
    const ledger = this.#ledgers.get(botId);
    if (!ledger) return [];
    const asks = ledger.outbox;
    ledger.outbox = [];
    ledger.pending += asks.length;
    ledger.today += asks.filter(ask => utcDay(ask.askedAt) === ledger.day).length;
    return asks;
  }

  /**
   * The bot's sandbox is gone: its setting and its outside flag go (the supervisor gives both again at the next
   * launch, the flag from what it kept); uncollected questions stay.
   */
  drop(botId: string): void {
    const ledger = this.#ledgers.get(botId);
    if (!ledger) return;
    if (ledger.outbox.length === 0) this.#ledgers.delete(botId);
    else {
      ledger.enabled = false;
      ledger.outside = false;
    }
  }

  /** A web tool was called by the box: anything Main asks from now on may have been shaped by outside text. */
  markOutside(botId: string): void {
    this.#ledger(botId).outside = true;
  }

  /** Whether outside text has reached Main's conversation while this sandbox ran; the supervisor keeps it from here. */
  outside(botId: string): boolean {
    return this.#ledgers.get(botId)?.outside === true;
  }

  /** Whether the `app` tools are offered: only while the owner's setting is on. */
  enabled(botId: string): boolean {
    return this.#ledgers.get(botId)?.enabled === true;
  }

  #pending(ledger: Ledger): number {
    return ledger.pending + ledger.outbox.length;
  }

  #today(ledger: Ledger, day: string): number {
    return (ledger.day === day ? ledger.today : 0) + ledger.outbox.filter(ask => utcDay(ask.askedAt) === day).length;
  }

  /** One `ask_owner` call. Never throws and never answers with anything but a fixed sentence or `{id, state}`. */
  call(botId: string, args: Record<string, unknown>) {
    const log = (outcome: string) => console.log(JSON.stringify({ gateway: "asks", bot: botId.slice(0, 12), tool: "ask_owner", outcome }));
    const refuse = (error: keyof typeof ASK_ERRORS, outcome: string) => {
      log(outcome);
      return toolText(ASK_ERRORS[error], true);
    };
    const ledger = this.#ledgers.get(botId);
    if (!ledger?.enabled) return refuse("off", "off");

    const question = plainAskText(args.question, MAX_QUESTION_CHARS);
    const extra = Object.keys(args).some(key => key !== "question" && key !== "choices");
    if (question === undefined || extra) return refuse("invalid", "invalid");
    let choices: string[] = [];
    if (args.choices !== undefined) {
      if (!Array.isArray(args.choices) || args.choices.length > MAX_CHOICES) return refuse("invalid", "invalid");
      const checked = args.choices.map(choice => plainAskText(choice, MAX_CHOICE_CHARS));
      if (checked.includes(undefined)) return refuse("invalid", "invalid");
      choices = checked as string[];
    }

    const now = this.#now();
    const until = ledger.declined.get(questionHash(question));
    if (until !== undefined && until > now && until - DECLINE_COOLDOWN_MS <= now) return refuse("recent", "recent");

    // Per bot and per owner: today an owner has one bot, so the two agree, but the cap is on the owner.
    const day = utcDay(now);
    const owner = this.#ownerOf(botId);
    let ownerPending = 0;
    let ownerToday = 0;
    for (const [other, held] of this.#ledgers) {
      if (this.#ownerOf(other) !== owner) continue;
      ownerPending += this.#pending(held);
      ownerToday += this.#today(held, day);
    }
    if (this.#pending(ledger) >= MAX_PENDING || ownerPending >= MAX_PENDING) return refuse("pending", "too_many_pending");
    if (this.#today(ledger, day) >= MAX_PER_DAY || ownerToday >= MAX_PER_DAY) return refuse("daily", "daily_limit");

    const id = randomBytes(12).toString("hex");
    ledger.outbox.push({ id, question, choices, askedAt: now, outside: ledger.outside });
    log("asked");
    return toolText(JSON.stringify({ id, state: "pending" }));
  }
}
