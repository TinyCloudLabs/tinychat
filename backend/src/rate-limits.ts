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
import type { Express, Request, RequestHandler } from "express";

const WINDOW_MS = 15 * 60 * 1000;

/**
 * INTERIM (2026-10-14 incident): every bucket below is keyed by `req.ip`, but in production
 * `req.ip` is the same address for EVERY client. The Phala gateway relays TCP to the ingress
 * without the PROXY protocol, so nginx's `$remote_addr` (the only XFF entry `trust proxy 1`
 * believes) is the gateway's. Each "per-IP" ceiling is therefore a whole-service ceiling: the
 * 120 global bucket drained and 429'd every user, and anyone sending 120 requests could do the
 * same on purpose. The drain source is not known yet (`GlobalBucketRouteCounter` below exists to
 * find it); one ordinary browser peaked at 148 requests per window across all buckets.
 *
 * Until per-client keying lands, the polling and read ceilings are their per-client budget
 * times this many concurrent clients, so 20-30 active users behind the one shared key stay
 * under them (30 x 148 = 4,440 < 6,000). Requests that cost money, touch third-party consent or
 * mutate are NOT scaled: paid chat, Google OAuth and the private cloud / calendar mutations
 * carry fixed ceilings below. Revert to 1 with the per-client keying fix.
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
/** Not scaled: status reads are on focus/visibility only, and the mint keeps its own
 *  6-per-address-per-hour cap, so 600 is ample behind the shared key. */
export const DELEGATION_LIMIT = 600;
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
/** Not scaled by `SHARED_KEY_HEADROOM`: a low-volume consent/token flow, so 150 is about thirty
 *  concurrent reconnects behind the shared key while keeping the open 302 bounded. */
export const GOOGLE_OAUTH_LIMIT = 150;
export const GOOGLE_OAUTH_PATHS = ["/api/connectors/google/oauth"] as const;

/** Authenticated autojoin status polls once a minute; it must not exhaust chat or popup OAuth.
 *  Reads (GET/HEAD) poll; setup and other mutations are rare and get a far smaller ceiling. */
export const CALENDAR_AUTOJOIN_LIMIT = 3000;
export const CALENDAR_AUTOJOIN_MUTATION_LIMIT = 150;
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
/** Creating, cancelling or deleting a job is not polling: the reads above keep the polling
 *  budget, mutations get their own small one. */
export const PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT = 300;
export const PRIVATE_CLOUD_TRANSCRIPTION_PATHS = ["/api/transcriber/private-cloud"] as const;

/**
 * Paid chat: `POST /api/chat` and `POST /api/agent/chat` start an upstream model call.
 * The limiter is attached to those two route handlers themselves (`paidChatLimiter`, returned by
 * `applyRateLimiters`), so ANY path Express routes to them is charged here, whatever its slashes
 * or case. The paths below only let the root classifier keep the usual spellings out of the
 * global bucket. With the
 * paywall off (the compose default) nothing else bounds their spend: usage is recorded only after
 * a completion and requests carry no `max_tokens`. So they get their own bucket, NOT the global
 * one scaled by the headroom: 600 sends per window across everyone while the key is shared
 * (~20-30 sends per active user), independent of the polling budgets.
 */
export const PAID_CHAT_LIMIT = 600;
export const PAID_CHAT_PATHS = ["/api/chat", "/api/agent/chat"] as const;

/** Liveness probes, matched exactly (`/health` or `/health/`). Exempt from every bucket: the
 *  handler only serializes in-memory state, and a drained bucket must never make monitors report
 *  the backend down. */
export const UNLIMITED_PATHS = ["/health"] as const;

export type Bucket =
  | "verification"
  | "connectorCompanion"
  | "connectorMeetings"
  | "delegation"
  | "googleOAuth"
  | "calendarAutojoin"
  | "calendarAutojoinMutation"
  | "transcriber"
  | "privateCloudTranscription"
  | "privateCloudTranscriptionMutation"
  | "hostedUpload"
  | "paidChat"
  | "global"
  | "none";

