// The gateway's side of TrustBot's meeting reads: the `app` MCP server's four meeting tools, offered only while the
// owner's setting is on, and the web pause that follows a read. Each call is signed to the backend, which checks the
// owner's grant to TrustBot's read identity again before it reads anything. The gateway holds no grant and no data.
//
// The pause: once a meeting result reaches Main's conversation, web search and page fetch are refused in that
// conversation. The mark is saved (bot id to conversation id) before the result is returned, and a result whose mark
// cannot be saved is not returned. A new conversation id from the supervisor (the conversation was cleared) ends it.
// Log lines carry the tool, the outcome and counts, never arguments or results.
// Details: TC-3792

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { readBody, type UpstreamFetch } from "./gateway";
import { isRecord } from "./guards";
import { MEETING_TOOL_NAMES, MEETING_TOOLS, type MeetingToolName } from "./meeting-tools";
import { botIdFor, BOT_ID } from "./owner";
import type { ReadsPush } from "./reads";
import { signedCallHeader } from "./signed-call";
import { toolText, untrustedRecord } from "./web";

export const READ_ERRORS = {
  off: "Reading meetings is off. The owner can turn it on in this chat under Meetings.",
  ended: "Your access to the owner's meetings has ended. They can turn it on in this chat under Meetings.",
  unavailable: "Meetings can't be read right now.",
  budget: "You've read enough meetings for today. Carry on without them.",
  busy: "A meeting read is already running. Wait for its result before reading again.",
} as const;
type ReadError = keyof typeof READ_ERRORS;

/** Reads per bot per UTC day. */
export const READS_PER_DAY = 200;
const CALL_TIMEOUT_MS = 20_000;
/** The backend answers at most 16,000 characters of tool text; JSON escaping can roughly double it. */
const ANSWER_BYTES = 64 * 1024;
const BACKEND_PATH = "/api/internal/bots/main/reads/";
const CONVERSATION_ID = /^[0-9a-f]{32}$/;

/** Where the marks live: bot id to the id of the conversation that holds owner data. */
export interface HeldStore {
  load(): Record<string, string> | undefined;
  save(marks: Record<string, string>): void;
}

