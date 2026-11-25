// One bot of one owner (Main, or a sibling the backend created): at most one message at a time, its sandbox started
// on demand and stopped once the session has settled and stayed idle. Everything the sandbox says is treated as
// untrusted input; only checked fields are turned into events, which the server encodes itself.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ActivityRecord, HistoryJournal, type HistoryGrantUpdate, type HistoryOptions, type HistoryPermission, readHistoryRevocation, removeHistoryRevocation, saveHistoryRevocation, type StagedHistory, updateHistoryPermission } from "./history";
import { isRecord } from "./guards";
import { type BotLayout, botLayout, type LayoutRoots } from "./layout";
import { MESSAGING_STRINGS } from "./messaging-strings";
import { BOT_ID, botIdFor, MAIN_BOT_NAME, MAIN_KEY } from "./owner";
import { type DeleteSkip, lastUsed, markUsed, removeWorkingState } from "./retention";
import { type OwnerDate, ownerDateLine } from "./owner-date";
import { type Frame, type HostToolHandler, type HostToolReply, RpcError } from "./rpc";
import { addressesIn } from "./web";
import { readWebPolicy, type WebPolicy, writeWebPolicy } from "./web-policy";
import { type AnswerInput, type AnswerResult, type AppOrigin, AskStore, type AskReply, type AskRequest, cancelAsks, readAsksEnabled, type SecretLine, sweepAsks as sweepAskStores, writeAsksEnabled } from "./asks";
import { type ReadArea, type ReadsSetting, readReads, writeReads } from "./reads";
import {
  type ActionKind, type ActionOutcome, type ActionPayload, type ActionReply, type ActionRequest, type ActionResult, ActionStore, type ApproveResult, actionBinding,
} from "./actions";
import type { FeedbackSent } from "./feedback";

/** Where a message the app sends Main comes from: a decided question or secret request, or a decided proposal. */
export type AppSource = { app: AppOrigin["app"] | ActionReply["decision"]; secret?: SecretLine };

export type ErrorCode = "bot_unavailable" | "model_unavailable" | "busy" | "at_capacity" | "invalid";

export const MAX_TEXT = 8000;

/** Owner-visible sentences; never provider text. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bot_unavailable: `${MAIN_BOT_NAME} isn't available. Try again later.`,
  model_unavailable: `${MAIN_BOT_NAME}'s model isn't answering. Try again later.`,
  busy: `${MAIN_BOT_NAME} is still working on your last message. Send this one when it replies.`,
  at_capacity: `${MAIN_BOT_NAME} can't start right now because TinyCloud is running as many bots as it can. Your message wasn't sent. Try again shortly.`,
  invalid: "Messages can be up to 8,000 characters.",
};

export interface TurnSink {
  status(state: "starting" | "working"): void;
  delta(text: string): void;
  activity?(record: ActivityRecord): void;
  done(messageId: string): void;
  error(code: ErrorCode): void;
}

export interface ListedMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  at: string;
  /** Set for a message the app wrote (the owner's decision on a request from Main), not typed by the owner. */
  origin?: "app";
  /** With `origin: "app"`: what the owner decided, so the app need not read the composed text. */
  decision?: AskReply["decision"] | ActionReply["decision"];
  /** With a decision on a secret request: what the owner's chat line names. */
  secret?: SecretLine;
}

/** The owner's setting for questions from Main. */
export interface AsksSettings {
  enabled: boolean;
}

export interface BotMessenger {
  keys: readonly string[];
  dispatch(targetKey: string, text: string, signal: AbortSignal): Promise<HostToolReply>;
}

type StopFailure = "teardown_failed" | "gateway_cleanup_pending";

/** A running sandbox with OMP's RPC channel on its stdio, already bound to the bot's session. */
export interface Sandbox {
  nextId(): string;
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  onFrame(listener: (frame: Frame) => void): () => void;
  onHostToolCall?(handle: HostToolHandler): () => void;
  /** Settles once the sandbox has exited and been cleaned up. */
  readonly exited: Promise<void>;
  /** Registers the bot's egress socket and token with the gateway again (idempotent; the gateway may have restarted). */
  refreshEgress(): Promise<void>;
  /** Saves the bot's state to disk while the sandbox is paused. Never rejects; a failure keeps the previous copy. */
  snapshot(): Promise<void>;
  stop(): Promise<void | "gateway_cleanup_pending">;
}

export interface SandboxLauncher {
  /** Whether the bot has ever run, i.e. has a session to list. */
  hasState(layout: BotLayout): boolean;
  /** Unconfirmed sandbox or copier teardown; sandboxOnly counts just sandboxes for running slots. */
  leftover(layout: BotLayout, sandboxOnly?: boolean): boolean;
  /** `botName` is the name the owner sees, for the bot's prompt only; absent, the prompt uses MAIN_BOT_NAME. */
  launch(layout: BotLayout, botName?: string): Promise<Sandbox>;
  /** Retries cleanup for a stopped bot, including after the supervisor has restarted. */
  cleanupEgress?(layout: BotLayout): Promise<boolean>;
  /** Every mount point the supervisor sees (decoded from /proc/self/mountinfo). */
  mountPoints?(): string[];
  provenance?(layout: BotLayout): Promise<unknown>;
  /** Gives the gateway the bot's saved web setting (read from its data directory). */
  pushWeb?(layout: BotLayout): Promise<void>;
  /** Whether the gateway has a search provider and today's web counts for the bot; counts only. */
  webStatus?(layout: BotLayout): Promise<unknown>;
  /** Page addresses the owner typed, which the bot may read. */
  learnAddresses?(layout: BotLayout, urls: string[]): Promise<void>;
  /**
   * Collects the requests the box made, settles secret requests with the gateway, then gives the gateway the owner's
   * setting and the counts; `turn` starts a turn. `ownerDid` (Main's owner, when known) lets the gateway make
   * approval links, which OpenKey checks against that account.
   */
  syncAsks?(layout: BotLayout, turn?: { outside: boolean }, ownerDid?: string): Promise<void>;
  /** Gives the gateway the owner's read setting and the bot's conversation id (reads.ts). */
  pushReads?(layout: BotLayout): Promise<void>;
  /** Whether the bot's current conversation holds owner data it read; message_bot is refused while it does. */
  readsHeld?(layout: BotLayout): Promise<boolean>;
  /**
   * Collects the proposals the box made, then gives the gateway the counts, the final proposals and, when given, the
   * recipients Main may name from now (an empty list: none) and whether the owner started the turn.
   */
  syncActions?(layout: BotLayout, keys?: readonly string[], ownerTurn?: boolean): Promise<void>;
  /** Has the gateway spend an approval it issued: true once for that id and binding, else false. */
  spendAction?(layout: BotLayout, id: string, binding: string): Promise<boolean>;
  /** Has the gateway post an approved feedback report once (actions-desk.ts `send`); unknown when the call fails. */
  sendFeedback?(layout: BotLayout, id: string, binding: string, body: string): Promise<FeedbackSent>;
  /** Removes what the bot keeps off this host (a remote sandbox and its snapshot) before its directories go. */
  removeState?(layout: BotLayout): Promise<void>;
}

