// Main asking its owner a question (`ask_owner`) or to use a secret (`request_secret`). The owner's setting and the
// requests live in the supervisor's data directory for the bot, beside web.json and outside anything a sandbox mounts.
// The gateway takes the box's call, applies the setting and the limits (shared by both kinds), and holds the new request
// until the supervisor collects it; the outcome comes back to Main only as a message the supervisor itself writes (see
// composeReply and SECRET_REPLIES). Nothing here is authority: a question can be answered, declined or closed
// because the owner turned requests off; a secret request records what the owner and OpenKey decided, and the
// gateway (which alone holds the approval) is told to forget its key once the request is over.

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./guards";
import { type BotLayout, botLayout, type LayoutRoots } from "./layout";
import { BOT_ID } from "./owner";
import { joinSites, knownSecret, MAX_SITES, SECRET_NAME, secretSites, writeMethods } from "./secret-catalog";

export const MAX_QUESTION_CHARS = 280;
export const MAX_CHOICES = 4;
export const MAX_CHOICE_CHARS = 60;
export const MAX_ANSWER_CHARS = 280;
export const MAX_PENDING = 3;
export const MAX_PER_DAY = 10;
export const DECLINE_COOLDOWN_MS = 60 * 60_000;
export const EXPIRY_MS = 24 * 60 * 60_000;
export const MAX_WHY_CHARS = 200;
/** The longest an approval may last until each secret has its own key (TC-3284). */
export const MAX_GRANT_MS = 7 * 24 * 60 * 60_000;
/** Where the gateway's approval links point: OpenKey's one-tap page. */
export const OPENKEY_ORIGIN = "https://openkey.so";
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
 * What the supervisor tells Main once a question is closed. Fixed text around the owner's answer: Monica's words
 * (agent-ask-owner-words), each in its own constant.
 */
export const ASK_REPLIES = {
  answered: "The person answered your question: ",
  declined: "The person chose not to answer now. Carry on without it, and don’t ask again unless they bring it up.",
  stopped: "The person turned off questions and requests from you, so your open questions and secret requests were closed without an answer. Carry on without asking.",
} as const;

export function composeReply(state: "answered" | "declined" | "stopped", answer?: string): string {
  return state === "answered" ? `${ASK_REPLIES.answered}${answer ?? ""}` : ASK_REPLIES[state];
}

/** A time as Main reads it: "2026-11-22 13:12 UTC". */
export const utcMinute = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Fixed refusals of `request_secret`. Only the secret's name, its sites and an end time are filled in, never Main's sentence. */
export const SECRET_ERRORS = {
  off: () => "The owner hasn’t allowed requests from you. Don’t ask for the secret in chat.",
  name: () => "A secret name is capital letters, digits and underscores, starting with a letter, like OPENAI_API_KEY.",
  why: () => `Say what the secret is for in one plain sentence of up to ${MAX_WHY_CHARS} characters.`,
  sites: () => `Name 1 to ${MAX_SITES} public sites, like api.example.com. Addresses, ports and private networks aren’t allowed.`,
  approved: (name: string, sites: readonly string[], until: number) => `You can already use ${name} with ${joinSites(sites)} until ${utcMinute(until)}. Use call_with_secret.`,
  pending: (name: string) => `You already asked for ${name}. Wait for the owner; don’t ask in chat.`,
  recent: (name: string) => `The owner declined ${name} recently. Don’t ask again unless they bring it up.`,
  many: () => "Too many open requests for now. Carry on without asking.",
} as const;

/** What the supervisor tells Main about a secret request: fixed text around its name, sites and end time. */
export const SECRET_REPLIES = {
  approved: (name: string, sites: readonly string[], until: number) =>
    `The owner approved ${name} for ${joinSites(sites)} until ${utcMinute(until)}. Use it with call_with_secret. You can’t see its value.`,
  declined: (name: string) => `The owner declined your request for ${name}. Carry on without it, and don’t ask again unless they bring it up.`,
  revoked: (name: string) => `The owner stopped your access to ${name}. Carry on without it, and don’t ask again unless they bring it up.`,
} as const;

