// The gateway's side of `propose_action`: the `app` MCP server's tool, its limits, and the approvals it issued. Every
// call is checked here, so the sandbox cannot get past the recipients the supervisor allows for the turn, the limits
// or a final decision by anything it sends. Each proposal gets an id and a binding (owner, bot, kind, recipients,
// text) that are kept on the gateway's volume; the supervisor may spend that binding once, after the owner's tap,
// and nothing the box can reach spends it. Log lines carry outcomes and nothing the model or the owner wrote.

import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  ACTION_ERRORS, ACTION_EXPIRY_MS, actionBinding, actionHash, type ActionsPush, checkedTargets, MAX_ACTION_TEXT, MAX_ACTIONS_PER_DAY,
  MAX_PENDING_ACTIONS, MAX_TARGETS, MIN_TARGETS, type NewAction, plainMessage,
} from "./actions";
import { utcDay } from "./asks";
import { isRecord } from "./guards";
import { toolText } from "./web";

export const PROPOSE_TOOL = {
  name: "propose_action",
  description:
    "Propose sending one message to two or more of the owner's other bots. The owner sees a card with the recipients and your message exactly as written, " +
    "and taps Send or Don't send; TinyCloud sends it once. It returns an id and the state \"pending\" at once; do not wait. " +
    "The outcome arrives later as a message from the app. To message one bot, use message_bot.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["message_bots"], description: "What to do. \"message_bots\": send one message to several bots." },
      targets: {
        type: "array", minItems: MIN_TARGETS, maxItems: MAX_TARGETS, uniqueItems: true, items: { type: "string" },
        description: "Keys of the bots to message: two or more, from the bots you can message.",
      },
      text: { type: "string", minLength: 1, maxLength: MAX_ACTION_TEXT, description: "The message, exactly as each bot should get it." },
    },
    required: ["kind", "targets", "text"],
    additionalProperties: false,
  },
} as const;

/** One approval the gateway issued: whose, what it binds, until when, and whether it has been spent. */
export interface IssuedAction {
  bot: string;
  binding: string;
  expiresAt: number;
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
        && typeof entry.bot === "string" && typeof entry.binding === "string" && Number.isSafeInteger(entry.expiresAt) && (entry.spent === undefined || entry.spent === true));
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
  pending: number;
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

  constructor(now: () => number, ownerOf: (botId: string) => string, outside: (botId: string) => boolean, store?: ActionLedgerStore) {
    this.#now = now;
    this.#ownerOf = ownerOf;
    this.#outside = outside;
    this.#store = store;
    for (const [id, entry] of Object.entries(store?.load() ?? {})) this.#issued.set(id, entry);
  }

  #ledger(botId: string): Ledger {
    let ledger = this.#ledgers.get(botId);
    if (!ledger) this.#ledgers.set(botId, (ledger = { keys: [], pending: 0, day: "", today: 0, final: new Set(), outbox: [] }));
    return ledger;
  }

  /** The supervisor's counts and final proposals, and at a turn's start the recipients Main may name in it. */
  push(botId: string, push: ActionsPush): void {
    const ledger = this.#ledger(botId);
    if (push.keys) ledger.keys = [...push.keys];
    ledger.pending = push.pending;
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
    ledger.today += actions.filter(action => utcDay(action.askedAt) === ledger.day).length;
    return actions;
  }

  /** The bot's sandbox is gone: the recipients it may name go; uncollected proposals and issued approvals stay. */
  drop(botId: string): void {
    const ledger = this.#ledgers.get(botId);
    if (!ledger) return;
    if (ledger.outbox.length === 0) this.#ledgers.delete(botId);
    else ledger.keys = [];
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

  /** One `propose_action` call, from a bot whose owner allows requests. Never throws; answers a fixed sentence or `{id, state}`. */
  call(botId: string, args: Record<string, unknown>) {
    const log = (outcome: string) => console.log(JSON.stringify({ gateway: "actions", bot: botId.slice(0, 12), tool: "propose_action", outcome }));
    const refuse = (error: keyof typeof ACTION_ERRORS, outcome: string) => {
      log(outcome);
      return toolText(ACTION_ERRORS[error], true);
    };
    const ledger = this.#ledger(botId);
    const extra = Object.keys(args).some(key => key !== "kind" && key !== "targets" && key !== "text");
    const targets = checkedTargets(args.targets);
    const text = plainMessage(args.text, MAX_ACTION_TEXT);
    if (extra || args.kind !== "message_bots" || !targets || text === undefined || !targets.every(key => ledger.keys.includes(key))) {
      return refuse("invalid", "invalid");
    }
    const payload = { kind: "message_bots" as const, targets, text };
    if (ledger.final.has(actionHash(payload))) return refuse("final", "final");

    const now = this.#now();
    const day = utcDay(now);
    const owner = this.#ownerOf(botId);
    let ownerPending = 0;
    let ownerToday = 0;
    for (const [other, held] of this.#ledgers) {
      if (this.#ownerOf(other) !== owner) continue;
      ownerPending += held.pending + held.outbox.length;
      ownerToday += (held.day === day ? held.today : 0) + held.outbox.filter(action => utcDay(action.askedAt) === day).length;
    }
    if (ownerPending >= MAX_PENDING_ACTIONS) return refuse("pending", "too_many_pending");
    if (ownerToday >= MAX_ACTIONS_PER_DAY) return refuse("daily", "daily_limit");

    const id = randomBytes(12).toString("hex");
    const binding = actionBinding(owner, botId, payload);
    this.#issued.set(id, { bot: botId, binding, expiresAt: now + ACTION_EXPIRY_MS });
    // A proposal whose approval could not be kept could never be spent: it is not made.
    if (!this.#persist()) {
      this.#issued.delete(id);
      return refuse("pending", "ledger_unsaved");
    }
    ledger.outbox.push({ id, ...payload, binding, askedAt: now, outside: this.#outside(botId) });
    log("proposed");
    return toolText(JSON.stringify({ id, state: "pending" }));
  }
}
