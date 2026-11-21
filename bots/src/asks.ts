// Main asking its owner a question (`ask_owner`). The owner's setting and the requests live in the supervisor's data
// directory for the bot, beside web.json and outside anything a sandbox mounts. The gateway takes the box's call,
// applies the setting and the limits, and holds the new question until the supervisor collects it; the answer
// comes back to Main only as a message the supervisor itself writes (see composeReply). Nothing here is authority:
// a question can be answered, declined or closed because the owner turned questions off, and that is all.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./guards";
import { type BotLayout, botLayout, type LayoutRoots } from "./layout";
import { BOT_ID } from "./owner";

export const MAX_QUESTION_CHARS = 280;
export const MAX_CHOICES = 4;
export const MAX_CHOICE_CHARS = 60;
export const MAX_ANSWER_CHARS = 280;
export const MAX_PENDING = 3;
export const MAX_PER_DAY = 10;
export const DECLINE_COOLDOWN_MS = 60 * 60_000;
export const EXPIRY_MS = 24 * 60 * 60_000;
/** How long an answer that Main has not been told yet is kept; well inside the 24 hours the text may live. */
export const REPLY_KEEP_MS = 12 * 60 * 60_000;
/** Metadata (no text) of resolved requests is kept this long, and at most this many. */
const META_KEEP_MS = 7 * 24 * 60 * 60_000;
const META_KEEP_COUNT = 200;
const LISTED_RESOLVED = 20;

/** Fixed sentences for the model. Never the question, an answer, a count of anyone's questions or a name. */
export const ASK_ERRORS = {
  off: "The owner hasn't allowed questions from you. Carry on without asking.",
  invalid: `A question must be 1 to ${MAX_QUESTION_CHARS} characters of plain text, with at most ${MAX_CHOICES} choices of up to ${MAX_CHOICE_CHARS} characters each.`,
  recent: "The owner said not now to this question. Don't ask it again for a while.",
  pending: "Too many open questions for now. Carry on without asking.",
  daily: "You've asked enough questions for today. Carry on without asking.",
} as const;
export type AskError = keyof typeof ASK_ERRORS;

/**
 * What the supervisor tells Main once a question is closed. Fixed text around the owner's answer. PENDING SAM'S
 * APPROVAL: every sentence here, each in its own constant, until the final words are given.
 */
export const ASK_REPLIES = {
  answered: "The person answered your question: ",
  declined: "The person chose not to answer now. Carry on without it, and don’t ask again unless they bring it up.",
  stopped: "The person turned off questions from you, so your open questions were closed without an answer. Carry on without asking.",
} as const;

export function composeReply(state: "answered" | "declined" | "stopped", answer?: string): string {
  return state === "answered" ? `${ASK_REPLIES.answered}${answer ?? ""}` : ASK_REPLIES[state];
}

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/**
 * Text from the box or the owner as one line of plain text: control, bidirectional and other format characters are
 * removed (line breaks and tabs become spaces), runs of whitespace collapse, ends are trimmed. Undefined when the
 * result is empty, too long (counted in characters) or not a string. Nothing is truncated: a long question is refused.
 */
export function plainAskText(input: unknown, max: number): string | undefined {
  if (typeof input !== "string" || input.length > max * 8) return undefined;
  const text = input.replace(/[\t\n\r\u000b\u000c\u0085\u2028\u2029]/g, " ").replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  const length = [...text].length;
  return length >= 1 && length <= max ? text : undefined;
}

/** The question as compared for the one-hour cooldown: lowercase, apostrophes and other punctuation dropped, whitespace collapsed. */
export const normalizedQuestion = (question: string): string =>
  question.toLowerCase().replace(/['’]/g, "").replace(/\p{P}/gu, " ").replace(/\s+/g, " ").trim();
export const questionHash = (question: string): string => createHash("sha256").update(normalizedQuestion(question)).digest("hex");
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export type AskState = "pending" | "answered" | "declined" | "stopped" | "expired";

/** A checked question as the gateway hands it over. */
export interface NewAsk {
  id: string;
  question: string;
  choices: string[];
  askedAt: number;
  outside: boolean;
}

export function parseNewAsks(input: unknown): NewAsk[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.asks) || input.asks.length > MAX_PENDING) return undefined;
  const asks: NewAsk[] = [];
  for (const ask of input.asks) {
    if (!isRecord(ask) || typeof ask.id !== "string" || !/^[0-9a-f]{24}$/.test(ask.id) || typeof ask.outside !== "boolean") return undefined;
    const question = plainAskText(ask.question, MAX_QUESTION_CHARS);
    if (question === undefined || !Array.isArray(ask.choices) || ask.choices.length > MAX_CHOICES) return undefined;
    const choices = ask.choices.map(choice => plainAskText(choice, MAX_CHOICE_CHARS));
    if (choices.includes(undefined) || !Number.isSafeInteger(ask.askedAt) || (ask.askedAt as number) <= 0) return undefined;
    asks.push({ id: ask.id, question, choices: choices as string[], askedAt: ask.askedAt as number, outside: ask.outside });
  }
  return asks;
}

