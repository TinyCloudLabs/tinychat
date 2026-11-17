import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";
import { meetingLinkFromInput } from "@tinyboilerplate/core";

import {
  TERMINAL_MEETING_STATUSES,
  TranscriptionApiError,
  computeCreateRequestHash,
  type TranscriptionApiClient,
  type TranscriptionMeeting,
} from "../services/transcription-api.js";
import {
  DuplicateCreateIntentError,
  resolvePendingCreates,
  TooManyPendingCreatesError,
  type ShareProvenance,
  type PurgeState,
  type TranscriberIndexEntries,
  type TranscriberIndexStore,
} from "../services/transcriber-index.js";
import { purgeMeeting } from "../services/transcriber-purge.js";
import { PrivateCloudPurgeError, type PrivateCloudPurger } from "../services/private-cloud-purge.js";
import { redactedErrorMessage } from "../services/webhook-tokens.js";

/**
 * The TRANSCRIBER surface: send a bot to a meeting, watch it, read the transcript.
 *
 * Mounted at `/api/transcriber/meetings` behind the session `authMiddleware`, and ONLY when the
 * private transcription API is configured (`TRANSCRIPTION_API_URL` + `TRANSCRIPTION_API_KEY`).
 * The browser never sees the project key: this router is a per-address proxy over
 * `services/transcription-api.ts`, and the per-address index is the ownership boundary — the
 * tenant is ALWAYS the session address, and someone else's meeting id is `not_found`.
 *
 *   GET    /                  the address's meetings, newest first, statuses refreshed upstream
 *   POST   /                  { meeting_url, bot_name?, language? } → 201 meeting
 *   GET    /:id               one meeting
 *   POST   /:id/stop          stop the bot (idempotent)
 *   GET    /:id/transcript    200 transcript, or 202 { status } while pending
 *   DELETE /:id               forget it here AND upstream, then read back that it is gone (202 while still deleting)
 *   DELETE /                  the same for every recording this address holds (account deletion step)
 *
 * TC-581: a calendar capture another account's bot made can be SHARED into this address's index.
 * A shared meeting is served through a field whitelist (the owner's address and occurrence id are
 * stripped), cannot be stopped (403 `shared_meeting`), and DELETE only removes it from this list.
 */

export interface TranscriberRouterOptions {
  api: TranscriptionApiClient;
  index: TranscriberIndexStore;
  /** Bot display name when the caller does not give one. */
  defaultBotName?: string;
  /** Omit when server delivery is disabled. */
  webhookUrl?: string;
  onObservedCompletion?: (address: string, meetingId: string) => Promise<void>;
  /** TC-3136: told about addresses with an unconfirmed purge so the sweeper retries them. */
  purger?: { track(address: string): void };
  /** Delays between the in-request purge attempts (default: first at once, then 0.4 s and 1.5 s). */
  purgeDelaysMs?: number[];
  purgeSleep?: (ms: number) => Promise<void>;
  /** TC-3166: account deletion also clears the account's private cloud transcription jobs. Omitted while that service is dark. */
  privateCloud?: PrivateCloudPurger;
}

export const MEETING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_URL_LENGTH = 2048;
const MAX_BOT_NAME_LENGTH = 64;
const LIST_CONCURRENCY = 8;
const BULK_DELETE_CONCURRENCY = 4;
const CREATE_DEDUP_CANDIDATES = 32;

export function isValidMeetingUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" || url.protocol === "http:";
}

/** Canonical comparison/storage identity. The original URL still goes to ptx. */
export function normalizeMeetingUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.searchParams.sort();
  return url.toString();
}

class InvalidCreateResponseError extends Error {}

/** The only fields of someone else's meeting this address sees. Metadata comes from its OWN calendar. */
export function sharedMeetingView(meeting: TranscriptionMeeting, provenance: ShareProvenance): TranscriptionMeeting {
  return {
    id: meeting.id,
    status: meeting.status,
    platform: meeting.platform,
    meeting_url: meeting.meeting_url,
    created_at: meeting.created_at,
    ...(meeting.started_at === undefined ? {} : { started_at: meeting.started_at }),
    ...(meeting.ended_at === undefined ? {} : { ended_at: meeting.ended_at }),
    ...(meeting.transcript === undefined ? {} : { transcript: {
      ...(meeting.transcript.status === undefined ? {} : { status: meeting.transcript.status }),
      ...(meeting.transcript.version === undefined ? {} : { version: meeting.transcript.version }),
    } }),
    ...(meeting.error === undefined ? {} : { error: meeting.error }),
    metadata: {
      source: "google-calendar-autojoin",
      calendar_title: provenance.title || "Calendar meeting",
      ...(provenance.scheduledStart ? { scheduled_start: provenance.scheduledStart } : {}),
      shared: true,
    },
  };
}