/** The cooldown key of a declined secret request; never equal to a question's (questions hash their normalized text). */
export const secretHash = (name: string): string => createHash("sha256").update(`secret\0${name}`).digest("hex");

const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/**
 * Text from the box or the owner as one line of plain text: control, bidirectional and other format characters are
 * removed (line breaks and tabs become spaces), runs of whitespace collapse, ends are trimmed. Undefined when the
 * result is empty, too long (counted in characters) or not a string. Nothing is truncated: a long question is refused.
 */
export function plainAskText(input: unknown, max: number): string | undefined {
  if (typeof input !== "string" || input.length > max * 8) return undefined;
  // Matching vertical tab and form feed is the point: every line-breaking control becomes a space before UNSAFE strips the rest.
  // eslint-disable-next-line no-control-regex
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
/**
 * A secret request's states. `stopped`: closed while pending because the owner turned requests off. `revoked`: the
 * owner pressed Stop now on an approval. `ended`: an approval reached its end. `failed`: the approval could not be
 * asked for or kept; the owner may try again, which makes it pending once more.
 */
export type SecretState = "pending" | "approved" | "declined" | "stopped" | "revoked" | "expired" | "ended" | "failed";
const SECRET_STATES: readonly SecretState[] = ["pending", "approved", "declined", "stopped", "revoked", "expired", "ended", "failed"];
const ASK_STATES: readonly AskState[] = ["pending", "answered", "declined", "stopped", "expired"];

/** A checked question as the gateway hands it over. */
export interface NewAsk {
  kind?: undefined;
  id: string;
  question: string;
  choices: string[];
  askedAt: number;
  outside: boolean;
}

/** A checked secret request as the gateway hands it over. For a known secret `sites` is the catalog's, never Main's. */
export interface NewSecret {
  kind: "secret";
  id: string;
  name: string;
  why: string;
  sites: string[];
  askedAt: number;
  outside: boolean;
}

export type NewRequest = NewAsk | NewSecret;

/** The sites a secret may be used with: the catalog's for a known secret (whatever Main named), else Main's 1 to 3. */
export function sitesFor(name: string, given: unknown): string[] | undefined {
  const known = knownSecret(name);
  return known ? [known.site] : secretSites(given);
}

export function parseNewAsks(input: unknown): NewRequest[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.asks) || input.asks.length > MAX_PENDING) return undefined;
  const asks: NewRequest[] = [];
  for (const ask of input.asks) {
    if (!isRecord(ask) || typeof ask.id !== "string" || !/^[0-9a-f]{24}$/.test(ask.id) || typeof ask.outside !== "boolean") return undefined;
    if (!Number.isSafeInteger(ask.askedAt) || (ask.askedAt as number) <= 0) return undefined;
    if (ask.kind === "secret") {
      const why = plainAskText(ask.why, MAX_WHY_CHARS);
      if (typeof ask.name !== "string" || !SECRET_NAME.test(ask.name) || why === undefined) return undefined;
      const sites = sitesFor(ask.name, ask.sites);
      if (!sites) return undefined;
      asks.push({ kind: "secret", id: ask.id, name: ask.name, why, sites, askedAt: ask.askedAt as number, outside: ask.outside });
      continue;
    }
    if (ask.kind !== undefined) return undefined;
    const question = plainAskText(ask.question, MAX_QUESTION_CHARS);
    if (question === undefined || !Array.isArray(ask.choices) || ask.choices.length > MAX_CHOICES) return undefined;
    const choices = ask.choices.map(choice => plainAskText(choice, MAX_CHOICE_CHARS));
    if (choices.includes(undefined)) return undefined;
    asks.push({ id: ask.id, question, choices: choices as string[], askedAt: ask.askedAt as number, outside: ask.outside });
  }
  return asks;
}

