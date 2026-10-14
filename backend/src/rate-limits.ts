/**
 * Rate-limiter wiring (ST5).
 *
 * The verification proxies (signature / NRAS / Phala TDX / backend attestation) fan out to ~3-4
 * backend hits PER badge click and ~3 per model probe, so sharing the
 * 120-request global bucket with `/api/chat` lets a handful of verifications
 * 429 the next chat send (which `streamChat` treats as a fatal error). These
 * verification mounts get their OWN, far larger bucket and are exempted from the
 * global one so verification traffic can never exhaust the chat allowance.
 *
 * Extracted from index.ts so the wiring is unit-testable without booting the
 * full server.
 */
import rateLimit from "express-rate-limit";
import type { Express } from "express";

const WINDOW_MS = 15 * 60 * 1000;

/**
 * INTERIM (2026-10-14 incident): every bucket below is keyed by `req.ip`, but in production
 * `req.ip` is the same address for EVERY client. The Phala gateway relays TCP to the ingress
 * without the PROXY protocol, so nginx's `$remote_addr` (the only XFF entry `trust proxy 1`
 * believes) is the gateway's. Each "per-IP" ceiling is therefore a whole-service ceiling: one
 * browser with one running Private job (~150-200 requests per window) drained the 120 global
 * bucket and 429'd everyone, and anyone sending 120 requests could do the same on purpose.
 *
 * Until per-client keying lands, every ceiling is its per-client budget times this many
 * concurrent clients, so 20-30 active users behind the one shared key stay under all of them
 * (Clarissa measured a peak of 148 requests per window from one ordinary browser; 30 x 148 =
 * 4,440 < 6,000). A shared-key limit is no protection against a single abuser at any size, so
 * this weakens nothing real. Revert to 1 with the per-client keying fix.
 */
export const SHARED_KEY_HEADROOM = 50;

export const GLOBAL_LIMIT = 120 * SHARED_KEY_HEADROOM;
export const VERIFICATION_LIMIT = 600 * SHARED_KEY_HEADROOM;
export const VERIFICATION_PATHS = [
  "/api/signature",
  "/api/nras-proxy",
  "/api/phala-verify",
  "/api/attestation/self",
] as const;

/**
 * Connector-webhook COMPANIONS (design §4.4). They mount after `applyRateLimiters`, so without
 * their own bucket they land in `globalLimiter`'s 120/15min — the bucket `/api/chat` shares,
 * and the exact failure this file's header describes for badge traffic. §3.7/§5.4 add three
 * calls per app visit (`GET …/webhooks/pending`, `POST …/webhooks/drain`, plus the delegation
 * probe below) and §3.3 fires them on EVERY mount, so on a shared-NAT office IP or a tab that
 * reloads often this would eat the chat allowance.
 */
export const CONNECTOR_COMPANION_LIMIT = 600 * SHARED_KEY_HEADROOM;
export const CONNECTOR_COMPANION_PATHS = ["/api/connectors/webhooks"] as const;

/**
 * W5's authenticated READ API (backend-ingest plan §8.1 W5) gets its own bucket for exactly the
 * reason above: it is the cohort's meetings view, so ONE visit is a list plus a content GET per
 * meeting opened, and sharing `globalLimiter`'s 120/15min would let scrolling an archive 429 the
 * next chat send. Kept separate from the companions' bucket rather than folded into it — the two
 * surfaces have different callers (the drain card vs. the meetings view) and a busy archive must
 * not be able to exhaust the drain path either. Keyed by IP, like every other bucket here:
 * `applyRateLimiters` runs before `authMiddleware`.
 */
export const CONNECTOR_MEETINGS_LIMIT = 600 * SHARED_KEY_HEADROOM;
export const CONNECTOR_MEETINGS_PATHS = ["/api/connectors/meetings"] as const;

/**
 * `/api/delegations` gets its OWN bucket, not a share of the companions' (§4.4 names the route;
 * S2e bounds one *request*, a bucket bounds a caller). Smaller than the companions': the visit
 * path costs one `GET /status` and, rarely, one mint, and a mint is the most expensive
 * authenticated request in the backend (sequential node round trips per resource). Keyed by IP,
 * because at `applyRateLimiters`' mount position `authMiddleware` has not run yet.
 */
export const DELEGATION_LIMIT = 240 * SHARED_KEY_HEADROOM;
export const DELEGATION_PATHS = ["/api/delegations"] as const;

/**
 * The Google Meet OAuth proxy (gmeet plan §4.1 / §6 WP-A) gets its own bucket for the reason this
 * file's header states: it mounts after `applyRateLimiters`, so without one it would land in
 * `globalLimiter`'s 120/15min — the bucket `/api/chat` shares — and a user who reconnects a couple
 * of times would 429 their own next chat send.
 *
 * SMALL on purpose, and the only bucket here that is. The others exist because a legitimate visit
 * is chatty; this one is the opposite. A whole consent dance costs three requests (`/start`,
 * `/callback`, `/exchange`) and a sync costs at most one `/refresh`, so 30/15min is roughly six
 * reconnects or twenty-odd token mints an hour from one IP — generous for a human, tight for the
 * two abuses that matter on an UNAUTHENTICATED pair of GETs: `/start` is an open 302 into Google's
 * consent screen, and `/callback` renders a page for anyone who asks. Neither may be free.
 *
 * Keyed by IP like every bucket in this file — `applyRateLimiters` runs ahead of `authMiddleware`,
 * so no session is known here even for the three authenticated POSTs.
 */
