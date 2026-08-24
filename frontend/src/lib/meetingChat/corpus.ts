/**
 * Metadata-only meeting corpus discovery.
 *
 * This module intentionally has no evidence reads. In particular, SQL discovery
 * does not load summary text, transcript bodies, or the connector metadata
 * payload: those remain unavailable until a meeting has been selected.
 */

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_KV_PREFIX, CONNECTORS_SQL_DB_NAME } from "../connectors/connectorStore";
import type {
  ConnectorMeetingList,
  ConnectorMeetingMeta,
  ConnectorMeetingsClient,
  ConnectorMeetingsResult,
} from "../connectors/meetingsApi";
import { DEFAULT_MEETINGS_SOURCE } from "../connectors/meetingsView";
import type { MeetingCandidate, MeetingCorpus, MeetingLaneHealth, MeetingRef } from "./types";

/** The deliberately small MVP source allowlist, shared by SQL and KV discovery. */
export const SUPPORTED_MEETING_SOURCES = ["fireflies", "google-meet", "tinycloud-transcriber"] as const;

function isSupportedMeetingSource(source: string): boolean {
  return (SUPPORTED_MEETING_SOURCES as readonly string[]).includes(source);
}

/** The server list's documented maximum page size. */
export const SERVER_DISCOVERY_PAGE_SIZE = 200;
/** The server keeps at most this many meetings for one user. */
export const SERVER_DISCOVERY_MAX_MEETINGS = 500;
/** SQL has the same bounded inspection policy, plus one overflow sentinel row. */
export const SQL_DISCOVERY_MAX_MEETINGS = 500;

/**
 * The sole SQL discovery read. The summary columns appear only inside an
 * availability expression; their values are never returned to the browser
 * corpus. `metadata` is deliberately absent because it is provider payload.
 */
export const SQL_MEETING_METADATA_QUERY = `SELECT
  id,
  source,
  source_id,
  title,
  started_at,
  organizer_email,
  participants,
  CASE WHEN summary_overview IS NOT NULL OR summary_action_items IS NOT NULL THEN 1 ELSE 0 END AS has_sql_summary,
  created_at,
  updated_at
FROM connector_meeting
WHERE source IN ('fireflies', 'google-meet', 'tinycloud-transcriber')
ORDER BY started_at DESC, id ASC
LIMIT ${SQL_DISCOVERY_MAX_MEETINGS + 1}`;

/** The SQL lane alone, before server/KV discovery and exact-identity merging. */
export interface SqlMeetingDiscovery {
  candidates: readonly MeetingCandidate[];
  lane: MeetingLaneHealth;
}

/** The server lane alone, before SQL/KV discovery and exact-identity merging. */
export interface ServerMeetingDiscovery {
  candidates: readonly MeetingCandidate[];
  lane: MeetingLaneHealth;
}

/** The KV lane alone, before SQL/server discovery and exact-identity merging. */
export interface KvMeetingDiscovery {
  candidates: readonly MeetingCandidate[];
  lane: MeetingLaneHealth;
}

/** The three metadata lanes that make up one content-free meeting corpus. */
export interface MeetingCorpusDiscoveries {
  sql: SqlMeetingDiscovery;
  server: ServerMeetingDiscovery;
  kv: KvMeetingDiscovery;
}

type DiscoveryLane = keyof MeetingCorpusDiscoveries;

interface CandidateFragment {
  lane: DiscoveryLane;
  candidate: MeetingCandidate;
}

const DISCOVERY_LANE_ORDER: Readonly<Record<DiscoveryLane, number>> = {
  // SQL carries the richest browser-local metadata. Server metadata is next;
  // prefix-only KV identities deliberately contribute no descriptive fields.
  sql: 0,
  server: 1,
  kv: 2,
};

interface SqlError {
  code?: unknown;
  message?: unknown;
}

interface SqlQueryResult {
  ok: boolean;
  data?: { rows?: unknown };
  error?: SqlError;
}

interface ParsedParticipants {
  names: string[];
  emails: string[];
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parseParticipants(value: unknown): ParsedParticipants | null {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(decoded)) return null;

  const names: string[] = [];
  const emails: string[] = [];
  for (const participant of decoded) {
    if (typeof participant !== "object" || participant === null) return null;
    const record = participant as { name?: unknown; email?: unknown };
    if (typeof record.name !== "string" || record.name.length === 0) return null;
    if (record.email !== null && typeof record.email !== "string") return null;
    names.push(record.name);
    if (typeof record.email === "string" && record.email.length > 0) {
      emails.push(record.email);
    }
  }
  return { names, emails };
}