interface StoredAsk {
  id: string;
  /** Absent for a question (files written before secret requests have none). */
  kind?: "secret";
  state: AskState | SecretState;
  askedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  outside: boolean;
  /** For the cooldown: the hash of the normalized question (or of the secret's name), kept after the text is gone. */
  hash: string;
  question?: string;
  choices?: string[];
  answer?: string;
  /** Answered, declined, stopped, approved or revoked, and Main has not been told yet. */
  undelivered?: true;
  /** A secret request: its name and sites stay with its metadata; Main's sentence goes when the request is over. */
  name?: string;
  sites?: string[];
  why?: string;
  /** The gateway's OpenKey link for this request, while pending. */
  approveUrl?: string;
  /** When the approval ends (approved, and kept after it is revoked or has ended). */
  until?: number;
  /** The request is over: the gateway is still to be told to forget its key for it. */
  wipe?: true;
}

/** A question as the owner's app sees it. Times are ISO 8601 UTC. */
export interface QuestionRequest {
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

/** A secret request as the owner's app sees it. Never a value: only the name, the sites and what was decided. */
export interface SecretRequest {
  id: string;
  kind: "secret";
  state: SecretState;
  askedAt: string;
  expiresAt: string;
  outside: boolean;
  resolvedAt?: string;
  name: string;
  sites: string[];
  /** The service's name, for a secret the catalog knows. */
  service?: string;
  /** The write methods the catalog lets Main use with it (a known secret only); absent when it can only read. */
  writes?: string[];
  /** Main's sentence, while pending or failed. */
  why?: string;
  /** OpenKey's approval page, while pending and once the gateway has made it. */
  approveUrl?: string;
  until?: string;
  undelivered?: true;
}

export type AskRequest = QuestionRequest | SecretRequest;

/** What a chat line about a secret request names: never Main's sentence. */
export interface SecretLine {
  name: string;
  sites: string[];
  service?: string;
  until?: string;
}

/** A secret line as a history record holds it; anything else reads as none. */
export function parseSecretLine(value: unknown): SecretLine | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || !SECRET_NAME.test(value.name)) return undefined;
  if (!Array.isArray(value.sites) || value.sites.length > MAX_SITES || !value.sites.every(site => typeof site === "string")) return undefined;
  if (value.service !== undefined && typeof value.service !== "string") return undefined;
  if (value.until !== undefined && (typeof value.until !== "string" || Number.isNaN(Date.parse(value.until)))) return undefined;
  return {
    name: value.name, sites: [...value.sites as string[]],
    ...(typeof value.service === "string" ? { service: value.service } : {}), ...(typeof value.until === "string" ? { until: value.until } : {}),
  };
}

export const APP_DECISIONS: readonly AskReply["decision"][] = ["answered", "declined", "stopped", "approved", "revoked"];

/** What a decided request says to Main: the composed message, and which decision it carries. */
export interface AskReply {
  text: string;
  decision: "answered" | "declined" | "stopped" | "approved" | "revoked";
  /** For a secret request (not a switch-off): what the owner's chat line names. */
  secret?: SecretLine;
}

/** The origin of a message the app wrote: the owner's decision on a request from Main. Only this service composes one. */
export interface AppOrigin {
  app: AskReply["decision"];
  secret?: SecretLine;
}

/**
 * A checked owner decision. On a question: a decline, or an answer given as text or as the index of one of the
 * choices. On a secret request: a decline (pending), stop (approved), or retry (failed).
 */
export type AnswerInput = { decision: "decline" } | { decision: "stop" } | { decision: "retry" }
  | { decision: "answer"; answer: string; choice?: undefined } | { decision: "answer"; choice: number; answer?: undefined };
export type AnswerResult = { ok: true; request: AskRequest } | { ok: false; error: "not_pending" | "invalid" };

/** The body of `POST .../answer`: exactly a decline, stop or retry, or an answer given as text or as the index of a choice. */
export function parseAnswerInput(input: unknown): AnswerInput | undefined {
  if (!isRecord(input)) return undefined;
  const keys = Object.keys(input);
  if (input.decision === "decline" || input.decision === "stop" || input.decision === "retry") return keys.length === 1 ? { decision: input.decision } : undefined;
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

/** The saved settings file: `missing` when there is none, `unreadable` when it cannot be read or is not a JSON object. */
function readAsksFile(layout: BotLayout): Record<string, unknown> | "missing" | "unreadable" {
  const file = asksFile(layout);
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return "missing";
    if (!stat.isFile()) return "unreadable";
    const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(saved) ? saved : "unreadable";
  } catch {
    return "unreadable";
  }
}

