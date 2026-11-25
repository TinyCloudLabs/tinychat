// The gateway's side of `propose_action`: the `app` MCP server's tool, its limits, and the approvals it issued. Every
// call is checked here, so the sandbox cannot get past the recipients the supervisor allows for the turn, the limits
// or a final decision by anything it sends. Each proposal gets an id and a binding (owner, bot, kind, recipients,
// text) that are kept on the gateway's volume; the supervisor may spend that binding once, after the owner's tap,
// and nothing the box can reach spends it. A feedback report (feedback.ts) is built here, proposed only in a turn the
// owner started, and posted from here after the owner's tap: the one POST this gateway makes to the feedback origin.
// Log lines carry outcomes and nothing the model or the owner wrote.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  ACTION_ERRORS, ACTION_EXPIRY_MS, ACTION_KINDS, actionBinding, actionHash, type ActionKind, type ActionPayload, type ActionsPush, checkedTargets,
  MAX_ACTION_TEXT, MAX_ACTIONS_PER_DAY, MAX_PENDING_ACTIONS, MAX_TARGETS, MIN_TARGETS, type NewAction, plainMessage,
} from "./actions";
import { utcDay } from "./asks";
import { FEEDBACK_ORIGIN } from "./config";
import {
  FEEDBACK_ERRORS, FEEDBACK_GAP_MS, FEEDBACK_TYPES, type FeedbackSent, MAX_FEEDBACK_FIELD, MAX_FEEDBACK_PER_DAY, MAX_FEEDBACK_POSTS_PER_MINUTE,
  MAX_FEEDBACK_TITLE, MAX_OPEN_FEEDBACK, postFeedback, proposedFeedback, storedFeedback,
} from "./feedback";
import { isRecord } from "./guards";
import { toolText } from "./web";

export const PROPOSE_TOOL = {
  name: "propose_action",
  description:
    "Propose sending one message to two or more of the owner's other bots. The owner sees a card with the recipients and your message exactly as written, " +
    "and taps Send or Don't send; TinyCloud sends it once. It returns an id and the state \"pending\" at once; do not wait. " +
    "The outcome arrives later as a message from the app. To message one bot, use message_bot. " +
    "With kind \"send_feedback\" and a report, propose sending one report about TinyCloud (a bug, something hard to use or an idea) to the TinyCloud team. " +
    "Propose it only when the owner asked for it in this turn. The owner sees the report exactly as written and taps Send report or Don't send. " +
    "It goes without the owner's name or account. Put no secret, email, key, token, address or home path in it; write a placeholder such as <token> in its place. " +
    "Security issues can't be reported this way; tell the owner to raise them with the TinyCloud team directly.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string", enum: ["message_bots", "send_feedback"],
        description: "What to do. \"message_bots\": send one message to several bots. \"send_feedback\": send one feedback report to the TinyCloud team.",
      },
      targets: {
        type: "array", minItems: MIN_TARGETS, maxItems: MAX_TARGETS, uniqueItems: true, items: { type: "string" },
        description: "For message_bots: keys of the bots to message, two or more, from the bots you can message.",
      },
      text: { type: "string", minLength: 1, maxLength: MAX_ACTION_TEXT, description: "For message_bots: the message, exactly as each bot should get it." },
      report: {
        type: "object",
        description: "For send_feedback: the report, exactly as the team should get it.",
        properties: {
          type: { type: "string", enum: [...FEEDBACK_TYPES] },
          title: { type: "string", minLength: 1, maxLength: MAX_FEEDBACK_TITLE, description: "One line." },
          tried: { type: "string", minLength: 1, maxLength: MAX_FEEDBACK_FIELD, description: "What the owner tried to do." },
          happened: { type: "string", minLength: 1, maxLength: MAX_FEEDBACK_FIELD, description: "What happened." },
          expected: { type: "string", minLength: 1, maxLength: MAX_FEEDBACK_FIELD, description: "What the owner expected." },
        },
        required: ["type", "title", "tried", "happened", "expected"],
        additionalProperties: false,
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
} as const;

/**
 * One approval the gateway issued: whose, what it binds, until when, and whether it has been spent. `kind` and `at`
 * (when it was proposed) hold the feedback limits; an entry saved without them is a message to bots.
 */
export interface IssuedAction {
  bot: string;
  binding: string;
  expiresAt: number;
  kind?: ActionKind;
  at?: number;
  spent?: true;
}

export interface ActionLedgerStore {
  load(): Record<string, IssuedAction> | undefined;
  save(issued: Record<string, IssuedAction>): void;
}

/**
 * Issued approvals beside the budget file, saved the same way: temporary file, fsync, rename, fsync of the directory.
 * A file that cannot be read starts an empty ledger, which spends nothing: every approval it held is refused.
 */