function parseAvailability(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 0) return false;
  if (value === 1) return true;
  return null;
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : typeof value === "string" ? value : null;
}

function firstStableString(
  fragments: readonly CandidateFragment[],
  value: (candidate: MeetingCandidate) => string | null,
): string | null {
  const matches = fragments
    .map((fragment) => ({ ...fragment, value: value(fragment.candidate) }))
    .filter((fragment): fragment is CandidateFragment & { value: string } => fragment.value !== null)
    .sort((a, b) => (
      DISCOVERY_LANE_ORDER[a.lane] - DISCOVERY_LANE_ORDER[b.lane]
      || a.value.localeCompare(b.value)
    ));
  return matches[0]?.value ?? null;
}

function stableStringSet(
  fragments: readonly CandidateFragment[],
  value: (candidate: MeetingCandidate) => readonly string[],
): string[] {
  return [...new Set(fragments.flatMap((fragment) => value(fragment.candidate)))].sort((a, b) => a.localeCompare(b));
}

function corpusIsPartial(lanes: MeetingCorpusDiscoveries): boolean {
  // A feature-dark server endpoint is intentionally non-participating for a
  // user. Keep it in lane diagnostics, but do not turn an otherwise complete
  // local corpus into a failed aggregate.
  return Object.values(lanes).some(({ lane }) => (
    lane.state !== "healthy" && lane.state !== "unused" && lane.state !== "feature-dark"
  ));
}

function canonicalLaneFragment(fragments: readonly CandidateFragment[], lane: DiscoveryLane): CandidateFragment | null {
  const laneFragments = fragments.filter((fragment) => fragment.lane === lane);
  if (laneFragments.length === 0) return null;
  // SQL evidence availability and its row locator are one atomic fragment.
  // Prefer a readable-summary fragment deterministically, never independently
  // merge a flag from one duplicate row with a locator from another.
  return [...laneFragments].sort((left, right) => (
    Number(right.candidate.hasSqlSummary) - Number(left.candidate.hasSqlSummary)
    || (left.candidate.localRowId ?? "").localeCompare(right.candidate.localRowId ?? "")
    || (left.candidate.updatedAt ?? "").localeCompare(right.candidate.updatedAt ?? "")
    || (left.candidate.title ?? "").localeCompare(right.candidate.title ?? "")
  ))[0];
}

/**
 * Merge discovery lanes by the complete meeting identity only. In particular,
 * title, date, participant, and provider-adjacent values are never lookup
 * keys: similarly named meetings must remain separate candidates.
 *
 * The result is stable regardless of page or lane candidate ordering. KV-only
 * identities stay opaque because their prefix discovery contributed no body
 * data to reconcile.
 */
export function mergeMeetingCorpus(discoveries: MeetingCorpusDiscoveries): MeetingCorpus {
  const bySource = new Map<string, Map<string, CandidateFragment[]>>();

  for (const lane of ["sql", "server", "kv"] as const) {
    for (const candidate of discoveries[lane].candidates) {
      let bySourceId = bySource.get(candidate.source);
      if (bySourceId === undefined) {
        bySourceId = new Map();
        bySource.set(candidate.source, bySourceId);
      }
      const fragments = bySourceId.get(candidate.sourceId) ?? [];
      fragments.push({ lane, candidate });
      bySourceId.set(candidate.sourceId, fragments);
    }
  }

  const candidates: MeetingCandidate[] = [];
  for (const [source, bySourceId] of bySource) {
    for (const [sourceId, fragments] of bySourceId) {
      const canonicalFragments = (["sql", "server", "kv"] as const)
        .map((lane) => canonicalLaneFragment(fragments, lane))
        .filter((fragment): fragment is CandidateFragment => fragment !== null);
      const sql = canonicalLaneFragment(fragments, "sql")?.candidate;
      candidates.push({
        source,
        sourceId,
        title: firstStableString(canonicalFragments, (candidate) => candidate.title),
        startedAt: firstStableString(canonicalFragments, (candidate) => candidate.startedAt),
        participantNames: stableStringSet(canonicalFragments, (candidate) => candidate.participantNames),
        participantEmails: stableStringSet(canonicalFragments, (candidate) => candidate.participantEmails),
        organizerEmail: firstStableString(canonicalFragments, (candidate) => candidate.organizerEmail),
        // Availability is monotonic across exact-identity fragments.  The
        // canonical lane fragment remains important for a paired SQL row
        // locator, but one duplicate observation must never hide another
        // readable representation of the same exact meeting.
        hasSqlSummary: sql?.hasSqlSummary ?? false,
        hasLocalRecord: fragments.some(({ candidate }) => candidate.hasLocalRecord),
        hasLocalTranscript: fragments.some(({ candidate }) => candidate.hasLocalTranscript),
        hasServerSummary: fragments.some(({ candidate }) => candidate.hasServerSummary),
        hasServerTranscript: fragments.some(({ candidate }) => candidate.hasServerTranscript),
        localRowId: sql?.localRowId ?? null,
        createdAt: firstStableString(canonicalFragments, (candidate) => candidate.createdAt),
        updatedAt: firstStableString(canonicalFragments, (candidate) => candidate.updatedAt),
      });
    }
  }

  candidates.sort((a, b) => a.source.localeCompare(b.source) || a.sourceId.localeCompare(b.sourceId));
  return {
    candidates,
    lanes: {
      sql: discoveries.sql.lane,
      server: discoveries.server.lane,
      kv: discoveries.kv.lane,
    },
    partial: corpusIsPartial(discoveries),
  };
}