/**
 * The owner's setting. Nothing saved, or a saved file without `enabled`, reads as on (the default: the owner never
 * chose off). A file that is unreadable or malformed reads as off and is logged: a fault never brings questions the
 * owner didn't expect. Never an error.
 */
export function readAsksEnabled(layout: BotLayout): boolean {
  const saved = readAsksFile(layout);
  if (saved === "missing") return true;
  if (saved !== "unreadable" && !Object.hasOwn(saved, "enabled")) return true;
  if (saved !== "unreadable" && typeof saved.enabled === "boolean") return saved.enabled;
  console.log(JSON.stringify({ bots: "asks_setting_unreadable", bot: layout.botId.slice(0, 12) }));
  return false;
}

/** Whether anything from outside the owner's own words has reached Main's conversation since it began. */
export function readOutsideSeen(layout: BotLayout): boolean {
  const saved = readAsksFile(layout);
  return typeof saved !== "string" && saved.outsideSeen === true;
}

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
  if (!isRecord(value) || typeof value.id !== "string" || !/^[0-9a-f]{24}$/.test(value.id)) return false;
  if (!Number.isSafeInteger(value.askedAt) || !Number.isSafeInteger(value.expiresAt) || typeof value.hash !== "string" || typeof value.outside !== "boolean") return false;
  if (value.kind === undefined) return ASK_STATES.some(state => state === value.state);
  return value.kind === "secret" && SECRET_STATES.some(state => state === value.state) && typeof value.name === "string" && SECRET_NAME.test(value.name)
    && Array.isArray(value.sites) && value.sites.every(site => typeof site === "string") && (value.until === undefined || Number.isSafeInteger(value.until));
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
  /** The latest secret request for each name (never Main's sentence). Absent reads as none. */
  secrets?: SecretPush[];
}

/** One secret as the gateway knows it: for `request_secret`'s refusals, `call_with_secret` and `list_secrets`. */
export interface SecretPush {
  id: string;
  name: string;
  state: SecretState;
  sites: string[];
  until?: number;
}

function parseSecretPush(entry: unknown): SecretPush | undefined {
  if (!isRecord(entry) || typeof entry.id !== "string" || !/^[0-9a-f]{24}$/.test(entry.id)) return undefined;
  if (typeof entry.name !== "string" || !SECRET_NAME.test(entry.name) || !SECRET_STATES.some(state => state === entry.state)) return undefined;
  if (!Array.isArray(entry.sites) || entry.sites.length < 1 || entry.sites.length > MAX_SITES || !entry.sites.every(site => typeof site === "string")) return undefined;
  if (entry.until !== undefined && !Number.isSafeInteger(entry.until)) return undefined;
  return { id: entry.id, name: entry.name, state: entry.state as SecretState, sites: [...entry.sites as string[]], ...(entry.until !== undefined ? { until: entry.until as number } : {}) };
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
  let secrets: SecretPush[] | undefined;
  if (input.secrets !== undefined) {
    if (!Array.isArray(input.secrets) || input.secrets.length > META_KEEP_COUNT) return undefined;
    secrets = [];
    for (const entry of input.secrets) {
      const secret = parseSecretPush(entry);
      if (!secret) return undefined;
      secrets.push(secret);
    }
  }
  return { enabled: input.enabled, pending: input.pending, day: input.day, today: input.today, declined, ...(turn ? { turn } : {}), ...(secrets ? { secrets } : {}) };
}

/** Still in play: a pending request, or an approval in use. Never dropped as old metadata. */
const active = (ask: StoredAsk): boolean => ask.state === "pending" || ask.state === "approved";

/** A secret request is over: Main's sentence and the link go, and the gateway is to forget the request's key. */
function closeSecret(ask: StoredAsk): void {
  delete ask.why;
  delete ask.approveUrl;
  ask.wipe = true;
}