export function fileActionLedgerStore(path: string): ActionLedgerStore {
  return {
    load() {
      if (!existsSync(path)) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        value = undefined;
      }
      const valid = isRecord(value) && Object.entries(value).every(([id, entry]) => /^[0-9a-f]{24}$/.test(id) && isRecord(entry)
        && typeof entry.bot === "string" && typeof entry.binding === "string" && Number.isSafeInteger(entry.expiresAt) && (entry.spent === undefined || entry.spent === true)
        && (entry.kind === undefined || ACTION_KINDS.some(kind => kind === entry.kind)) && (entry.at === undefined || Number.isSafeInteger(entry.at)));
      if (valid) return value as Record<string, IssuedAction>;
      console.log(JSON.stringify({ gateway: "actions", outcome: "ledger_unreadable" }));
      return undefined;
    },
    save(issued) {
      const fresh = `${path}.new`;
      const file = openSync(fresh, "w", 0o600);
      try {
        writeSync(file, JSON.stringify(issued));
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(fresh, path);
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    },
  };
}

/** An issued approval may be spent until an hour past its proposal's expiry (the supervisor's clock may lag); then it goes. */
const SPEND_GRACE_MS = 60 * 60_000;

interface Ledger {
  /** The recipients Main may name, as the supervisor gave them at the start of the turn. */
  keys: string[];
  /** The owner wrote the message that started the current turn, as the supervisor said at its start. */
  ownerTurn: boolean;
  pending: number;
  /** Open feedback proposals, as the supervisor counted them. */
  feedback: number;
  day: string;
  today: number;
  final: Set<string>;
  /** Proposals made since the supervisor last collected. */
  outbox: NewAction[];
}

export class ActionDesk {
  readonly #now: () => number;
  readonly #ownerOf: (botId: string) => string;
  readonly #outside: (botId: string) => boolean;
  readonly #ledgers = new Map<string, Ledger>();
  readonly #issued = new Map<string, IssuedAction>();
  readonly #store: ActionLedgerStore | undefined;
  readonly #held: (botId: string) => boolean;
  readonly #feedbackUrl: string;
  /** When each feedback POST of the last minute started, across all bots. */
  #posts: number[] = [];

  /**
   * `held`: whether the bot's chat holds the owner's private data, which sends nothing to other bots (meeting-reads.ts).
   * `feedbackUrl`: where reports go; FEEDBACK_ORIGIN unless a loopback mock (config.ts).
   */
  constructor(
    now: () => number, ownerOf: (botId: string) => string, outside: (botId: string) => boolean, store?: ActionLedgerStore,
    held: (botId: string) => boolean = () => false, feedbackUrl: string = FEEDBACK_ORIGIN,
  ) {
    this.#held = held;
    this.#now = now;
    this.#ownerOf = ownerOf;
    this.#outside = outside;
    this.#store = store;
    this.#feedbackUrl = feedbackUrl;
    for (const [id, entry] of Object.entries(store?.load() ?? {})) this.#issued.set(id, entry);
  }

