// One bot of one owner (Main, or a sibling the backend created): at most one message at a time, its sandbox started
// on demand and stopped once the session has settled and stayed idle. Everything the sandbox says is treated as
// untrusted input; only checked fields are turned into events, which the server encodes itself.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ActivityRecord, HistoryJournal, type HistoryOptions, type StagedHistory } from "./history";
import { isRecord } from "./guards";
import { type BotLayout, botLayout, type LayoutRoots } from "./layout";
import { MESSAGING_STRINGS } from "./messaging-strings";
import { BOT_ID, botIdFor, MAIN_KEY } from "./owner";
import { type DeleteSkip, lastUsed, markUsed, removeWorkingState } from "./retention";
import { type Frame, type HostToolHandler, type HostToolReply, RpcError } from "./rpc";
import { addressesIn } from "./web";
import { readWebPolicy, type WebPolicy, writeWebPolicy } from "./web-policy";
import { type AnswerInput, type AnswerResult, type AppOrigin, AskStore, type AskReply, type AskRequest, cancelAsks, readAsksEnabled, sweepAsks as sweepAskStores, writeAsksEnabled } from "./asks";
import { type ReadArea, type ReadsSetting, writeReads } from "./reads";

export type ErrorCode = "bot_unavailable" | "model_unavailable" | "busy" | "at_capacity" | "invalid";

export const MAX_TEXT = 8000;

