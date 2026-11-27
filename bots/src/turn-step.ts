// What a bot is doing during a turn, for the app's working line (TC-4382): one id of a fixed set per tool the agent
// starts and, for a page read, the site's host. Nothing else of a tool call leaves the supervisor: no arguments and
// no output. `thinking` says the agent is between tools and writing nothing.
import { isRecord } from "./guards";
import type { Frame } from "./rpc";

export const TURN_STEP_IDS = [
  "thinking", "search", "read_page", "commands", "files", "request", "secret", "meetings", "feed", "chats", "telegram", "bot_message", "tool",
] as const;
export type TurnStepId = (typeof TURN_STEP_IDS)[number];

export interface TurnStep {
  step: TurnStepId;
  /** Only with `read_page`: the host of the page, lower case, with no port. */
  host?: string;
}

/** The tool names OMP reports (its own tools, `mcp__<server>_<tool>` for the gateway's, the host tool as named). A name not listed is `tool`. */
const STEP_OF_TOOL: Readonly<Record<string, TurnStepId>> = {
  bash: "commands",
  read: "files", write: "files", edit: "files", glob: "files", grep: "files",
  mcp__web_search: "search",
  mcp__web_fetch: "read_page",
  mcp__app_ask_owner: "request", mcp__app_request_secret: "request", mcp__app_propose_action: "request",
  mcp__app_list_secrets: "secret", mcp__app_call_with_secret: "secret",
  mcp__app_tinycloud_find_meetings: "meetings", mcp__app_tinycloud_read_meeting: "meetings",
  mcp__app_tinycloud_search_transcripts: "meetings", mcp__app_tinycloud_list_meeting_actions: "meetings",
  mcp__app_list_feed_cards: "feed", mcp__app_read_card: "feed",
  mcp__app_list_chats: "chats", mcp__app_read_chat: "chats",
  mcp__app_list_telegram_chats: "telegram", mcp__app_read_telegram_chat: "telegram",
  message_bot: "bot_message",
};

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const MAX_ADDRESS = 2048;
/** Tool calls followed at once; a turn that opens more is not followed past this many. */
const MAX_OPEN_CALLS = 64;

/** The host of an http(s) address with no userinfo: lower case, no port, no path. Any doubt gives none. */
function pageHost(address: unknown): string | undefined {
  if (typeof address !== "string" || address.length > MAX_ADDRESS) return undefined;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
  const host = url.hostname.toLowerCase();
  return HOST.test(host) ? host : undefined;
}

/** The step a tool call is. Of `args` only a page read's address is looked at, and only its host is kept. */
export function stepOfTool(toolName: unknown, args: unknown): TurnStep {
  const step = typeof toolName === "string" && Object.hasOwn(STEP_OF_TOOL, toolName) ? STEP_OF_TOOL[toolName]! : "tool";
  if (step !== "read_page") return { step };
  const host = pageHost(isRecord(args) ? args.url : undefined);
  return host ? { step, host } : { step };
}

/** Follows one turn's frames and reports each change of step once. */
export class TurnSteps {
  readonly #emit: (step: TurnStep) => void;
  readonly #open = new Set<string>();
  #last = "";

  constructor(emit: (step: TurnStep) => void) {
    this.#emit = emit;
  }

  /** A tool call started or ended. With none left open the agent is thinking. */
  tool(frame: Frame): void {
    const id = frame.toolCallId;
    if (typeof id !== "string" || id.length < 1 || id.length > 256) return;
    if (frame.type === "tool_execution_start") {
      if (this.#open.size >= MAX_OPEN_CALLS) return;
      this.#open.add(id);
      this.#say(stepOfTool(frame.toolName, frame.args));
    } else if (this.#open.delete(id) && this.#open.size === 0) {
      this.#say({ step: "thinking" });
    }
  }

  /** The agent finished a message: until a tool starts or text arrives it is thinking. */
  messageEnded(): void {
    if (this.#open.size === 0) this.#say({ step: "thinking" });
  }

  /** Reply text arrived: the app shows that by itself, so the next step is said even when it repeats the last one. */
  wrote(): void {
    this.#last = "";
  }

  #say(step: TurnStep): void {
    const key = `${step.step} ${step.host ?? ""}`;
    if (key === this.#last) return;
    this.#last = key;
    this.#emit(step);
  }
}
