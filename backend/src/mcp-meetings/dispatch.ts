/**
 * Executes Exo's four meeting tools over the hosted MCP, read-only, and returns the same
 * `{ status, body }` shape eliza-service's `POST /tools/:name` returned, so the chat loop is unchanged.
 * Logic ported from eliza-service actions/tinycloud-search-transcripts.ts (ed320bd).
 */
import { checkContext, isAccessError, MeetingRetrievalError, safeMeetingRef, withinContext } from "./evidence.js";
import type { MeetingSelection, RetrievalContext } from "./evidence.js";
import { createReader } from "./reader.js";
import type { McpMeetingPort } from "./port.js";
import {
  findMeetings, listMeetingActions, parseFindMeetingsArgs, parseListMeetingActionsArgs, parseReadMeetingArgs,
  parseTranscriptSearchArgs, readMeeting, searchTranscripts, ToolError,
  TINYCLOUD_FIND_MEETINGS, TINYCLOUD_LIST_MEETING_ACTIONS, TINYCLOUD_READ_MEETING, TINYCLOUD_SEARCH_TRANSCRIPTS,
} from "./tools.js";
import type { FindMeetingsArgs, ListMeetingActionsArgs, MeetingFilters, ReadMeetingArgs, TranscriptSearchArgs } from "./tools.js";

type Operation = "find" | "read" | "search" | "actions";
const OPERATIONS: Record<string, Operation> = {
  [TINYCLOUD_FIND_MEETINGS]: "find", [TINYCLOUD_READ_MEETING]: "read",
  [TINYCLOUD_SEARCH_TRANSCRIPTS]: "search", [TINYCLOUD_LIST_MEETING_ACTIONS]: "actions",
};
/** Whole tool response bound (JSON chars), as in eliza-service handlers/tools.ts. */
const TOOL_RESPONSE_CHAR_LIMIT = 16_000;
const TOOL_DEADLINE_MS = 10_000;
const MAX_SELECTIONS = 1_000;

export interface McpToolRequest {
  name: string;
  args: Record<string, unknown>;
  /** Owner identity from the authenticated session (never the request body). */
  owner: string;
  roomId?: string;
  context?: RetrievalContext;
  signal?: AbortSignal;
}
export interface McpToolResponse { status: number; body: Record<string, unknown> }

export interface McpMeetingTools {
  isMeetingTool(name: string): boolean;
  run(request: McpToolRequest): Promise<McpToolResponse>;
}

