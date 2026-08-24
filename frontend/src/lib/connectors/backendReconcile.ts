// W6 — BROWSER RECONCILE: the user-space copy of a backend-ingested meeting
// (backend-ingest plan §8.1 W6; §8.2 delta 6's user-space half).
//
// WHAT THIS IS FOR. Under the dark backend-ingest cohort the backend fetches and
// stores the meeting itself, so it is visible on any signed-in device through
// W5's read API — vault or no vault. That server copy is the goal, but it is not
// the user's own archive: everything the app has always done with a meeting
// (Option-C parity, offline, the user's own space as the system of record) reads
// from `${APP_ID}/connectors/…`. This module closes that gap. When a session with
// an UNLOCKED vault happens to be open, it pulls the rows the server says are
// unreconciled and copies them into the user's own space.
//
// KV ONLY — the standing rule. Plan §7: "any user-space connector write (the W6
// reconcile) is `tcw.kv` — KV, never SQL/DuckDB". So this module holds no SQL
// handle and writes exactly two kinds of key, both built by `connectorStore` so
// they land inside the granted `${APP_ID}/connectors/` prefix:
//
//     `${APP_ID}/connectors/{source}/meeting/{sourceId}`     the record
//     `${APP_ID}/connectors/{source}/transcript/{sourceId}`  the body (Option C's shape)
//
// STORAGE BEFORE ACK — carried verbatim from `targetedSync`. `reconciledAt` is
// stamped through W5's ack ONLY after the user-space write RESOLVED ok. Acking
// first would let a failed write drop a meeting out of the server's discovery
// filter with nothing left to retry it. The inverse — written, ack lost — is the
// safe direction and the one this design accepts: the next run re-writes the same
// keys (an overwrite, not a duplicate) and re-acks.
//
// THE SERVER COPY IS RETAINED (D2a `retain`). Reconcile is a COPY, never a move:
// nothing here deletes a server row or shortens its retention, because a second
// device that has not reconciled still has to be able to read the meeting.
//
// NO PROMPTS, NO LOGS, FAIL CLOSED. A locked vault is a reported no-op, never an
// unlock dialog. Nothing is logged — a meeting id is an identifier and the
// content is the user's own words. And every failure is stated: an unreadable
// list is a FAILURE, never "there was nothing to reconcile".
//
// SEQUENTIAL EVERYWHERE. TinyCloud drops concurrent responses on one space, so
// meetings are processed one at a time and the two KV writes for a meeting are
// awaited in order — never `Promise.all`.

import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { isSecretsUnlocked } from "./connectorSecrets";
import { meetingKvKey, transcriptKvKey } from "./connectorStore";
import type {
  ConnectorMeetingContent,
  ConnectorMeetingList,
  ConnectorMeetingMeta,
  ConnectorMeetingReconciled,
  ConnectorMeetingsResult,
} from "./meetingsApi";
import { DEFAULT_MEETINGS_SOURCE, type LocalMeetingRef } from "./meetingsView";

/** One page of the discovery filter. Whole pages are cheap — the list is metadata. */
export const RECONCILE_PAGE_SIZE = 50;

/**
 * How many meetings ONE run copies. A first sign-in on a cohort account can face
 * a whole archive, and a browser tab is not the place to serialize 500 transcript
 * bodies; the run stops here and says so (`truncated`), and the next visit — or an
 * explicit re-run — continues from the same filter. Never a silent cap.
 */
export const RECONCILE_MAX_PER_RUN = 100;

/** Why a run did nothing. All three are DEFINED product states, not errors. */
export type BackendReconcileBlocked =
  /** The browser vault is locked. A user-initiated unlock is the only way in. */
  | "vault-locked"
  /** 404 on the list: the flag is dark, or this address is not in the cohort. */
  | "feature-dark"
  /** No session, or it expired mid-run. */
  | "signed-out";

export interface BackendReconcileFailure {
  sourceId: string;
  /** Where it broke: reading the server copy, or writing the user's own space. */
  stage: "read" | "storage";
  /** A short reason. Never content, never a credential, never a stack. */
  detail: string;
}

export interface BackendReconcileOutcome {
  /** Unreconciled rows this run looked at. */
  scanned: number;
  /** Meetings written into the user's own space. */
  written: number;
  /** Written AND stamped — the only meetings the server will stop offering. */
  reconciled: number;
  /**
   * Written, but the ack did not land. The meeting is safe; the stamp is not, so
   * the server still lists it and the next run settles it idempotently.
   */
  unacknowledged: string[];
  /** Listed, then gone by the time we read it (retention or a purge). Not a failure. */
  vanished: number;
  /** Per-meeting failures. Each stays unreconciled server-side for a later retry. */
  failures: BackendReconcileFailure[];
  /** True when the run stopped on {@link RECONCILE_MAX_PER_RUN} with rows still queued. */
  truncated: boolean;
  blocked: BackendReconcileBlocked | null;
  /** What this space now holds — feed straight into `applyLocalMeetings`. */
  local: LocalMeetingRef[];
}