/**
 * Build one metadata-only corpus. The lanes intentionally run one after
 * another: all three use the same browser-side storage/session resources, and
 * discovery must not introduce concurrent storage work before selection.
 */
export async function discoverMeetingCorpus(
  tcw: Pick<TinyCloudWeb, "kv" | "sql">,
  meetings: Pick<ConnectorMeetingsClient, "list">,
  source: string = DEFAULT_MEETINGS_SOURCE,
  signal?: AbortSignal,
  selected?: MeetingRef | null,
): Promise<MeetingCorpus> {
  const sql = await discoverSqlMeetings(tcw, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const server = await discoverServerMeetings(meetings, source, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  // SQL is the authoritative metadata lane for every connector.  Walk each
  // discovered source's local identities so transcript-only Google Meet and
  // Transcriber records can merge by their exact identity before selection.
  const sources = [...new Set([source, ...sql.candidates.map((candidate) => candidate.source), selected?.source])]
    .filter((value): value is string => typeof value === "string")
    .filter(isSupportedMeetingSource);
  const kvDiscoveries: KvMeetingDiscovery[] = [];
  for (const kvSource of sources) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    kvDiscoveries.push(await discoverKvMeetings(tcw, kvSource, signal));
  }
  const kv: KvMeetingDiscovery = {
    candidates: kvDiscoveries.flatMap((discovery) => discovery.candidates),
    lane: combineKvLanes(kvDiscoveries.map((discovery) => discovery.lane)),
  };
  return mergeMeetingCorpus({ sql, server, kv });
}

function combineKvLanes(lanes: readonly MeetingLaneHealth[]): MeetingLaneHealth {
  const failed = lanes.find((lane) => lane.state === "failed");
  if (failed) return failed;
  const partial = lanes.reduce((total, lane) => total + (lane.state === "partial" ? lane.malformedRows : 0), 0);
  return partial > 0 ? { state: "partial", malformedRows: partial } : { state: "healthy" };
}

function opaqueKvCandidate(source: string, sourceId: string): MeetingCandidate {
  return {
    source,
    sourceId,
    // A reconciled KV key is an identity and availability signal, not a
    // metadata read. KV-only entries must therefore remain intentionally
    // opaque until a selected-evidence read in a later retrieval stage.
    title: null,
    startedAt: null,
    participantNames: [],
    participantEmails: [],
    organizerEmail: null,
    hasSqlSummary: false,
    hasLocalRecord: false,
    hasLocalTranscript: false,
    hasServerSummary: false,
    hasServerTranscript: false,
    localRowId: null,
    createdAt: null,
    updatedAt: null,
  };
}

function kvFailureLane(error: unknown): MeetingLaneHealth {
  // `ok: false` is a storage response (including authorization); a rejected
  // list call is handled separately as transport. Neither is an empty prefix.
  void error;
  return { state: "failed", reason: "storage" };
}

/**
 * List one source-scoped KV prefix serially. This deliberately consumes only
 * keys and cursors: calling kv.get here would turn metadata discovery into an
 * unbounded evidence read.
 */
async function listKvKeys(
  tcw: Pick<TinyCloudWeb, "kv">,
  path: string,
  signal?: AbortSignal,
): Promise<{ ok: true; keys: string[]; malformed: number } | { ok: false; lane: MeetingLaneHealth }> {
  const keys: string[] = [];
  let malformed = 0;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();

  while (true) {
    let page: Awaited<ReturnType<typeof tcw.kv.list>>;
    try {
      page = await tcw.kv.list({ path, ...(cursor === undefined ? {} : { cursor }), signal });
    } catch {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return { ok: false, lane: { state: "failed", reason: "transport" } };
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!page || page.ok !== true) return { ok: false, lane: kvFailureLane(page?.error) };
    if (!Array.isArray(page.data?.keys)) return { ok: false, lane: { state: "failed", reason: "malformed-response" } };

    for (const key of page.data.keys) {
      if (typeof key !== "string") malformed += 1;
      else keys.push(key);
    }

    const nextCursor = (page.data as { cursor?: unknown }).cursor;
    if (nextCursor === undefined || nextCursor === null) return { ok: true, keys, malformed };
    if (typeof nextCursor !== "string" || nextCursor.length === 0 || seenCursors.has(nextCursor)) {
      return { ok: false, lane: { state: "failed", reason: "malformed-response" } };
    }
    // A cursor without listed keys cannot make progress. Treat it as an
    // invalid envelope rather than looping forever or calling the prefix empty.
    if (page.data.keys.length === 0) return { ok: false, lane: { state: "failed", reason: "malformed-response" } };
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

function collectKvIdentities(
  keys: readonly string[],
  prefix: string,
  source: string,
  availability: "record" | "transcript",
  candidates: Map<string, MeetingCandidate>,
): number {
  let malformed = 0;
  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      malformed += 1;
      continue;
    }
    const sourceId = key.slice(prefix.length);
    if (sourceId.length === 0) {
      malformed += 1;
      continue;
    }
    const identity = `${source}\u0000${sourceId}`;
    const existing = candidates.get(identity) ?? opaqueKvCandidate(source, sourceId);
    const candidate: MeetingCandidate = {
      ...existing,
      hasLocalRecord: availability === "record" || existing.hasLocalRecord,
      hasLocalTranscript: availability === "transcript" || existing.hasLocalTranscript,
    };
    candidates.set(identity, candidate);
  }
  return malformed;
}

/**
 * Discover local reconciled identities without opening a meeting or transcript
 * value. The two prefix walks are intentionally awaited in order; TinyCloud
 * storage calls must not overlap.
 */
export async function discoverKvMeetings(
  tcw: Pick<TinyCloudWeb, "kv">,
  source: string = DEFAULT_MEETINGS_SOURCE,
  signal?: AbortSignal,
): Promise<KvMeetingDiscovery> {
  const meetingPrefix = `${CONNECTORS_KV_PREFIX}/${source}/meeting/`;
  const transcriptPrefix = `${CONNECTORS_KV_PREFIX}/${source}/transcript/`;
  const meetings = await listKvKeys(tcw, meetingPrefix, signal);
  if (!meetings.ok) return { candidates: [], lane: meetings.lane };
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const transcripts = await listKvKeys(tcw, transcriptPrefix, signal);
  if (!transcripts.ok) return { candidates: [], lane: transcripts.lane };

  const candidates = new Map<string, MeetingCandidate>();
  let malformedRows = meetings.malformed + transcripts.malformed;
  malformedRows += collectKvIdentities(meetings.keys, meetingPrefix, source, "record", candidates);
  malformedRows += collectKvIdentities(transcripts.keys, transcriptPrefix, source, "transcript", candidates);

  return {
    candidates: [...candidates.values()].sort((a, b) => (
      a.source.localeCompare(b.source) || a.sourceId.localeCompare(b.sourceId)
    )),
    lane: malformedRows === 0 ? { state: "healthy" } : { state: "partial", malformedRows },
  };
}

/**
 * A list response is untrusted at runtime, even though the browser client has
 * a TypeScript type. Read only its metadata fields and reject a malformed row
 * before it can influence a candidate.
 */
function parseServerMeetingMeta(source: string, value: unknown): MeetingCandidate | null {
  if (typeof value !== "object" || value === null) return null;
  const meta = value as Partial<ConnectorMeetingMeta>;
  if (
    typeof meta.sourceId !== "string"
    || meta.sourceId.length === 0
    || (meta.title !== undefined && typeof meta.title !== "string")
    || (meta.ts !== undefined && typeof meta.ts !== "string")
    || (meta.participantNames !== undefined && !isBoundedStringArray(meta.participantNames, false))
    || (meta.participantEmails !== undefined && !isBoundedStringArray(meta.participantEmails, true))
    || (meta.organizerEmail !== undefined && !isBoundedEmail(meta.organizerEmail))
    || typeof meta.storedAt !== "string"
    || typeof meta.updatedAt !== "string"
    || typeof meta.hasTranscript !== "boolean"
    || typeof meta.hasSummary !== "boolean"
  ) {
    return null;
  }

  return {
    source,
    sourceId: meta.sourceId,
    title: optionalString(meta.title),
    startedAt: optionalString(meta.ts),
    participantNames: meta.participantNames === undefined ? [] : [...meta.participantNames],
    participantEmails: meta.participantEmails === undefined ? [] : meta.participantEmails.map((email) => email.toLocaleLowerCase()),
    organizerEmail: meta.organizerEmail?.toLocaleLowerCase() ?? null,
    hasSqlSummary: false,
    hasLocalRecord: false,
    hasLocalTranscript: false,
    hasServerSummary: meta.hasSummary,
    hasServerTranscript: meta.hasTranscript,
    localRowId: null,
    createdAt: meta.storedAt,
    updatedAt: meta.updatedAt,
  };
}

function isBoundedEmail(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isBoundedStringArray(value: unknown, emails: boolean): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every((item) =>
    typeof item === "string" && item.length > 0 && item.length <= 256 && (!emails || isBoundedEmail(item)),
  );
}

function serverFailureLane(
  result: Exclude<ConnectorMeetingsResult<ConnectorMeetingList>, { status: "ok" }>,
): MeetingLaneHealth {
  switch (result.status) {
    case "feature-dark":
      return { state: "feature-dark" };
    case "unauthenticated":
      return { state: "signed-out" };
    case "offline":
      return { state: "offline" };
    case "retryable":
      return { state: "retryable", httpStatus: result.httpStatus };
    case "rejected":
      return { state: "rejected", httpStatus: result.httpStatus };
    // `list` never intentionally returns not-found, but keep an unexpected
    // client implementation distinct from an empty server archive.
    case "not-found":
      return { state: "rejected", httpStatus: null };
  }
}

function isServerList(value: unknown, source: string): value is ConnectorMeetingList {
  if (typeof value !== "object" || value === null) return false;
  const page = value as Partial<ConnectorMeetingList>;
  return page.source === source
    && Array.isArray(page.meetings)
    && typeof page.hasMore === "boolean"
    && (page.nextCursor === null || typeof page.nextCursor === "string");
}

/**
 * Page the Fireflies cohort's metadata-only server list. Pages deliberately
 * remain serial: browser connector requests share one authenticated client,
 * and discovery must never race cursors or read a meeting body.
 */
export async function discoverServerMeetings(
  meetings: Pick<ConnectorMeetingsClient, "list">,
  source: string = DEFAULT_MEETINGS_SOURCE,
  signal?: AbortSignal,
): Promise<ServerMeetingDiscovery> {
  const candidates: MeetingCandidate[] = [];
  let cursor: string | undefined;
  let malformedRows = 0;
  let inspectedRows = 0;
  let truncated = false;
  const seenCursors = new Set<string>();

  while (inspectedRows < SERVER_DISCOVERY_MAX_MEETINGS) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result = await meetings.list({
      source,
      limit: SERVER_DISCOVERY_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
      signal,
    });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    if (result.status !== "ok") {
      return { candidates, lane: serverFailureLane(result) };
    }
    if (!isServerList(result.value, source)) {
      return {
        candidates,
        lane: { state: "failed", reason: "malformed-response" },
      };
    }

    const pageRows = result.value.meetings;
    if (result.value.hasMore && pageRows.length === 0) {
      return { candidates, lane: { state: "failed", reason: "malformed-response" } };
    }
    const acceptedBeforePage = candidates.length;
    // A terminal response can still violate the 500-row inspection contract.
    // Receipt, rather than `hasMore`, establishes that rows were omitted.
    if (pageRows.length > SERVER_DISCOVERY_MAX_MEETINGS - inspectedRows) truncated = true;
    for (const meta of pageRows) {
      if (inspectedRows >= SERVER_DISCOVERY_MAX_MEETINGS) break;
      inspectedRows += 1;
      const candidate = parseServerMeetingMeta(source, meta);
      if (candidate === null) {
        malformedRows += 1;
        continue;
      }
      candidates.push(candidate);
    }

    if (!result.value.hasMore) break;
    if (inspectedRows >= SERVER_DISCOVERY_MAX_MEETINGS) {
      truncated = true;
      break;
    }
    if (candidates.length === acceptedBeforePage) {
      return { candidates, lane: { state: "failed", reason: "malformed-response" } };
    }
    if (result.value.nextCursor === null || result.value.nextCursor.length === 0) {
      return {
        candidates,
        lane: { state: "failed", reason: "malformed-response" },
      };
    }
    if (seenCursors.has(result.value.nextCursor)) {
      return { candidates, lane: { state: "failed", reason: "malformed-response" } };
    }
    seenCursors.add(result.value.nextCursor);
    cursor = result.value.nextCursor;
  }

  return {
    candidates,
    lane: malformedRows === 0 && !truncated
      ? { state: "healthy" }
      : { state: "partial", malformedRows, ...(truncated ? { truncated: true } : {}) },
  };
}