/** Owner-visible sentences; never provider text. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bot_unavailable: "Main isn't available. Try again later.",
  model_unavailable: "Main's model isn't answering. Try again later.",
  busy: "Main is still working on your last message. Send this one when it replies.",
  at_capacity: "Main can't start right now because TinyCloud is running as many bots as it can. Your message wasn't sent. Try again shortly.",
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
  /** Set for a message the app wrote (the owner's reply to a question from Main), not typed by the owner. */
  origin?: "app";
  /** With `origin: "app"`: what the owner decided, so the app need not read the composed text. */
  decision?: "answered" | "declined" | "stopped";
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
  launch(layout: BotLayout): Promise<Sandbox>;
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
  /** Collects the questions the box asked, then gives the gateway the owner's setting for questions and the counts; `turn` starts a turn. */
  syncAsks?(layout: BotLayout, turn?: { outside: boolean }): Promise<void>;
  /** Gives the gateway the owner's read setting and the bot's conversation id (reads.ts). */
  pushReads?(layout: BotLayout): Promise<void>;
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

  constructor(layout: BotLayout, launcher: SandboxLauncher, options: BotOptions, running: RunningLimit) {
    this.layout = layout;
    this.#launcher = launcher;
    this.#options = options;
    this.#running = running;
  }

  /** Runs one message. Reports through `sink` and always ends with exactly one done or error. */
  async send(text: string, sink: TurnSink, owner?: string, messenger?: BotMessenger, from: "owner" | "bot" | AppOrigin = "owner"): Promise<void> {
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
    if (this.#options.history) {
      this.#busy = true;
      await this.#deleting;
      if (this.#retired) { this.#busy = false; sink.error("bot_unavailable"); return; }
      try {
        this.#history ??= new HistoryJournal(this.layout, this.#options.history);
        this.#history.begin(owner ?? "", this.#options.maxTurnBytes * 16 + 128 * 1024);
        this.#history.append({ type: "user", text, at: new Date().toISOString(), ...(typeof from === "object" ? { origin: "app", decision: from.app } : {}) });
        this.#history.startDraft();
      } catch { this.#busy = false; sink.error("bot_unavailable"); return; }
    }
    const output = sink;
    sink = {
      status: state => output.status(state),
      delta: text => { this.#history?.delta(text); output.delta(text); },
      activity: record => { this.#history?.append(record); output.activity?.(record); },
      done: messageId => { this.#history?.finishDraft({ type: "done", messageId }); output.done(messageId); },
      error: code => { this.#history?.finishDraft({ type: "error", code }); output.error(code); },
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
        await this.#launcher.syncAsks?.(this.layout, { outside: from === "bot" });
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
        await this.#turn(sandbox, text, sink);
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
        await this.#turn(sandbox, text, sink, messenger);
      } finally {
        try { await sandbox.request({ type: "set_host_tools", tools: [] }, HOST_TOOLS_TIMEOUT_MS); }
        catch { if (this.#sandbox === sandbox) await this.#stop(sandbox); }
      }
    } finally {
      clearInterval(heartbeat);
      // Questions Main asked during the turn are collected now, while the gateway still holds them.
      void this.#launcher.syncAsks?.(this.layout).catch(() => {});
      if (this.#history) {
        try { this.#history.append({ type: "provenance", receipts: await this.#launcher.provenance?.(this.layout) ?? [] }); }
        catch { this.#history.append({ type: "provenance", verified: false }); }
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
      if (!this.#history.legacyPending) {
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

  /** Whether the owner lets Main ask questions. On until turned off. */
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
        await this.#launcher.syncAsks?.(this.layout).catch(() => log("asks_setting_push_failed", this.layout.botId));
        log("asks_setting", this.layout.botId, { enabled, stopped });
        return;
      }
      try {
        await this.#launcher.syncAsks?.(this.layout);
      } catch (error) {
        writeAsksEnabled(this.layout, previous);
        await this.#launcher.syncAsks?.(this.layout).catch(() => {});
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

  /** The owner's requests from Main: what the box has asked so far (collected from the gateway first), pending first. */
  async requests(): Promise<AskRequest[]> {
    await this.#deleting;
    await this.#launcher.syncAsks?.(this.layout).catch(() => {});
    return new AskStore(this.layout).list();
  }

  /** Records the owner's decision on one request. Only a pending, unexpired request can be decided. */
  async answerRequest(id: string, input: AnswerInput): Promise<AnswerResult> {
    await this.#deleting;
    const result = new AskStore(this.layout).answer(id, input);
    if (result.ok) {
      log("ask_resolved", this.layout.botId, { outcome: input.decision === "answer" ? "answered" : "declined" });
      void this.#launcher.syncAsks?.(this.layout).catch(() => {});
    }
    return result;
  }

  /**
   * The message that tells Main what the owner decided, composed here from the stored decision; undefined unless the
   * request is decided and Main has not been told. This is the only source of text for an app-originated message.
   */
  appReply(requestId: string): AskReply | undefined {
    return new AskStore(this.layout).reply(requestId);
  }

  /** Main has been told: the answer text is deleted (the metadata stays). */
  appReplyDelivered(requestId: string): void {
    new AskStore(this.layout).delivered(requestId);
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
            cause = this.#options.history && (!covered || !this.#history?.covered) && !this.#history?.expiryDue()
              ? "archive_pending" : await removeWorkingState(this.layout, this.#launcher);
          }
        }
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
  historyPermission(owner: string, expiresAt?: number, validUntil?: number) {
    // A sibling that has never run has no journal, and a change of permission must not make one (or its directory).
    return this.#historyOperation(journal => {
      if (expiresAt === undefined) { journal.begin(owner, 0); journal.permissionActive(validUntil!); }
      else journal.permissionExpired(expiresAt, owner);
    }, this.layout.botKey !== undefined);
  }
  historyStage(staged: StagedHistory) { return this.#historyOperation(journal => journal.stage(staged)); }
  historyNotice() { return this.#options.history ? this.#historyOperation(journal => journal.notice()) : Promise.resolve(undefined); }
  historyNoticeAck(id: string, receivedAt: number) { return this.#historyOperation(journal => journal.acknowledgeNotice(id, receivedAt)); }
  historyExpiryDue(now = Date.now()) { return this.#options.history ? this.#journal().expiryDue(now) : false; }
  historyPending() {
    return this.#options.history ? this.#historyOperation(journal => journal.pending()) : Promise.resolve(undefined);
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

  #turn(sandbox: Sandbox, text: string, sink: TurnSink, messenger?: BotMessenger): Promise<void> {
    const id = sandbox.nextId();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const activity = new TurnActivity();
    const reaching = new Set<string>();
    const offHost = messenger && sandbox.onHostToolCall?.(async (name, args, signal) => {
      if (name !== MESSAGE_BOT) return { text: MESSAGING_STRINGS.unavailable, isError: true };
      if (!isRecord(args) || Object.keys(args).length !== 2
        || typeof args.targetKey !== "string" || !messenger.keys.includes(args.targetKey)
        || typeof args.text !== "string" || args.text.length < 1 || args.text.length > MAX_TEXT) {
        return { text: MESSAGING_STRINGS.invalid, isError: true };
      }
      const { targetKey } = args;
      if (reaching.has(targetKey)) return { text: MESSAGING_STRINGS.busy, isError: true };
      reaching.add(targetKey);
      try {
        const reply = await messenger.dispatch(targetKey, args.text, signal);
        if (!signal.aborted && !reply.isError) {
          activity.messaged(targetKey);
          // Another bot's words are now in Main's conversation: what it asks from here on says so.
          await this.#launcher.syncAsks?.(this.layout, { outside: true }).catch(() => {});
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
        sandbox = await this.#launcher.launch(this.layout);
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
    const collected = this.#launcher.syncAsks?.(this.layout).catch(() => {});
    this.#stopping = (collected ? collected.then(() => sandbox.stop()) : sandbox.stop())
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
    return this.#bot(botIdFor(ownerDid));
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
