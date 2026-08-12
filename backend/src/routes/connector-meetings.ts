import { Router } from "express";
import type { Request, Response } from "express";

import type { ContentMeta, StoredMeeting } from "../services/content-store.js";
import type { IngestModeLookup } from "../services/ingest-mode.js";
import {
  isValidMeetingId,
  isValidSource,
  keyedLogHash,
  normalizeWebhookAddress,
  redactedErrorMessage,
} from "../services/webhook-tokens.js";
import { CONNECTOR_REGISTRY, DEFAULT_CONNECTOR_SOURCE } from "./connector-webhooks.js";

/**
 * W5 — the AUTHENTICATED READ API (backend-ingest plan §8.1 W5; §9 anti-pattern 5).
 *
 * This is where the goal is actually delivered. W3 fetched the meeting and W4 stored it while
 * nobody was looking; until this router exists, a device that has never opened the app — no
 * vault, no Fireflies key, no user-space copy — still cannot see it. Three routes, mounted at
 * `/api/connectors/meetings` behind the session `authMiddleware` and ONLY when
 * `CONNECTOR_BACKEND_INGEST_ENABLED` is armed:
 *
 *   `GET  /`                              the paginated metadata list
 *   `GET  /:source/:sourceId`             one meeting's content
 *   `POST /:source/:sourceId/reconciled`  the reconcile-ack (the ONE mutation)
 *
 * **Strictly side-effect-free GETs (§9 anti-pattern 5).** Listen's `GET /fireflies/pending` ran
 * an unsynchronized read-modify-write on a shared queue *inside a GET*, so a retry, a prefetch or
 * two tabs raced each other into lost items. Neither GET here writes anything: they call only
 * `list` and `get`, which are pure reads all the way down to the substrate port, and
 * `connector-meetings.test.ts` proves it by counting every mutating method of that port across a
 * full sweep of the read surface (the acceptance sentence is literally "instrument write
 * counters; GET list/content causes zero writes"). No last-read stamp, no lazy re-seal, no
 * opportunistic sweep — a read surface that writes is a read surface that can lose data.
 *
 * **The tenant is ALWAYS the session address.** No route accepts an address, an account id or a
 * token; {@link MeetingsContentPort} has no untenanted method to reach for (§8.2 delta 1 / §9
 * anti-pattern 1 — Listen's global "current user" begins as a route that takes a tenant as
 * input). A meeting id belonging to another address is simply `not_found`.
 *
 * **The cohort gate is W2's, verbatim.** Flag off → the mount does not exist; flag on but the
 * address is not enrolled → 404, indistinguishable from the flag being off. An unreadable cohort
 * is a 503, never "treat them as not enrolled".
 *
 * **Fail closed.** An unreadable store answers 503, never `[]` — a list rendered as "you have no
 * meetings" is the failure mode that makes a user re-run a sync, or worse, believe a meeting was
 * lost. Internal error text never reaches a caller and no meeting id, address or content ever
 * reaches a log line in the clear.
 */

/**
 * The read surface's view of W4's store: exactly three methods, all tenant-scoped. `purge`,
 * `sweepRetention` and the blob port are deliberately unreachable from here — a read API one
 * refactor away from `purge` is a read API that can destroy an archive.
 */
