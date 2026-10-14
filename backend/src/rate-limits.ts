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
import { verifySessionToken } from "@tinyboilerplate/server";

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Who a bucket counts (2026-10-14 incident). Not the IP: in production every client reaches the
 * backend from the Phala gateway's one address (the gateway relays TCP to the ingress without
 * the PROXY protocol, so `$remote_addr`, the only XFF entry `trust proxy 1` believes, is the
 * gateway's), and anything a client can reach without the ingress lets it write
 * `X-Forwarded-For` itself. IP keys were one bucket for everyone, and an XFF-derived key is
 * attacker-chosen.
 *
 * So a request carrying a session JWT this backend signed counts against its own address's
 * bucket at `SESSION_LIMITS`. Everything else (no token, a forged, foreign or expired one) shares
 * ONE anonymous bucket per bucket kind, at the `*_LIMIT` constants below: whole-service ceilings
 * sized for 20-30 concurrent clients (one ordinary browser peaked at 148 requests per window;
 * 30 x 148 = 4,440 < 6,000). Nothing a client sends can mint a new key without a valid session,
 * and sessions are minted only through `/api/auth`, whose bucket ignores the bearer
 * (`AUTH_LIMIT`), so new keys per window are bounded whatever the caller holds.
 */
/** How many concurrent clients a polling or read bucket's anonymous ceiling is sized for. */
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
 * not be able to exhaust the drain path either.
 */
export const CONNECTOR_MEETINGS_LIMIT = 600 * SHARED_KEY_HEADROOM;
export const CONNECTOR_MEETINGS_PATHS = ["/api/connectors/meetings"] as const;

/**
 * `/api/delegations` gets its OWN bucket, not a share of the companions' (§4.4 names the route;
 * S2e bounds one *request*, a bucket bounds a caller). Smaller than the companions': the visit
 * path costs one `GET /status` and, rarely, one mint, and a mint is the most expensive
 * authenticated request in the backend (sequential node round trips per resource). Anonymous
 * ceiling not scaled: status reads are on focus/visibility only, and the mint keeps its own
 * 6-per-address-per-hour cap.
 */
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
 * reconnects or twenty-odd token mints an hour per account — generous for a human, tight for the
 * two abuses that matter on an UNAUTHENTICATED pair of GETs: `/start` is an open 302 into Google's
 * consent screen, and `/callback` renders a page for anyone who asks. Neither may be free.
 *
 * `/start` and `/callback` are top-level navigations with no session header, so every client's
 * share the anonymous ceiling: 150, about thirty concurrent reconnects, not scaled by the headroom.
 * The authenticated POSTs count per session (30).
 */
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
 * polling that follows it, and one account fits four full-size uploads per window: more than the
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
 * global bucket. With the paywall off (the compose default) nothing else bounds their spend:
 * usage is recorded only after a completion and requests carry no `max_tokens`. So they get their
 * own bucket, independent of the polling budgets: 120 sends per window per session, and 600
 * shared by everything unauthenticated (which `authMiddleware` then rejects before any upstream
 * call). A request budget, not a dollar guarantee.
 */
export const PAID_CHAT_LIMIT = 600;
export const PAID_CHAT_PATHS = ["/api/chat", "/api/agent/chat"] as const;

/**
 * Session minting (`/api/auth`: `GET /nonce`, `POST /verify`; the only routes that issue a
 * session). ALWAYS one shared bucket, whatever bearer the request carries: a signed-in caller
 * signing in a different wallet would otherwise mint sessions out of its own per-session bucket,
 * so every new key would cost nothing shared. 1200 auth requests per window across the service:
 * about 600 complete nonce+verify sign-ins within one window (nonces live 5 minutes, so a
 * sign-in can straddle a reset), far above 20-30 concurrent sign-ins.
 */
export const AUTH_LIMIT = 1200;
export const AUTH_PATHS = ["/api/auth"] as const;

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
  | "auth"
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
  [AUTH_PATHS, "auth"],
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
/**
 * Per-session ceilings: the pre-incident per-client budgets. Polling and read buckets are the
 * anonymous ceiling divided by `SHARED_KEY_HEADROOM`; spend, consent and mutation buckets are
 * set on their own.
 */
export const SESSION_LIMITS: Record<Exclude<Bucket, "none" | "auth">, number> = {
  global: GLOBAL_LIMIT / SHARED_KEY_HEADROOM,
  verification: VERIFICATION_LIMIT / SHARED_KEY_HEADROOM,
  connectorCompanion: CONNECTOR_COMPANION_LIMIT / SHARED_KEY_HEADROOM,
  connectorMeetings: CONNECTOR_MEETINGS_LIMIT / SHARED_KEY_HEADROOM,
  transcriber: TRANSCRIBER_LIMIT / SHARED_KEY_HEADROOM,
  privateCloudTranscription: PRIVATE_CLOUD_TRANSCRIPTION_LIMIT / SHARED_KEY_HEADROOM,
  hostedUpload: ASSEMBLYAI_HOSTED_UPLOAD_LIMIT / SHARED_KEY_HEADROOM,
  // One user's sends: the old per-client global budget, which chat used to share.
  paidChat: 120,
  privateCloudTranscriptionMutation: 60,
  calendarAutojoin: 240,
  calendarAutojoinMutation: 30,
  googleOAuth: 30,
  delegation: 240,
};