export interface BackendReconcileError {
  kind: "api" | "storage";
  message: string;
}

export type BackendReconcileResult =
  | { ok: true; data: BackendReconcileOutcome }
  | { ok: false; error: BackendReconcileError };

/**
 * The slice of W5's client this engine uses. `list` MUST support the `reconciled`
 * filter: plan §5.3 makes reconcile discovery a read-API list filter, and a run
 * that filtered client-side would re-page the whole archive every time.
 */
export interface BackendReconcileMeetingsClient {
  list(options?: {
    source?: string;
    limit?: number;
    cursor?: string;
    reconciled?: boolean;
  }): Promise<ConnectorMeetingsResult<ConnectorMeetingList>>;
  read(
    source: string,
    sourceId: string,
  ): Promise<ConnectorMeetingsResult<ConnectorMeetingContent>>;
  markReconciled(
    source: string,
    sourceId: string,
  ): Promise<ConnectorMeetingsResult<ConnectorMeetingReconciled>>;
}

/** Structural surface of `connectorSecrets`. Deliberately has NO `unlock`: this
 *  engine cannot pop a prompt even by accident. */
export interface BackendReconcileSecrets {
  isUnlocked(tcw: TinyCloudWeb): boolean;
}

export interface ReconcileBackendMeetingsOptions {
  tcw: TinyCloudWeb;
  meetings: BackendReconcileMeetingsClient;
  source?: string;
  secrets?: BackendReconcileSecrets;
  /** Bound for one run. Defaults to {@link RECONCILE_MAX_PER_RUN}. */
  maxMeetings?: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** Injectable clock — the copy stamp in the user-space record. */
  now?: () => string;
}

const defaultSecrets: BackendReconcileSecrets = { isUnlocked: isSecretsUnlocked };

/** The user-space record's schema version — a later reader must be able to tell. */
export const USER_SPACE_MEETING_VERSION = 1;

/**
 * The V1 record reconciliation writes to the source-scoped meeting KV key.
 *
 * This deliberately describes the serialized contract exactly: transcript
 * sentences live at their own KV key, while the optional summary remains the
 * opaque server payload it was when reconciliation first shipped.
 */
export interface ReconciledMeetingKvRecordV1 {
  v: typeof USER_SPACE_MEETING_VERSION;
  source: string;
  sourceId: string;
  title: string | null;
  startedAt: string | null;
  hasTranscript: boolean;
  hasSummary: boolean;
  summary?: unknown;
  storedAt: string;
  updatedAt: string;
  copiedAt: string;
  origin: "backend-ingest";
}

function errorDetail(error: unknown): string {
  if (error === null || error === undefined) return "unknown";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    const message = typeof e.message === "string" ? e.message : "";
    const joined = [code, message].filter((part) => part.length > 0).join(": ");
    if (joined.length > 0) return joined;
  }
  return "unknown";
}

/**
 * Option C stores the transcript body as the provider's `sentences` array, and
 * this copy keeps that shape so the user's space stays ONE archive rather than
 * two dialects. An unrecognized payload yields `null` — the record is still
 * written, the body key is simply left alone rather than overwritten with junk.
 */
function transcriptSentences(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload.length > 0 ? payload : null;
  if (typeof payload !== "object" || payload === null) return null;
  const sentences = (payload as Record<string, unknown>).sentences;
  if (Array.isArray(sentences) && sentences.length > 0) return sentences;
  return null;
}

function localRef(source: string, meta: ConnectorMeetingMeta): LocalMeetingRef {
  return {
    source,
    sourceId: meta.sourceId,
    title: meta.title ?? null,
    startedAt: meta.ts ?? null,
  };
}

/**
 * Copy every unreconciled server-held meeting into the user's own space, then
 * stamp each one — in that order, one meeting at a time.
 *
 * Returns `{ ok: false }` only for failures the caller cannot act on item-by-item
 * (an unreadable discovery list). Everything else is reported inside the outcome:
 * per-meeting failures, unacked writes, and the three blocked states.
 */