/** The owner's web setting plus what the gateway says of it. */
export interface WebSettings extends WebPolicy {
  available: boolean;
  today: { searches: number; pages: number; blocked: number };
}

/** Repeated while waiting, so idle proxies keep the stream open through slow starts and long turns. */
export const HEARTBEAT_MS = 15_000;

export interface BotOptions {
  /** Idle time after session_settled before the sandbox stops. */
  idleMs: number;
  /** A turn with no prompt_result by then ends with bot_unavailable and its sandbox is killed. */
  turnTimeoutMs: number;
  /** Assistant text bytes per turn; past it the agent's turn is aborted and the stream ends with an error. */
  maxTurnBytes: number;
  history?: HistoryOptions;
}

/** Thrown by a start refused at BOTS_MAX_RUNNING; the turn ends with at_capacity, never bot_unavailable. */
class AtCapacity extends Error {
  constructor() {
    super("BOTS_MAX_RUNNING sandboxes already running");
  }
}

/** How many sandboxes may run at once (BOTS_MAX_RUNNING), shared by every bot. */
export class RunningLimit {
  readonly #max: number;
  #running = 0;

  constructor(max: number) {
    this.#max = max;
  }

  /** Takes a place for one sandbox; false at the cap. */
  take(): boolean {
    if (this.#running >= this.#max) return false;
    this.#running++;
    return true;
  }

  /** Whether a place is free now. Only a hint: take() decides. */
  hasRoom(): boolean {
    return this.#running < this.#max;
  }

  release(): void {
    this.#running--;
  }
}

const LIST_LIMIT = 50;
const PAGE_LIMIT = 256;
const MAX_PAGES = 64;
const MAX_ACTIVITY_COUNT = 256;
const HOST_TOOLS_TIMEOUT_MS = 5_000;
const MESSAGE_BOT = "message_bot";

/**
 * Who wrote a turn's text: the owner in chat, another of the owner's bots through message_bot, or the app, from the
 * owner's response there to a question from Main or the outcome of a proposal from Main.
 */
export type TurnOrigin = "owner" | "bot" | AppSource;

/** The first line of every turn that did not come straight from the owner's chat (the bots' prompts rely on it). */
export const ORIGIN_LINES = {
  bot: "[TinyCloud: this message is from another of the owner's bots, not from the owner.]",
  app: "[TinyCloud: the owner responded in the app to your question. Their response follows.]",
  action: "[TinyCloud: the app reports the outcome of your proposal. It follows.]",
} as const;

/** Where OMP reads `@<path>` as a file to load into the turn: at the start of the text or after a space or opening mark. */
const FILE_MENTION = /(^|[\s([{<"'`])@/g;
/**
 * A bracket that would open a TinyCloud line, in text the supervisor did not write: spaces or marks may stand before
 * the word, and invisible format characters (such as a zero-width space) inside it.
 */
const TINYCLOUD_MARK = new RegExp(`\\[(?=[^\\p{L}\\p{N}\\]]*${[..."tinycloud"].join("\\p{Cf}*")})`, "giu");

/**
 * What OMP is sent for a turn. A turn that did not come straight from the owner's chat starts with its origin line, so
 * it never starts with "/": OMP runs slash commands and prompt templates only for a message that does, so such a turn
 * cannot run one (`/skill:` tokens, which OMP finds anywhere, are off with skills in config.yml). Its `@` mentions get a
 * word joiner after the `@`, so OMP does not load a file from the bot's box into the turn for whoever wrote it.
 * An owner's turn starts with their local date line when `date` is given, unless it is a slash command.
 * In every turn a `[` that would open a TinyCloud line gets a word joiner after it, so only the supervisor writes one.
 */
export function promptText(text: string, from: TurnOrigin, date?: OwnerDate): string {
  const written = text.replace(TINYCLOUD_MARK, "[\u2060");
  if (from === "owner") return date && !written.startsWith("/") ? `${ownerDateLine(date)}\n${written}` : written;
  const line = from === "bot" ? ORIGIN_LINES.bot
    : from.app === "action_approved" || from.app === "action_declined" || from.app === "feedback_sent" || from.app === "feedback_declined" ? ORIGIN_LINES.action
    : ORIGIN_LINES.app;
  return `${line}\n${written.replace(FILE_MENTION, "$1@\u2060")}`;
}

function messageBotTool(keys: readonly string[]) {
  return {
    name: MESSAGE_BOT,
    description: MESSAGING_STRINGS.description,
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        targetKey: { type: "string", enum: keys, description: MESSAGING_STRINGS.target },
        text: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: MESSAGING_STRINGS.text },
      },
      required: ["targetKey", "text"],
      additionalProperties: false,
    },
  };
}

/** Only fixed verbs and counters leave the supervisor. Paths are used in memory to count distinct files. */
class TurnActivity {
  readonly #calls = new Map<string, { tool: string; completed: boolean }>();
  readonly #files = new Set<string>();
  readonly #messages = new Map<string, number>();
  #commands = 0;

  frame(frame: Frame): void {
    const { toolCallId: id, toolName: tool } = frame;
    if (typeof id !== "string" || id.length < 1 || id.length > 256) return;
    if (tool !== "bash" && tool !== "write" && tool !== "edit") return;
    if (frame.type === "tool_execution_start") {
      if (this.#calls.size < MAX_ACTIVITY_COUNT && !this.#calls.has(id)) {
        this.#calls.set(id, { tool, completed: false });
      }
      return;
    }
    const call = this.#calls.get(id);
    if (!call || call.completed || call.tool !== tool) return;
    call.completed = true;
    if (frame.isError !== undefined && frame.isError !== false) return;
    if (tool === "bash") {
      this.#commands++;
      return;
    }
    const details = isRecord(frame.result) ? frame.result.details : undefined;
    if (!isRecord(details)) return;
    if (tool === "write") {
      if (!details.touchesNoFiles) this.#addFile(details.resolvedPath);
    } else if (Array.isArray(details.perFileResults)) {
      for (const file of details.perFileResults.slice(0, MAX_ACTIVITY_COUNT)) {
        if (isRecord(file) && !file.isError) this.#addFile(file.path);
      }
    } else if (!details.errorKind) {
      this.#addFile(details.path);
    }
  }

  #addFile(path: unknown): void {
    if (typeof path === "string" && path.startsWith("/") && path.length <= 4096 && this.#files.size < MAX_ACTIVITY_COUNT) {
      this.#files.add(path);
    }
  }

  messaged(key: string): void {
    this.#messages.set(key, Math.min((this.#messages.get(key) ?? 0) + 1, MAX_ACTIVITY_COUNT));
  }

  records(): ActivityRecord[] {
    const counts = { ran_commands: this.#commands, changed_files: this.#files.size } as const;
    const records: ActivityRecord[] = [];
    const base = () => ({ type: "activity" as const, id: randomBytes(16).toString("hex") });
    for (const verb of ["ran_commands", "changed_files"] as const) {
      const count = counts[verb];
      if (count > 0) records.push({ ...base(), verb, count, at: new Date().toISOString() });
    }
    for (const [targetKey, count] of this.#messages) {
      records.push({ ...base(), verb: "messaged_bot", count, at: new Date().toISOString(), targetKey });
    }
    return records;
  }
}

function log(event: string, botId: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ bots: event, bot: botId.slice(0, 12), ...extra }));
}