/**
 * Buckets that cost money or third-party capacity per request keep a whole-service ceiling ON
 * TOP of the per-session one. Any fresh wallet can sign in (SIWE, no allowlist) and the paywall
 * defaults off, so per-session buckets alone would scale with the number of addresses. Each
 * request is charged to its own key first and then to this one constant key, so a session
 * already over its own limit is denied without spending the aggregate. Requests without a
 * verified session never count here: all three routes sit behind `authMiddleware`, so they can
 * never reach a cost, and a tokenless flood must not drain the ceiling every signed-in user
 * shares. Draining it takes real sessions (about five at the per-session limits).
 */
export const AGGREGATE_LIMITS: Partial<Record<Exclude<Bucket, "none" | "auth">, number>> = {
  paidChat: PAID_CHAT_LIMIT,
  privateCloudTranscriptionMutation: PRIVATE_CLOUD_TRANSCRIPTION_MUTATION_LIMIT,
  hostedUpload: ASSEMBLYAI_HOSTED_UPLOAD_LIMIT,
};

const ANONYMOUS_KEY = "anonymous";
const AGGREGATE_KEY = "aggregate";

/** The session address a request proves, or null. Memoized per request: each limiter asks for
 *  its key and its limit. Same header parsing as `createAuthMiddleware`. */
const sessionAddresses = new WeakMap<Request, Promise<string | null>>();
function sessionAddress(req: Request, sessionKey: string): Promise<string | null> {
  let address = sessionAddresses.get(req);
  if (!address) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : header;
    address = token
      ? verifySessionToken(token, sessionKey).then(
          (session) => session.address.toLowerCase(),
          () => null,
        )
      : Promise.resolve(null);
    sessionAddresses.set(req, address);
  }
  return address;
}

export interface RateLimitOptions {
  /** The key the backend signs session JWTs with (`BACKEND_PRIVATE_KEY`). */
  sessionKey: string;
}

export function applyRateLimiters(app: Express, { sessionKey }: RateLimitOptions): {
  globalRoutes: GlobalBucketRouteCounter;
  /** Attach to the paid chat route handlers (see `PAID_CHAT_LIMIT`). */
  paidChatLimiter: RequestHandler;
} {
  // No limiter reads req.ip any more; other code (the connector webhook pre-limiter) still does.
  app.set("trust proxy", 1);
  const bucket = (kind: Exclude<Bucket, "none">, anonymous: number, skip?: (req: Request) => boolean) =>
    rateLimit({
      windowMs: WINDOW_MS,
      // `auth` never looks at the bearer: see `AUTH_LIMIT`.
      limit: async (req) =>
        kind !== "auth" && (await sessionAddress(req, sessionKey)) ? SESSION_LIMITS[kind] : anonymous,
      keyGenerator: async (req) => {
        const address = kind === "auth" ? null : await sessionAddress(req, sessionKey);
        return address ? `session:${address}` : ANONYMOUS_KEY;
      },
      standardHeaders: "draft-7",
      legacyHeaders: false,
      ...(skip ? { skip } : {}),
    });
  // The aggregate ceiling sends no RateLimit headers: they describe the caller's own bucket.
  const aggregate = (kind: keyof typeof AGGREGATE_LIMITS, skip?: (req: Request) => boolean) =>
    rateLimit({
      windowMs: WINDOW_MS,
      limit: AGGREGATE_LIMITS[kind]!,
      keyGenerator: () => AGGREGATE_KEY,
      standardHeaders: false,
      legacyHeaders: false,
      skip: async (req) => (skip?.(req) ?? false) || !(await sessionAddress(req, sessionKey)),
    });
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
    auth: AUTH_LIMIT,
    global: GLOBAL_LIMIT,
  };
  for (const [kind, anonymous] of Object.entries(limits) as [keyof typeof limits, number][]) {
    // Mounted at the app root, so req.path is the full path.
    const skip = (req: Request) => bucketFor(req.method, req.path) !== kind;
    app.use(bucket(kind, anonymous, skip));
    if (kind !== "auth" && kind in AGGREGATE_LIMITS) app.use(aggregate(kind, skip));
  }
  // Paid chat is charged ONCE per request: at the root when the classifier recognises the path
  // (so the global bucket skips it), otherwise at the handler. A spelling the classifier misses
  // is charged to global AND paid chat, never to neither.
  const paidChat = bucket("paidChat", PAID_CHAT_LIMIT);
  const paidChatAggregate = aggregate("paidChat");
  const paidChatCharged = new WeakSet<Request>();
  const paidChatLimiter: RequestHandler = (req, res, next) => {
    if (paidChatCharged.has(req)) return next();
    paidChatCharged.add(req);
    return paidChat(req, res, (error?: unknown) => (error ? next(error) : paidChatAggregate(req, res, next)));
  };
  app.use((req, res, next) => (bucketFor(req.method, req.path) === "paidChat" ? paidChatLimiter(req, res, next) : next()));
  return { globalRoutes, paidChatLimiter };
}