export function createTranscriberRouter(options: TranscriberRouterOptions): Router {
  const { api, index } = options;
  const defaultBotName = options.defaultBotName ?? "TinyCloud Private Notetaker";
  const router = Router();
  // Process-local protection complements ptx's durable Idempotency-Key guarantee. Concurrent
  // sends share the existing create path and add no lane read.
  const inFlightByOwnerUrl = new Map<string, Promise<{ meeting: TranscriptionMeeting; created: boolean }>>();

  const ownerUrlKey = (address: string, meetingUrl: string) => `${address}\n${meetingUrl}`;

  function addressOf(req: Request, res: Response): string | null {
    const address = req.user?.address;
    if (typeof address !== "string" || address.length === 0) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    return address.toLowerCase();
  }

  /** Upstream failures become our own codes; only a 400-class validation message (benign by
   *  upstream's taxonomy — detail-carrying errors are 5xx and go down the generic path) and the
   *  429 `capacity_exhausted` message are passed through so the form can say why a send failed. */
  function upstreamFailure(res: Response, error: unknown, what: string): void {
    if (error instanceof TranscriptionApiError) {
      if (error.status === 404) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      if (error.status === 409 && error.code === "idempotency_conflict") {
        res.status(409).json({
          error: "idempotency_conflict",
          message: "This send key belongs to a different request. Please send again.",
        });
        return;
      }
      if (error.status === 400 || error.status === 422) {
        res.status(400).json({ error: error.code ?? "invalid_request", message: error.message });
        return;
      }
      if (error.status === 429) {
        // TC-907: Retry-After is relayed, and a capacity refusal keeps upstream's fixed message
        // ("All N meeting notetakers are busy right now…") so the form can show it.
        const retryAfter = error.retryAfterMs === null ? undefined : Math.ceil(error.retryAfterMs / 1000);
        if (retryAfter !== undefined) res.setHeader("Retry-After", String(retryAfter));
        res.status(429).json({
          ...(error.code === "capacity_exhausted"
            ? { error: "capacity_exhausted", message: error.message }
            : { error: "upstream_rate_limited" }),
          ...(retryAfter === undefined ? {} : { retry_after_seconds: retryAfter }),
        });
        return;
      }
    }
    console.warn(`[transcriber] ${what} failed err=${redactedErrorMessage(error)}`);
    res.status(503).json({ error: "transcriber_unavailable" });
  }

  async function owned(
    req: Request,
    res: Response,
  ): Promise<{ address: string; id: string; shared: ShareProvenance | undefined } | null> {
    const address = addressOf(req, res);
    if (address === null) return null;
    const id = req.params.id;
    if (typeof id !== "string" || !MEETING_ID_RE.test(id)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    let ids: string[];
    let shares: Record<string, ShareProvenance>;
    try {
      ({ ids, shared: shares } = await index.entries(address));
    } catch (error) {
      console.warn(`[transcriber] index read failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return null;
    }
    if (!ids.includes(id)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return { address, id, shared: Object.hasOwn(shares, id) ? shares[id] : undefined };
  }

  /** Positive ownership before an upstream side effect: tinychat stamps every meeting it creates. */
  async function createdBy(address: string, id: string): Promise<boolean> {
    const owner = (await api.getMeeting(id)).metadata?.tinychat_address;
    return typeof owner === "string" && owner.toLowerCase() === address;
  }

  /** TC-3166: whether this deployment keeps private cloud transcription jobs, from config only (no PTX call). */
  router.get("/scope", (req, res) => {
    if (addressOf(req, res) === null) return;
    res.json({ privateCloud: options.privateCloud !== undefined });
  });

  router.get("/", async (req, res) => {
    const address = addressOf(req, res);
    if (address === null) return;
    try {
      await resolvePendingCreates(address, api, index);
    } catch (error) {
      console.warn(`[transcriber] index recovery failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }
    const owner: string = address;
    let ids: string[];
    let shares: Record<string, ShareProvenance>;
    let purging: Record<string, PurgeState>;
    try {
      ({ ids, shared: shares, purging = {} } = await index.entries(address));
    } catch (error) {
      console.warn(`[transcriber] index read failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }
    // Refresh every row upstream (no list endpoint in V1). One unreadable row does not blank
    // the list: it is reported as `unavailable: true` and keeps its id so it can still be deleted.
    const meetings: (TranscriptionMeeting | { id: string; unavailable: true; deleting?: true } | null)[] = new Array(
      ids.length,
    ).fill(null);
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i]!;
        if (Object.hasOwn(purging, id)) {
          meetings[i] = { id, unavailable: true, deleting: true };
          continue;
        }
        try {
          const found = await api.getMeeting(id);
          const shared = Object.hasOwn(shares, id);
          meetings[i] = shared ? sharedMeetingView(found, shares[id]!) : found;
          // A trusted observation: our own upstream read says completed, for this session's owner.
          // A meeting shared into this list (TC-581) is never this session's to deliver.
          const recordedOwner = found.metadata?.tinychat_address;
          if (!shared && found.status === "completed" && typeof recordedOwner === "string" && recordedOwner.toLowerCase() === owner.toLowerCase()) {
            try { await options.onObservedCompletion?.(owner, id); }
            catch { console.warn("[transcriber] completion wake failed"); }
          }
        } catch (error) {
          if (error instanceof TranscriptionApiError && error.status === 404) {
            // Gone upstream (deleted out of band): drop it from the index rather than
            // showing a ghost forever.
            try {
              await index.remove(owner, id);
            } catch {
              /* best effort */
            }
            continue;
          }
          meetings[i] = { id, unavailable: true };
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, ids.length) }, worker));
    res.json({ meetings: meetings.filter((m) => m !== null) });
  });

  router.post("/", async (req, res) => {
    const address = addressOf(req, res);
    if (address === null) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Older clients send links as pasted (google.com/meet/<code>, Calendar redirects); ptx only knows canonical hosts.
    const link = typeof body.meeting_url === "string" ? meetingLinkFromInput(body.meeting_url) : null;
    if (!isValidMeetingUrl(link)) {
      res.status(400).json({ error: "invalid_meeting_url" });
      return;
    }
    const meetingUrl = normalizeMeetingUrl(link);
    const suppliedKey = req.get("Idempotency-Key");
    if (suppliedKey !== undefined && !IDEMPOTENCY_KEY_RE.test(suppliedKey)) {
      res.status(400).json({ error: "invalid_idempotency_key" });
      return;
    }
    const botName =
      typeof body.bot_name === "string" && body.bot_name.trim().length > 0
        ? body.bot_name.trim().slice(0, MAX_BOT_NAME_LENGTH)
        : defaultBotName;
    const language =
      typeof body.language === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(body.language)
        ? body.language
        : undefined;
    const createBody = {
      // Fragments and the exact query remain intact: Signal and signed meeting links may carry
      // capabilities there. Canonicalization is only an identity used by TinyChat dedupe.
      meeting_url: link,
      bot_name: botName,
      ...(language ? { language } : {}),
      ...(options.webhookUrl ? { webhook_url: options.webhookUrl } : {}),
      metadata: { tinychat_address: address },
    };

    const ownerMeetingKey = ownerUrlKey(address, meetingUrl);
    let create = inFlightByOwnerUrl.get(ownerMeetingKey);
    const joinedExistingCreate = create !== undefined;
    if (!create) {
      const key = suppliedKey ?? `manual-v1-${randomUUID()}`;
      create = (async () => {
        const intent = { key, hash: computeCreateRequestHash(createBody), createdAt: Date.now() };
        const entries = await index.beginCreate(address, intent);
        const candidates = entries.ids
          .filter(id => !Object.hasOwn(entries.shared, id))
          .slice(0, CREATE_DEDUP_CANDIDATES);
        let cursor = 0;
        let existing: TranscriptionMeeting | null = null;
        async function scan(): Promise<void> {
          while (existing === null && cursor < candidates.length) {
            const id = candidates[cursor++]!;
            try {
              const current = await api.getMeeting(id);
              const owner = current.metadata?.tinychat_address;
              if (typeof owner === "string" && owner.toLowerCase() === address
                && !TERMINAL_MEETING_STATUSES.has(current.status)
                && normalizeMeetingUrl(current.meeting_url) === meetingUrl) existing = current;
            } catch {
              // Historical rows may be gone or temporarily unreadable. Neither should block a
              // fresh send; the stable key and in-flight map remain the primary duplicate guards.
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, candidates.length) }, scan));
        if (existing !== null) {
          await index.abandonCreate(address, key);
          return { meeting: existing, created: false };
        }
        let meeting: TranscriptionMeeting;
        let attempts = 0;
        try {
          meeting = await api.createMeeting(createBody, { idempotencyKey: key, onAttempt: () => { attempts++; } });
        } catch (error) {
          // TC-907: a lone definitive refusal clears the intent. After a transport retry, an
          // earlier attempt can still commit, so lookup-only recovery retains ownership of it.
          const refused = error instanceof TranscriptionApiError && error.status >= 400 && error.status < 500
            && (error.status !== 429 || error.code === "capacity_exhausted");
          if (refused && attempts <= 1) {
            try { await index.abandonCreate(address, key); }
            catch { /* Recovery will later see the missing key and clear the intent. */ }
          }
          throw error;
        }
        if (typeof meeting?.id !== "string" || !MEETING_ID_RE.test(meeting.id)) {
          throw new InvalidCreateResponseError("create returned an unusable id");
        }
        try {
          await index.completeCreate(address, key, meeting.id);
        } catch (error) {
          console.warn(`[transcriber] index write failed err=${redactedErrorMessage(error)}`);
          try {
            await api.deleteMeeting(meeting.id);
            try { await index.abandonCreate(address, key); }
            catch { /* A later lookup sees 404 and abandons after the grace period. */ }
          } catch { /* Retain the durable intent when deletion fails. */ }
          throw error;
        }
        return { meeting, created: true };
      })();
      inFlightByOwnerUrl.set(ownerMeetingKey, create);
      void create.finally(() => {
        if (inFlightByOwnerUrl.get(ownerMeetingKey) === create) inFlightByOwnerUrl.delete(ownerMeetingKey);
      }).catch(() => {});
    }
    try {
      const result = await create;
      res.status(joinedExistingCreate || !result.created ? 200 : 201).json(result.meeting);
    } catch (error) {
      if (error instanceof TooManyPendingCreatesError) {
        res.status(429).json({ error: "too_many_pending_creates" });
        return;
      }
      if (error instanceof DuplicateCreateIntentError) {
        res.status(409).json({
          error: "idempotency_conflict",
          message: "This send key belongs to a different request. Please send again.",
        });
        return;
      }
      if (error instanceof InvalidCreateResponseError) {
        console.warn("[transcriber] create returned an unusable id");
        res.status(502).json({ error: "transcriber_bad_response" });
        return;
      }
      upstreamFailure(res, error, "create");
    }
  });

  router.get("/:id", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;
    try {
      const found = await api.getMeeting(own.id);
      res.json(own.shared ? sharedMeetingView(found, own.shared) : found);
    } catch (error) {
      upstreamFailure(res, error, "get");
    }
  });

  router.post("/:id/stop", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;
    try {
      if (own.shared || !(await createdBy(own.address, own.id))) {
        // Someone else's bot: only its owner can end it.
        res.status(403).json({ error: "shared_meeting" });
        return;
      }
      res.json(await api.stopMeeting(own.id));
    } catch (error) {
      upstreamFailure(res, error, "stop");
    }
  });

  router.get("/:id/transcript", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;
    try {
      const result = await api.getTranscript(own.id);
      if (result.pending) {
        res.status(202).json({ meeting_id: own.id, status: result.status });
        return;
      }
      res.json(result.transcript);
    } catch (error) {
      upstreamFailure(res, error, "transcript");
    }
  });

  /**
   * TC-3136: purge the upstream copy (and the capture provider's behind it) and prove it is gone. A purge
   * that cannot be confirmed keeps the entry as "deleting" for the sweeper to retry; it is never dropped
   * silently. Shared entries are list-only removals ("shared"); an own entry the provider does not attribute to
   * this address is dropped from the list but its provider copy is NOT deleted ("not_ours").
   */
  async function removeEntry(address: string, id: string, shared: boolean): Promise<"gone" | "shared" | "not_ours" | "deleting"> {
    const outcome = shared ? "shared" : await purgeMeeting(api, address, id, { delaysMs: options.purgeDelaysMs, sleep: options.purgeSleep });
    if (outcome === "failed") {
      await index.markPurging(address, id);
      options.purger?.track(address);
      return "deleting";
    }
    await index.remove(address, id);
    return outcome;
  }

  router.delete("/:id", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;
    try {
      const result = await removeEntry(own.address, own.id, own.shared !== undefined);
      if (result === "deleting") {
        res.status(202).json({ id: own.id, status: "deleting" });
        return;
      }
      // Own entry the provider does not attribute to this address: dropped from the list, copy NOT deleted.
      // Say so (200 + body) instead of the silent 204. "shared" has no copy of the caller's own to leave behind.
      if (result === "not_ours") {
        res.status(200).json({ id: own.id, status: "not_deleted" });
        return;
      }
    } catch (error) {
      console.warn(`[transcriber] index write failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }
    res.status(204).end();
  });

  /**
   * Removes every recording this address holds (the step before OpenKey account deletion, which
   * TinyChat gets no signal for). 200 when all are confirmed gone, 202 with the count still deleting.
   * `listOnly` counts recordings shared with this address: dropped from this list, the sharer still has them.
   * `notDeleted` counts the address's own entries the provider did not attribute to it: dropped from the list
   * but NOT deleted at the provider. Both are subsets of `removed`.
   *
   * TC-3166: the same call also deletes the account's private cloud transcription jobs (voice notes and
   * uploads) and reads back that PTX lists none. `privateCloudDeleted` counts them, or is `null` when that
   * service is not used (never 0, which would read as "checked, none"). A failure there is a 503 like any other
   * unconfirmed delete; the step is safe to retry.
   */
  router.delete("/", async (req, res) => {
    const address = addressOf(req, res);
    if (address === null) return;
    let entries: TranscriberIndexEntries;
    try {
      await resolvePendingCreates(address, api, index);
      entries = await index.entries(address);
    } catch (error) {
      console.warn(`[transcriber] index read failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }
    const ids = [...entries.ids];
    let removed = 0;
    let deleting = 0;
    let listOnly = 0;
    let notDeleted = 0;
    let failed = 0;
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < ids.length) {
        const id = ids[cursor++]!;
        try {
          const result = await removeEntry(address!, id, Object.hasOwn(entries.shared, id));
          if (result === "deleting") deleting++;
          else {
            removed++;
            if (result === "shared") listOnly++;
            if (result === "not_ours") notDeleted++;
          }
        } catch (error) {
          failed++;
          console.warn(`[transcriber] index write failed err=${redactedErrorMessage(error)}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(BULK_DELETE_CONCURRENCY, ids.length) }, worker));
    const privateCloud = await purgePrivateCloud(options.privateCloud, address);
    if (failed > 0 || privateCloud.failed) {
      res.status(503).json({ error: "transcriber_unavailable", removed, deleting, listOnly, notDeleted, failed, privateCloudFailed: privateCloud.failed });
      return;
    }
    res.status(deleting > 0 ? 202 : 200).json({ removed, deleting, listOnly, notDeleted, privateCloudDeleted: privateCloud.deleted });
  });

  return router;
}

/**
 * `privateCloudDeleted` is the number of jobs deleted and read back gone, or `null` when the private cloud
 * service is not used at all, which the step must never read as "checked, none".
 */
async function purgePrivateCloud(purger: PrivateCloudPurger | undefined, address: string): Promise<{ deleted: number | null; failed: boolean }> {
  if (!purger) return { deleted: null, failed: false };
  try {
    return { deleted: await purger.purge(address), failed: false };
  } catch (error) {
    console.warn(`[transcriber] private_cloud_purge_failed reason=${error instanceof PrivateCloudPurgeError ? error.reason : error instanceof Error ? error.name : "unknown"}`);
    return { deleted: null, failed: true };
  }
}

/**
 * TC-3166: the bulk DELETE for a deployment that has private cloud transcription but no meeting transcriber
 * (so no `createTranscriberRouter`). The account-deletion step still asks the private cloud service; there are no
 * meetings to remove.
 */
export function createPrivateCloudOnlyBulkDeleteRouter(purger: PrivateCloudPurger): Router {
  const router = Router();
  router.delete("/", async (req, res) => {
    const address = req.user?.address;
    if (typeof address !== "string" || address.length === 0) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const privateCloud = await purgePrivateCloud(purger, address.toLowerCase());
    if (privateCloud.failed) {
      res.status(503).json({ error: "transcriber_unavailable", removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, failed: 0, privateCloudFailed: true });
      return;
    }
    res.status(200).json({ removed: 0, deleting: 0, listOnly: 0, notDeleted: 0, privateCloudDeleted: privateCloud.deleted });
  });
  router.get("/scope", (req, res) => {
    if (typeof req.user?.address !== "string" || req.user.address.length === 0) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ privateCloud: true });
  });
  return router;
}