/** Positional TinyCloud SQL rows are validated before any metadata is exposed. */
function parseSqlMeetingRow(row: unknown): MeetingCandidate | null {
  if (!Array.isArray(row) || row.length < 10) return null;
  const id = nullableString(row[0]);
  const source = nullableString(row[1]);
  const sourceId = nullableString(row[2]);
  const title = nullableString(row[3]);
  const startedAt = nullableString(row[4]);
  const organizerEmail = nullableString(row[5]);
  const participants = parseParticipants(row[6]);
  const hasSqlSummary = parseAvailability(row[7]);
  const createdAt = nullableString(row[8]);
  const updatedAt = nullableString(row[9]);

  if (
    id === undefined
    || id === null
    || id.length === 0
    || source === undefined
    || source === null
    || source.length === 0
    || sourceId === undefined
    || sourceId === null
    || sourceId.length === 0
    || title === undefined
    || startedAt === undefined
    || organizerEmail === undefined
    || participants === null
    || hasSqlSummary === null
    || createdAt === undefined
    || updatedAt === undefined
    || !isSupportedMeetingSource(source)
  ) {
    return null;
  }

  return {
    source,
    sourceId,
    title,
    startedAt,
    participantNames: participants.names,
    participantEmails: participants.emails,
    organizerEmail,
    hasSqlSummary,
    hasLocalRecord: false,
    hasLocalTranscript: false,
    hasServerSummary: false,
    hasServerTranscript: false,
    localRowId: id,
    createdAt,
    updatedAt,
  };
}

