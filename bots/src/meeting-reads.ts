// The gateway's side of TrustBot's reads of owner data: the `app` MCP server's read tools (four meeting tools, and
// four feed and chat tools), each area's tools offered only while the owner's setting for that area is on, and the
// web pause that follows a read. Each call is signed to the backend, which checks the owner's grant to TrustBot's
// read identity again before it reads anything. The gateway holds no grant and no data.
//
// The pause: once a result from any area reaches Main's conversation, web search and page fetch are refused in that
// conversation. The mark is saved (bot id to conversation id) before the result is returned, and a result whose mark
// cannot be saved is not returned. A new conversation id from the supervisor (the conversation was cleared) ends it.
// Log lines carry the tool, the outcome and counts, never arguments or results.
// Details: TC-3792, TC-3794

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { readBody, type UpstreamFetch } from "./gateway";
import { FEED_CHAT_ERRORS, FEED_CHAT_RECORD_KIND, FEED_CHAT_TOOL_NAMES, FEED_CHAT_TOOLS, type FeedChatTool } from "./feed-chat-tools";
import { isRecord } from "./guards";
import { MEETING_TOOL_NAMES, MEETING_TOOLS, type MeetingToolName } from "./meeting-tools";
import { botIdFor, BOT_ID } from "./owner";
import type { ReadArea, ReadsPush } from "./reads";
import { signedCallHeader } from "./signed-call";
import { toolText, untrustedRecord } from "./web";

/** The daily count and the one-at-a-time rule cover every area together, so their sentences name no area. */
export const READ_LIMIT_ERRORS = {
  budget: "You've used today's reads of the owner's data. Carry on without them.",
  busy: "Another read of the owner's data is already running. Wait for its result before reading again.",
} as const;

export const READ_ERRORS = {
  off: "Reading meetings is off. The owner can turn it on in this chat under Meetings.",
  ended: "Your access to the owner's meetings has ended. They can turn it on in this chat under Meetings.",
  unavailable: "Meetings can't be read right now.",
  ...READ_LIMIT_ERRORS,
} as const;
type ReadError = "off" | "ended" | "unavailable" | "budget" | "busy" | "not_found";
export type ReadToolName = MeetingToolName | FeedChatTool;

/** Each area's tools and the fixed sentences its refusals give; an area without `not_found` says `unavailable`. */
const AREA_TOOLS: Readonly<Record<ReadArea, { tools: ReadonlyArray<{ name: string }>; errors: Record<Exclude<ReadError, "not_found">, string> & { not_found?: string } }>> = {
  meetings: { tools: MEETING_TOOLS, errors: READ_ERRORS },
  feed_chats: { tools: FEED_CHAT_TOOLS, errors: { ...FEED_CHAT_ERRORS, ...READ_LIMIT_ERRORS } },
};
const isFeedChatTool = (name: ReadToolName): name is FeedChatTool => FEED_CHAT_TOOL_NAMES.some(tool => tool === name);
const areaOf = (name: ReadToolName): ReadArea => isFeedChatTool(name) ? "feed_chats" : "meetings";

/** Reads per bot per UTC day. */
export const READS_PER_DAY = 200;
const CALL_TIMEOUT_MS = 20_000;
const AUDIT_TIMEOUT_MS = 2_000;
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
  /** Send refusals to the backend that serves the standing-read audit. Reads are always audited by the backend
   *  before they run; these reports of blocked attempts are bounded and never retried. */
  forwardRefusals?: boolean;
  store?: HeldStore;
  fetch?: UpstreamFetch;
  now?: () => number;
}

/** `unanswered`: no response, or a server error, so the backend may not have recorded the attempt. */
type Answer = { ok: true; text: string } | { ok: false; error: ReadError; unanswered?: true };
type RefusalReport = { owner: string; area: ReadArea; tool: ReadToolName; outcome: "off" | "budget" | "busy" | "unavailable" };

export class MeetingDesk {
  readonly #options: MeetingDeskOptions;
  readonly #fetch: UpstreamFetch;
  readonly #now: () => number;
  /** The supervisor's push per bot: the owner's areas and the current conversation. */
  readonly #settings = new Map<string, ReadsPush>();
  readonly #marks = new Map<string, string>();
  readonly #calling = new Set<string>();
  readonly #today = new Map<string, { day: string; count: number }>();
  readonly #auditToday = new Map<string, { day: string; count: number; capped: boolean }>();

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

