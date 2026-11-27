// The gateway's side of `ask_owner` and `request_secret`: the `app` MCP server's tools, the owner's setting as pushed
// by the supervisor, and the limits (one set for both kinds). Every call is checked here, so the sandbox cannot get
// past the setting or the caps by anything it sends. The gateway only holds a new request until the supervisor
// collects it; the records are the supervisor's. Log lines carry counts by outcome and nothing the model or the owner
// wrote.

import { randomBytes } from "node:crypto";
import {
  ASK_ERRORS, type AsksPush, DECLINE_COOLDOWN_MS, MAX_CHOICE_CHARS, MAX_CHOICES, MAX_PENDING, MAX_PER_DAY, MAX_QUESTION_CHARS, MAX_WHY_CHARS,
  type NewRequest, plainAskText, questionHash, SECRET_ERRORS, type SecretPush, secretHash, sitesFor, utcDay,
} from "./asks";
import { MAX_SITES, SECRET_NAME } from "./secret-catalog";
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
  {
    name: "request_secret",
    description:
      "Ask the owner to let you use one secret, by name, with the sites you name. It returns an id and the state \"pending\" at once; " +
      "do not wait for it. If the owner approves or declines, you get a new message from the app. You never see the secret's value.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: SECRET_NAME.source },
        why: { type: "string", minLength: 1, maxLength: MAX_WHY_CHARS, description: "One sentence the owner sees." },
        sites: {
          type: "array", maxItems: MAX_SITES, items: { type: "string" },
          description: "Host names, like api.example.com. Ignored for known services; their sites come from TinyCloud Secrets.",
        },
      },
      required: ["name", "why"],
      additionalProperties: false,
    },
  },
] as const;

interface Ledger {
  enabled: boolean;
  /** The supervisor's counts at its last push (they include every request it has collected). */
  pending: number;
  day: string;
  today: number;
  declined: Map<string, number>;
  /** The latest secret request for each name, as of the last push (and what was collected since). */
  secrets: SecretPush[];
  /** Requests made since the supervisor last collected. */
  outbox: NewRequest[];
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
    if (!ledger) this.#ledgers.set(botId, (ledger = { enabled: false, pending: 0, day: "", today: 0, declined: new Map(), secrets: [], outbox: [], outside: false }));
    return ledger;
  }

  /** The supervisor's setting, counts and cooldowns for this bot. Applies from the bot's next call. */
  push(botId: string, push: AsksPush): void {
    const ledger = this.#ledger(botId);
    ledger.enabled = push.enabled;
    // Off means off: what the box asked before it was told is not collected afterwards.
    if (!push.enabled) ledger.outbox = [];
    ledger.pending = push.pending;
    ledger.day = push.day;
    ledger.today = push.today;
    ledger.declined = new Map(push.declined.map(entry => [entry.hash, entry.until]));
    ledger.secrets = push.secrets ?? [];
    // Only ever turned on here: a later push cannot say the conversation is clean again. The supervisor keeps the truth.
    if (push.turn?.outside) ledger.outside = true;
  }

  /**
   * Hands the supervisor the requests made since its last collection. They count as the supervisor's from now,
   * until its next push says what it holds, so the limits never dip between the two.
   */
  drain(botId: string): NewRequest[] {
    const ledger = this.#ledgers.get(botId);
    if (!ledger) return [];
    const asks = ledger.outbox;
    ledger.outbox = [];
    ledger.pending += asks.length;
    ledger.today += asks.filter(ask => utcDay(ask.askedAt) === ledger.day).length;
    for (const ask of asks) {
      if (ask.kind !== "secret") continue;
      ledger.secrets = [...ledger.secrets.filter(secret => secret.name !== ask.name), { id: ask.id, name: ask.name, state: "pending", sites: ask.sites }];
    }
    return asks;
  }

  /** The latest secret request for each name, as the supervisor last said (for `call_with_secret` and `list_secrets`). */
  secrets(botId: string): readonly SecretPush[] {
    return this.#ledgers.get(botId)?.secrets ?? [];
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

  /** Account erase: the bot's ledger goes whole, uncollected questions included. */
  erase(botId: string): void {
    this.#ledgers.delete(botId);
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
    if (this.#cooling(ledger, questionHash(question), now)) return refuse("recent", "recent");
    const capped = this.#capped(botId, ledger, now);
    if (capped === "pending") return refuse("pending", "too_many_pending");
    if (capped === "daily") return refuse("daily", "daily_limit");

    const id = randomBytes(12).toString("hex");
    ledger.outbox.push({ id, question, choices, askedAt: now, outside: ledger.outside });
    log("asked");
    return toolText(JSON.stringify({ id, state: "pending" }));
  }

  /** Whether the owner declined this request (by its hash) within the cooldown. */
  #cooling(ledger: Ledger, hash: string, now: number): boolean {
    const until = ledger.declined.get(hash);
    return until !== undefined && until > now && until - DECLINE_COOLDOWN_MS <= now;
  }

  /** Which cap a new request would pass, counting questions and secret requests together. */
  #capped(botId: string, ledger: Ledger, now: number): "pending" | "daily" | undefined {
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
    if (this.#pending(ledger) >= MAX_PENDING || ownerPending >= MAX_PENDING) return "pending";
    if (this.#today(ledger, day) >= MAX_PER_DAY || ownerToday >= MAX_PER_DAY) return "daily";
    return undefined;
  }

  /**
   * One `request_secret` call. Never throws and never answers with anything but a fixed sentence (naming only the
   * secret, its sites and an end time) or `{id, state, name, sites}`. A known secret's sites are the catalog's,
   * whatever Main named.
   */
  callSecret(botId: string, args: Record<string, unknown>) {
    const log = (outcome: string) => console.log(JSON.stringify({ gateway: "asks", bot: botId.slice(0, 12), tool: "request_secret", outcome }));
    const refuse = (text: string, outcome: string) => {
      log(outcome);
      return toolText(text, true);
    };
    const ledger = this.#ledgers.get(botId);
    if (!ledger?.enabled) return refuse(SECRET_ERRORS.off(), "off");

    const name = args.name;
    const extra = Object.keys(args).some(key => key !== "name" && key !== "why" && key !== "sites");
    if (typeof name !== "string" || !SECRET_NAME.test(name) || extra) return refuse(SECRET_ERRORS.name(), "invalid");
    const why = plainAskText(args.why, MAX_WHY_CHARS);
    if (why === undefined) return refuse(SECRET_ERRORS.why(), "invalid");
    const sites = sitesFor(name, args.sites);
    if (!sites) return refuse(SECRET_ERRORS.sites(), "invalid");

    const now = this.#now();
    const held = ledger.secrets.find(secret => secret.name === name);
    if (held?.state === "approved" && held.until !== undefined && held.until > now) return refuse(SECRET_ERRORS.approved(name, held.sites, held.until), "approved");
    if (held?.state === "pending" || ledger.outbox.some(ask => ask.kind === "secret" && ask.name === name)) return refuse(SECRET_ERRORS.pending(name), "already_pending");
    if (this.#cooling(ledger, secretHash(name), now)) return refuse(SECRET_ERRORS.recent(name), "recent");
    const capped = this.#capped(botId, ledger, now);
    if (capped) return refuse(SECRET_ERRORS.many(), capped === "pending" ? "too_many_pending" : "daily_limit");

    const id = randomBytes(12).toString("hex");
    ledger.outbox.push({ kind: "secret", id, name, why, sites, askedAt: now, outside: ledger.outside });
    log("asked");
    return toolText(JSON.stringify({ id, state: "pending", name, sites }));
  }
}
