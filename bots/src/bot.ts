// One owner's Main bot: at most one message at a time, its sandbox started on demand and stopped once the
// session has settled and stayed idle. Everything the sandbox says is treated as untrusted input; only checked
// fields are turned into events, which the server encodes itself.

import { readdirSync } from "node:fs";
import { HistoryJournal, type HistoryOptions, type StagedHistory } from "./history";
import { isRecord } from "./guards";
import { type BotLayout, botLayout, type LayoutRoots } from "./layout";
import { BOT_ID, botIdFor } from "./owner";
import { type DeleteSkip, lastUsed, markUsed, removeWorkingState } from "./retention";
import { type Frame, RpcError } from "./rpc";

export type ErrorCode = "bot_unavailable" | "model_unavailable" | "busy" | "invalid";

export const MAX_TEXT = 8000;

/** Owner-visible sentences; never provider text. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bot_unavailable: "Main isn't available. Try again later.",
  model_unavailable: "Main's model isn't answering. Try again later.",
  busy: "Main is still working on your last message. Send this one when it replies.",
  invalid: "Messages can be up to 8,000 characters.",
};

export interface TurnSink {
  status(state: "starting" | "working"): void;
  delta(text: string): void;
  done(messageId: string): void;
  error(code: ErrorCode): void;
}

export interface ListedMessage {
  id: string;
  role: "user" | "bot";
  text: string;
  at: string;
}

/** A running sandbox with OMP's RPC channel on its stdio, already bound to the bot's session. */
export interface Sandbox {
  nextId(): string;
  request(command: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  onFrame(listener: (frame: Frame) => void): () => void;
  /** Settles once the sandbox has exited and been cleaned up. */
  readonly exited: Promise<void>;
  /** Registers the bot's egress socket and token with the gateway again (idempotent; the gateway may have restarted). */
  refreshEgress(): Promise<void>;
  /** Saves the bot's state to disk while the sandbox is paused. Never rejects; a failure keeps the previous copy. */
  snapshot(): Promise<void>;
  stop(): Promise<void>;
}

export interface SandboxLauncher {
  /** Whether the bot has ever run, i.e. has a session to list. */
  hasState(layout: BotLayout): boolean;
  /** Unconfirmed sandbox or copier teardown; sandboxOnly counts just sandboxes for running slots. */
  leftover(layout: BotLayout, sandboxOnly?: boolean): boolean;
  launch(layout: BotLayout): Promise<Sandbox>;
  /** Every mount point the supervisor sees (decoded from /proc/self/mountinfo). */
  mountPoints?(): string[];
  provenance?(layout: BotLayout): Promise<unknown>;
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

  release(): void {
    this.#running--;
  }
}

const LIST_LIMIT = 50;
const PAGE_LIMIT = 256;
const MAX_PAGES = 64;

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
  #stopping: Promise<void> | undefined;
  #deleting: Promise<void> | undefined;
  #busy = false;
  #listing = 0;
  #settled = true;
  #idle: Timer | undefined;
  /** This bot holds one BOTS_MAX_RUNNING place: for its sandbox, or for a leftover whose end is unconfirmed. */
  #hasPlace = false;

  constructor(layout: BotLayout, launcher: SandboxLauncher, options: BotOptions, running: RunningLimit) {
    this.layout = layout;
    this.#launcher = launcher;
    this.#options = options;
    this.#running = running;
  }