/** `portFor` builds the read-only port for one owner on every call; nothing about the grant is retained here. */
export function createMcpMeetingTools(portFor: (owner: string) => McpMeetingPort): McpMeetingTools {
  // Content-free follow-up state (a meeting reference or scope state per owner and room); bounded, never holds text.
  const selections = new Map<string, MeetingSelection>();
  const keyOf = (owner: string, roomId?: string) => `${owner.toLowerCase()}\u0000${roomId ?? ""}`;
  const setSelection = (owner: string, roomId: string | undefined, selection: MeetingSelection) => {
    if (!roomId) return;
    const key = keyOf(owner, roomId);
    if (selection.state === "none") { selections.delete(key); return; }
    selections.delete(key);
    selections.set(key, selection);
    if (selections.size > MAX_SELECTIONS) selections.delete(selections.keys().next().value as string);
  };
  const selectedFor = (owner: string, roomId?: string): string | null => {
    if (!roomId) return null;
    const selection = selections.get(keyOf(owner, roomId));
    return selection?.state === "single" ? selection.meetingRef : null;
  };

  function scopeReference(request: McpToolRequest, args: MeetingFilters & { meetingRef?: string; selectFirst?: boolean; sort?: "newest" | "oldest" }, context: RetrievalContext, operation: Operation): string | undefined {
    const { retrievalMode: mode } = context;
    const filters = [args.title, args.participant, args.from, args.to, args.source].some(value => value !== undefined);
    if (mode === "selected" && (args.meetingRef !== undefined || filters || args.selectFirst !== undefined || args.sort !== undefined)) throw new ToolError("selected scope conflicts", 400, "invalid_scope");
    if (args.meetingRef && filters) throw new ToolError("exact scope conflicts", 400, "invalid_scope");
    if (mode && args.meetingRef && !safeMeetingRef(args.meetingRef)) throw new ToolError("invalid reference", 400, "invalid_args");
    if (mode === "single" && (operation === "read" || operation === "search") && !args.meetingRef) throw new ToolError("exact reference required", 400, "invalid_scope");
    if (mode === "range" && operation === "read" && !args.meetingRef) throw new ToolError("exact reference required", 400, "invalid_scope");
    if (mode && mode !== "range" && operation === "actions") throw new ToolError("action aggregation requires range scope", 400, "invalid_scope");
    if (mode === "range") setSelection(request.owner, request.roomId, { state: "range" });
    else if (mode === "single") setSelection(request.owner, request.roomId, { state: "none" });
    if (mode === "selected" || (mode === undefined && operation === "read" && (!args.meetingRef || /^\[?M\d+\]?$/i.test(args.meetingRef)))) {
      const reference = selectedFor(request.owner, request.roomId);
      if (!reference) throw new ToolError("select a meeting first", 409, "meeting_selection_required");
      return reference;
    }
    return args.meetingRef;
  }

  function retrievalContext(raw: RetrievalContext | undefined, signal?: AbortSignal): RetrievalContext {
    const context: RetrievalContext = { ...raw, signal };
    if (context.retrievalMode !== undefined && !["selected", "single", "range"].includes(context.retrievalMode)) throw new ToolError("invalid retrieval mode", 400, "invalid_args");
    if (context.timeZone !== undefined) {
      if (typeof context.timeZone !== "string") throw new ToolError("invalid time zone", 400, "invalid_args");
      try { new Intl.DateTimeFormat("en", { timeZone: context.timeZone }); } catch { throw new ToolError("invalid time zone", 400, "invalid_args"); }
    }
    if (context.deadlineAt !== undefined && (typeof context.deadlineAt !== "number" || !Number.isFinite(context.deadlineAt))) throw new ToolError("invalid deadline", 400, "invalid_args");
    context.deadlineAt = Math.min(context.deadlineAt ?? Infinity, Date.now() + TOOL_DEADLINE_MS);
    checkContext(context);
    return context;
  }

  async function execute(request: McpToolRequest): Promise<McpToolResponse> {
    const operation = OPERATIONS[request.name.toLowerCase()];
    if (!operation) return { status: 404, body: { error: "tool_not_found", tool: request.name } };
    const parse = operation === "find" ? parseFindMeetingsArgs : operation === "read" ? parseReadMeetingArgs
      : operation === "search" ? parseTranscriptSearchArgs : parseListMeetingActionsArgs;
    const args = parse(request.args);
    if (!args) throw new ToolError("invalid meeting arguments", 400, "invalid_args");
    const context = retrievalContext(request.context, request.signal);
    const reader = createReader(portFor(request.owner));
    const reference = scopeReference(request, args, context, operation);
    try {
      const result = await withinContext(async () => operation === "find"
        ? findMeetings(reader, { ...args as FindMeetingsArgs, ...(reference ? { meetingRef: reference } : {}) }, context.timeZone, context)
        : operation === "read"
          ? reference ? readMeeting(reader, { ...args as ReadMeetingArgs, meetingRef: reference }, context)
            : Promise.reject(new ToolError("select a meeting first", 409, "meeting_selection_required"))
          : operation === "search"
            ? searchTranscripts(reader, { ...args as TranscriptSearchArgs, ...(reference ? { meetingRef: reference } : {}) }, context.timeZone, context)
            : listMeetingActions(reader, args as ListMeetingActionsArgs, context.timeZone, context), context);
      const first = result.data.outcomes[0]; const discovery = result.data.discovery;
      if (context.retrievalMode === "single" && first) {
        const proven = reference || (discovery?.countKind === "exact" && discovery.matchedCount === 1) || ((args as FindMeetingsArgs).selectFirst && discovery?.orderProven);
        setSelection(request.owner, request.roomId, proven ? { state: "single", meetingRef: first.meetingRef } : { state: "ambiguous" });
      } else if (context.retrievalMode === undefined && first && (operation === "read"
        || (operation === "find" && (discovery?.matchedCount === 1 || (args as FindMeetingsArgs).selectFirst))
        || (operation === "search" && result.data.matches.length === 1))) {
        setSelection(request.owner, request.roomId, { state: "single", meetingRef: operation === "search" ? result.data.matches[0]!.meetingRef : first.meetingRef });
      }
      const body = { ok: true, tool: request.name, result: { text: result.text, data: result.data ?? null, frames: [{ text: result.text }] } };
      if (JSON.stringify(body).length > TOOL_RESPONSE_CHAR_LIMIT) throw new MeetingRetrievalError("meeting_result_size_limit", 413);
      return { status: 200, body };
    } catch (error) {
      if (isAccessError(error) || (error as { code?: string }).code === "meeting_not_found") setSelection(request.owner, request.roomId, { state: "none" });
      throw error;
    }
  }

  return {
    isMeetingTool: name => Object.prototype.hasOwnProperty.call(OPERATIONS, name.toLowerCase()),
    async run(request) {
      try {
        return await execute(request);
      } catch (error) {
        if (error instanceof ToolError) return { status: error.status, body: { error: error.code } };
        if (error instanceof MeetingRetrievalError) return { status: error.status, body: { error: error.code } };
        return { status: 502, body: { error: "tool_failed" } };
      }
    },
  };
}