/**
 * One bot's requests in `requests.json`, read and written whole on every operation (the file is small and the
 * supervisor is one process). Every operation first settles the clock: a pending request past its 24 hours expires
 * and loses its text; an approval past its end has ended; a reply Main has not been told within REPLY_KEEP_MS loses
 * its text and is dropped; old metadata goes. Text is therefore gone at delivery or at expiry, whichever the
 * supervisor sees first. A secret request keeps its name and sites with its metadata: they are what the owner approved.
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
        if (ask.kind === "secret") closeSecret(ask);
        changed = true;
      }
      if (ask.state === "approved" && (ask.until ?? 0) <= now) {
        // Main is not told an approval ended: its next use says so. An approval it was never told of is not news now.
        ask.state = "ended";
        ask.resolvedAt = ask.until ?? now;
        delete ask.undelivered;
        closeSecret(ask);
        changed = true;
      }
      if (ask.undelivered && (ask.resolvedAt ?? 0) + REPLY_KEEP_MS <= now) {
        delete ask.answer;
        delete ask.undelivered;
        changed = true;
      }
    }
    const kept = asks.filter(ask => active(ask) || (ask.resolvedAt ?? ask.askedAt) + META_KEEP_MS > now);
    const resolved = kept.filter(ask => !active(ask)).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
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

  /** Records requests the gateway collected. Requests already held (same id) are not added twice. */
  ingest(incoming: NewRequest[]): void {
    const asks = this.#load();
    let changed = false;
    for (const ask of incoming) {
      if (asks.some(held => held.id === ask.id)) continue;
      const held = { id: ask.id, state: "pending" as const, askedAt: ask.askedAt, expiresAt: ask.askedAt + EXPIRY_MS, outside: ask.outside };
      asks.push(ask.kind === "secret"
        ? { ...held, kind: "secret", hash: secretHash(ask.name), name: ask.name, sites: ask.sites, why: ask.why }
        : { ...held, hash: questionHash(ask.question), question: ask.question, choices: ask.choices });
      changed = true;
    }
    // Expiry is applied again: a request collected late may already be past its time.
    if (changed) {
      this.#settle(asks);
      this.#save(asks);
    }
  }

  #view(ask: StoredAsk): AskRequest {
    const common = {
      id: ask.id, askedAt: new Date(ask.askedAt).toISOString(), expiresAt: new Date(ask.expiresAt).toISOString(), outside: ask.outside,
      ...(ask.resolvedAt !== undefined ? { resolvedAt: new Date(ask.resolvedAt).toISOString() } : {}),
    };
    const undelivered = ask.undelivered ? { undelivered: true as const } : {};
    if (ask.kind === "secret") {
      const service = knownSecret(ask.name!)?.service;
      const writes = writeMethods(ask.name!);
      return {
        ...common, kind: "secret", state: ask.state as SecretState, name: ask.name!, sites: [...ask.sites ?? []],
        ...(service ? { service } : {}),
        ...(writes.length ? { writes: [...writes] } : {}),
        ...((ask.state === "pending" || ask.state === "failed") && ask.why !== undefined ? { why: ask.why } : {}),
        ...(ask.state === "pending" && ask.approveUrl !== undefined ? { approveUrl: ask.approveUrl } : {}),
        ...(ask.until !== undefined && (ask.state === "approved" || ask.state === "revoked" || ask.state === "ended") ? { until: new Date(ask.until).toISOString() } : {}),
        ...undelivered,
      };
    }
    return {
      ...common, kind: "ask", state: ask.state as AskState,
      ...(ask.state === "pending" && ask.question !== undefined ? { question: ask.question, choices: ask.choices ?? [] } : {}),
      ...(ask.undelivered && ask.state === "answered" && ask.answer !== undefined ? { answer: ask.answer } : {}),
      ...undelivered,
    };
  }

  /** Pending first (oldest first), then approvals in use, then the most recent resolved. */
  list(): AskRequest[] {
    const asks = this.#load();
    const pending = asks.filter(ask => ask.state === "pending").sort((a, b) => a.askedAt - b.askedAt);
    const approved = asks.filter(ask => ask.state === "approved").sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
    const resolved = asks.filter(ask => !active(ask)).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)).slice(0, LISTED_RESOLVED);
    return [...pending, ...approved, ...resolved].map(ask => this.#view(ask));
  }

  /**
   * Records the owner's decision. On a pending, unexpired question: an answer (checked and made plain text here; a
   * choice becomes the text of that choice) or a decline. On a secret request: decline while pending, stop while
   * approved, retry while failed (pending again for another 24 hours, with a new link to come). Anything else about
   * the request is not for the caller to change.
   */
  answer(id: string, input: AnswerInput): AnswerResult {
    const asks = this.#load();
    const ask = asks.find(held => held.id === id);
    if (ask?.kind === "secret") return this.#decideSecret(asks, ask, input);
    if (!ask || ask.state !== "pending") return { ok: false, error: "not_pending" };
    if (input.decision === "stop" || input.decision === "retry") return { ok: false, error: "invalid" };
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

  #decideSecret(asks: StoredAsk[], ask: StoredAsk, input: AnswerInput): AnswerResult {
    if (input.decision === "answer") return { ok: false, error: "invalid" };
    const from = { decline: "pending", stop: "approved", retry: "failed" }[input.decision];
    if (ask.state !== from) return { ok: false, error: "not_pending" };
    const now = this.#now();
    if (input.decision === "retry") {
      // The old key goes first (see syncAsks), then the gateway makes a new one with a new link.
      ask.state = "pending";
      ask.expiresAt = now + EXPIRY_MS;
      delete ask.resolvedAt;
      delete ask.approveUrl;
      ask.wipe = true;
    } else {
      ask.state = input.decision === "stop" ? "revoked" : "declined";
      ask.resolvedAt = now;
      ask.undelivered = true;
      closeSecret(ask);
    }
    this.#save(asks);
    return { ok: true, request: this.#view(ask) };
  }

  /**
   * The owner turned requests off: every pending request becomes `stopped` (not declined, and not an answer) with its
   * question, choices or sentence gone at once. They share one `resolvedAt`, which marks them as one switch-off: Main
   * is told once for the lot, with its own sentence (see `delivered`). A stopped request is not held against being
   * asked again: only declined requests make a cooldown (see `push`). Approvals already given are not touched: they
   * last until their end or until the owner stops them.
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
      if (ask.kind === "secret") closeSecret(ask);
      stopped++;
    }
    if (stopped > 0) this.#save(asks);
    return stopped;
  }

  /** The message for Main, composed from the stored decision; undefined unless the request is decided and not yet delivered. */
  reply(id: string): AskReply | undefined {
    const ask = this.#load().find(held => held.id === id);
    if (!ask?.undelivered) return undefined;
    if (ask.state === "stopped") return { text: ASK_REPLIES.stopped, decision: "stopped" };
    if (ask.kind !== "secret") {
      return ask.state === "answered" || ask.state === "declined" ? { text: composeReply(ask.state, ask.answer), decision: ask.state } : undefined;
    }
    const name = ask.name!;
    const sites = ask.sites ?? [];
    const service = knownSecret(name)?.service;
    const secret: SecretLine = { name, sites: [...sites], ...(service ? { service } : {}), ...(ask.until !== undefined ? { until: new Date(ask.until).toISOString() } : {}) };
    if (ask.state === "approved" && ask.until !== undefined) return { text: SECRET_REPLIES.approved(name, sites, ask.until), decision: "approved", secret };
    if (ask.state === "declined") return { text: SECRET_REPLIES.declined(name), decision: "declined", secret };
    if (ask.state === "revoked") return { text: SECRET_REPLIES.revoked(name), decision: "revoked", secret };
    return undefined;
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

  /**
   * What the gateway needs to hold its limits: counts (questions and secret requests together), the requests
   * declined within the cooldown, and the latest secret request for each name.
   */
  push(): Omit<AsksPush, "enabled"> {
    const asks = this.#load();
    const now = this.#now();
    const day = utcDay(now);
    const latest = new Map<string, StoredAsk>();
    for (const ask of asks) {
      if (ask.kind !== "secret") continue;
      const seen = latest.get(ask.name!);
      if (!seen || ask.askedAt >= seen.askedAt) latest.set(ask.name!, ask);
    }
    return {
      pending: asks.filter(ask => ask.state === "pending").length,
      day,
      today: asks.filter(ask => utcDay(ask.askedAt) === day).length,
      declined: asks
        .filter(ask => ask.state === "declined" && (ask.resolvedAt ?? 0) + DECLINE_COOLDOWN_MS > now)
        .map(ask => ({ hash: ask.hash, until: (ask.resolvedAt ?? 0) + DECLINE_COOLDOWN_MS })),
      secrets: [...latest.values()].map(ask => ({
        id: ask.id, name: ask.name!, state: ask.state as SecretState, sites: [...ask.sites ?? []], ...(ask.until !== undefined ? { until: ask.until } : {}),
      })),
    };
  }

  // What the gateway reports and needs for secret requests (see syncAsks). Each changes only a secret request in the
  // state named, and answers whether it did.

  #secret(id: string, state: SecretState, change: (ask: StoredAsk, now: number) => boolean): boolean {
    const asks = this.#load();
    const ask = asks.find(held => held.id === id);
    if (ask?.kind !== "secret" || ask.state !== state || !change(ask, this.#now())) return false;
    this.#save(asks);
    return true;
  }

  /** The gateway's OpenKey link for a pending request; only a link to OpenKey is kept. */
  approvalLink(id: string, url: string): boolean {
    return this.#secret(id, "pending", ask => {
      if (!url.startsWith(`${OPENKEY_ORIGIN}/`) || url.length > 2048) return false;
      ask.approveUrl = url;
      return true;
    });
  }

  /** The owner approved in OpenKey and the gateway kept the approval, which ends at `until` (at most MAX_GRANT_MS from now). */
  approved(id: string, until: number): boolean {
    return this.#secret(id, "pending", (ask, now) => {
      if (!Number.isSafeInteger(until) || until <= now || until > now + MAX_GRANT_MS) return false;
      ask.state = "approved";
      ask.resolvedAt = now;
      ask.until = until;
      ask.undelivered = true;
      delete ask.why;
      delete ask.approveUrl;
      return true;
    });
  }

  /** The owner declined in OpenKey: the same as Decline on the card. */
  declinedInOpenKey(id: string): boolean {
    return this.#secret(id, "pending", (ask, now) => {
      ask.state = "declined";
      ask.resolvedAt = now;
      ask.undelivered = true;
      closeSecret(ask);
      return true;
    });
  }

  /** OpenKey's link ran out before the request did: the request expires now, without a message. */
  expiredInOpenKey(id: string): boolean {
    return this.#secret(id, "pending", (ask, now) => {
      ask.state = "expired";
      ask.resolvedAt = now;
      closeSecret(ask);
      return true;
    });
  }

  /** The approval could not be asked for or kept. Main's sentence stays, for a retry. */
  failed(id: string): boolean {
    return this.#secret(id, "pending", (ask, now) => {
      ask.state = "failed";
      ask.resolvedAt = now;
      delete ask.approveUrl;
      ask.wipe = true;
      return true;
    });
  }

  /** Pending secret requests the gateway has no link for yet (an old key is forgotten first). */
  linksNeeded(): Array<{ id: string; name: string; sites: string[]; why: string }> {
    return this.#load()
      .filter(ask => ask.kind === "secret" && ask.state === "pending" && ask.approveUrl === undefined && !ask.wipe && ask.why !== undefined)
      .map(ask => ({ id: ask.id, name: ask.name!, sites: [...ask.sites ?? []], why: ask.why! }));
  }

  /** Secret requests whose key the gateway is still to forget. */
  wipes(): string[] {
    return this.#load().filter(ask => ask.wipe).map(ask => ask.id);
  }

  /** The gateway forgot the key. */
  wiped(id: string): void {
    const asks = this.#load();
    const ask = asks.find(held => held.id === id);
    if (!ask?.wipe) return;
    delete ask.wipe;
    this.#save(asks);
  }
}