  /** Runs one message through Main. Reports through `sink` and always ends with exactly one done or error. */
  async send(text: string, sink: TurnSink, owner?: string): Promise<void> {
    if (this.#busy) {
      sink.error("busy");
      return;
    }
    if (this.#options.history) {
      try {
        this.#history ??= new HistoryJournal(this.layout, this.#options.history);
        this.#history.begin(owner ?? "", this.#options.maxTurnBytes * 8 + 128 * 1024);
        this.#history.append({ type: "user", text, at: new Date().toISOString() });
        this.#history.startDraft();
      } catch { sink.error("bot_unavailable"); return; }
    }
    const output = sink;
    sink = {
      status: state => output.status(state),
      delta: text => { this.#history?.delta(text); output.delta(text); },
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
      } catch (error) {
        log("start_failed", this.layout.botId, { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
        sink.error("bot_unavailable");
        return;
      }
      if (state === "starting") {
        state = "working";
        sink.status(state);
      }
      await this.#turn(sandbox, text, sink);
    } finally {
      clearInterval(heartbeat);
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
      this.#history ??= new HistoryJournal(this.layout, this.#options.history);
      if (!this.#history.legacyPending) return this.#history.messages();
    }
    this.#listing++;
    this.#clearIdle();
    try {
      // A bot whose working state is being deleted lists nothing once that is done.
      await this.#deleting;
      if (!this.#sandbox && !this.#launcher.hasState(this.layout)) return [];
      const sandbox = await this.#ensure();
      this.#markUsed();
      return listedMessages(await readMessages(sandbox));
    } finally {
      this.#listing--;
      this.#armIdle();
    }
  }

  /** A message or history request is in flight, including one still starting the sandbox. */
  get inUse(): boolean {
    return this.#busy || this.#listing > 0;
  }

  /** Stops the sandbox if one is running or starting. False if its teardown failed (logged as stop_failed). */
  async stop(): Promise<boolean> {
    this.#clearIdle();
    const sandbox = this.#sandbox ?? (await this.#starting?.catch(() => undefined));
    const stopped = sandbox ? await this.#stop(sandbox) : true;
    await this.#stopping;
    return stopped;
  }

  /**
   * The one way a bot's working state is deleted: stops its sandbox, then removes its data directory (state snapshot
   * and last-use marker) and its run directory. A failed teardown, a path that is not the bot's own directory, a
   * mount at or under either directory keeps everything and logs
   * state_delete_skipped instead. A request that arrives meanwhile waits for this, then starts a fresh bot.
   */
  deleteWorkingState(reason: string, closing = () => false): Promise<void> {
    this.#deleting ??= (async () => {
      let cause: DeleteSkip | undefined;
      try {
        const stopped = await this.stop();
        if (!stopped || this.#launcher.leftover(this.layout)) cause = "teardown_failed";
        else {
          const covered = await this.historyCovered();
          // Signature checks await: closing or a newly appended message can change eligibility meanwhile.
          cause = closing() ? "closing" : this.#options.history && (!covered || !this.#history?.covered) && !this.#history?.expiryDue() ? "archive_pending"
            : await removeWorkingState(this.layout, this.#launcher);
        }
      } catch {
        cause = "error";
      }
      if (cause) log("state_delete_skipped", this.layout.botId, { reason, cause });
      else { this.#history = undefined; log("state_deleted", this.layout.botId, { reason }); }
    })().finally(() => {
      this.#deleting = undefined;
    });
    return this.#deleting;
  }

  #journal() {
    if (!this.#options.history) throw new Error("history_disabled");
    return this.#history ??= new HistoryJournal(this.layout, this.#options.history);
  }
  historyPermission(owner: string, expiresAt?: number, validUntil?: number) {
    if (expiresAt === undefined) { this.#journal().begin(owner, 0); this.#journal().permissionActive(validUntil!); }
    else this.#journal().permissionExpired(expiresAt, owner);
  }
  historyStage(staged: StagedHistory) { this.#journal().stage(staged); }
  historyNotice() { return this.#options.history ? this.#journal().notice() : undefined; }
  historyNoticeAck(id: string, renderedAt: number, deleteAt: number) { this.#journal().acknowledgeNotice(id, renderedAt, deleteAt); }
  historyExpiryDue(now = Date.now()) { return this.#options.history ? this.#journal().expiryDue(now) : false; }
  historyPending() {
    if (!this.#options.history) return undefined;
    this.#history ??= new HistoryJournal(this.layout, this.#options.history);
    return this.#history.pending();
  }
  async historyReceipt(receipt: unknown) {
    if (!this.#options.history) throw new Error("history_disabled");
    this.#history ??= new HistoryJournal(this.layout, this.#options.history);
    await this.#history.accept(receipt);
  }
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

  #turn(sandbox: Sandbox, text: string, sink: TurnSink): Promise<void> {
    const id = sandbox.nextId();
    const { promise, resolve } = Promise.withResolvers<void>();
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
      if ("messageId" in outcome) sink.done(outcome.messageId);
      else sink.error(outcome.code);
      resolve();
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
      // At the cap a start is refused, never squeezed into memory the running bots may need. A leftover's place
      // passes to the next start, which first ends the leftover.
      if (!this.#hasPlace) {
        if (!this.#running.take()) throw new Error("BOTS_MAX_RUNNING sandboxes already running");
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

  async #stop(sandbox: Sandbox): Promise<boolean> {
    if (this.#sandbox === sandbox) this.#sandbox = undefined;
    let stopped = true;
    this.#stopping = sandbox
      .stop()
      .catch(error => {
        stopped = false;
        log("stop_failed", this.layout.botId, { error: error instanceof Error ? error.message.slice(0, 300) : "unknown" });
      })
      .finally(() => {
        this.#stopping = undefined;
      });
    await this.#stopping;
    log("stopped", this.layout.botId);
    return stopped;
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
  readonly #deletions = new Set<Promise<void>>();
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

  /** Deletes one bot's working state; see Bot.deleteWorkingState. stopAll waits for it to finish. */
  deleteWorkingState(botId: string, reason: string): Promise<void> {
    if (this.#closing) return Promise.resolve();
    const deletion = this.#bot(botId).deleteWorkingState(reason, () => this.#closing);
    this.#deletions.add(deletion);
    void deletion.finally(() => this.#deletions.delete(deletion));
    return deletion;
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

  #bot(botId: string): Bot {
    let bot = this.#bots.get(botId);
    if (!bot) {
      bot = new Bot(botLayout(botId, this.#roots), this.#launcher, this.#options, this.#running);
      this.#bots.set(botId, bot);
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