interface StoredAsk {
  id: string;
  state: AskState;
  askedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  outside: boolean;
  /** For the cooldown: the hash of the normalized question, kept after the text is gone. */
  hash: string;
  question?: string;
  choices?: string[];
  answer?: string;
  /** Answered, declined or stopped, and Main has not been told yet. */
  undelivered?: true;
}

/** A request as the owner's app sees it. Times are ISO 8601 UTC. */
export interface AskRequest {
  id: string;
  kind: "ask";
  state: AskState;
  askedAt: string;
  expiresAt: string;
  outside: boolean;
  resolvedAt?: string;
  question?: string;
  choices?: string[];
  answer?: string;
  /** Answered, declined or stopped, and Main has not been told yet (so the app may deliver it). `answer` is present only while answered and undelivered. */
  undelivered?: true;
}

/** What a decided request says to Main: the composed message, and which decision it carries. */
export interface AskReply {
  text: string;
  decision: "answered" | "declined" | "stopped";
}

/** The origin of a message the app wrote: the owner's decision on a question from Main. Only this service composes one. */
export interface AppOrigin {
  app: AskReply["decision"];
}

/** A checked owner decision: a decline, or an answer given as text or as the index of one of the choices. */
export type AnswerInput = { decision: "decline" } | { decision: "answer"; answer: string; choice?: undefined } | { decision: "answer"; choice: number; answer?: undefined };
export type AnswerResult = { ok: true; request: AskRequest } | { ok: false; error: "not_pending" | "invalid" };

/** The body of `POST .../answer`: exactly a decline, or an answer given as text or as the index of a choice. */
export function parseAnswerInput(input: unknown): AnswerInput | undefined {
  if (!isRecord(input)) return undefined;
  const keys = Object.keys(input);
  if (input.decision === "decline") return keys.length === 1 ? { decision: "decline" } : undefined;
  if (input.decision !== "answer" || keys.length !== 2) return undefined;
  if ("answer" in input) return typeof input.answer === "string" ? { decision: "answer", answer: input.answer } : undefined;
  if ("choice" in input) return typeof input.choice === "number" && Number.isSafeInteger(input.choice) ? { decision: "answer", choice: input.choice } : undefined;
  return undefined;
}

export const asksFile = (layout: BotLayout): string => join(layout.dataDir, "asks.json");
export const requestsFile = (layout: BotLayout): string => join(layout.dataDir, "requests.json");