/** The marks beside the budget file, saved the same way: temporary file, fsync, rename, fsync of the directory. */
export function fileHeldStore(path: string): HeldStore {
  return {
    load() {
      if (!existsSync(path)) return undefined;
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        throw new Error(`held file ${path} is unreadable (${error instanceof Error ? error.message : "unknown"})`, { cause: error });
      }
      if (!isRecord(value) || !Object.entries(value).every(([bot, conversation]) => BOT_ID.test(bot) && typeof conversation === "string" && CONVERSATION_ID.test(conversation))) {
        throw new Error(`held file ${path} is malformed`);
      }
      return value as Record<string, string>;
    },
    save(marks) {
      const fresh = `${path}.new`;
      const file = openSync(fresh, "w", 0o600);
      try {
        writeSync(file, JSON.stringify(marks));
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

export interface MeetingDeskOptions {
  /** The backend's origin and the secret its calls are signed with; without a secret every read is refused. */
  backendOrigin: string;
  backendCallSecret: string | undefined;
  store?: HeldStore;
  fetch?: UpstreamFetch;
  now?: () => number;
}

type Answer = { ok: true; text: string } | { ok: false; error: ReadError };

export class MeetingDesk {
  readonly #options: MeetingDeskOptions;
  readonly #fetch: UpstreamFetch;
  readonly #now: () => number;
  /** The supervisor's push per bot: the owner's areas and the current conversation. */
  readonly #settings = new Map<string, ReadsPush>();
  readonly #marks = new Map<string, string>();
  readonly #calling = new Set<string>();
  readonly #today = new Map<string, { day: string; count: number }>();

  constructor(options: MeetingDeskOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    for (const [botId, conversation] of Object.entries(options.store?.load() ?? {})) this.#marks.set(botId, conversation);
  }

  /** The supervisor's push. Refused (false) unless the owner it names is this Main's owner. */
  push(botId: string, push: ReadsPush): boolean {
    if (push.owner !== undefined && botIdFor(push.owner) !== botId) return false;
    this.#settings.set(botId, push);
    return true;
  }

  drop(botId: string): void {
    this.#settings.delete(botId);
  }

  /** The meeting tools, while the owner's setting is on. */
  tools(botId: string): typeof MEETING_TOOLS | readonly [] {
    return this.#settings.get(botId)?.areas.includes("meetings") ? MEETING_TOOLS : [];
  }

  handles(name: unknown): name is MeetingToolName {
    return MEETING_TOOL_NAMES.some(tool => tool === name);
  }

  /**
   * Whether this bot's conversation holds owner data. With a mark but no conversation pushed since the gateway
   * started, it is held: the gateway cannot tell the conversation was cleared.
   */
  held(botId: string): boolean {
    const mark = this.#marks.get(botId);
    if (mark === undefined) return false;
    const current = this.#settings.get(botId)?.conversation;
    return current === undefined || current === mark;
  }

  async call(botId: string, name: MeetingToolName, args: Record<string, unknown>) {
    const log = (outcome: string) => console.log(JSON.stringify({ gateway: "reads", bot: botId.slice(0, 12), tool: name, outcome }));
    const refuse = (error: ReadError, outcome: string = error) => {
      log(outcome);
      return toolText(READ_ERRORS[error], true);
    };
    const setting = this.#settings.get(botId);
    if (!setting?.areas.includes("meetings") || !setting.owner) return refuse("off");
    if (!this.#options.backendCallSecret) return refuse("unavailable", "no_secret");
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    const today = this.#today.get(botId);
    const used = today?.day === day ? today.count : 0;
    if (used >= READS_PER_DAY) return refuse("budget");
    if (this.#calling.has(botId)) return refuse("busy");
    this.#calling.add(botId);
    this.#today.set(botId, { day, count: used + 1 });
    try {
      const answer = await this.#ask(setting.owner, name, args);
      if (!answer.ok) return refuse(answer.error);
      // The conversation is marked before the result reaches it; a mark that cannot be kept withholds the result.
      if (this.#marks.get(botId) !== setting.conversation && !this.#mark(botId, setting.conversation)) return refuse("unavailable", "held_store");
      log("ok");
      return toolText(untrustedRecord("meeting", answer.text));
    } finally {
      this.#calling.delete(botId);
    }
  }

  #mark(botId: string, conversation: string): boolean {
    const before = this.#marks.get(botId);
    this.#marks.set(botId, conversation);
    try {
      this.#options.store?.save(Object.fromEntries(this.#marks));
      return true;
    } catch {
      if (before === undefined) this.#marks.delete(botId);
      else this.#marks.set(botId, before);
      return false;
    }
  }

  async #ask(owner: string, name: MeetingToolName, args: Record<string, unknown>): Promise<Answer> {
    const path = `${BACKEND_PATH}${name}`;
    const body = JSON.stringify({ args });
    const authorization = signedCallHeader(this.#options.backendCallSecret!, {
      direction: "to-backend", environment: "private", owner, bot: "main", method: "POST", path, body,
    });
    try {
      const response = await this.#fetch(`${this.#options.backendOrigin}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        headers: { authorization, "content-type": "application/json" }, body,
      });
      if (response.status !== 200 && response.status !== 400) {
        void response.body?.cancel().catch(() => {});
        return { ok: false, error: "unavailable" };
      }
      const bytes = await readBody(response, ANSWER_BYTES, CALL_TIMEOUT_MS);
      if (typeof bytes === "string") return { ok: false, error: "unavailable" };
      const answer: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(answer)) return { ok: false, error: "unavailable" };
      if (answer.ok === true && typeof answer.text === "string") return { ok: true, text: answer.text };
      return { ok: false, error: answer.error === "off" || answer.error === "ended" ? answer.error : "unavailable" };
    } catch {
      return { ok: false, error: "unavailable" };
    }
  }
}
