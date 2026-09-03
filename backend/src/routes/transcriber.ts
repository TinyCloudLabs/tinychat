import { Router } from "express";
import type { Request, Response } from "express";

import {
  TranscriptionApiError,
  type TranscriptionApiClient,
  type TranscriptionMeeting,
} from "../services/transcription-api.js";
import type { TranscriberIndexStore } from "../services/transcriber-index.js";
import type { TranscriberRecoveryConfig } from "../services/transcriber-recovery-config.js";
import type { RecoveryRateLimiter } from "../rate-limits.js";
import { redactedErrorMessage } from "../services/webhook-tokens.js";

export interface TranscriberRecoveryLogEvent {
  operation: "recover";
  outcome: "started" | "already_active" | "already_completed" | "error";
  statusClass: "2xx" | "4xx" | "5xx";
  errorClass?:
    | "invalid_request"
    | "not_found"
    | "conflict"
    | "recording_absent"
    | "rate_limited"
    | "capability_unavailable"
    | "configuration_unavailable"
    | "upstream_unavailable";
  correlation?: string;
}

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
 */

export interface TranscriberRouterOptions {
  api: TranscriptionApiClient;
  index: TranscriberIndexStore;
  /** Bot display name when the caller does not give one. */
  defaultBotName?: string;
  recovery?: Pick<TranscriberRecoveryConfig, "enabled" | "ready">;
  recoveryLimiter?: RecoveryRateLimiter;
  recoveryLogger?: (event: TranscriberRecoveryLogEvent) => void;
}

const MEETING_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_URL_LENGTH = 2048;
const MAX_BOT_NAME_LENGTH = 64;
const LIST_CONCURRENCY = 8;
const RECOVERY_ACTION_KEY = /^[\x21-\x7e]{1,128}$/;
const TRANSCRIBER_CONTRACT_HEADER = "space-save-v2";

export function shouldBypassGlobalJsonParserForTranscriberRecovery(method: string, path: string): boolean {
  return method === "POST" && /^\/api\/transcriber\/meetings\/[^/]+\/recover\/?$/i.test(path);
}

function defaultRecoveryLogger(event: TranscriberRecoveryLogEvent): void {
  const fields = [
    `op=${event.operation}`,
    `outcome=${event.outcome}`,
    `status_class=${event.statusClass}`,
    ...(event.errorClass === undefined ? [] : [`error_class=${event.errorClass}`]),
    ...(event.correlation === undefined ? [] : [`correlation=${event.correlation}`]),
  ];
  console.log(`[transcriber-recovery] ${fields.join(" ")}`);
}

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