function writeFileAtomic(layout: BotLayout, file: string, content: string): void {
  mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  const fresh = `${file}.new`;
  const handle = openSync(fresh, "w", 0o600);
  try {
    writeSync(handle, content);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(fresh, file);
}

function readAsksFile(layout: BotLayout): Record<string, unknown> {
  const file = asksFile(layout);
  try {
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return {};
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(saved) ? saved : {};
  } catch {
    return {};
  }
}

/** The owner's setting. Missing, unreadable or malformed reads as off: the safe reading, never an error. */
export const readAsksEnabled = (layout: BotLayout): boolean => readAsksFile(layout).enabled === true;

/** Whether anything from outside the owner's own words has reached Main's conversation since it began. */
export const readOutsideSeen = (layout: BotLayout): boolean => readAsksFile(layout).outsideSeen === true;

function writeAsksFile(layout: BotLayout, enabled: boolean, outsideSeen: boolean): void {
  writeFileAtomic(layout, asksFile(layout), JSON.stringify({ enabled, ...(outsideSeen ? { outsideSeen } : {}) }));
}

/** Saves the setting. Throws if it cannot be written. */
export function writeAsksEnabled(layout: BotLayout, enabled: boolean): void {
  writeAsksFile(layout, enabled, readOutsideSeen(layout));
}

/** Records that outside text has reached the conversation. It stays until the bot's working state is reset. */
export function writeOutsideSeen(layout: BotLayout): void {
  writeAsksFile(layout, readAsksEnabled(layout), true);
}

function validStored(value: unknown): value is StoredAsk {
  return isRecord(value) && typeof value.id === "string" && /^[0-9a-f]{24}$/.test(value.id)
    && (value.state === "pending" || value.state === "answered" || value.state === "declined" || value.state === "stopped" || value.state === "expired")
    && Number.isSafeInteger(value.askedAt) && Number.isSafeInteger(value.expiresAt) && typeof value.hash === "string" && typeof value.outside === "boolean";
}

/** The pushed snapshot the gateway enforces its limits from. */
export interface AsksPush {
  enabled: boolean;
  pending: number;
  day: string;
  today: number;
  declined: Array<{ hash: string; until: number }>;
  /** Present on the push that starts a turn: whether its input came from outside this chat's owner. */
  turn?: { outside: boolean };
}

export function parseAsksPush(input: unknown): AsksPush | undefined {
  if (!isRecord(input) || typeof input.enabled !== "boolean") return undefined;
  const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
  if (!count(input.pending) || !count(input.today) || typeof input.day !== "string" || !/^\d{4}-\d\d-\d\d$/.test(input.day)) return undefined;
  if (!Array.isArray(input.declined) || input.declined.length > META_KEEP_COUNT) return undefined;
  const declined: AsksPush["declined"] = [];
  for (const entry of input.declined) {
    if (!isRecord(entry) || typeof entry.hash !== "string" || !/^[0-9a-f]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.until)) return undefined;
    declined.push({ hash: entry.hash, until: entry.until as number });
  }
  let turn: AsksPush["turn"];
  if (input.turn !== undefined) {
    if (!isRecord(input.turn) || typeof input.turn.outside !== "boolean") return undefined;
    turn = { outside: input.turn.outside };
  }
  return { enabled: input.enabled, pending: input.pending, day: input.day, today: input.today, declined, ...(turn ? { turn } : {}) };
}

/**
 * One bot's requests in `requests.json`, read and written whole on every operation (the file is small and the
 * supervisor is one process). Every operation first settles the clock: a pending request past its 24 hours expires
 * and loses its text; a reply Main has not been told within REPLY_KEEP_MS loses its text and is dropped; old
 * metadata goes. Text is therefore gone at delivery or at expiry, whichever the supervisor sees first.
 */
export class AskStore {
  readonly #layout: BotLayout;
  readonly #now: () => number;

  constructor(layout: BotLayout, now: () => number = Date.now) {
    this.#layout = layout;
    this.#now = now;
  }

  #read(): StoredAsk[] {
    const file = requestsFile(this.#layout);
    try {
      if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return [];
      const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
      return isRecord(saved) && Array.isArray(saved.asks) ? saved.asks.filter(validStored) : [];
    } catch {
      return [];
    }
  }

