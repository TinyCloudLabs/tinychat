import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { Request, Response } from "express";

import {
  TranscriptionApiError,
  computeCreateRequestHash,
  type TranscriptionApiClient,
  type TranscriptionMeeting,
} from "../services/transcription-api.js";
import {
  resolvePendingCreates,
  TooManyPendingCreatesError,
  type ShareProvenance,
  type TranscriberIndexStore,
} from "../services/transcriber-index.js";
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
 *   DELETE /:id               forget it here AND upstream
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
}

export const MEETING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL_LENGTH = 2048;
const MAX_BOT_NAME_LENGTH = 64;
const LIST_CONCURRENCY = 8;

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
    ...(meeting.transcript === undefined ? {} : { transcript: meeting.transcript }),
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
    try {
      ({ ids, shared: shares } = await index.entries(address));
    } catch (error) {
      console.warn(`[transcriber] index read failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }
    // Refresh every row upstream (no list endpoint in V1). One unreadable row does not blank
    // the list: it is reported as `unavailable: true` and keeps its id so it can still be deleted.
    const meetings: (TranscriptionMeeting | { id: string; unavailable: true } | null)[] = new Array(
      ids.length,
    ).fill(null);
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i]!;
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
    if (!isValidMeetingUrl(body.meeting_url)) {
      res.status(400).json({ error: "invalid_meeting_url" });
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
      meeting_url: body.meeting_url,
      bot_name: botName,
      ...(language ? { language } : {}),
      ...(options.webhookUrl ? { webhook_url: options.webhookUrl } : {}),
      metadata: { tinychat_address: address },
    };

    const key = `manual-v1-${randomUUID()}`;
    const intent = { key, hash: computeCreateRequestHash(createBody), createdAt: Date.now() };
    try {
      await index.beginCreate(address, intent);
    } catch (error) {
      if (error instanceof TooManyPendingCreatesError) {
        res.status(429).json({ error: "too_many_pending_creates" });
        return;
      }
      console.warn(`[transcriber] index begin failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }

    let meeting: TranscriptionMeeting;
    let attempts = 0;
    try {
      meeting = await api.createMeeting(createBody, { idempotencyKey: key, onAttempt: () => { attempts++; } });
    } catch (error) {
      // A definitive refusal of this send's only attempt created nothing, so its intent is cleared
      // now: a non-429 4xx, or (TC-907) a capacity 429, since ptx checks the key before capacity.
      // After a transport retry an earlier attempt may still commit late (a timeout, then a 409
      // while its replay is in flight), so the intent stays for lookup-only recovery: it owns a late
      // meeting, or abandons after the grace period. Recovery never creates.
      const refused = error instanceof TranscriptionApiError && error.status >= 400 && error.status < 500
        && (error.status !== 429 || error.code === "capacity_exhausted");
      if (refused && attempts <= 1) {
        try {
          await index.abandonCreate(address, key);
        } catch {
          // Recovery will later see the missing idempotency key and clear the intent.
        }
      }
      upstreamFailure(res, error, "create");
      return;
    }

    if (typeof meeting?.id !== "string" || !MEETING_ID_RE.test(meeting.id)) {
      // The durable intent stays available for a verified idempotency lookup during recovery.
      console.warn("[transcriber] create returned an unusable id");
      res.status(502).json({ error: "transcriber_bad_response" });
      return;
    }
    try {
      await index.completeCreate(address, key, meeting.id);
    } catch (error) {
      console.warn(`[transcriber] index write failed err=${redactedErrorMessage(error)}`);
      try {
        await api.deleteMeeting(meeting.id);
        try {
          await index.abandonCreate(address, key);
        } catch {
          // A subsequent lookup sees 404 and abandons after the grace period.
        }
      } catch {
        // Deletion failed: retain the durable intent so the bot remains discoverable.
      }
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }
    res.status(201).json(meeting);
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

  router.delete("/:id", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;
    // A recording this address did not create belongs to its owner: removing it here only takes
    // it off this list.
    if (!own.shared) {
      try {
        if (await createdBy(own.address, own.id)) await api.deleteMeeting(own.id);
      } catch (error) {
        // Already gone upstream is fine — the point is that it is gone.
        if (!(error instanceof TranscriptionApiError && error.status === 404)) {
          upstreamFailure(res, error, "delete");
          return;
        }
      }
    }
    try {
      await index.remove(own.address, own.id);
    } catch (error) {
      console.warn(`[transcriber] index remove failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return;
    }
    res.status(204).end();
  });

  return router;
}