  #ledger(botId: string): Ledger {
    let ledger = this.#ledgers.get(botId);
    if (!ledger) this.#ledgers.set(botId, (ledger = { keys: [], ownerTurn: false, pending: 0, feedback: 0, day: "", today: 0, final: new Set(), outbox: [] }));
    return ledger;
  }

  /**
   * The supervisor's counts and final proposals, and at a turn's start the recipients Main may name in it and whether
   * the owner started it. Only this push sets `ownerTurn`; nothing the box sends does.
   */
  push(botId: string, push: ActionsPush): void {
    const ledger = this.#ledger(botId);
    if (push.keys) {
      ledger.keys = [...push.keys];
      ledger.ownerTurn = push.ownerTurn === true;
    }
    ledger.pending = push.pending;
    ledger.feedback = push.feedback ?? 0;
    ledger.day = push.day;
    ledger.today = push.today;
    ledger.final = new Set(push.final);
  }

  /** Hands the supervisor the proposals made since its last collection; they count as its own from now. */
  drain(botId: string): NewAction[] {
    const ledger = this.#ledgers.get(botId);
    if (!ledger) return [];
    const actions = ledger.outbox;
    ledger.outbox = [];
    ledger.pending += actions.length;
    ledger.feedback += actions.filter(action => action.kind === "send_feedback").length;
    ledger.today += actions.filter(action => utcDay(action.askedAt) === ledger.day).length;
    return actions;
  }

  /** The bot's sandbox is gone: the recipients it may name go; uncollected proposals and issued approvals stay. */
  drop(botId: string): void {
    const ledger = this.#ledgers.get(botId);
    if (!ledger) return;
    if (ledger.outbox.length === 0) this.#ledgers.delete(botId);
    else {
      ledger.keys = [];
      ledger.ownerTurn = false;
    }
  }

  #persist(): boolean {
    const now = this.#now();
    for (const [id, entry] of this.#issued) if (entry.expiresAt + SPEND_GRACE_MS <= now) this.#issued.delete(id);
    try {
      this.#store?.save(Object.fromEntries(this.#issued));
      return true;
    } catch {
      console.log(JSON.stringify({ gateway: "actions", outcome: "ledger_unsaved" }));
      return false;
    }
  }

  /**
   * Spends an approval: true once, for the bot it was issued to, with exactly the binding it was issued with, before
   * it lapses. Only the supervisor's control socket reaches this. A spend that cannot be saved is refused.
   */
  spend(botId: string, id: string, binding: string): boolean {
    // An approval issued before a meeting read cannot be sent after it; it is left unspent.
    if (this.#held(botId)) {
      console.log(JSON.stringify({ gateway: "actions", bot: botId.slice(0, 12), outcome: "spend_held" }));
      return false;
    }
    const entry = this.#issued.get(id);
    const ok = entry !== undefined && entry.bot === botId && entry.binding === binding && !entry.spent && this.#now() < entry.expiresAt + SPEND_GRACE_MS;
    if (ok) {
      entry.spent = true;
      if (!this.#persist()) {
        console.log(JSON.stringify({ gateway: "actions", bot: botId.slice(0, 12), outcome: "spend_refused" }));
        return false;
      }
    }
    console.log(JSON.stringify({ gateway: "actions", bot: botId.slice(0, 12), outcome: ok ? "spent" : "spend_refused" }));
    return ok;
  }

  /**
   * Sends an approved report after the owner's tap. Refused while the chat is held, and unless the body passes the
   * same checks as at proposal and its binding, recomputed here, is the one issued for this bot and the one given.
   * Then the global cap, then the spend (saved) and only then one POST. A stop after the spend leaves the outcome
   * unknown; the report is never posted twice. The log line holds the outcome and status, never a field or the report id.
   */
  async send(botId: string, id: string, binding: string, body: string): Promise<FeedbackSent> {
    const log = (outcome: FeedbackSent["outcome"], status?: number, code?: string) => console.log(JSON.stringify({
      gateway: "actions", bot: botId.slice(0, 12), kind: "send_feedback", outcome, ...(status !== undefined ? { status } : {}), ...(code ? { code } : {}),
    }));
    if (this.#held(botId)) {
      log("refused");
      return { outcome: "refused" };
    }
    const entry = this.#issued.get(id);
    const payload: ActionPayload = { kind: "send_feedback", targets: [], text: body };
    if (entry?.kind !== "send_feedback" || !storedFeedback(body) || actionBinding(this.#ownerOf(botId), botId, payload) !== binding) {
      log("refused");
      return { outcome: "refused" };
    }
    const now = this.#now();
    this.#posts = this.#posts.filter(at => at > now - 60_000);
    if (this.#posts.length >= MAX_FEEDBACK_POSTS_PER_MINUTE) {
      log("busy");
      return { outcome: "busy" };
    }
    if (!this.spend(botId, id, binding)) {
      log("refused");
      return { outcome: "refused" };
    }
    this.#posts.push(now);
    const { status, ...sent } = await postFeedback(this.#feedbackUrl, body);
    log(sent.outcome, status, sent.code);
    return sent;
  }

  /** One `propose_action` call, from a bot whose owner allows requests. Never throws; answers a fixed sentence or `{id, state}`. */
  call(botId: string, args: Record<string, unknown>) {
    if (args.kind === "send_feedback") return this.#callFeedback(botId, args);
    const log = (outcome: string) => console.log(JSON.stringify({ gateway: "actions", bot: botId.slice(0, 12), tool: "propose_action", outcome }));
    const refuse = (error: keyof typeof ACTION_ERRORS, outcome: string) => {
      log(outcome);
      return toolText(ACTION_ERRORS[error], true);
    };
    if (this.#held(botId)) return refuse("held", "held");
    const ledger = this.#ledger(botId);
    const extra = Object.keys(args).some(key => key !== "kind" && key !== "targets" && key !== "text");
    const targets = checkedTargets(args.targets);
    const text = plainMessage(args.text, MAX_ACTION_TEXT);
    if (extra || args.kind !== "message_bots" || !targets || text === undefined || !targets.every(key => ledger.keys.includes(key))) {
      return refuse("invalid", "invalid");
    }
    const payload = { kind: "message_bots" as const, targets, text };
    if (ledger.final.has(actionHash(payload))) return refuse("final", "final");
    const limit = this.#ownerLimit(botId);
    if (limit) return refuse(limit, limit === "pending" ? "too_many_pending" : "daily_limit");
    return this.#issue(botId, payload, log) ?? refuse("pending", "ledger_unsaved");
  }

  /** The owner-wide limits on open proposals and proposals today, across all of the owner's bots. */
  #ownerLimit(botId: string): "pending" | "daily" | undefined {
    const day = utcDay(this.#now());
    const owner = this.#ownerOf(botId);
    let ownerPending = 0;
    let ownerToday = 0;
    for (const [other, held] of this.#ledgers) {
      if (this.#ownerOf(other) !== owner) continue;
      ownerPending += held.pending + held.outbox.length;
      ownerToday += (held.day === day ? held.today : 0) + held.outbox.filter(action => utcDay(action.askedAt) === day).length;
    }
    if (ownerPending >= MAX_PENDING_ACTIONS) return "pending";
    if (ownerToday >= MAX_ACTIONS_PER_DAY) return "daily";
    return undefined;
  }

  /** Issues and keeps the approval, then queues the proposal; undefined when the approval could not be kept. */
  #issue(botId: string, payload: ActionPayload, log: (outcome: string) => void) {
    const now = this.#now();
    const id = randomBytes(12).toString("hex");
    const binding = actionBinding(this.#ownerOf(botId), botId, payload);
    this.#issued.set(id, { bot: botId, binding, expiresAt: now + ACTION_EXPIRY_MS, kind: payload.kind, at: now });
    // A proposal whose approval could not be kept could never be spent: it is not made.
    if (!this.#persist()) {
      this.#issued.delete(id);
      return undefined;
    }
    this.#ledger(botId).outbox.push({ id, ...payload, targets: [...payload.targets], binding, askedAt: now, outside: this.#outside(botId) });
    log("proposed");
    return toolText(JSON.stringify({ id, state: "pending" }));
  }

  /**
   * `send_feedback`: only in a turn the owner started, never from a held chat; a report that is valid, clean of
   * anything that looks like a secret and not a security report; within the owner-wide limits and the feedback ones
   * (one open, one per 10 minutes, three per UTC day, from the issued approvals of the last 25 hours).
   */
  #callFeedback(botId: string, args: Record<string, unknown>) {
    const log = (outcome: string) => console.log(JSON.stringify({ gateway: "actions", bot: botId.slice(0, 12), tool: "propose_action", kind: "send_feedback", outcome }));
    const refuse = (text: string, outcome: string) => {
      log(outcome);
      return toolText(text, true);
    };
    if (this.#held(botId)) return refuse(FEEDBACK_ERRORS.held, "held");
    const ledger = this.#ledger(botId);
    if (!ledger.ownerTurn) return refuse(FEEDBACK_ERRORS.ownerTurn, "not_owner_turn");
    if (Object.keys(args).some(key => key !== "kind" && key !== "report")) return refuse(FEEDBACK_ERRORS.invalid, "invalid");
    const built = proposedFeedback(args.report);
    if ("error" in built) return refuse(FEEDBACK_ERRORS[built.error], built.error);
    const payload: ActionPayload = { kind: "send_feedback", targets: [], text: built.body };
    if (ledger.final.has(actionHash(payload))) return refuse(FEEDBACK_ERRORS.final, "final");
    const limit = this.#ownerLimit(botId);
    if (limit) return refuse(ACTION_ERRORS[limit], limit === "pending" ? "too_many_pending" : "daily_limit");

    const now = this.#now();
    const day = utcDay(now);
    const owner = this.#ownerOf(botId);
    let open = 0;
    for (const [other, held] of this.#ledgers) {
      if (this.#ownerOf(other) === owner) open += held.feedback + held.outbox.filter(action => action.kind === "send_feedback").length;
    }
    if (open >= MAX_OPEN_FEEDBACK) return refuse(ACTION_ERRORS.pending, "feedback_open");
    const issued = [...this.#issued.values()].filter(entry => entry.kind === "send_feedback" && entry.at !== undefined && this.#ownerOf(entry.bot) === owner);
    if (issued.some(entry => entry.at! > now - FEEDBACK_GAP_MS)) return refuse(FEEDBACK_ERRORS.gap, "feedback_gap");
    if (issued.filter(entry => utcDay(entry.at!) === day).length >= MAX_FEEDBACK_PER_DAY) return refuse(FEEDBACK_ERRORS.daily, "feedback_daily");
    return this.#issue(botId, payload, log) ?? refuse(ACTION_ERRORS.pending, "ledger_unsaved");
  }
}
