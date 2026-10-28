// Ported from tinycloud-agents eliza-service (ed320bd) so chat reads meetings through the hosted MCP.
import { checkContext, discoverMeetings, exactMeeting, formatMeetingResult, isAccessError, metadataOutcome, readMeetingEvidence, safeMeetingRef, unattemptedOutcome, validDate } from "./evidence.js";
import type { BodyResult, DiscoveryResult, EvidenceRequest, MeetingOutcome, MeetingSelection, RetrievalContext } from "./evidence.js";

/** A tool failure with a stable code and HTTP-style status. */
export class ToolError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = "ToolError"; }
}

export const TINYCLOUD_FIND_MEETINGS = "tinycloud_find_meetings";
export const TINYCLOUD_READ_MEETING = "tinycloud_read_meeting";
export const TINYCLOUD_SEARCH_TRANSCRIPTS = "tinycloud_search_transcripts";
export const TINYCLOUD_LIST_MEETING_ACTIONS = "tinycloud_list_meeting_actions";

/** `connector_meeting.source` values the agent reads. TinyChat writes Exo Local recordings as `exo-local`, combined meetings as `exo-merged`, and voice notes as `exo-voice-note` (readable once a transcript is saved). */
export const TRANSCRIPT_SOURCES = ["fireflies", "google-meet", "tinycloud-transcriber", "exo-local", "exo-merged", "exo-voice-note"] as const;
export type TranscriptSource = typeof TRANSCRIPT_SOURCES[number];
type SortOrder = "newest" | "oldest";

export interface MeetingFilters {
  title?: string;
  participant?: string;
  from?: string;
  to?: string;
  source?: TranscriptSource;
}

export interface FindMeetingsArgs extends MeetingFilters { sort?: SortOrder; selectFirst?: boolean; limit?: number; meetingRef?: string; cursor?: number }
export interface ReadMeetingArgs {
  meetingRef?: string;
  focus: "summary" | "actions" | "decisions" | "speaker" | "transcript";
  query?: string;
  speaker?: string;
  assignee?: string;
  includeBody?: boolean;
}
export interface TranscriptSearchArgs extends MeetingFilters { query: string; speaker?: string; meetingRef?: string; sort?: SortOrder }
export interface ListMeetingActionsArgs extends MeetingFilters { assignee?: string; includeBody?: boolean; sort?: SortOrder }

function parseBoundedString(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function parseFilters(args: Record<string, unknown>): MeetingFilters | null {
  const title = parseBoundedString(args.title, 160);
  const participant = parseBoundedString(args.participant, 160);
  if (title === null || participant === null) return null;
  if (args.from !== undefined && (typeof args.from !== "string" || !validDate(args.from))) return null;
  if (args.to !== undefined && (typeof args.to !== "string" || !validDate(args.to))) return null;
  if (typeof args.from === "string" && typeof args.to === "string" && args.from > args.to) return null;
  if (args.source !== undefined && !TRANSCRIPT_SOURCES.includes(args.source as TranscriptSource)) return null;
  return {
    ...(title ? { title } : {}),
    ...(participant ? { participant } : {}),
    ...(typeof args.from === "string" ? { from: args.from } : {}),
    ...(typeof args.to === "string" ? { to: args.to } : {}),
    ...(args.source !== undefined ? { source: args.source as TranscriptSource } : {}),
  };
}

export function parseFindMeetingsArgs(args: Record<string, unknown>): FindMeetingsArgs | null {
  const allowed = new Set(["title", "participant", "from", "to", "source", "sort", "selectFirst", "limit", "meetingRef", "cursor"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const filters = parseFilters(args);
  const meetingRef = parseBoundedString(args.meetingRef, 128);
  if (!filters || meetingRef === null || (meetingRef && !safeMeetingRef(meetingRef))) return null;
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 12)) return null;
  if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || Number(args.cursor) < 0)) return null;
  if (args.sort !== undefined && args.sort !== "newest" && args.sort !== "oldest") return null;
  if (args.selectFirst !== undefined && typeof args.selectFirst !== "boolean") return null;
  return {
    ...filters,
    ...(meetingRef ? { meetingRef } : {}),
    ...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
    ...(args.cursor !== undefined ? { cursor: Number(args.cursor) } : {}),
    ...(args.sort ? { sort: args.sort as SortOrder } : {}),
    ...(typeof args.selectFirst === "boolean" ? { selectFirst: args.selectFirst } : {}),
  };
}