/** The supervisor's calls to the gateway's control socket. */
export interface AsksGateway {
  /** Takes the requests the box has asked since the last time. */
  drain(): Promise<unknown>;
  push(body: AsksPush): Promise<void>;
  /** Secret requests' approvals, which only the gateway holds. Absent: a gateway without them. */
  secrets?: SecretsGateway;
}

export interface SecretsGateway {
  /** Takes what became of approvals since the last time: `{ outcomes: [{ id, outcome, until? }] }`. */
  drain(): Promise<unknown>;
  /**
   * A fresh key and OpenKey link for a pending request (the same link again while it is open); throws if there is
   * none. Absent when the caller does not know the owner's account, which the gateway checks the approval against.
   */
  link?(id: string, request: { name: string; sites: string[]; header: string; why: string }): Promise<{ approveUrl: string }>;
  /** Forgets the request's key and anything it approved. */
  forget(id: string): Promise<void>;
}

const chains = new Map<string, Promise<unknown>>();

/** One task at a time per bot, in the order they were asked for. */
function inOrder<T>(botId: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(botId) ?? Promise.resolve()).catch(() => {}).then(task);
  chains.set(botId, run);
  void run.catch(() => {}).finally(() => { if (chains.get(botId) === run) chains.delete(botId); });
  return run;
}