export const GOOGLE_OAUTH_LIMIT = 30 * SHARED_KEY_HEADROOM;
export const GOOGLE_OAUTH_PATHS = ["/api/connectors/google/oauth"] as const;

/** Authenticated autojoin status polls once a minute; it must not exhaust chat or popup OAuth. */
export const CALENDAR_AUTOJOIN_LIMIT = 240 * SHARED_KEY_HEADROOM;
export const CALENDAR_AUTOJOIN_PATHS = ["/api/connectors/google/autojoin"] as const;

/**
 * The transcriber surface (routes/transcriber.ts) polls: while a bot is joining or in a meeting
 * the settings card re-reads the list every few seconds, and that alone would exhaust the
 * 120/15min global bucket `/api/chat` shares. Own bucket, same reasoning as the meetings view.
 */
export const TRANSCRIBER_LIMIT = 600 * SHARED_KEY_HEADROOM;
export const TRANSCRIBER_PATHS = ["/api/transcriber"] as const;

/**
 * Hosted AssemblyAI uploads (routes/assemblyai-hosted.ts) arrive in 1 MiB parts, because the
 * ingress refuses larger bodies: one 120,960,000-byte recording is 116 part PUTs plus its create.
 * They get their own bucket (and leave the transcriber one) so an upload can never starve the
 * polling that follows it, and one IP fits four full-size uploads per window: more than the
 * per-account daily allowance (three) and the one-active-upload-per-account rule allow anyway.
 */
export const ASSEMBLYAI_HOSTED_UPLOAD_LIMIT = 480 * SHARED_KEY_HEADROOM;
export const ASSEMBLYAI_HOSTED_UPLOAD_PATHS = ["/api/transcriber/assemblyai/hosted/uploads"] as const;

/**
 * Exo private cloud transcription (routes/private-cloud-transcription.ts). The web app polls a
 * running job's status every few seconds for as long as the job runs, so it gets its own bucket
 * and leaves the transcriber one: a long job must not starve the meeting bot's polling, or the
 * other way round.
 */
export const PRIVATE_CLOUD_TRANSCRIPTION_LIMIT = 600 * SHARED_KEY_HEADROOM;
export const PRIVATE_CLOUD_TRANSCRIPTION_PATHS = ["/api/transcriber/private-cloud"] as const;

/** Liveness probes. Exempt from the global bucket and given none of their own: the handler is a
 *  constant JSON body, and a drained bucket must never make monitors report the backend down. */
export const UNLIMITED_PATHS = ["/health"] as const;

const DEDICATED_PATHS = [
  ...VERIFICATION_PATHS,
  ...CONNECTOR_COMPANION_PATHS,
  ...CONNECTOR_MEETINGS_PATHS,
  ...DELEGATION_PATHS,
  ...GOOGLE_OAUTH_PATHS,
  ...CALENDAR_AUTOJOIN_PATHS,
  ...TRANSCRIBER_PATHS,
  ...UNLIMITED_PATHS,
] as const;

function matchesMountPath(path: string, mount: string): boolean {
  return path === mount || path.startsWith(`${mount}/`);
}

/** Mount the global limiter (exempting every path that carries its own bucket) plus one
 *  dedicated limiter per group: verification, connector companions, connector meetings,
 *  delegations, google oauth, transcriber, private cloud transcription, hosted AssemblyAI
 *  uploads. `/health` is in no bucket at all. */
export function applyRateLimiters(app: Express): void {
  app.set("trust proxy", 1);
  const verificationLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: VERIFICATION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const connectorCompanionLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: CONNECTOR_COMPANION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const connectorMeetingsLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: CONNECTOR_MEETINGS_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const delegationLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: DELEGATION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const googleOAuthLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: GOOGLE_OAUTH_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const calendarAutojoinLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: CALENDAR_AUTOJOIN_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const transcriberLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: TRANSCRIBER_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Mounted under /api/transcriber, so the full path is baseUrl + path.
    skip: (req) =>
      [...ASSEMBLYAI_HOSTED_UPLOAD_PATHS, ...PRIVATE_CLOUD_TRANSCRIPTION_PATHS].some((p) =>
        matchesMountPath(`${req.baseUrl}${req.path}`, p),
      ),
  });
  const privateCloudTranscriptionLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const hostedUploadLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: ASSEMBLYAI_HOSTED_UPLOAD_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const globalLimiter = rateLimit({
    windowMs: WINDOW_MS,
    limit: GLOBAL_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: (req) => DEDICATED_PATHS.some((p) => matchesMountPath(req.path, p)),
  });
  app.use(globalLimiter);
  for (const p of VERIFICATION_PATHS) app.use(p, verificationLimiter);
  for (const p of CONNECTOR_COMPANION_PATHS) app.use(p, connectorCompanionLimiter);
  for (const p of CONNECTOR_MEETINGS_PATHS) app.use(p, connectorMeetingsLimiter);
  for (const p of DELEGATION_PATHS) app.use(p, delegationLimiter);
  for (const p of GOOGLE_OAUTH_PATHS) app.use(p, googleOAuthLimiter);
  for (const p of CALENDAR_AUTOJOIN_PATHS) app.use(p, calendarAutojoinLimiter);
  for (const p of TRANSCRIBER_PATHS) app.use(p, transcriberLimiter);
  for (const p of ASSEMBLYAI_HOSTED_UPLOAD_PATHS) app.use(p, hostedUploadLimiter);
  for (const p of PRIVATE_CLOUD_TRANSCRIPTION_PATHS) app.use(p, privateCloudTranscriptionLimiter);
}
