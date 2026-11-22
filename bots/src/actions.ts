// Main proposing an action (`propose_action`) for its owner to approve on a card. The first kind is one message to
// two or more of the owner's other bots. The gateway takes the box's call, checks it, gives it an id and binds it to
// the owner, the bot, the kind, the recipients and the text; the supervisor collects it into `actions.json`, beside
// the requests of `ask_owner` and outside anything a sandbox mounts. Only the owner's tap on the card approves it, and
// the owner's tap names the binding of what the card showed. The supervisor then has the gateway spend the approval
// (once, and only for that binding) and delivers the message to each recipient by the path `message_bot` takes. Main
// learns the outcome only from a message this service composes. A declined or expired proposal is final: the gateway
// refuses the same proposal from then on.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { normalizedQuestion, readAsksEnabled, utcDay } from "./asks";
import { isRecord } from "./guards";
import type { BotLayout } from "./layout";
import { isBotKey, MAIN_KEY } from "./owner";

export const ACTION_KINDS = ["message_bots"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const MIN_TARGETS = 2;
export const MAX_TARGETS = 8;
export const MAX_ACTION_TEXT = 2000;
export const MAX_PENDING_ACTIONS = 3;
export const MAX_ACTIONS_PER_DAY = 10;
export const ACTION_EXPIRY_MS = 24 * 60 * 60_000;
/** A send that has not finished by then (the supervisor stopped while sending) is over, with what it recorded. */
export const SENDING_LIMIT_MS = 15 * 60_000;
/** How long an outcome Main has not been told is kept. */
const REPLY_KEEP_MS = 12 * 60 * 60_000;
/** Metadata (recipients, state, hashes; no message text) of a finished proposal is kept this long, and at most this many. */
const META_KEEP_MS = 7 * 24 * 60 * 60_000;
const META_KEEP_COUNT = 200;
const LISTED_RESOLVED = 20;

/** Fixed sentences for the model. Never the message, a name, or anything the owner wrote. */
export const ACTION_ERRORS = {
  off: "The owner hasn't allowed requests from you. Carry on without proposing.",
  invalid: `A proposal names ${MIN_TARGETS} to ${MAX_TARGETS} different bots you can message and a message of 1 to ${MAX_ACTION_TEXT} characters.`,
  final: "The owner already declined this, or it expired. Don't propose it again, reword it or send it bot by bot.",
  pending: "Too many open requests for now. Carry on without proposing.",
  daily: "You've made enough requests for today. Carry on without proposing.",
  held: "Proposing a message to another bot is paused in this chat because it holds the owner’s private data. It stays paused until the chat is cleared after 30 days without use.",
} as const;

const listKeys = (keys: readonly string[]): string => keys.length < 2 ? keys.join("") : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;

/** What the supervisor tells Main once a proposal is decided: fixed text around the recipients' keys. */
export const ACTION_REPLIES = {
  sent: (delivered: readonly string[]) => `The owner approved your proposal. Your message was delivered to ${listKeys(delivered)}.`,
  partly: (delivered: readonly string[], failed: readonly string[]) =>
    `The owner approved your proposal. Your message was delivered to ${listKeys(delivered)}. It could not be delivered to ${listKeys(failed)}.`,
  notSent: "The owner approved your proposal, but it could not be sent. Nothing was delivered. Don't send it bot by bot.",
  declined: "The owner declined your proposal. Nothing was sent. Don't propose it again unless they bring it up.",
} as const;

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/**
 * A message from the box as plain text that keeps its lines: line separators become line breaks, every other control,
 * bidirectional or format character goes, trailing spaces go, three or more line breaks become two, ends are trimmed.
 * Undefined when the result is empty or longer than `max` characters. Nothing is truncated.
 */
export function plainMessage(input: unknown, max: number): string | undefined {
  if (typeof input !== "string" || input.length > max * 8) return undefined;
  const text = input
    // eslint-disable-next-line no-control-regex -- vertical tab and form feed are line breaks here
    .replace(/\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .split("\n").map(line => line.replace(UNSAFE, "").replace(/ +$/, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const length = [...text].length;
  return length >= 1 && length <= max ? text : undefined;
}

/** The recipients of a proposal: distinct sibling keys, in a fixed order, or undefined. Main is never one. */
export function checkedTargets(input: unknown): string[] | undefined {
  if (!Array.isArray(input) || input.length < MIN_TARGETS || input.length > MAX_TARGETS) return undefined;
  if (!input.every((key): key is string => typeof key === "string" && isBotKey(key) && key !== MAIN_KEY)) return undefined;
  const targets = [...new Set(input)].sort();
  return targets.length === input.length ? targets : undefined;
}

/** What one proposal is, as the gateway binds it and the supervisor checks it again before sending. */
export interface ActionPayload {
  kind: ActionKind;
  targets: readonly string[];
  text: string;
}

/**
 * The binding of an approval: the owner (the id of their Main), the bot, the kind, the recipients and the text. The
 * card's tap names it, the supervisor recomputes it from what it is about to send, and the gateway spends only it.
 */
export function actionBinding(ownerId: string, botId: string, payload: ActionPayload): string {
  return createHash("sha256").update(JSON.stringify(["tinycloud-action/1", ownerId, botId, payload.kind, [...payload.targets].sort(), payload.text])).digest("hex");
}

/** The same proposal, whatever its id or wording of case, punctuation and spacing: a declined or expired one is final. */
export function actionHash(payload: ActionPayload): string {
  return createHash("sha256").update(JSON.stringify(["tinycloud-action-final/1", payload.kind, [...payload.targets].sort(), normalizedQuestion(payload.text)])).digest("hex");
}

/** A checked proposal as the gateway hands it over. */
export interface NewAction extends ActionPayload {
  id: string;
  binding: string;
  askedAt: number;
  outside: boolean;
}

const ACTION_ID = /^[0-9a-f]{24}$/;
const HASH = /^[0-9a-f]{64}$/;

export function parseNewActions(input: unknown): NewAction[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.actions) || input.actions.length > MAX_PENDING_ACTIONS) return undefined;
  const actions: NewAction[] = [];
  for (const action of input.actions) {
    if (!isRecord(action) || typeof action.id !== "string" || !ACTION_ID.test(action.id) || typeof action.outside !== "boolean") return undefined;
    if (!ACTION_KINDS.some(kind => kind === action.kind) || typeof action.binding !== "string" || !HASH.test(action.binding)) return undefined;
    if (!Number.isSafeInteger(action.askedAt) || (action.askedAt as number) <= 0) return undefined;
    const targets = checkedTargets(action.targets);
    const text = plainMessage(action.text, MAX_ACTION_TEXT);
    if (!targets || text === undefined || text !== action.text) return undefined;
    actions.push({ id: action.id, kind: action.kind as ActionKind, targets, text, binding: action.binding, askedAt: action.askedAt as number, outside: action.outside });
  }
  return actions;
}

/** The supervisor's push: the recipients Main may name this turn (absent: unchanged), counts, and final proposals. */
export interface ActionsPush {
  keys?: string[];
  pending: number;
  day: string;
  today: number;
  final: string[];
}

export function parseActionsPush(input: unknown): ActionsPush | undefined {
  if (!isRecord(input)) return undefined;
  const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
  if (!count(input.pending) || !count(input.today) || typeof input.day !== "string" || !/^\d{4}-\d\d-\d\d$/.test(input.day)) return undefined;
  if (!Array.isArray(input.final) || input.final.length > META_KEEP_COUNT || !input.final.every(hash => typeof hash === "string" && HASH.test(hash))) return undefined;
  let keys: string[] | undefined;
  if (input.keys !== undefined) {
    if (!Array.isArray(input.keys) || input.keys.length > 64 || !input.keys.every(key => typeof key === "string" && isBotKey(key))) return undefined;
    keys = [...input.keys as string[]];
  }
  return { ...(keys ? { keys } : {}), pending: input.pending, day: input.day, today: input.today, final: [...input.final as string[]] };
}

/**
 * `sending`: approved, the approval spent or being spent, delivery under way. `done`: over, with one outcome per
 * recipient. `stopped`: closed while pending because the owner turned requests off.
 */
export type ActionState = "pending" | "sending" | "done" | "declined" | "expired" | "stopped";
const ACTION_STATES: readonly ActionState[] = ["pending", "sending", "done", "declined", "expired", "stopped"];

export interface ActionOutcome {
  key: string;
  delivered: boolean;
}

interface StoredAction {
  id: string;
  kind: ActionKind;
  state: ActionState;
  askedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  outside: boolean;
  binding: string;
  /** For finality: kept after the text is gone. */
  hash: string;
  targets: string[];
  /** Kept only until the proposal is over. */
  text?: string;
  outcomes?: ActionOutcome[];
  /** Done or declined, and Main has not been told yet. */
  undelivered?: true;
}

/** A proposal as the owner's app sees it. Times are ISO 8601 UTC. The card is made from these fields. */
export interface ActionRequest {
  id: string;
  kind: "action";
  action: ActionKind;
  state: ActionState;
  askedAt: string;
  expiresAt: string;
  outside: boolean;
  resolvedAt?: string;
  targets: string[];
  /** The message, while pending: shown as written and labelled as Main's. */
  text?: string;
  /** While pending: what the owner's tap must name. */
  binding?: string;
  outcomes?: ActionOutcome[];
  undelivered?: true;
}

/** What a decided proposal says to Main: the composed message and which decision it carries. */
export interface ActionReply {
  text: string;
  decision: "action_approved" | "action_declined";
}

export type ActionResult = { ok: true; request: ActionRequest } | { ok: false; error: "not_pending" | "invalid" };

/** The owner's Send: also refused while the chat holds the owner's private data, before anything is marked sending. */
export type ApproveResult = ActionResult | { ok: false; error: "held" };

/** The owner's tap on Send: `{ decision: "approve", binding }`, and the recipients the backend admits for Main's turn. */
export function parseApproveInput(input: unknown): { binding: string; keys: unknown } | undefined {
  if (!isRecord(input) || input.decision !== "approve" || typeof input.binding !== "string" || !HASH.test(input.binding)) return undefined;
  if (Object.keys(input).some(key => key !== "decision" && key !== "binding" && key !== "messageableBotKeys")) return undefined;
  return { binding: input.binding, keys: input.messageableBotKeys };
}

export const actionsFile = (layout: BotLayout): string => join(layout.dataDir, "actions.json");

function validStored(value: unknown): value is StoredAction {
  return isRecord(value) && typeof value.id === "string" && ACTION_ID.test(value.id) && ACTION_KINDS.some(kind => kind === value.kind)
    && ACTION_STATES.some(state => state === value.state) && Number.isSafeInteger(value.askedAt) && Number.isSafeInteger(value.expiresAt)
    && typeof value.outside === "boolean" && typeof value.binding === "string" && typeof value.hash === "string"
    && Array.isArray(value.targets) && value.targets.every(key => typeof key === "string");
}

/**
 * One bot's proposals in `actions.json`, read and written whole on every operation. Every operation first settles the
 * clock: a pending proposal past its 24 hours expires and loses its text; a send cut short by a stop is over with what
 * it recorded; an outcome Main has not been told within 12 hours is dropped; old metadata goes.
 */
export class ActionStore {
  readonly #layout: BotLayout;
  readonly #now: () => number;

  constructor(layout: BotLayout, now: () => number = Date.now) {
    this.#layout = layout;
    this.#now = now;
  }

  #read(): StoredAction[] {
    const file = actionsFile(this.#layout);
    try {
      if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return [];
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      return isRecord(saved) && Array.isArray(saved.actions) ? saved.actions.filter(validStored) : [];
    } catch {
      return [];
    }
  }

  #settle(actions: StoredAction[]): boolean {
    const now = this.#now();
    let changed = false;
    for (const action of actions) {
      if (action.state === "pending" && action.expiresAt <= now) {
        action.state = "expired";
        action.resolvedAt = action.expiresAt;
        delete action.text;
        changed = true;
      }
      if (action.state === "sending" && (action.resolvedAt ?? 0) + SENDING_LIMIT_MS <= now) {
        this.#finish(action, action.outcomes ?? []);
        changed = true;
      }
      if (action.undelivered && (action.resolvedAt ?? 0) + REPLY_KEEP_MS <= now) {
        delete action.undelivered;
        changed = true;
      }
    }
    const open = (action: StoredAction) => action.state === "pending" || action.state === "sending";
    const kept = actions.filter(action => open(action) || (action.resolvedAt ?? action.askedAt) + META_KEEP_MS > now);
    const resolved = kept.filter(action => !open(action)).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    const drop = new Set(resolved.slice(META_KEEP_COUNT));
    const next = kept.filter(action => !drop.has(action));
    if (next.length !== actions.length) {
      actions.splice(0, actions.length, ...next);
      changed = true;
    }
    return changed;
  }

  /** Over: every recipient without a recorded delivery counts as not delivered. */
  #finish(action: StoredAction, outcomes: ActionOutcome[]): void {
    action.state = "done";
    action.outcomes = action.targets.map(key => ({ key, delivered: outcomes.some(outcome => outcome.key === key && outcome.delivered) }));
    action.undelivered = true;
    delete action.text;
  }

  #load(): StoredAction[] {
    const actions = this.#read();
    if (this.#settle(actions)) this.#save(actions);
    return actions;
  }

  #save(actions: StoredAction[]): void {
    mkdirSync(this.#layout.dataDir, { recursive: true, mode: 0o700 });
    const file = actionsFile(this.#layout);
    const fresh = `${file}.new`;
    const handle = openSync(fresh, "w", 0o600);
    try {
      writeSync(handle, JSON.stringify({ v: 1, actions }));
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(fresh, file);
  }

  has(id: string): boolean {
    return this.#load().some(action => action.id === id);
  }

  /** Records proposals the gateway collected; one already held (same id) is not added twice. */
  ingest(incoming: NewAction[]): void {
    const actions = this.#load();
    let changed = false;
    for (const action of incoming) {
      if (actions.some(held => held.id === action.id)) continue;
      actions.push({
        id: action.id, kind: action.kind, state: "pending", askedAt: action.askedAt, expiresAt: action.askedAt + ACTION_EXPIRY_MS,
        outside: action.outside, binding: action.binding, hash: actionHash(action), targets: [...action.targets], text: action.text,
      });
      changed = true;
    }
    if (changed) {
      this.#settle(actions);
      this.#save(actions);
    }
  }

  #view(action: StoredAction): ActionRequest {
    const pending = action.state === "pending" && action.text !== undefined;
    return {
      id: action.id, kind: "action", action: action.kind, state: action.state,
      askedAt: new Date(action.askedAt).toISOString(), expiresAt: new Date(action.expiresAt).toISOString(), outside: action.outside,
      ...(action.resolvedAt !== undefined ? { resolvedAt: new Date(action.resolvedAt).toISOString() } : {}),
      targets: [...action.targets],
      ...(pending ? { text: action.text, binding: action.binding } : {}),
      ...(action.outcomes ? { outcomes: action.outcomes.map(outcome => ({ ...outcome })) } : {}),
      ...(action.undelivered ? { undelivered: true as const } : {}),
    };
  }

  /** Open first (oldest first), then the most recent finished. */
  list(): ActionRequest[] {
    const actions = this.#load();
    const open = actions.filter(action => action.state === "pending" || action.state === "sending").sort((a, b) => a.askedAt - b.askedAt);
    const resolved = actions.filter(action => action.state !== "pending" && action.state !== "sending")
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, LISTED_RESOLVED);
    return [...open, ...resolved].map(action => this.#view(action));
  }

  /** The owner's Don't send: final, and Main is told. */
  decline(id: string): ActionResult {
    const actions = this.#load();
    const action = actions.find(held => held.id === id);
    if (!action || action.state !== "pending") return { ok: false, error: "not_pending" };
    action.state = "declined";
    action.resolvedAt = this.#now();
    action.undelivered = true;
    delete action.text;
    this.#save(actions);
    return { ok: true, request: this.#view(action) };
  }

  /**
   * The owner's Send on a pending, unexpired proposal. `binding` is what the card showed; it must equal the stored one,
   * and the stored one must still be the binding of the stored owner, bot, recipients and text. The proposal becomes
   * `sending` here, so a second Send is refused; the payload to send is handed back with it.
   */
  approve(id: string, binding: string, ownerId: string): { ok: true; request: ActionRequest; payload: ActionPayload } | { ok: false; error: "not_pending" | "invalid" } {
    const actions = this.#load();
    const action = actions.find(held => held.id === id);
    if (!action || action.state !== "pending" || action.text === undefined) return { ok: false, error: "not_pending" };
    const payload: ActionPayload = { kind: action.kind, targets: [...action.targets], text: action.text };
    if (binding !== action.binding || actionBinding(ownerId, this.#layout.botId, payload) !== action.binding) return { ok: false, error: "invalid" };
    action.state = "sending";
    action.resolvedAt = this.#now();
    this.#save(actions);
    return { ok: true, request: this.#view(action), payload };
  }

  /** The send is over with these outcomes. Only a proposal that is sending can finish, once. */
  finish(id: string, outcomes: ActionOutcome[]): void {
    const actions = this.#load();
    const action = actions.find(held => held.id === id);
    if (action?.state !== "sending") return;
    this.#finish(action, outcomes);
    this.#save(actions);
  }

  /** The owner turned requests off: pending proposals close without a message to Main. */
  cancelPending(): number {
    const actions = this.#load();
    let stopped = 0;
    for (const action of actions) {
      if (action.state !== "pending") continue;
      action.state = "stopped";
      action.resolvedAt = this.#now();
      delete action.text;
      stopped++;
    }
    if (stopped > 0) this.#save(actions);
    return stopped;
  }

  /** The message for Main, composed from the stored outcome; undefined unless decided and not yet told. */
  reply(id: string): ActionReply | undefined {
    const action = this.#load().find(held => held.id === id);
    if (!action?.undelivered) return undefined;
    if (action.state === "declined") return { text: ACTION_REPLIES.declined, decision: "action_declined" };
    if (action.state !== "done") return undefined;
    const delivered = (action.outcomes ?? []).filter(outcome => outcome.delivered).map(outcome => outcome.key);
    const failed = (action.outcomes ?? []).filter(outcome => !outcome.delivered).map(outcome => outcome.key);
    const text = delivered.length === 0 ? ACTION_REPLIES.notSent : failed.length === 0 ? ACTION_REPLIES.sent(delivered) : ACTION_REPLIES.partly(delivered, failed);
    return { text, decision: "action_approved" };
  }

  delivered(id: string): void {
    const actions = this.#load();
    const action = actions.find(held => held.id === id);
    if (!action?.undelivered) return;
    delete action.undelivered;
    this.#save(actions);
  }

  /** What the gateway holds its limits and finality from. Declined and expired proposals stay final while their metadata is kept. */
  push(): Omit<ActionsPush, "keys"> {
    const actions = this.#load();
    const day = utcDay(this.#now());
    return {
      pending: actions.filter(action => action.state === "pending").length,
      day,
      today: actions.filter(action => utcDay(action.askedAt) === day).length,
      final: [...new Set(actions.filter(action => action.state === "declined" || action.state === "expired").map(action => action.hash))],
    };
  }
}

/** The supervisor's calls to the gateway's control socket for proposals. */
export interface ActionsGateway {
  drain(): Promise<unknown>;
  push(body: ActionsPush): Promise<void>;
}

const chains = new Map<string, Promise<unknown>>();

function inOrder<T>(botId: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(botId) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(botId, run);
  void run.catch(() => {}).finally(() => { if (chains.get(botId) === run) chains.delete(botId); });
  return run;
}

/**
 * Collects new proposals, stores them while the owner's setting for requests is on (dropped while it is off), then
 * gives the gateway the counts, the final proposals and, at the start of a turn, the recipients Main may name. One at
 * a time per bot.
 */
export function syncActions(layout: BotLayout, gateway: ActionsGateway, keys?: readonly string[], now: () => number = Date.now): Promise<void> {
  return inOrder(layout.botId, async () => {
    const store = new ActionStore(layout, now);
    const collected = parseNewActions(await gateway.drain());
    if (readAsksEnabled(layout) && collected?.length) store.ingest(collected);
    await gateway.push({ ...store.push(), ...(keys ? { keys: [...keys] } : {}) });
  });
}