type SecretOutcome = { id: string; outcome: "approved"; until: number } | { id: string; outcome: "declined" | "expired" | "failed" };

function parseOutcomes(input: unknown): SecretOutcome[] {
  if (!isRecord(input) || !Array.isArray(input.outcomes)) return [];
  return input.outcomes.flatMap((entry: unknown): SecretOutcome[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[0-9a-f]{24}$/.test(entry.id)) return [];
    if (entry.outcome === "approved") return Number.isSafeInteger(entry.until) ? [{ id: entry.id, outcome: "approved", until: entry.until as number }] : [];
    return entry.outcome === "declined" || entry.outcome === "expired" || entry.outcome === "failed" ? [{ id: entry.id, outcome: entry.outcome }] : [];
  });
}

/**
 * The gateway's side of secret requests: what OpenKey decided is recorded; keys of requests that are over are
 * forgotten (one that cannot be is tried again at the next sync); pending requests without a link get one, and one
 * that cannot have a link fails, so the owner sees Try again rather than a step that never opens.
 */
async function syncSecrets(store: AskStore, gateway: SecretsGateway): Promise<void> {
  for (const outcome of parseOutcomes(await gateway.drain())) {
    if (outcome.outcome === "approved") {
      // An approval longer than allowed is not kept: the request fails and its key is forgotten.
      if (!store.approved(outcome.id, outcome.until)) store.failed(outcome.id);
    } else if (outcome.outcome === "declined") store.declinedInOpenKey(outcome.id);
    else if (outcome.outcome === "expired") store.expiredInOpenKey(outcome.id);
    else store.failed(outcome.id);
  }
  for (const id of store.wipes()) {
    try {
      await gateway.forget(id);
      store.wiped(id);
    } catch { /* tried again at the next sync */ }
  }
  if (!gateway.link) return;
  for (const { id, ...request } of store.linksNeeded()) {
    try {
      const { approveUrl } = await gateway.link(id, { ...request, header: knownSecret(request.name)?.header.name ?? "authorization" });
      if (!store.approvalLink(id, approveUrl)) store.failed(id);
    } catch {
      store.failed(id);
    }
  }
}

/**
 * Brings the supervisor's records and the gateway together: collects new requests, stores them, settles secret
 * requests with the gateway (see syncSecrets), then gives the gateway the setting, the counts, the cooldowns and
 * the secrets. One at a time per bot, so a push never overtakes the
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
    // A gateway that cannot settle secret requests now still gets the setting and the counts.
    if (gateway.secrets) await syncSecrets(store, gateway.secrets).catch(() => {});
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