function isMissingConnectorMeetingTable(error: SqlError | undefined): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  return /no such table\s*:\s*connector_meeting/i.test(message);
}

/**
 * Discover local SQL metadata with exactly one read-only query.
 *
 * A missing table means that this connector lane has never been used. Other
 * result errors are failures, not an empty archive; an SDK rejection is kept
 * separate as a transport failure.
 */
export async function discoverSqlMeetings(
  tcw: Pick<TinyCloudWeb, "sql">,
  signal?: AbortSignal,
): Promise<SqlMeetingDiscovery> {
  let result: SqlQueryResult;
  try {
    result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(SQL_MEETING_METADATA_QUERY, [], { signal }) as SqlQueryResult;
  } catch {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return { candidates: [], lane: { state: "failed", reason: "transport" } };
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  if (!result || result.ok !== true) {
    if (isMissingConnectorMeetingTable(result?.error)) {
      return { candidates: [], lane: { state: "unused", reason: "missing-table" } };
    }
    return { candidates: [], lane: { state: "failed", reason: "storage" } };
  }

  const rows = result.data?.rows;
  if (!Array.isArray(rows)) {
    return { candidates: [], lane: { state: "failed", reason: "malformed-response" } };
  }

  const truncated = rows.length > SQL_DISCOVERY_MAX_MEETINGS;
  const candidates: MeetingCandidate[] = [];
  let malformedRows = 0;
  for (const row of rows.slice(0, SQL_DISCOVERY_MAX_MEETINGS)) {
    const candidate = parseSqlMeetingRow(row);
    if (candidate === null) {
      malformedRows += 1;
      continue;
    }
    candidates.push(candidate);
  }

  return {
    candidates,
    lane: malformedRows === 0 && !truncated
      ? { state: "healthy" }
      : { state: "partial", malformedRows, ...(truncated ? { truncated: true } : {}) },
  };
}