  /** The tools of each area the owner's setting has on. */
  tools(botId: string): ReadonlyArray<{ name: string }> {
    return (this.#settings.get(botId)?.areas ?? []).flatMap(area => AREA_TOOLS[area].tools);
  }

  handles(name: unknown): name is ReadToolName {
    return MEETING_TOOL_NAMES.some(tool => tool === name) || FEED_CHAT_TOOL_NAMES.some(tool => tool === name);
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

  async call(botId: string, name: ReadToolName, args: Record<string, unknown>) {
    const area = areaOf(name);
    const errors = AREA_TOOLS[area].errors;
    const log = (outcome: string) => console.log(JSON.stringify({ gateway: "reads", bot: botId.slice(0, 12), tool: name, outcome }));
    const refuse = (error: ReadError, outcome: string = error) => {
      log(outcome);
      return toolText(error === "not_found" ? errors.not_found ?? errors.unavailable : errors[error], true);
    };
    const setting = this.#settings.get(botId);
    const refuseLocally = (outcome: RefusalReport["outcome"]) => {
      const secret = this.#options.backendCallSecret;
      if (this.#options.forwardRefusals && setting?.owner && secret) {
        void this.#forwardRefusal(botId, secret, { owner: setting.owner, area, tool: name, outcome });
      }
      return refuse(outcome);
    };
    if (!setting?.areas.includes(area) || !setting.owner) return refuseLocally("off");
    if (!this.#options.backendCallSecret) return refuse("unavailable", "no_secret");
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    const today = this.#today.get(botId);
    const used = today?.day === day ? today.count : 0;
    if (used >= READS_PER_DAY) return refuseLocally("budget");
    if (this.#calling.has(botId)) return refuseLocally("busy");
    this.#calling.add(botId);
    this.#today.set(botId, { day, count: used + 1 });
    try {
      const answer = await this.#ask(setting.owner, name, args);
      if (!answer.ok) return answer.unanswered ? refuseLocally("unavailable") : refuse(answer.error);
      // The conversation is marked before the result reaches it; a mark that cannot be kept withholds the result.
      if (this.#marks.get(botId) !== setting.conversation && !this.#mark(botId, setting.conversation)) return refuse("unavailable", "held_store");
      log("ok");
      return toolText(untrustedRecord(isFeedChatTool(name) ? FEED_CHAT_RECORD_KIND[name] : "meeting", answer.text));
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

  async #forwardRefusal(botId: string, secret: string, report: RefusalReport): Promise<void> {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    const previous = this.#auditToday.get(botId);
    const today = previous?.day === day ? previous : { day, count: 0, capped: false };
    if (today.count >= READS_PER_DAY) {
      if (!today.capped) {
        today.capped = true;
        console.log(JSON.stringify({ gateway: "reads", outcome: "audit_forward_capped" }));
      }
      return;
    }
    today.count++;
    this.#auditToday.set(botId, today);
    const path = `${BACKEND_PATH}audit/refusal`;
    const body = JSON.stringify(report);
    try {
      const authorization = signedCallHeader(secret, {
        direction: "to-backend", environment: "private", owner: report.owner, bot: "main", method: "POST", path, body,
      });
      const response = await this.#fetch(`${this.#options.backendOrigin}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(AUDIT_TIMEOUT_MS),
        headers: { authorization, "content-type": "application/json" }, body,
      });
      void response.body?.cancel().catch(() => {});
      if (response.status === 204) return;
    } catch {
      // The refusal is already decided. The report cannot affect its reply.
    }
    console.log(JSON.stringify({ gateway: "reads", outcome: "audit_forward_failed" }));
  }

  async #ask(owner: string, name: ReadToolName, args: Record<string, unknown>): Promise<Answer> {
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
        return { ok: false, error: "unavailable", ...(response.status >= 500 ? { unanswered: true as const } : {}) };
      }
      const bytes = await readBody(response, ANSWER_BYTES, CALL_TIMEOUT_MS);
      if (typeof bytes === "string") return { ok: false, error: "unavailable" };
      const answer: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(answer)) return { ok: false, error: "unavailable" };
      if (answer.ok === true && typeof answer.text === "string") return { ok: true, text: answer.text };
      const error = answer.error === "off" || answer.error === "ended" || answer.error === "not_found" ? answer.error : "unavailable";
      return { ok: false, error };
    } catch {
      // No usable answer arrived; the backend may never have seen the call.
      return { ok: false, error: "unavailable", unanswered: true };
    }
  }
}