/** Most specific first: a nested prefix (private cloud, hosted uploads) wins over its parent. */
const PREFIX_BUCKETS: ReadonlyArray<readonly [readonly string[], Bucket]> = [
  [PRIVATE_CLOUD_TRANSCRIPTION_PATHS, "privateCloudTranscription"],
  [ASSEMBLYAI_HOSTED_UPLOAD_PATHS, "hostedUpload"],
  [TRANSCRIBER_PATHS, "transcriber"],
  [VERIFICATION_PATHS, "verification"],
  [CONNECTOR_COMPANION_PATHS, "connectorCompanion"],
  [CONNECTOR_MEETINGS_PATHS, "connectorMeetings"],
  [DELEGATION_PATHS, "delegation"],
  [GOOGLE_OAUTH_PATHS, "googleOAuth"],
  [CALENDAR_AUTOJOIN_PATHS, "calendarAutojoin"],
];

function matchesMountPath(path: string, mount: string): boolean {
  return path === mount || path.startsWith(`${mount}/`);
}

/** Runs of slashes collapsed: Express mounts route `/api/agent//chat` like `/api/agent/chat`.
 *  Not applied to the `/health` exemption, which stays exact. */
function collapseSlashes(path: string): string {
  return path.replace(/\/{2,}/g, "/");
}

/** `/api/chat/` → `/api/chat`; keeps `/`. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Exactly `/health` or `/health/`, any case. Not a prefix: `/health/anything` and the raw
 *  `/health/../api/chat` are global-limited like any other path. */
function isUnlimitedPath(path: string): boolean {
  return UNLIMITED_PATHS.some((p) => path === p || path === `${p}/`);
}

const READ_METHODS = new Set(["GET", "HEAD"]);

/** Buckets whose non-read requests count against a separate, smaller mutation bucket. */
const MUTATION_BUCKETS: Partial<Record<Bucket, Bucket>> = {
  privateCloudTranscription: "privateCloudTranscriptionMutation",
  calendarAutojoin: "calendarAutojoinMutation",
};

/**
 * The ONE bucket a request counts against. Express routes case-insensitively, so the path is
 * lower-cased first: `/API/Transcriber/PRIVATE-CLOUD/…` must land in the same single bucket as
 * the route it reaches, not in several (or in the global one by mismatch).
 */
export function bucketFor(method: string, rawPath: string): Bucket {
  if (isUnlimitedPath(rawPath.toLowerCase())) return "none";
  const path = collapseSlashes(rawPath.toLowerCase());
  if (method === "POST" && PAID_CHAT_PATHS.some((p) => withoutTrailingSlash(path) === p)) return "paidChat";
  for (const [mounts, bucket] of PREFIX_BUCKETS) {
    if (mounts.some((m) => matchesMountPath(path, m))) {
      const mutation = MUTATION_BUCKETS[bucket];
      return mutation && !READ_METHODS.has(method) ? mutation : bucket;
    }
  }
  return "global";
}

/**
 * Route templates for the requests the GLOBAL bucket charges, most specific first. The global
 * bucket's drain source is unknown, so it is counted per route: a template or mount (never the
 * raw path, a query string or anything identifying the client), and a fixed list so a client
 * cannot grow the map. Anything else is `other`.
 */
const GLOBAL_ROUTE_TEMPLATES = [
  "/api/agent/session",
  "/api/agent",
  "/api/chat/models",
  "/api/chat/model-selection",
  "/api/chat",
  "/api/billing/config",
  "/api/billing/rates",
  "/api/billing/status",
  "/api/billing/checkout",
  "/api/billing/portal",
  "/api/billing",
  "/api/auth/nonce",
  "/api/auth/verify",
  "/api/auth",
  "/api/manifest",
  "/api/server-info",
  "/api/connectors/credentials",
  "/api/connectors",
  "/api/openapi.json",
  "/api/docs",
  "/api",
  "/health",
] as const;

const COUNTED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function globalRouteLabel(rawMethod: string, rawPath: string): string {
  const method = COUNTED_METHODS.has(rawMethod) ? rawMethod : "OTHER";
  const path = collapseSlashes(rawPath.toLowerCase());
  const template = GLOBAL_ROUTE_TEMPLATES.find((t) => matchesMountPath(path, t));
  const route = !template ? "other" : path === template ? template : `${template}/*`;
  return `${method} ${route}`;
}

export interface RouteCount {
  route: string;
  count: number;
}

/** Requests charged to the global bucket, per route label, since start and since the last
 *  `takeInterval()`. Allowed and denied requests both count. */