export interface MeetingsContentPort {
  list(source: string, address: string): Promise<ContentMeta[]>;
  get(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<StoredMeeting | null>;
  /** Stamps `reconciledAt`. `false` = there is no such row (never "it failed"). */
  markReconciled(
    source: string,
    address: string,
    sourceId: string,
  ): Promise<boolean>;
}

export interface ConnectorMeetingsRouterOptions {
  content: MeetingsContentPort;
  /** The cohort gate. Absent = no address is enrolled, so every route 404s. */
  modes?: IngestModeLookup;
  registry?: ReadonlySet<string>;
  defaultSource?: string;
}

/** Page size when the caller does not ask. Whole pages are cheap: the index is ONE sealed read. */
export const MEETINGS_PAGE_SIZE_DEFAULT = 50;
/** Over this is a 400, never a silent truncation to the cap (no silent caps). */
export const MEETINGS_PAGE_SIZE_MAX = 200;

function hashedField(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

function warnMeetings(fields: string): void {
  console.warn(`[connector-meetings] ${fields} t=${new Date().toISOString()}`);
}

/**
 * The wire shape of one row. `title` rides it because it is the caller's OWN meeting and a list
 * without titles is not a meetings view; the transcript and the summary do NOT — the list is
 * metadata, and a body that is never sent cannot be over-fetched by a poll.
 */
function metaView(meta: ContentMeta) {
  return {
    sourceId: meta.sourceId,
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.ts === undefined ? {} : { ts: meta.ts }),
    ...(meta.transcriptStoredAt === undefined
      ? {}
      : { transcriptStoredAt: meta.transcriptStoredAt }),
    ...(meta.summaryStoredAt === undefined
      ? {}
      : { summaryStoredAt: meta.summaryStoredAt }),
    ...(meta.reconciledAt === undefined
      ? {}
      : { reconciledAt: meta.reconciledAt }),
    sizeBytes: meta.sizeBytes,
    storedAt: meta.storedAt,
    updatedAt: meta.updatedAt,
    // Delta 6's read half: a partial row is a legal, complete row. The view says WHICH half
    // arrived so the UI can render "summary only" instead of an empty transcript pane.
    hasTranscript: meta.transcriptStoredAt !== undefined,
    hasSummary: meta.summaryStoredAt !== undefined,
  };
}

export function createConnectorMeetingsRouter(
  options: ConnectorMeetingsRouterOptions,
): Router {
  const { content } = options;
  const registry = options.registry ?? CONNECTOR_REGISTRY;
  const defaultSource = options.defaultSource ?? DEFAULT_CONNECTOR_SOURCE;
  const router = Router();

  /**
   * Session address + cohort + registry in one place, answering 404/401/503 itself and returning
   * null when it did — a handler that forgets a check cannot proceed without one (W2's idiom).
   *
   * Order matters: the source and the cohort are settled BEFORE any caller-supplied meeting id is
   * validated, so a non-cohort caller gets the same flat 404 for every input and cannot use a
   * 400-vs-404 difference to learn that the surface exists.
   */
  async function tenant(
    req: Request,
    res: Response,
    rawSource: unknown,
  ): Promise<{ address: string; source: string } | null> {
    if (!isValidSource(rawSource) || !registry.has(rawSource)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }

    let address: string;
    try {
      address = normalizeWebhookAddress(req.user?.address);
    } catch {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }

    if (options.modes === undefined) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    let mode: string;
    try {
      mode = await options.modes.mode(address);
    } catch {
      // Fail closed: an unreadable cohort is an outage, not "this user is not enrolled".
      warnMeetings(`op=cohort result=unavailable aid=${hashedField(address)}`);
      res.status(503).json({ error: "unavailable" });
      return null;
    }
    if (mode !== "backend") {
      // Dark for everyone else — the same answer as a deployment without the flag.
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return { address, source: rawSource };
  }

  /** One query value, or null when it is absent / repeated / not a string. */
  function singleQuery(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    return typeof value === "string" ? value : null;
  }

  /**
   * `GET /api/connectors/meetings` — the list. A pure read: the store's `list` opens the sealed
   * per-tenant index and returns metadata, newest first.
   *
   * Paging is explicit in BOTH directions. An over-cap or unparseable `limit` is a 400 rather
   * than a clamp, and a `cursor` whose row is gone (retention swept it between two pages) is a
   * 400 rather than a silent restart at page 1 — a restart reads to the caller as "here are new
   * meetings", which is exactly the lie a paginated archive must not tell.
   *
   * `?reconciled=false` is **W6's discovery queue** (plan §5.3: for a cohort address `/drain`
   * carries "no reconcile payload — reconcile discovery is a read-API list filter"). It is a
   * filter over the SAME pure read: still no write, still tenant-scoped, and `?reconciled=true`
   * is its exact mirror. Anything other than the two literals is a 400 rather than an ignored
   * parameter — a silently dropped filter hands the browser the whole archive to re-copy on
   * every run, which is the expensive failure that looks like success.
   */
  router.get("/", async (req, res) => {
    const rawSource = singleQuery(req.query.source);
    const target = await tenant(req, res, rawSource ?? defaultSource);
    if (target === null) return;

    const rawReconciled = singleQuery(req.query.reconciled);
    let wantReconciled: boolean | undefined;
    if (rawReconciled !== undefined) {
      if (rawReconciled !== "true" && rawReconciled !== "false") {
        res.status(400).json({
          error: "invalid_reconciled",
          message: "reconciled must be exactly 'true' or 'false'",
        });
        return;
      }
      wantReconciled = rawReconciled === "true";
    }

    const rawLimit = singleQuery(req.query.limit);
    let limit = MEETINGS_PAGE_SIZE_DEFAULT;
    if (rawLimit !== undefined) {
      if (
        rawLimit === null ||
        !/^\d+$/.test(rawLimit) ||
        Number(rawLimit) < 1 ||
        Number(rawLimit) > MEETINGS_PAGE_SIZE_MAX
      ) {
        res.status(400).json({
          error: "invalid_limit",
          message: `limit must be an integer between 1 and ${MEETINGS_PAGE_SIZE_MAX}`,
        });
        return;
      }
      limit = Number(rawLimit);
    }

    const rawCursor = singleQuery(req.query.cursor);
    if (rawCursor !== undefined && !isValidMeetingId(rawCursor)) {
      res.status(400).json({ error: "invalid_cursor" });
      return;
    }

    let rows: ContentMeta[];
    try {
      rows = await content.list(target.source, target.address);
    } catch (error) {
      warnMeetings(
        `op=list result=unavailable source=${target.source} ` +
          `aid=${hashedField(target.address)} err=${redactedErrorMessage(error)}`,
      );
      // Never `[]`: an unreadable archive is an outage the caller must be told about.
      res.status(503).json({ error: "unavailable" });
      return;
    }

    // The filter is applied BEFORE paging, so a cursor addresses the filtered set the caller
    // is actually walking. A row stamped by another device between two pages therefore leaves
    // the set and its cursor is `invalid_cursor` — the same honest 400 a swept row gets, and
    // the browser simply restarts the run rather than being told it reached the end.
    if (wantReconciled !== undefined) {
      const want = wantReconciled;
      rows = rows.filter((row) => (row.reconciledAt !== undefined) === want);
    }

    let start = 0;
    if (rawCursor !== undefined) {
      const at = rows.findIndex((row) => row.sourceId === rawCursor);
      if (at < 0) {
        res.status(400).json({ error: "invalid_cursor" });
        return;
      }
      start = at + 1;
    }

    const page = rows.slice(start, start + limit);
    const hasMore = start + page.length < rows.length;
    res.json({
      source: target.source,
      meetings: page.map(metaView),
      // The cursor IS the last id on the page: opaque enough that no offset arithmetic leaks,
      // stable across a concurrent upsert (which changes order, never identity).
      nextCursor: hasMore ? (page[page.length - 1]?.sourceId ?? null) : null,
      hasMore,
    });
  });

  /**
   * `GET /api/connectors/meetings/:source/:sourceId` — one meeting, decrypted inside the TEE and
   * returned to its owner. Also a pure read. A row that does not exist for THIS address is
   * `not_found` with no echo of the id the caller supplied.
   */
  router.get("/:source/:sourceId", async (req, res) => {
    const target = await tenant(req, res, req.params.source);
    if (target === null) return;

    const sourceId = req.params.sourceId;
    if (!isValidMeetingId(sourceId)) {
      // Refused BEFORE the first store call, exactly as `POST /ack` validates its batch.
      res.status(400).json({ error: "invalid_meeting_id" });
      return;
    }

    let stored: StoredMeeting | null;
    try {
      stored = await content.get(target.source, target.address, sourceId);
    } catch (error) {
      warnMeetings(
        `op=read result=unavailable source=${target.source} ` +
          `aid=${hashedField(target.address)} mid=${hashedField(sourceId)} ` +
          `err=${redactedErrorMessage(error)}`,
      );
      res.status(503).json({ error: "unavailable" });
      return;
    }
    if (stored === null) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    res.json({
      source: target.source,
      sourceId,
      meta: metaView(stored.meta),
      // Only the two known halves are projected — a substrate value never becomes an
      // arbitrary response body.
      content: {
        ...(stored.content.transcript === undefined
          ? {}
          : { transcript: stored.content.transcript }),
        ...(stored.content.summary === undefined
          ? {}
          : { summary: stored.content.summary }),
      },
    });
  });

  /**
   * `POST /api/connectors/meetings/:source/:sourceId/reconciled` — the reconcile-ack, and the one
   * mutation in this router. W6 calls it AFTER the browser wrote the meeting into the user's own
   * space (the storage-before-ack invariant carried from `targetedSync`), so a stamp always
   * trails a durable user-space write, never leads it.
   *
   * Idempotent: a lost response is retried and the retry is a success, as `POST /ack` treats an
   * already-settled identity. The server copy is RETAINED (D2a `retain`) — a second device that
   * has not reconciled still has to be able to read it.
   */
  router.post("/:source/:sourceId/reconciled", async (req, res) => {
    const target = await tenant(req, res, req.params.source);
    if (target === null) return;

    const sourceId = req.params.sourceId;
    if (!isValidMeetingId(sourceId)) {
      res.status(400).json({ error: "invalid_meeting_id" });
      return;
    }

    let stamped: boolean;
    try {
      stamped = await content.markReconciled(
        target.source,
        target.address,
        sourceId,
      );
    } catch (error) {
      // A stamp that did not land must NOT be reported as one: the browser would stop
      // re-reconciling a meeting the server still believes is unreconciled.
      warnMeetings(
        `op=reconcile result=unavailable source=${target.source} ` +
          `aid=${hashedField(target.address)} mid=${hashedField(sourceId)} ` +
          `err=${redactedErrorMessage(error)}`,
      );
      res.status(503).json({ error: "unavailable" });
      return;
    }
    if (!stamped) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ reconciled: true, source: target.source, sourceId });
  });

  return router;
}