  /** Applies the clock to `asks`; true when anything changed. */
  #settle(asks: StoredAsk[]): boolean {
    const now = this.#now();
    let changed = false;
    for (const ask of asks) {
      if (ask.state === "pending" && ask.expiresAt <= now) {
        ask.state = "expired";
        ask.resolvedAt = ask.expiresAt;
        delete ask.question;
        delete ask.choices;
        changed = true;
      }
      if (ask.undelivered && (ask.resolvedAt ?? 0) + REPLY_KEEP_MS <= now) {
        delete ask.answer;
        delete ask.undelivered;
        changed = true;
      }
    }
    const kept = asks.filter(ask => ask.state === "pending" || (ask.resolvedAt ?? ask.askedAt) + META_KEEP_MS > now);
    const resolved = kept.filter(ask => ask.state !== "pending").sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    const drop = new Set(resolved.slice(META_KEEP_COUNT));
    const next = kept.filter(ask => !drop.has(ask));
    if (next.length !== asks.length) {
      asks.splice(0, asks.length, ...next);
      changed = true;
    }
    return changed;
  }

  /** Reads, settles and saves the result if the clock changed anything. */
  #load(): StoredAsk[] {
    const asks = this.#read();
    if (this.#settle(asks)) this.#save(asks);
    return asks;
  }

  #save(asks: StoredAsk[]): void {
    writeFileAtomic(this.#layout, requestsFile(this.#layout), JSON.stringify({ v: 1, asks }));
  }

  /** Whether a requests file exists (the sweep skips bots that never had a question). */
  get present(): boolean {
    return lstatSync(requestsFile(this.#layout), { throwIfNoEntry: false })?.isFile() === true;
  }

  /** Applies the clock without anything else. */
  settle(): void {
    this.#load();
  }

  /** Records questions the gateway collected. Questions already held (same id) are not added twice. */
  ingest(incoming: NewAsk[]): void {
    const asks = this.#load();
    let changed = false;
    for (const ask of incoming) {
      if (asks.some(held => held.id === ask.id)) continue;
      asks.push({
        id: ask.id, state: "pending", askedAt: ask.askedAt, expiresAt: ask.askedAt + EXPIRY_MS, outside: ask.outside,
        hash: questionHash(ask.question), question: ask.question, choices: ask.choices,
      });
      changed = true;
    }
    // Expiry is applied again: a question collected late may already be past its time.
    if (changed) {
      this.#settle(asks);
      this.#save(asks);
    }
  }

  #view(ask: StoredAsk): AskRequest {
    return {
      id: ask.id, kind: "ask", state: ask.state, askedAt: new Date(ask.askedAt).toISOString(), expiresAt: new Date(ask.expiresAt).toISOString(),
      outside: ask.outside,
      ...(ask.resolvedAt !== undefined ? { resolvedAt: new Date(ask.resolvedAt).toISOString() } : {}),
      ...(ask.state === "pending" && ask.question !== undefined ? { question: ask.question, choices: ask.choices ?? [] } : {}),
      ...(ask.undelivered && ask.state === "answered" && ask.answer !== undefined ? { answer: ask.answer } : {}),
      ...(ask.undelivered ? { undelivered: true as const } : {}),
    };
  }

  /** Pending first (oldest first), then the most recent resolved. */
  list(): AskRequest[] {
    const asks = this.#load();
    const pending = asks.filter(ask => ask.state === "pending").sort((a, b) => a.askedAt - b.askedAt);
    const resolved = asks.filter(ask => ask.state !== "pending").sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, LISTED_RESOLVED);
    return [...pending, ...resolved].map(ask => this.#view(ask));
  }

  /**
   * Records the owner's decision on a pending, unexpired request. An answer is checked and made plain text here;
   * a choice becomes the text of that choice. Anything else about the request is not for the caller to change.
   */
  answer(id: string, input: AnswerInput): AnswerResult {
    const asks = this.#load();
    const ask = asks.find(held => held.id === id);
    if (!ask || ask.state !== "pending") return { ok: false, error: "not_pending" };
    let answer: string | undefined;
    if (input.decision === "answer") {
      answer = "choice" in input && input.choice !== undefined ? ask.choices?.[input.choice] : plainAskText(input.answer, MAX_ANSWER_CHARS);
      if (answer === undefined) return { ok: false, error: "invalid" };
    }
    ask.state = input.decision === "answer" ? "answered" : "declined";
    ask.resolvedAt = this.#now();
    ask.undelivered = true;
    delete ask.question;
    delete ask.choices;
    if (answer !== undefined) ask.answer = answer;
    this.#save(asks);
    return { ok: true, request: this.#view(ask) };
  }

  /**
   * The owner turned questions off: every pending request becomes `stopped` (not declined, and not an answer) with its
   * question and choices gone at once. They share one `resolvedAt`, which marks them as one switch-off: Main is told
   * once for the lot, with its own sentence (see `delivered`). A stopped question is not held against being asked
   * again: only declined requests make a cooldown (see `push`).
   * Requests already decided or expired are left as they are. Returns how many were stopped.
   */
  cancelPending(): number {
    const asks = this.#load();
    const now = this.#now();
    let stopped = 0;
    for (const ask of asks) {
      if (ask.state !== "pending") continue;
      ask.state = "stopped";
      ask.resolvedAt = now;
      ask.undelivered = true;
      delete ask.question;
      delete ask.choices;
      stopped++;
    }
    if (stopped > 0) this.#save(asks);
    return stopped;
  }

  /** The message for Main, composed from the stored decision; undefined unless the request is decided and not yet delivered. */
  reply(id: string): AskReply | undefined {
    const ask = this.#load().find(held => held.id === id);
    if (!ask || !ask.undelivered || (ask.state !== "answered" && ask.state !== "declined" && ask.state !== "stopped")) return undefined;
    return { text: composeReply(ask.state, ask.answer), decision: ask.state };
  }

  /**
   * Main has been told: the answer text is deleted, the metadata stays. For a stopped request the one message told
   * Main about the whole switch-off, so every request stopped by that same switch-off (they share `resolvedAt`) is
   * delivered with it; a request stopped by a later switch-off is a separate message.
   */
  delivered(id: string): void {
    const asks = this.#load();
    const ask = asks.find(held => held.id === id);
    if (!ask?.undelivered) return;
    for (const told of asks) {
      if (told !== ask && !(ask.state === "stopped" && told.state === "stopped" && told.resolvedAt === ask.resolvedAt)) continue;
      delete told.undelivered;
      delete told.answer;
    }
    this.#save(asks);
  }

  /** What the gateway needs to hold its limits: counts and the questions declined within the cooldown. */
  push(): Omit<AsksPush, "enabled"> {
    const asks = this.#load();
    const now = this.#now();
    const day = utcDay(now);
    return {
      pending: asks.filter(ask => ask.state === "pending").length,
      day,
      today: asks.filter(ask => utcDay(ask.askedAt) === day).length,
      declined: asks
        .filter(ask => ask.state === "declined" && (ask.resolvedAt ?? 0) + DECLINE_COOLDOWN_MS > now)
        .map(ask => ({ hash: ask.hash, until: (ask.resolvedAt ?? 0) + DECLINE_COOLDOWN_MS })),
    };
  }
}

/** The supervisor's two calls to the gateway's control socket. */
export interface AsksGateway {
  /** Takes the questions the box has asked since the last time. */
  drain(): Promise<unknown>;
  push(body: AsksPush): Promise<void>;
}

const chains = new Map<string, Promise<unknown>>();

/** One task at a time per bot, in the order they were asked for. */
function inOrder<T>(botId: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(botId) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(botId, run);
  void run.catch(() => {}).finally(() => { if (chains.get(botId) === run) chains.delete(botId); });
  return run;
}

/**
 * Brings the supervisor's records and the gateway together: collects new questions, stores them, then gives the
 * gateway the setting, the counts and the cooldowns. One at a time per bot, so a push never overtakes the
 * collection that precedes it. While the setting is off, what the gateway had not yet handed over is dropped, not
 * stored: nothing becomes pending after the owner switched it off. Whether outside text has reached Main's
 * conversation only ever turns on: by a web call the gateway saw, or by `turn.outside` (the turn began with
 * another bot's message, or a bot's reply came back during it). It is kept in asks.json and given to the gateway
 * with every push, so a restart of either side does not lose it; only a reset of the bot's working state (its data
 * directory goes) clears it.
 */
export function syncAsks(layout: BotLayout, gateway: AsksGateway, turn?: { outside: boolean }, now: () => number = Date.now): Promise<void> {
  return inOrder(layout.botId, async () => {
    const store = new AskStore(layout, now);
    const drained = await gateway.drain();
    const enabled = readAsksEnabled(layout);
    const collected = parseNewAsks(drained);
    if (enabled && collected?.length) store.ingest(collected);
    let outside = readOutsideSeen(layout);
    if (!outside && (turn?.outside || (isRecord(drained) && drained.outside === true))) {
      outside = true;
      // A disk that cannot take the flag still lets the gateway have it for as long as it runs.
      try { writeOutsideSeen(layout); } catch { /* the push below carries it */ }
    }
    await gateway.push({ enabled, ...store.push(), ...(turn || outside ? { turn: { outside } } : {}) });
  });
}

/**
 * The owner switched the setting off: every pending question is cancelled, by the path a decline takes (see
 * AskStore.cancelPending). It waits for any collection already under way, so nothing it stores is left pending, and
 * what is collected after it is dropped while the setting is off. Resolves to how many were cancelled.
 */
export function cancelAsks(layout: BotLayout, now: () => number = Date.now): Promise<number> {
  return inOrder(layout.botId, async () => new AskStore(layout, now).cancelPending());
}

/** Applies the clock to every bot's requests: text of expired questions and stale replies goes even if nobody asks. */
export function sweepAsks(roots: LayoutRoots, now: () => number = Date.now): number {
  let swept = 0;
  for (const entry of readdirSync(roots.dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !BOT_ID.test(entry.name)) continue;
    const store = new AskStore(botLayout(entry.name, roots), now);
    if (!store.present) continue;
    store.settle();
    swept++;
  }
  return swept;
}