/** A message timestamp from untrusted input: whole milliseconds within Date's range, else undefined. */
function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 8.64e15 ? value : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/**
 * Owner-facing history: user messages, and each run of assistant messages after one as a single bot message
 * (texts joined by a blank line, as streamed). Ids come from the first message's timestamp, so the `done` id of a
 * streamed reply matches its id here.
 */
export function listedMessages(messages: unknown[]): ListedMessage[] {
  const listed: ListedMessage[] = [];
  let reply: ListedMessage | undefined;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const at = timestamp(message.timestamp);
    if (message.role === "user") {
      reply = undefined;
      const text = textOf(message.content);
      if (at !== undefined && message.synthetic !== true && text) {
        listed.push({ id: `u-${at}`, role: "user", text, at: new Date(at).toISOString() });
      }
    } else if (message.role === "assistant") {
      if (!reply) {
        if (at === undefined) continue;
        reply = { id: `b-${at}`, role: "bot", text: "", at: new Date(at).toISOString() };
        listed.push(reply);
      }
      const text = textOf(message.content);
      if (text) reply.text = reply.text ? `${reply.text}\n\n${text}` : text;
    }
  }
  return listed.filter(message => message.text).slice(-LIST_LIMIT);
}

async function readMessages(sandbox: Sandbox): Promise<unknown[]> {
  const messages: unknown[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await sandbox.request({ type: "get_messages_page", limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      if (!isRecord(data) || !Array.isArray(data.messages)) throw new Error("malformed message page");
      messages.push(...data.messages);
      if (typeof data.nextCursor !== "string") return messages;
      cursor = data.nextCursor;
    }
    throw new Error("message history too long");
  } catch (error) {
    // Paging refuses while a turn streams; OMP's own client falls back to the snapshot the same way.
    if (!(error instanceof RpcError) || (error.code !== "session_busy" && error.code !== "stale_cursor")) throw error;
  }
  const data = await sandbox.request({ type: "get_messages" });
  if (!isRecord(data) || !Array.isArray(data.messages)) throw new Error("malformed messages");
  return data.messages;
}

export class Bot {
  readonly layout: BotLayout;
  readonly #launcher: SandboxLauncher;
  readonly #options: BotOptions;
  readonly #running: RunningLimit;
  #history: HistoryJournal | undefined;
  /** The newest archive grant seen by a bot that has no journal to record it in (a sibling that has not run yet). */
  // The backend resends live grants. A confirmed revoke also has a durable marker outside the working directory.
  #grantSeen: HistoryPermission | undefined;
  #sandbox: Sandbox | undefined;
  #starting: Promise<Sandbox> | undefined;
  #stopping: Promise<StopFailure | undefined> | undefined;
  #deleting: Promise<DeleteSkip | undefined> | undefined;
  #webSaves: Promise<void> = Promise.resolve();
  #askSaves: Promise<void> = Promise.resolve();
  #readSaves: Promise<void> = Promise.resolve();
  #busy = false;
  #listing = 0;
  #settled = true;
  #idle: Timer | undefined;
  /** This bot holds one BOTS_MAX_RUNNING place: for its sandbox, or for a leftover whose end is unconfirmed. */
  #hasPlace = false;
  /** The backend is deleting this bot: the deletion that removes its working state retires it. */
  #retiring = false;
  /** Set once the backend's deletion of this bot has removed its working state. Nothing runs or writes for it again. */
  #retired = false;
  /** The name the owner sees, as the backend last sent it; the next sandbox start puts it into the prompt. */
  #name: string | undefined;
  /** Main's owner, once a request named them (see BotManager.forOwner): the account approval links are made for. */
  #ownerDid: string | undefined;

  constructor(layout: BotLayout, launcher: SandboxLauncher, options: BotOptions, running: RunningLimit) {
    this.layout = layout;
    this.#launcher = launcher;
    this.#options = options;
    this.#running = running;
  }

  /** Takes the name the owner sees for the bot. Only the prompt's wording uses it; nothing is trusted by name. */
  setName(botName: string): void {
    this.#name = botName;
  }

  /** Records Main's owner. Only the DID this bot's id was made from is kept. */
  knowOwner(ownerDid: string): void {
    if (this.layout.botKey === undefined && botIdFor(ownerDid) === this.layout.botId) this.#ownerDid = ownerDid;
  }

  #syncAsks(turn?: { outside: boolean }): Promise<void> {
    return this.#launcher.syncAsks?.(this.layout, turn, this.#ownerDid) ?? Promise.resolve();
  }

  /**
   * Runs one message. Reports through `sink` and always ends with exactly one done or error. `date` is the owner's
   * local date and time zone, used only on the owner's own turns.
   */
  async send(text: string, sink: TurnSink, owner?: string, messenger?: BotMessenger, from: TurnOrigin = "owner", date?: OwnerDate): Promise<void> {
    if (this.#busy) {
      sink.error("busy");
      return;
    }
    // A start that will be refused at the cap must not leave the message in the history, or a retry would show it twice.
    if (!this.#sandbox && !this.#starting && !this.#hasPlace && !this.#retired && !this.#running.hasRoom()) {
      log("at_capacity", this.layout.botId);
      sink.status("starting");
      sink.error("at_capacity");
      return;
    }
    // The journal of this turn, fixed at its start: a grant that arrives mid-turn on a bot that began it without one makes
    // #history exist with no draft, and the turn's sink must not write to that.
    let turnJournal: HistoryJournal | undefined;
    if (this.#options.history) {
      this.#busy = true;
      await this.#deleting;
      if (this.#retired) { this.#busy = false; sink.error("bot_unavailable"); return; }
      try {
        // TC-3933: a bot that has never had an archive grant starts no journal. Journaling starts when a grant arrives; the
        // turns before it are not archived. Without this the journal only grows (nothing removes a batch until the working
        // state is deleted, and that waits for the archive), fills at about 3.9 MiB and fails every turn from then on. A
        // journal such a bot already holds is kept as it is, not written to and not deleted; New chat and the sweep still
        // delete the bot with it.
        const journal = this.#journal();
        const granted = this.#hasGrant();
        if (granted && !(journal.permission ?? this.#grantSeen)?.revoked) {
          journal.begin(owner ?? "", this.#options.maxTurnBytes * 16 + 128 * 1024);
          if (!journal.everGranted && this.#grantSeen) {
            journal.permissionActive(this.#grantSeen.validUntil, Date.now(), this.#grantSeen.grant);
          }
          journal.append({
            type: "user", text, at: new Date().toISOString(),
            ...(typeof from === "object" ? { origin: "app", decision: from.app, ...(from.secret ? { secret: from.secret } : {}) } : {}),
          });
          journal.startDraft();
          turnJournal = journal;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "history_full") log("history_full", this.layout.botId);
        this.#busy = false; sink.error("bot_unavailable"); return;
      }
    }
    const output = sink;
    sink = {
      status: state => output.status(state),
      delta: text => { turnJournal?.delta(text); output.delta(text); },
      activity: record => { turnJournal?.append(record); output.activity?.(record); },
      done: messageId => { turnJournal?.finishDraft({ type: "done", messageId }); output.done(messageId); },
      error: code => { turnJournal?.finishDraft({ type: "error", code }); output.error(code); },
    };
    this.#busy = true;
    this.#clearIdle();
    let state: "starting" | "working" = this.#sandbox ? "working" : "starting";
    sink.status(state);
    const heartbeat = setInterval(() => sink.status(state), HEARTBEAT_MS);
    try {
      let sandbox: Sandbox;
      try {
        sandbox = await this.#ensure();
        this.#markUsed();
        await sandbox.refreshEgress();
        await this.#syncAsks({ outside: from === "bot" });
        // Main may propose sending to the bots it may message in this turn; a turn another bot started names none.
        // Only a turn the owner wrote may propose a feedback report; this push is the one thing that says so.
        await this.#launcher.syncActions?.(this.layout, from === "bot" ? [] : messenger?.keys ?? [], from === "owner");
        // Only what the owner typed counts as an address they chose; a message from another bot may carry text a web page put there, and an app reply is composed here.
        const typed = from === "owner" ? addressesIn(text, 50) : [];
        if (typed.length > 0) await this.#launcher.learnAddresses?.(this.layout, typed);
      } catch (error) {
        if (error instanceof AtCapacity) {
          log("at_capacity", this.layout.botId);
          sink.error("at_capacity");
          return;
        }
        log("start_failed", this.layout.botId, { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
        sink.error("bot_unavailable");
        return;
      }
      if (state === "starting") {
        state = "working";
        sink.status(state);
      }
      if (!messenger || !sandbox.onHostToolCall) {
        await this.#turn(sandbox, promptText(text, from, date), sink);
        return;
      }
      try {
        await sandbox.request({ type: "set_host_tools", tools: [messageBotTool(messenger.keys)] }, HOST_TOOLS_TIMEOUT_MS);
      } catch {
        sink.error("bot_unavailable");
        await this.#stop(sandbox);
        return;
      }
      try {
        await this.#turn(sandbox, promptText(text, from, date), sink, messenger);
      } finally {
        try { await sandbox.request({ type: "set_host_tools", tools: [] }, HOST_TOOLS_TIMEOUT_MS); }
        catch { if (this.#sandbox === sandbox) await this.#stop(sandbox); }
      }
    } finally {
      clearInterval(heartbeat);
      // Questions Main asked during the turn are collected now, while the gateway still holds them.
      void this.#syncAsks().catch(() => {});
      void this.#launcher.syncActions?.(this.layout, []).catch(() => {});
      if (turnJournal) {
        try { turnJournal.append({ type: "provenance", receipts: await this.#launcher.provenance?.(this.layout) ?? [] }); }
        catch { turnJournal.append({ type: "provenance", verified: false }); }
      }
      this.#busy = false;
      this.#armIdle();
    }
  }

  /** The newest messages of Main's session; empty for a bot that has never run (without starting one). */
  async list(): Promise<ListedMessage[]> {
    if (this.#options.history) {
      await this.#deleting;
      if (this.#retired) throw new Error("bot_retired");
      this.#history ??= new HistoryJournal(this.layout, this.#options.history);
      // A bot that keeps no journal (TC-3933) shows what its own state holds, as a bot without history does.
      if (this.#hasGrant() && !this.#history.permission?.revoked && !this.#history.legacyPending) {
        const messages = this.#history.messages();
        if (messages.length) this.#markUsed();
        return messages;
      }
    }
    this.#listing++;
    this.#clearIdle();
    try {
      // A bot whose working state is being deleted lists nothing once that is done.
      await this.#deleting;
      if (this.#retired) throw new Error("bot_retired");
      if (!this.#sandbox && !this.#launcher.hasState(this.layout)) return [];
      const sandbox = await this.#ensure();
      this.#markUsed();
      return listedMessages(await readMessages(sandbox));
    } finally {
      this.#listing--;
      this.#armIdle();
    }
  }

  /** The owner's web setting and today's counts. A gateway that cannot answer reads as unavailable, with zero counts. */
  async webSettings(): Promise<WebSettings> {
    await this.#deleting;
    const policy = readWebPolicy(this.layout);
    const none = { available: false, today: { searches: 0, pages: 0, blocked: 0 } };
    let status: unknown;
    try {
      status = await this.#launcher.webStatus?.(this.layout);
    } catch {
      status = undefined;
    }
    const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
    if (!isRecord(status) || !isRecord(status.today)) return { ...policy, ...none };
    const { searches, pages, blocked } = status.today;
    return { ...policy, available: status.available === true, today: { searches: count(searches), pages: count(pages), blocked: count(blocked) } };
  }

  /**
   * Saves the owner's web setting and gives it to the gateway; if the gateway cannot take it, the previous setting
   * is put back (in the file and, as far as the gateway answers, there) and this throws. Saves are one at a time, so
   * two never share the temporary file. Takes effect at the bot's next web call, running or not.
   */
  setWebPolicy(policy: WebPolicy): Promise<WebSettings> {
    const saved = this.#webSaves.then(async () => {
      await this.#deleting;
      const previous = readWebPolicy(this.layout);
      mkdirSync(this.layout.dataDir, { recursive: true, mode: 0o700 });
      writeWebPolicy(this.layout, policy);
      try {
        await this.#launcher.pushWeb?.(this.layout);
      } catch (error) {
        writeWebPolicy(this.layout, previous);
        // A push that timed out may still have arrived; say the old setting again. If this fails too, the next
        // message pushes the saved one before the bot can act.
        await this.#launcher.pushWeb?.(this.layout).catch(() => {});
        throw error;
      }
      log("web_setting", this.layout.botId, { mode: policy.mode, hosts: policy.hosts.length });
    });
    this.#webSaves = saved.catch(() => {});
    return saved.then(() => this.webSettings());
  }

  /** Whether the owner lets Main ask questions. Off until turned on. */
  async asksSettings(): Promise<AsksSettings> {
    await this.#deleting;
    return { enabled: readAsksEnabled(this.layout) };
  }

  /**
   * Saves the owner's setting for questions and gives it to the gateway; if the gateway cannot take it the previous
   * setting is put back and this throws. One at a time, like the web setting. Takes effect at the bot's next call.
   * Turning it off first closes every pending question (see cancelAsks), which does not depend on the gateway, and
   * then stays off even if the gateway cannot be told yet: the gateway is told again at its next sync, and what it
   * collects meanwhile is dropped while the setting is off.
   */
  setAsksEnabled(enabled: boolean): Promise<AsksSettings> {
    const saved = this.#askSaves.then(async () => {
      await this.#deleting;
      const previous = readAsksEnabled(this.layout);
      writeAsksEnabled(this.layout, enabled);
      if (!enabled) {
        const stopped = await cancelAsks(this.layout);
        new ActionStore(this.layout).cancelPending();
        await this.#syncAsks().catch(() => log("asks_setting_push_failed", this.layout.botId));
        await this.#launcher.syncActions?.(this.layout).catch(() => {});
        log("asks_setting", this.layout.botId, { enabled, stopped });
        return;
      }
      try {
        await this.#syncAsks();
      } catch (error) {
        writeAsksEnabled(this.layout, previous);
        await this.#syncAsks().catch(() => {});
        throw error;
      }
      log("asks_setting", this.layout.botId, { enabled });
    });
    this.#askSaves = saved.catch(() => {});
    return saved.then(() => ({ enabled }));
  }

  /**
   * Saves which areas the owner lets Main read and gives the gateway the setting. The backend checks the owner's grant
   * on every read whatever the gateway holds, so a push that fails is logged and sent again at the next message.
   */
  setReads(owner: string, areas: ReadArea[]): Promise<ReadsSetting> {
    const setting: ReadsSetting = areas.length > 0 ? { areas, owner } : { areas: [] };
    const saved = this.#readSaves.then(async () => {
      await this.#deleting;
      writeReads(this.layout, setting);
      await this.#launcher.pushReads?.(this.layout).catch(() => log("reads_setting_push_failed", this.layout.botId));
      log("reads_setting", this.layout.botId, { areas: areas.length });
    });
    this.#readSaves = saved.catch(() => {});
    return saved.then(() => ({ areas: setting.areas }));
  }

  /** The owner's requests from Main: questions and proposals so far (collected from the gateway first), open first. */
  async requests(): Promise<(AskRequest | ActionRequest)[]> {
    await this.#deleting;
    await this.#syncAsks().catch(() => {});
    await this.#launcher.syncActions?.(this.layout).catch(() => {});
    const asks = new AskStore(this.layout).list();
    const actions = new ActionStore(this.layout).list();
    const open = (request: AskRequest | ActionRequest) => request.state === "pending" || request.state === "sending";
    return [...asks.filter(open), ...actions.filter(open), ...asks.filter(request => !open(request)), ...actions.filter(request => !open(request))];
  }

  /** Records the owner's decision on one request. Only a pending, unexpired request can be decided; a proposal only declined here. */
  async answerRequest(id: string, input: AnswerInput): Promise<AnswerResult | ActionResult> {
    await this.#deleting;
    const actions = new ActionStore(this.layout);
    if (actions.has(id)) {
      if (input.decision !== "decline") return { ok: false, error: "invalid" };
      const result = actions.decline(id);
      if (result.ok) {
        log("action_resolved", this.layout.botId, { outcome: "declined" });
        void this.#launcher.syncActions?.(this.layout).catch(() => {});
      }
      return result;
    }
    const result = new AskStore(this.layout).answer(id, input);
    if (result.ok) {
      log("ask_resolved", this.layout.botId, { outcome: result.request.state });
      void this.#syncAsks().catch(() => {});
    }
    return result;
  }

  /** The kind of a proposal from Main, or undefined when `id` is not one. */
  requestKind(id: string): ActionKind | undefined {
    return new ActionStore(this.layout).kind(id);
  }

  /**
   * The owner's Send on a proposal card, naming the binding the card showed. Checked and marked sending here, so a
   * second Send is refused; the send itself runs after this returns. A message to bots: the gateway spends the
   * approval (once, for that binding), then each recipient gets the message by the path `message_bot` takes, admitted
   * for this owner; recipients outside `messenger.keys` are not sent to, and without a messenger it is refused. A
   * feedback report: the gateway checks it again, spends the approval and posts it once. Main is told the outcome by
   * an app message.
   */
  async approveRequest(id: string, binding: string, messenger?: BotMessenger): Promise<ApproveResult> {
    await this.#deleting;
    // A chat that read the owner's meetings sends nothing out: the proposal stays as it is and the card says why.
    if (await this.holdsOwnerData()) return { ok: false, error: "held" };
    const store = new ActionStore(this.layout);
    if (store.kind(id) === "message_bots" && !messenger) return { ok: false, error: "invalid" };
    const approved = store.approve(id, binding, this.layout.ownerId);
    if (!approved.ok) return approved;
    log("action_resolved", this.layout.botId, { outcome: "approved", recipients: approved.payload.targets.length });
    const sent = approved.payload.kind === "send_feedback"
      ? this.#sendFeedback(id, binding, approved.payload.text)
      : this.#sendApproved(id, binding, approved.payload, messenger!);
    void sent.catch(() => log("action_send_failed", this.layout.botId));
    return { ok: true, request: approved.request };
  }

  async #sendFeedback(id: string, binding: string, body: string): Promise<void> {
    const store = new ActionStore(this.layout);
    // What is about to go out must be exactly what the owner approved and the gateway issued.
    if (actionBinding(this.layout.ownerId, this.layout.botId, { kind: "send_feedback", targets: [], text: body }) !== binding || !this.#launcher.sendFeedback) {
      store.finish(id, [], { outcome: "refused" });
      log("action_sent", this.layout.botId, { kind: "send_feedback", outcome: "refused" });
      return;
    }
    let sent: FeedbackSent;
    try {
      sent = await this.#launcher.sendFeedback(this.layout, id, binding, body);
    } catch {
      sent = { outcome: "unknown" };
    }
    store.finish(id, [], sent);
    log("action_sent", this.layout.botId, { kind: "send_feedback", outcome: sent.outcome });
  }

  async #sendApproved(id: string, binding: string, payload: ActionPayload, messenger: BotMessenger): Promise<void> {
    const store = new ActionStore(this.layout);
    const failed = payload.targets.map(key => ({ key, delivered: false }));
    // What is about to go out must be exactly what the owner approved and the gateway issued.
    if (actionBinding(this.layout.ownerId, this.layout.botId, payload) !== binding) {
      store.finish(id, failed);
      return;
    }
    let spent: boolean;
    try {
      spent = await this.#launcher.spendAction?.(this.layout, id, binding) ?? false;
    } catch {
      spent = false;
    }
    if (!spent) {
      log("action_sent", this.layout.botId, { outcome: "spend_refused" });
      store.finish(id, failed);
      return;
    }
    const signal = AbortSignal.timeout(this.#options.turnTimeoutMs);
    const outcomes: ActionOutcome[] = await Promise.all(payload.targets.map(async key => {
      if (!messenger.keys.includes(key)) return { key, delivered: false };
      try {
        const reply = await messenger.dispatch(key, payload.text, signal);
        return { key, delivered: !reply.isError };
      } catch {
        return { key, delivered: false };
      }
    }));
    store.finish(id, outcomes);
    log("action_sent", this.layout.botId, { delivered: outcomes.filter(outcome => outcome.delivered).length, failed: outcomes.filter(outcome => !outcome.delivered).length });
  }

  /**
   * The message that tells Main what the owner decided, composed here from the stored decision; undefined unless the
   * request is decided and Main has not been told. This is the only source of text for an app-originated message.
   */
  appReply(requestId: string): AskReply | ActionReply | undefined {
    const actions = new ActionStore(this.layout);
    return actions.has(requestId) ? actions.reply(requestId) : new AskStore(this.layout).reply(requestId);
  }

  /** Main has been told: the answer text is deleted (the metadata stays). */
  appReplyDelivered(requestId: string): void {
    new AskStore(this.layout).delivered(requestId);
    new ActionStore(this.layout).delivered(requestId);
  }

  /** A message or history request is in flight, including one still starting the sandbox. */
  get inUse(): boolean {
    return this.#busy || this.#listing > 0;
  }

  async listActivities(): Promise<ActivityRecord[]> {
    if (!this.#options.history) return [];
    return await this.#historyOperation(journal => journal.activities(), true) ?? [];
  }

  /** Stops the sandbox if one is running or starting. False if its teardown is incomplete. */
  async stop(): Promise<boolean> {
    return (await this.#stopSandbox()) === undefined;
  }

  async #stopSandbox(): Promise<StopFailure | undefined> {
    this.#clearIdle();
    const sandbox = this.#sandbox ?? (await this.#starting?.catch(() => undefined));
    return sandbox ? this.#stop(sandbox) : this.#stopping;
  }

  /**
   * The one way a bot's working state is deleted: stops its sandbox, then removes its data directory (state snapshot
   * and last-use marker) and its run directory. A failed teardown, a path that is not the bot's own directory, a
   * mount at or under either directory keeps everything and logs
   * state_delete_skipped instead. A request that arrives meanwhile waits for this, then starts a fresh bot; with
   * `retire` (the backend is deleting the bot) it is refused instead, and nothing is written for the bot again.
   * Resolves to why the state was kept, or to undefined once it is gone.
   */
  deleteWorkingState(reason: string, closing = () => false, retire = false): Promise<DeleteSkip | undefined> {
    // Also when a deletion is already under way: that one retires the bot when it succeeds.
    if (retire) this.#retiring = true;
    this.#deleting ??= (async () => {
      let cause: DeleteSkip | undefined;
      try {
        const stopFailure = await this.#stopSandbox();
        if (this.#launcher.leftover(this.layout)) cause = "teardown_failed";
        else if (stopFailure) cause = stopFailure;
        else if (await this.#launcher.cleanupEgress?.(this.layout) === false) cause = "gateway_cleanup_pending";
        else {
          const noWorkingState = this.#retiring && !this.inUse && !lstatSync(this.layout.dataDir, { throwIfNoEntry: false })
            && !lstatSync(this.layout.bundleDir, { throwIfNoEntry: false });
          const covered = noWorkingState || await this.historyCovered();
          // Signature checks await: closing or a newly appended message can change eligibility meanwhile.
          if (closing()) cause = "closing";
          else if (!noWorkingState) {
            // TC-3933: until the cause of the lost archive is settled, the retention sweep and the expiry sweep do not delete the
            // state of a bot that never had a grant, as before the journal stopped being kept for it. Only the owner's own
            // New chat or deletion does.
            if (this.#options.history && !this.#hasGrant() && reason !== "new_chat" && reason !== "deleted") cause = "ungranted_retained";
            else cause = this.#options.history && this.#hasGrant() && (!covered || !this.#history?.covered) && !this.#history?.expiryDue()
              ? "archive_pending" : await removeWorkingState(this.layout, this.#launcher);
          }
        }
        if (!cause && this.#retiring && this.layout.botKey !== undefined) removeHistoryRevocation(this.layout);
      } catch {
        cause = "error";
      }
      if (cause) log("state_delete_skipped", this.layout.botId, { reason, cause });
      else {
        this.#history = undefined;
        // Set before this resolves, so a request already waiting on the deletion sees it.
        if (this.#retiring) this.#retired = true;
        log("state_deleted", this.layout.botId, { reason });
      }
      return cause;
    })().finally(() => {
      this.#deleting = undefined;
    });
    return this.#deleting;
  }

  /**
   * The owner's "Start a new chat": deletes the working state (deleteWorkingState), so the conversation, its pending
   * questions and the mark of owner data it read are gone, then saves the owner's settings again: web access, the
   * questions setting and the read areas. Only their on/off fields come back; nothing about the old conversation does.
   * Refused while a request is in flight or a deletion is under way. The settings are saved again by a callback on the
   * deletion itself, registered before any request can wait on it, so a fresh sandbox always starts with them.
   */
  newChat(closing: () => boolean): Promise<DeleteSkip | "busy" | undefined> {
    if (this.inUse || this.#deleting) return Promise.resolve("busy");
    const web = readWebPolicy(this.layout);
    const asks = readAsksEnabled(this.layout);
    const reads = readReads(this.layout);
    return this.deleteWorkingState("new_chat", closing).then(cause => {
      if (cause) return cause;
      try {
        if (web.mode !== "off") {
          mkdirSync(this.layout.dataDir, { recursive: true, mode: 0o700 });
          writeWebPolicy(this.layout, web);
        }
        if (asks) writeAsksEnabled(this.layout, true);
        if (reads.areas.length > 0) writeReads(this.layout, reads);
      } catch {
        // A setting that is not saved reads as off.
        log("new_chat_settings_failed", this.layout.botId);
      }
      return undefined;
    });
  }

  #journal() {
    if (!this.#options.history) throw new Error("history_disabled");
    return this.#history ??= new HistoryJournal(this.layout, this.#options.history);
  }
  /** With `existing`, the operation is skipped when the bot has no journal, checked after any deletion has finished. */
  async #historyOperation<T>(run: (journal: HistoryJournal) => T | Promise<T>, existing = false): Promise<T | undefined> {
    this.#listing++;
    try {
      await this.#deleting;
      if (this.#retired) throw new Error("bot_retired");
      if (existing && !existsSync(join(this.layout.dataDir, "history.json"))) return undefined;
      return await run(this.#journal());
    } finally { this.#listing--; }
  }
  /**
   * TC-3933: whether this bot has ever had an archive grant: one on record in its journal, an expired one that left a
   * notice, or one just received by a bot with no journal yet. Only a bot with a grant keeps a journal.
   */
  #hasGrant(): boolean {
    if (!this.#options.history) return false;
    return this.#journal().everGranted || (this.#grantSeen !== undefined && !this.#grantSeen.revoked && this.#grantSeen.validUntil > Date.now());
  }
  async historyPermission(owner: string, expiresAt?: number, validUntil?: number, grant?: HistoryGrantUpdate) {
    // A sibling that has never run holds permission in memory so that it creates no journal or directory.
    await this.#historyOperation(journal => {
      const now = Date.now();
      // A confirmed revocation takes effect on receipt even if the backend clock runs ahead.
      const expiry = grant?.kind === "revoke" && expiresAt !== undefined ? Math.min(expiresAt, now) : expiresAt;
      if (this.layout.botKey !== undefined && !existsSync(join(this.layout.dataDir, "history.json"))) {
        if (expiry === undefined || grant?.kind === "revoke") {
          const current = this.#grantSeen ?? readHistoryRevocation(this.layout);
          // A restart can lose the live grant. Record a signed revoke when there is no
          // active permission to displace and the tag advances any saved revoke.
          const end = expiry ?? validUntil!;
          const canRecord = grant?.kind === "revoke" &&
            (!current || (current.revoked && current.grant && grant.revision > current.grant.revision));
          const baseline = canRecord ? { validUntil: end, grant } : current;
          const next = updateHistoryPermission(baseline, end, grant, now);
          if (next?.revoked && next !== current) saveHistoryRevocation(this.layout, next);
          this.#grantSeen = next;
        }
      } else {
        if (expiry === undefined) { journal.begin(owner, 0); journal.permissionActive(validUntil!, now, grant); }
        else journal.permissionExpired(expiry, owner, now, grant);
        this.#grantSeen = journal.permission;
      }
    });
  }
  historyStage(staged: StagedHistory) { return this.#historyOperation(journal => journal.stage(staged)); }
  historyNotice() { return this.#options.history ? this.#historyOperation(journal => journal.notice()) : Promise.resolve(undefined); }
  historyNoticeAck(id: string, receivedAt: number) { return this.#historyOperation(journal => journal.acknowledgeNotice(id, receivedAt)); }
  historyExpiryDue(now = Date.now()) { return this.#options.history ? this.#journal().expiryDue(now) : false; }
  historyPending() {
    return this.#options.history ? this.#historyOperation(journal => journal.pending()) : Promise.resolve(undefined);
  }
  historyNeedsGrantTag(): boolean {
    const permission = this.#options.history && this.#journal().permission;
    return !!permission && !permission.grant && permission.validUntil > Date.now();
  }
  historyReceipt(receipt: unknown) { return this.#historyOperation(journal => journal.accept(receipt)); }
  async historyCovered(): Promise<boolean> {
    if (!this.#options.history) return true;
    this.#history ??= new HistoryJournal(this.layout, this.#options.history);
    return this.#history.verifyCoverage();
  }

  #markUsed(): void {
    try {
      markUsed(this.layout);
    } catch (error) {
      log("mark_used_failed", this.layout.botId, { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
    }
  }

  /** Asks the gateway whether this conversation holds owner data it read. A launcher that cannot answer, or an answer that cannot be had, counts as held. */
  async holdsOwnerData(): Promise<boolean> {
    if (!this.#launcher.readsHeld) return true;
    try {
      return await this.#launcher.readsHeld(this.layout);
    } catch {
      log("reads_held_check_failed", this.layout.botId);
      return true;
    }
  }

  #turn(sandbox: Sandbox, text: string, sink: TurnSink, messenger?: BotMessenger): Promise<void> {
    const id = sandbox.nextId();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const activity = new TurnActivity();
    const reaching = new Set<string>();
    // One recipient per turn: the first bot `message_bot` sends to. Sending to more takes the owner's tap (propose_action).
    let recipient: string | undefined;
    const offHost = messenger && sandbox.onHostToolCall?.(async (name, args, signal) => {
      if (name !== MESSAGE_BOT) return { text: MESSAGING_STRINGS.unavailable, isError: true };
      if (!isRecord(args) || Object.keys(args).length !== 2
        || typeof args.targetKey !== "string" || !messenger.keys.includes(args.targetKey)
        || typeof args.text !== "string" || args.text.length < 1 || args.text.length > MAX_TEXT) {
        return { text: MESSAGING_STRINGS.invalid, isError: true };
      }
      const { targetKey } = args;
      // Owner data read in this conversation reaches another bot only through the owner's tap (propose_action).
      if (await this.holdsOwnerData()) return { text: MESSAGING_STRINGS.held, isError: true };
      if (recipient !== undefined && recipient !== targetKey) return { text: MESSAGING_STRINGS.oneBot, isError: true };
      if (reaching.has(targetKey)) return { text: MESSAGING_STRINGS.busy, isError: true };
      recipient = targetKey;
      reaching.add(targetKey);
      try {
        const reply = await messenger.dispatch(targetKey, args.text, signal);
        if (!signal.aborted && !reply.isError) {
          activity.messaged(targetKey);
          // Another bot's words are now in Main's conversation: what it asks from here on says so.
          await this.#syncAsks({ outside: true }).catch(() => {});
        }
        return reply;
      } finally {
        reaching.delete(targetKey);
      }
    });
    let firstReplyAt: number | undefined;
    let wroteText = false;
    let separate = false;
    let finished = false;
    let bytes = 0;
    const finish = (outcome: { messageId: string } | { code: ErrorCode }) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      off();
      offHost?.();
      try {
        for (const record of activity.records()) sink.activity?.(record);
        if ("messageId" in outcome) sink.done(outcome.messageId);
        else sink.error(outcome.code);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    // A turn that never reports back (a wedged agent, or one that ignores its tools' limits) loses its sandbox.
    const deadline = setTimeout(() => {
      if (finished) return;
      log("turn_timeout", this.layout.botId);
      finish({ code: "bot_unavailable" });
      void this.#stop(sandbox);
    }, this.#options.turnTimeoutMs);
    const off = sandbox.onFrame(frame => {
      if (frame.type === "message_update") {
        const event = frame.assistantMessageEvent;
        if (!isRecord(frame.message) || frame.message.role !== "assistant") return;
        if (!isRecord(event) || event.type !== "text_delta" || typeof event.delta !== "string" || !event.delta) return;
        bytes += Buffer.byteLength(event.delta);
        if (bytes > this.#options.maxTurnBytes) {
          // Too much text for one reply: stop the agent's turn and end the stream.
          log("turn_too_long", this.layout.botId);
          void sandbox.request({ type: "abort" }).catch(() => {});
          finish({ code: "bot_unavailable" });
          return;
        }
        if (separate) sink.delta("\n\n");
        separate = false;
        wroteText = true;
        sink.delta(event.delta);
      } else if (frame.type === "message_end") {
        if (!isRecord(frame.message) || frame.message.role !== "assistant") return;
        firstReplyAt ??= timestamp(frame.message.timestamp);
        separate = wroteText;
      } else if (frame.type === "tool_execution_start" || frame.type === "tool_execution_end") {
        activity.frame(frame);
      } else if (frame.type === "prompt_result" && frame.id === id) {
        this.#settled = frame.sessionSettled === true;
        if (frame.status === "completed") finish({ messageId: `b-${firstReplyAt ?? Date.now()}` });
        else finish({ code: frame.status === "error" ? "model_unavailable" : "bot_unavailable" });
      }
    });
    this.#settled = false;
    void sandbox.exited.then(() => finish({ code: "bot_unavailable" }));
    sandbox.request({ id, type: "prompt", message: text }).then(
      data => {
        // A slash command answered locally: no turn ran and no prompt_result follows.
        if (isRecord(data) && data.agentInvoked === false) {
          this.#settled = true;
          finish({ messageId: `b-${Date.now()}` });
        }
      },
      () => finish({ code: "bot_unavailable" }),
    );
    return promise;
  }

  #ensure(): Promise<Sandbox> {
    if (this.#sandbox) return Promise.resolve(this.#sandbox);
    this.#starting ??= (async () => {
      // Never launch over a sandbox still being torn down (both would mount the same state filesystem), nor
      // before a deletion of the bot's working state has finished.
      await this.#deleting;
      await this.#stopping;
      if (this.#retired) throw new Error("bot_retired");
      // At the cap a start is refused, never squeezed into memory the running bots may need. A leftover's place
      // passes to the next start, which first ends the leftover.
      if (!this.#hasPlace) {
        if (!this.#running.take()) throw new AtCapacity();
        this.#hasPlace = true;
      }
      const started = Date.now();
      let sandbox: Sandbox;
      try {
        sandbox = await this.#launcher.launch(this.layout, this.#name);
      } catch (error) {
        this.#releasePlace();
        throw error;
      }
      log("started", this.layout.botId, { ms: Date.now() - started });
      this.#sandbox = sandbox;
      this.#settled = true;
      sandbox.onFrame(frame => {
        if (frame.type !== "session_settled") return;
        this.#settled = true;
        void sandbox.snapshot();
        this.#armIdle();
      });
      // `exited` settles once the teardown is over, so the place frees only after the state is saved and unmounted,
      // and not at all while the end is unconfirmed.
      void sandbox.exited.then(() => {
        this.#releasePlace();
        if (this.#sandbox !== sandbox) return;
        this.#sandbox = undefined;
        this.#clearIdle();
        log("exited", this.layout.botId);
      });
      return sandbox;
    })().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /** Gives the bot's place back, unless a leftover of it may still be running. */
  #releasePlace(): void {
    if (!this.#hasPlace || this.#launcher.leftover(this.layout, true)) return;
    this.#hasPlace = false;
    this.#running.release();
  }

  async #stop(sandbox: Sandbox): Promise<StopFailure | undefined> {
    if (this.#sandbox === sandbox) this.#sandbox = undefined;
    // What the gateway holds about this sandbox (questions, whether outside text came in) is collected before it forgets it.
    const collected = Promise.all([this.#syncAsks().catch(() => {}), this.#launcher.syncActions?.(this.layout, []).catch(() => {})]);
    this.#stopping = collected.then(() => sandbox.stop())
      .then(cause => cause || undefined)
      .catch(error => {
        log("stop_failed", this.layout.botId, { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
        return "teardown_failed" as const;
      })
      .finally(() => {
        this.#stopping = undefined;
      });
    const cause = await this.#stopping;
    log("stopped", this.layout.botId);
    return cause;
  }

  #clearIdle(): void {
    clearTimeout(this.#idle);
    this.#idle = undefined;
  }

  #armIdle(): void {
    this.#clearIdle();
    const sandbox = this.#sandbox;
    if (!sandbox || this.#busy || this.#listing > 0 || !this.#settled) return;
    this.#idle = setTimeout(() => {
      if (this.#sandbox === sandbox && !this.#busy && this.#listing === 0) void this.#stop(sandbox);
    }, this.#options.idleMs);
  }
}

export class BotManager {
  readonly #bots = new Map<string, Bot>();
  readonly #launcher: SandboxLauncher;
  readonly #roots: LayoutRoots;
  readonly #options: BotOptions;
  readonly #deletions = new Set<Promise<unknown>>();
  #closing = false;
  readonly #running: RunningLimit;

  constructor(launcher: SandboxLauncher, roots: LayoutRoots, options: BotOptions, maxRunning: number) {
    this.#launcher = launcher;
    this.#roots = roots;
    this.#options = options;
    this.#running = new RunningLimit(maxRunning);
  }

  forOwner(ownerDid: string): Bot {
    const bot = this.#bot(botIdFor(ownerDid));
    bot.knowOwner(ownerDid);
    return bot;
  }

  /** One of the owner's bots by key. The caller has already checked the key's form and that the bot is announced. */
  forBot(ownerDid: string, key: string): Bot {
    if (key === MAIN_KEY) return this.forOwner(ownerDid);
    return this.#bot(botIdFor(ownerDid, key), { botKey: key, ownerId: botIdFor(ownerDid) });
  }

  /** Deletes one bot's working state; see Bot.deleteWorkingState. stopAll waits for it to finish. */
  deleteWorkingState(botId: string, reason: string, retire = false): Promise<DeleteSkip | undefined> {
    if (this.#closing) return Promise.resolve("closing");
    const deletion = this.#bot(botId).deleteWorkingState(reason, () => this.#closing, retire);
    this.#deletions.add(deletion);
    void deletion.finally(() => this.#deletions.delete(deletion));
    return deletion;
  }

  /** Starts a new chat with the owner's Main; see Bot.newChat. stopAll waits for it to finish. */
  newChat(ownerDid: string): Promise<DeleteSkip | "busy" | undefined> {
    if (this.#closing) return Promise.resolve("closing");
    const chat = this.forOwner(ownerDid).newChat(() => this.#closing);
    this.#deletions.add(chat);
    void chat.finally(() => this.#deletions.delete(chat));
    return chat;
  }

  /**
   * Deletes the working state of a sibling the backend is deleting, and retires the bot: a request that was already
   * waiting is refused instead of starting it again. A bot that never ran has no working state.
   */
  deleteBot(ownerDid: string, key: string): Promise<DeleteSkip | undefined> {
    const bot = this.forBot(ownerDid, key);
    return this.deleteWorkingState(bot.layout.botId, "deleted", true);
  }

  /**
   * Deletes the working state of every bot directory in the data root last used more than `retentionMs` before
   * `now` and with no request in flight. Entries that are not directories named by a bot id, symlinks included,
   * are left alone; so is everything once stopAll has begun. Failures are logged per bot.
   */
  async sweepUnused(retentionMs: number, now = Date.now()): Promise<void> {
    let botIds: string[];
    try {
      // Entry types come from lstat: a symlink is never a directory here.
      botIds = readdirSync(this.#roots.dataRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && BOT_ID.test(entry.name))
        .map(entry => entry.name);
    } catch (error) {
      console.log(JSON.stringify({ bots: "sweep_failed", error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
      return;
    }
    for (const botId of botIds) {
      if (this.#closing) return;
      try {
        const bot = this.#bot(botId);
        if (bot.historyExpiryDue(now) && !bot.inUse) { await this.deleteWorkingState(botId, "permission_expired"); continue; }
        const used = lastUsed(botLayout(botId, this.#roots));
        if (used === undefined || now - used <= retentionMs || this.#bots.get(botId)?.inUse) continue;
        await this.deleteWorkingState(botId, "unused");
      } catch (error) {
        log("sweep_failed", botId, { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
      }
    }
  }

  /** Applies the clock to every bot's stored questions, so the text of expired ones and of stale replies goes even if nobody asks. */
  sweepAsks(now = Date.now()): void {
    try {
      sweepAskStores(this.#roots, () => now);
    } catch (error) {
      console.log(JSON.stringify({ bots: "asks_sweep_failed", error: error instanceof Error ? error.message.slice(0, 300) : "unknown" }));
    }
  }

  #bot(botId: string, owner?: { botKey: string; ownerId: string }): Bot {
    let bot = this.#bots.get(botId);
    if (!bot) {
      bot = new Bot(botLayout(botId, this.#roots, owner), this.#launcher, this.#options, this.#running);
      this.#bots.set(botId, bot);
    } else if (owner) {
      // A sweep finds a bot by its directory, before anyone has said whose it is.
      Object.assign(bot.layout, owner);
    }
    return bot;
  }

  /** Lets deletions in progress finish (and starts no more), then stops every sandbox. */
  async stopAll(): Promise<void> {
    this.#closing = true;
    await Promise.all(this.#deletions);
    await Promise.all([...this.#bots.values()].map(bot => bot.stop()));
  }
}