export function parseReadMeetingArgs(args: Record<string, unknown>): ReadMeetingArgs | null {
  const allowed = new Set(["meetingRef", "focus", "query", "speaker", "assignee", "includeBody"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const meetingRef = parseBoundedString(args.meetingRef, 128);
  const query = parseBoundedString(args.query, 500);
  const speaker = parseBoundedString(args.speaker, 160);
  const assignee = parseBoundedString(args.assignee, 160);
  if (assignee === null || (args.includeBody !== undefined && typeof args.includeBody !== "boolean")) return null;
  if (meetingRef === null || query === null || speaker === null) return null;
  if (!["summary", "actions", "decisions", "speaker", "transcript"].includes(args.focus as string)) return null;
  if (args.focus === "speaker" && !speaker) return null;
  return {
    focus: args.focus as ReadMeetingArgs["focus"],
    ...(assignee ? { assignee } : {}),
    ...(args.includeBody !== undefined ? { includeBody: args.includeBody as boolean } : {}),
    ...(meetingRef ? { meetingRef } : {}),
    ...(query ? { query } : {}),
    ...(speaker ? { speaker } : {}),
  };
}

export function parseTranscriptSearchArgs(args: Record<string, unknown>): TranscriptSearchArgs | null {
  const allowed = new Set(["query", "title", "participant", "speaker", "meetingRef", "from", "to", "source", "sort"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const filters = parseFilters(args);
  const query = parseBoundedString(args.query, 500);
  const speaker = parseBoundedString(args.speaker, 160);
  const meetingRef = parseBoundedString(args.meetingRef, 128);
  if (!filters || !query || speaker === null || meetingRef === null) return null;
  if (args.sort !== undefined && args.sort !== "newest" && args.sort !== "oldest") return null;
  return { query, ...filters, ...(args.sort ? { sort: args.sort as SortOrder } : {}), ...(speaker ? { speaker } : {}), ...(meetingRef ? { meetingRef } : {}) };
}

export function parseListMeetingActionsArgs(args: Record<string, unknown>): ListMeetingActionsArgs | null {
  const allowed = new Set(["title", "participant", "from", "to", "source", "assignee", "includeBody", "sort"]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return null;
  const filters = parseFilters(args);
  const assignee = parseBoundedString(args.assignee, 160);
  if (!filters || assignee === null || (args.includeBody !== undefined && typeof args.includeBody !== "boolean")) return null;
  if (args.sort !== undefined && args.sort !== "newest" && args.sort !== "oldest") return null;
  return { ...filters, ...(args.sort ? { sort: args.sort as SortOrder } : {}), ...(assignee ? { assignee } : {}), ...(args.includeBody !== undefined ? { includeBody: args.includeBody as boolean } : {}) };
}

export const TINYCLOUD_CONNECTORS_SQL_PATH = "xyz.tinycloud.tinychat/connectors";
export const TINYCLOUD_CONNECTORS_KV_PREFIX = `${TINYCLOUD_CONNECTORS_SQL_PATH}/`;
export interface TranscriptMetadata {
  meetingRef: string;
  source: TranscriptSource;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  participantNames: string[];
  participantEmails: string[];
  organizerEmail: string | null;
  summaryOverview: string | null;
  summaryActionItems: string | null;
  metadata?: Record<string, unknown>;
  metadataLimited?: boolean;
  /** True when the list view caps a display field; `getMetadata` returns uncapped titles and summaries. */
  listingTruncated?: boolean;
}

export interface TranscriptReader {
  listMetadata(): Promise<TranscriptMetadata[]>;
  getMetadata?(meetingRef: string, context?: RetrievalContext): Promise<TranscriptMetadata | null>;
  discoverMetadata?(args: FindMeetingsArgs, context?: RetrievalContext): Promise<DiscoveryResult>;
  readBody?(source: TranscriptSource, sourceId: string, context?: RetrievalContext): Promise<BodyResult>;
  assertAccess?(): void;
  getTranscript(source: TranscriptSource, sourceId: string): Promise<unknown | null>;
}

export interface TranscriptRegistry {
  readerFor(entityId: string, roomId?: string): TranscriptReader;
  selectedMeetingFor(entityId: string, roomId?: string): string | null;
  setSelection?(entityId: string, roomId: string | undefined, selection: MeetingSelection): void;
  selectMeeting(entityId: string, roomId: string | undefined, meetingRef: string): void;
}


export async function findMeetings(reader: TranscriptReader, args: FindMeetingsArgs, timeZone?: string, context: RetrievalContext = {}) {
  if (args.meetingRef) {
    const row = await exactMeeting(reader, args.meetingRef, context);
    if (!row) throw new ToolError("meeting not found", 404, "meeting_not_found");
    return formatMeetingResult("find", [metadataOutcome(row)], { matchedCount: 1, countKind: "exact", returnedCount: 1, scanLimited: false, excludedUndatedCount: 0, orderProven: true, interval: {}, observedAt: new Date().toISOString(), omittedMeetingRefs: [] });
  }
  const result = await discoverMeetings(reader, args, { ...context, timeZone });
  return formatMeetingResult("find", result.rows.map(metadataOutcome), result.discovery);
}
export async function readMeeting(reader: TranscriptReader, args: ReadMeetingArgs & { meetingRef: string }, context: RetrievalContext = {}) {
  return formatMeetingResult("read", [await readMeetingEvidence(reader, args.meetingRef, args, context)]);
}
async function aggregate(reader: TranscriptReader, args: MeetingFilters & { meetingRef?: string; sort?: SortOrder }, request: EvidenceRequest, operation: "search" | "actions", context: RetrievalContext) {
  if (args.meetingRef) return formatMeetingResult(operation, [await readMeetingEvidence(reader, args.meetingRef, request, context)]);
  const discovered = await discoverMeetings(reader, { ...args, limit: 12 }, context);
  const rows = discovered.rows.filter((row, index, all) => all.findIndex(other => other.source === row.source && other.meetingRef === row.meetingRef) === index);
  const outcomes: MeetingOutcome[] = rows.map(row => unattemptedOutcome(row, request, "budget"));
  const siblings = new AbortController();
  const childContext = { ...context, signal: context.signal ? AbortSignal.any([context.signal, siblings.signal]) : siblings.signal };
  let cursor = 0; let accessFailure: unknown;
  await Promise.all(Array.from({ length: Math.min(3, rows.length) }, async () => {
    while (cursor < rows.length && !accessFailure) {
      if (context.signal?.aborted || (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt)) break;
      const index = cursor++; const row = rows[index]!;
      try { outcomes[index] = await readMeetingEvidence(reader, row.meetingRef, request, childContext, row); }
      catch (error) {
        if (isAccessError(error)) { accessFailure = error; siblings.abort(); break; }
        if (accessFailure) break;
        if ((error as { code?: string }).code === "retrieval_cancelled") throw error;
        outcomes[index] = unattemptedOutcome(row, request, (error as { code?: string }).code === "retrieval_timeout" ? "budget" : "metadata_unavailable");
        if (outcomes[index]!.coverage.omissionReasons[0] !== "budget") outcomes[index]!.state = "unavailable";
      }
    }
  }));
  if (accessFailure) throw accessFailure;
  if (context.signal?.aborted) checkContext(context);
  reader.assertAccess?.();
  // Older clients retain their four-match display bound. Outcomes explicitly record what was omitted.
  if (operation === "search" && context.retrievalMode === undefined) {
    let matches = 0;
    for (const outcome of outcomes) if (outcome.coverage.support !== "none" && ++matches > 4) {
      outcome.coverage.omittedEvidenceCount += outcome.evidence.length; outcome.evidence = [];
      outcome.coverage.evidenceRetained = 0; outcome.coverage.support = "none"; outcome.coverage.omissionReasons.push("legacy_match_limit"); outcome.search.retainedMatches = 0;
    }
  }
  return formatMeetingResult(operation, outcomes, discovered.discovery);
}
export async function searchTranscripts(reader: TranscriptReader, args: TranscriptSearchArgs, timeZone?: string, context: RetrievalContext = {}) {
  return aggregate(reader, args, { focus: "topic", query: args.query, speaker: args.speaker }, "search", { ...context, timeZone });
}
export async function listMeetingActions(reader: TranscriptReader, args: ListMeetingActionsArgs, timeZone?: string, context: RetrievalContext = {}) {
  return aggregate(reader, args, { focus: "actions", assignee: args.assignee, includeBody: args.includeBody }, "actions", { ...context, timeZone });
}