export async function reconcileBackendMeetings(
  opts: ReconcileBackendMeetingsOptions,
): Promise<BackendReconcileResult> {
  const { tcw, meetings } = opts;
  const source = opts.source ?? DEFAULT_MEETINGS_SOURCE;
  const secrets = opts.secrets ?? defaultSecrets;
  const pageSize = opts.pageSize ?? RECONCILE_PAGE_SIZE;
  const maxMeetings = opts.maxMeetings ?? RECONCILE_MAX_PER_RUN;
  const now = opts.now ?? (() => new Date().toISOString());

  const outcome: BackendReconcileOutcome = {
    scanned: 0,
    written: 0,
    reconciled: 0,
    unacknowledged: [],
    vanished: 0,
    failures: [],
    truncated: false,
    blocked: null,
    local: [],
  };

  // The vault gate comes FIRST, before any request: a locked session must cost
  // nothing and must not look like activity. `isUnlocked` is a read, never a prompt.
  if (!secrets.isUnlocked(tcw)) {
    return { ok: true, data: { ...outcome, blocked: "vault-locked" } };
  }

  let cursor: string | undefined;

  // ── Page the discovery filter, sequentially ────────────────────────
  for (;;) {
    if (opts.signal?.aborted) {
      outcome.truncated = true;
      break;
    }

    const list = await meetings.list({
      source,
      limit: pageSize,
      reconciled: false,
      ...(cursor === undefined ? {} : { cursor }),
    });

    if (list.status !== "ok") {
      if (list.status === "feature-dark") {
        // Not in the cohort (or the flag is dark): there is nothing to reconcile,
        // and that is a state, not an error.
        return { ok: true, data: { ...outcome, blocked: "feature-dark" } };
      }
      if (list.status === "unauthenticated") {
        return { ok: true, data: { ...outcome, blocked: "signed-out" } };
      }
      // FAIL CLOSED: an unreadable list is never "nothing to reconcile" — reporting
      // it as success would make a broken run indistinguishable from a clean one.
      return {
        ok: false,
        error: { kind: "api", message: `meetings.list: ${list.status}` },
      };
    }

    for (const meta of list.value.meetings) {
      if (opts.signal?.aborted) {
        outcome.truncated = true;
        break;
      }
      if (outcome.scanned >= maxMeetings) {
        outcome.truncated = true;
        break;
      }
      outcome.scanned += 1;

      const step = await copyOne(tcw, meetings, source, meta, now, outcome);
      if (step === "signed-out") {
        return { ok: true, data: { ...outcome, blocked: "signed-out" } };
      }
    }

    if (outcome.truncated) break;
    const next = list.value.hasMore ? list.value.nextCursor : null;
    if (next === null) break;
    cursor = next;
  }

  return { ok: true, data: outcome };
}

/**
 * One meeting: read the server copy, write the user's space, then ack. Mutates
 * `outcome` in place and reports only the one condition the caller must react to
 * — a session that went away mid-run.
 */
async function copyOne(
  tcw: TinyCloudWeb,
  meetings: BackendReconcileMeetingsClient,
  source: string,
  meta: ConnectorMeetingMeta,
  now: () => string,
  outcome: BackendReconcileOutcome,
): Promise<"done" | "signed-out"> {
  const sourceId = meta.sourceId;

  const read = await meetings.read(source, sourceId);
  if (read.status !== "ok") {
    if (read.status === "unauthenticated") return "signed-out";
    if (read.status === "not-found") {
      // Retention swept it, or a purge removed it, between the list and this read.
      // There is nothing to copy and nothing to stamp — and the run continues.
      outcome.vanished += 1;
      return "done";
    }
    outcome.failures.push({ sourceId, stage: "read", detail: read.status });
    return "done";
  }

  const content = read.value.content;
  // The read's metadata is the fresher of the two, but the route OMITS absent fields
  // rather than sending nulls, so folding it over the list row keeps whatever the
  // list knew (a title, a provider timestamp) instead of dropping it.
  const serverMeta: ConnectorMeetingMeta = { ...meta, ...read.value.meta };

  // Body first, record second: the record is what a reader discovers, so it must
  // never point at a transcript key that is not there yet.
  const sentences = transcriptSentences(content.transcript);
  if (sentences !== null) {
    const body = await tcw.kv.put(
      transcriptKvKey(source, sourceId),
      JSON.stringify(sentences),
    );
    if (!body.ok) {
      // The write did not happen, so NOTHING is acked: the server keeps this row
      // in the discovery filter and the next run retries it.
      outcome.failures.push({
        sourceId,
        stage: "storage",
        detail: errorDetail((body as { error?: unknown }).error),
      });
      return "done";
    }
  }

  const record: ReconciledMeetingKvRecordV1 = {
    v: USER_SPACE_MEETING_VERSION,
    source,
    sourceId,
    title: serverMeta.title ?? null,
    startedAt: serverMeta.ts ?? null,
    hasTranscript: sentences !== null,
    hasSummary: content.summary !== undefined,
    ...(content.summary === undefined ? {} : { summary: content.summary }),
    storedAt: serverMeta.storedAt,
    updatedAt: serverMeta.updatedAt,
    copiedAt: now(),
    // How it got here, so a later reader can tell an Option-C sync from a reconcile.
    origin: "backend-ingest" as const,
  };

  const written = await tcw.kv.put(
    meetingKvKey(source, sourceId),
    JSON.stringify(record),
  );
  if (!written.ok) {
    outcome.failures.push({
      sourceId,
      stage: "storage",
      detail: errorDetail((written as { error?: unknown }).error),
    });
    return "done";
  }
  outcome.written += 1;
  outcome.local.push(localRef(source, serverMeta));

  // ── Only now: the stamp ────────────────────────────────────────────
  const ack = await meetings.markReconciled(source, sourceId);
  if (ack.status === "ok") {
    outcome.reconciled += 1;
    return "done";
  }
  if (ack.status === "unauthenticated") {
    outcome.unacknowledged.push(sourceId);
    return "signed-out";
  }
  // Stored, not settled. Safe, and idempotently retried on the next run.
  outcome.unacknowledged.push(sourceId);
  return "done";
}