export class GlobalBucketRouteCounter {
  private readonly total = new Map<string, number>();
  private interval = new Map<string, number>();
  private cachedTop: { n: number; summary: { total: number; top: RouteCount[] } } | null = null;
  readonly since = new Date().toISOString();

  record(method: string, path: string): void {
    const label = globalRouteLabel(method, path);
    this.total.set(label, (this.total.get(label) ?? 0) + 1);
    this.interval.set(label, (this.interval.get(label) ?? 0) + 1);
    this.cachedTop = null;
  }

  /** Top `n` routes since start, plus the total. Sorted once per change, not once per probe. */
  top(n = 10): { since: string; total: number; top: RouteCount[] } {
    if (this.cachedTop?.n !== n) this.cachedTop = { n, summary: summarize(this.total, n) };
    return { since: this.since, ...this.cachedTop.summary };
  }

  /** One stdout line for the routes charged since the previous call, then resets them. */
  takeInterval(n = 10): string {
    const { total, top } = summarize(this.interval, n);
    this.interval = new Map();
    const routes = top.map((r) => `${r.route}=${r.count}`).join(" ");
    return `[rate-limit] op=global-bucket-routes window=5m total=${total} top=${JSON.stringify(routes)}`;
  }
}

function summarize(counts: Map<string, number>, n: number): { total: number; top: RouteCount[] } {
  let total = 0;
  for (const count of counts.values()) total += count;
  const top = [...counts.entries()]
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route))
    .slice(0, n);
  return { total, top };
}

/** Log the global bucket's per-route counts every `everyMs` (default 5 minutes). */
export function logGlobalBucketRoutes(counter: GlobalBucketRouteCounter, everyMs = 5 * 60_000): void {
  setInterval(() => console.log(counter.takeInterval()), everyMs).unref();
}

/** Mount one app-level limiter per bucket; each counts only the requests `bucketFor` assigns it,
 *  so every request lands in exactly one bucket (or none, for `/health`). */
export function applyRateLimiters(app: Express): {
  globalRoutes: GlobalBucketRouteCounter;
  /** Attach to the paid chat route handlers (see `PAID_CHAT_LIMIT`). */
  paidChatLimiter: RequestHandler;
} {
  app.set("trust proxy", 1);
  const globalRoutes = new GlobalBucketRouteCounter();
  app.use((req, _res, next) => {
    if (bucketFor(req.method, req.path) === "global") globalRoutes.record(req.method, req.path);
    next();
  });
  const limits: Record<Exclude<Bucket, "none" | "paidChat">, number> = {
    verification: VERIFICATION_LIMIT,
    connectorCompanion: CONNECTOR_COMPANION_LIMIT,
    connectorMeetings: CONNECTOR_MEETINGS_LIMIT,
    delegation: DELEGATION_LIMIT,
    googleOAuth: GOOGLE_OAUTH_LIMIT,
    calendarAutojoin: CALENDAR_AUTOJOIN_LIMIT,
    calendarAutojoinMutation: CALENDAR_AUTOJOIN_MUTATION_LIMIT,
    transcriber: TRANSCRIBER_LIMIT,
    privateCloudTranscription: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT,
    privateCloudTranscriptionMutation: PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT,
    hostedUpload: ASSEMBLYAI_HOSTED_UPLOAD_LIMIT,
    global: GLOBAL_LIMIT,
  };
  for (const [bucket, limit] of Object.entries(limits)) {
    app.use(
      rateLimit({
        windowMs: WINDOW_MS,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        // Mounted at the app root, so req.path is the full path.
        skip: (req) => bucketFor(req.method, req.path) !== bucket,
      }),
    );
  }
  // Paid chat is charged ONCE per request: at the root when the classifier recognises the path
  // (so the global bucket skips it), otherwise at the handler. A spelling the classifier misses
  // is charged to global AND paid chat, never to neither.
  const paidChat = rateLimit({
    windowMs: WINDOW_MS,
    limit: PAID_CHAT_LIMIT,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  const paidChatCharged = new WeakSet<Request>();
  const paidChatLimiter: RequestHandler = (req, res, next) => {
    if (paidChatCharged.has(req)) return next();
    paidChatCharged.add(req);
    return paidChat(req, res, next);
  };
  app.use((req, res, next) => (bucketFor(req.method, req.path) === "paidChat" ? paidChatLimiter(req, res, next) : next()));
  return { globalRoutes, paidChatLimiter };
}