export function createTranscriberRouter(options: TranscriberRouterOptions): Router {
  const { api, index } = options;
  const defaultBotName = options.defaultBotName ?? "TinyCloud Private Notetaker";
  const recovery = options.recovery ?? { enabled: false, ready: false };
  const recoveryLimiter = options.recoveryLimiter;
  const recoveryLogger = options.recoveryLogger ?? defaultRecoveryLogger;
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
   *  upstream's taxonomy — detail-carrying errors are 5xx and go down the generic path) is
   *  passed through so the form can say why a link was refused. */
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
        res.status(429).json({ error: "upstream_rate_limited" });
        return;
      }
    }
    console.warn(`[transcriber] ${what} failed err=${redactedErrorMessage(error)}`);
    res.status(503).json({ error: "transcriber_unavailable" });
  }

  function recoveryFailure(res: Response, error: unknown): TranscriberRecoveryLogEvent["errorClass"] {
    if (error instanceof TranscriptionApiError
      && [400, 404, 409, 410, 429].includes(error.status)
      && error.code !== null) {
      if (error.status === 429 && error.retryAfterSeconds !== null) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      res.status(error.status).json({ error: error.code });
      if (error.status === 400) return "invalid_request";
      if (error.status === 404) return "not_found";
      if (error.status === 409) return "conflict";
      if (error.status === 410) return "recording_absent";
      return "rate_limited";
    }
    res.status(503).json({ error: "transcriber_recovery_unavailable" });
    return "upstream_unavailable";
  }

  function requestCarriesBody(req: Request): boolean {
    const contentLength = req.get("Content-Length");
    return req.get("Content-Type") !== undefined
      || req.get("Transfer-Encoding") !== undefined
      || (contentLength !== undefined && contentLength !== "0");
  }

  async function owned(req: Request, res: Response): Promise<{ address: string; id: string } | null> {
    const address = addressOf(req, res);
    if (address === null) return null;
    const id = req.params.id;
    if (typeof id !== "string" || !MEETING_ID_RE.test(id)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    let ids: string[];
    try {
      ids = await index.list(address);
    } catch (error) {
      console.warn(`[transcriber] index read failed err=${redactedErrorMessage(error)}`);
      res.status(503).json({ error: "transcriber_unavailable" });
      return null;
    }
    if (!ids.includes(id)) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return { address, id };
  }

  router.get("/", async (req, res) => {
    const address = addressOf(req, res);
    if (address === null) return;
    const owner: string = address;
    let ids: string[];
    try {
      ids = await index.list(address);
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
          meetings[i] = await api.getMeeting(id);
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

    let meeting: TranscriptionMeeting;
    try {
      meeting = await api.createMeeting({
        meeting_url: body.meeting_url,
        bot_name: botName,
        ...(language ? { language } : {}),
      });
    } catch (error) {
      upstreamFailure(res, error, "create");
      return;
    }
    if (typeof meeting?.id !== "string" || !MEETING_ID_RE.test(meeting.id)) {
      console.warn("[transcriber] create returned an unusable id");
      res.status(502).json({ error: "transcriber_bad_response" });
      return;
    }
    try {
      await index.add(address, meeting.id);
    } catch (error) {
      // The bot is already on its way; the caller must not think it is not. Best effort to
      // undo upstream so the meeting does not become an orphan nobody can see.
      console.warn(`[transcriber] index write failed err=${redactedErrorMessage(error)}`);
      try {
        await api.deleteMeeting(meeting.id);
      } catch {
        /* best effort */
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
      res.json(await api.getMeeting(own.id));
    } catch (error) {
      upstreamFailure(res, error, "get");
    }
  });

  router.post("/:id/stop", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;
    try {
      res.json(await api.stopMeeting(own.id));
    } catch (error) {
      upstreamFailure(res, error, "stop");
    }
  });

  router.post("/:id/recover", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;

    const idempotencyKey = req.get("Idempotency-Key");
    if (idempotencyKey === undefined || !RECOVERY_ACTION_KEY.test(idempotencyKey)
      || requestCarriesBody(req)) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    if (!recovery.enabled || !recovery.ready || recoveryLimiter === undefined) {
      recoveryLogger({
        operation: "recover",
        outcome: "error",
        statusClass: "5xx",
        errorClass: "configuration_unavailable",
      });
      res.status(503).json({ error: "transcriber_recovery_unavailable" });
      return;
    }
    const limit = recoveryLimiter.consume(own.address);
    if (!limit.allowed) {
      if (limit.retryAfterSeconds !== null) {
        res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      }
      recoveryLogger({
        operation: "recover",
        outcome: "error",
        statusClass: "4xx",
        errorClass: "rate_limited",
        correlation: limit.correlation,
      });
      res.status(429).json({ error: "recovery_rate_limited" });
      return;
    }
    try {
      const capability = await api.getCapabilities();
      if (!capability.available) {
        recoveryLogger({
          operation: "recover",
          outcome: "error",
          statusClass: "5xx",
          errorClass: "capability_unavailable",
          correlation: limit.correlation,
        });
        res.status(503).json({ error: "transcriber_recovery_unavailable" });
        return;
      }
      const result = await api.recoverMeeting(own.id, idempotencyKey);
      recoveryLogger({
        operation: "recover",
        outcome: result.recovery.disposition,
        statusClass: "2xx",
        correlation: limit.correlation,
      });
      res.status(result.httpStatus).json({ status: result.status, recovery: result.recovery });
    } catch (error) {
      const errorClass = recoveryFailure(res, error);
      recoveryLogger({
        operation: "recover",
        outcome: "error",
        statusClass: error instanceof TranscriptionApiError && error.status < 500 ? "4xx" : "5xx",
        errorClass,
        correlation: limit.correlation,
      });
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
      const meeting = await api.getMeeting(own.id);
      if (meeting.recovery === undefined || meeting.transcript_revision === undefined) {
        res.status(503).json({ error: "transcriber_unavailable" });
        return;
      }
      const meetingRevision = meeting.transcript_revision;
      const transcriptRevision = result.transcript.transcript_revision;
      const unrecovered = meetingRevision === 0
        && (transcriptRevision === undefined || transcriptRevision === 0);
      if (!unrecovered) {
        if (req.get("X-TinyChat-Transcriber-Contract") !== TRANSCRIBER_CONTRACT_HEADER) {
          res.status(409).json({ error: "client_upgrade_required" });
          return;
        }
        if (!Number.isSafeInteger(meetingRevision) || (meetingRevision ?? 0) <= 0
          || !Number.isSafeInteger(transcriptRevision) || (transcriptRevision ?? 0) <= 0
          || meetingRevision !== transcriptRevision) {
          res.status(503).json({ error: "transcriber_unavailable" });
          return;
        }
      }
      res.json(result.transcript);
    } catch (error) {
      upstreamFailure(res, error, "transcript");
    }
  });

  router.delete("/:id", async (req, res) => {
    const own = await owned(req, res);
    if (own === null) return;
    try {
      await api.deleteMeeting(own.id);
    } catch (error) {
      // Already gone upstream is fine — the point is that it is gone.
      if (!(error instanceof TranscriptionApiError && error.status === 404)) {
        upstreamFailure(res, error, "delete");
        return;
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
