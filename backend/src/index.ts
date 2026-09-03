import "./types/index.js";

import { existsSync, readFileSync } from "fs";
import { createServer as createHttpsServer } from "https";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express from "express";
import { apiReference } from "@scalar/express-api-reference";
import { load as loadYaml } from "js-yaml";
import {
  DelegationCache,
  DelegationStore,
  createCsrfMiddleware,
  createNonceStore,
} from "@tinyboilerplate/server";
import { applySecurityDefaults } from "./security.js";
import { applyRateLimiters, createRecoveryRateLimiter } from "./rate-limits.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAuthRouter } from "./routes/auth.js";
import { createDelegationRouter } from "./routes/delegations.js";
import { createAgentRouter } from "./routes/agent.js";
import { createManifestRouter } from "./routes/manifest.js";
import { createChatRouter, defaultModel } from "./routes/chat.js";
import { LedgerFlusher } from "./billing/ledger-flusher.js";
import { LedgerRehydrator } from "./billing/ledger-rehydrate.js";
import { isOfferedModel } from "./billing/catalog.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "./entity-id.js";
import { createSignatureRouter } from "./routes/signature.js";
import { createNrasProxyRouter } from "./routes/nras-proxy.js";
import { createPhalaVerifyRouter } from "./routes/phala-verify.js";
import { createAttestationSelfRouter } from "./routes/attestation-self.js";
import { createServerInfoRouter } from "./routes/server-info.js";
import { createBillingRouter } from "./routes/billing.js";
import { createBillingWebhookHandler } from "./routes/billing-webhook.js";
import {
  ConnectorControlStore,
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  createConnectorWebhookHandler,
  createConnectorWebhookHostGuard,
  createConnectorWebhookParserErrorHandler,
  connectorDrainAbort,
  resolveWebhookHostAllowlist,
  DEFAULT_CONNECTOR_SOURCE,
} from "./routes/connector-webhooks.js";
import { createConnectorCredentialRouter } from "./routes/connector-credentials.js";
import { createConnectorMeetingsRouter } from "./routes/connector-meetings.js";
import { createGoogleOAuthRouter, normalizeAppOrigin } from "./routes/google-oauth.js";
import {
  createTranscriberRouter,
  shouldBypassGlobalJsonParserForTranscriberRecovery,
} from "./routes/transcriber.js";
import {
  createTranscriptionApiClient,
  transcriptionApiConfigFromEnv,
} from "./services/transcription-api.js";
import { KvTranscriberIndexStore } from "./services/transcriber-index.js";
import { transcriberRecoveryConfigFromEnv } from "./services/transcriber-recovery-config.js";
import { BackendStorageLane } from "./services/backend-storage-lane.js";
import { ConnectorQueue } from "./services/connector-queue.js";
import { ConnectorTeardownService } from "./services/connector-teardown.js";
import {
  ContentStore,
  KvContentBlobStore,
  validateContentCustodyConfig,
} from "./services/content-store.js";
import {
  CredentialStore,
  KvCredentialRowStore,
  validateCredentialCustodyConfig,
} from "./services/credential-store.js";
import {
  createRefreshingCredentialLookup,
  FirefliesOAuthClient,
  firefliesOAuthConfigFromEnv,
} from "./services/fireflies-oauth.js";
import {
  googleMeetOAuthEnabled,
  googleOAuthConfigFromEnv,
} from "./services/google-oauth.js";
import { ConnectorFetchWorker } from "./services/fetch-worker.js";
import { FirefliesMeetingFetcher } from "./services/fireflies-fetch.js";
import { backendIngestEnabled, IngestModeService } from "./services/ingest-mode.js";
import {
  IngestInstanceGuard,
  IngestInstanceSupervisor,
  KvInstanceLeaseStore,
} from "./services/ingest-instance.js";
import { createIngestOnDelivery } from "./services/ingest-nudge.js";
import { IngestRetentionSweeper } from "./services/ingest-retention.js";
import { IngestObservabilityReporter } from "./services/ingest-observability.js";
import {
  ConnectorDrainWorker,
  createWebhookConfigDirectory,
  drainIntervalFromEnv,
  startConnectorQueueMaintenanceTimer,
} from "./services/connector-drain.js";
import { assertStrongSecret, WebhookTokenService } from "./services/webhook-tokens.js";
import { APP_ID } from "./manifest.js";
import { createTinychatBackendIdentity } from "./startup.js";
import { appCorsOrigins } from "./cors-origins.js";

const BACKEND_PRIVATE_KEY = process.env.BACKEND_PRIVATE_KEY;
const TINYCLOUD_HOST = process.env.TINYCLOUD_HOST ?? "https://node.tinycloud.xyz";
const PORT = Number.parseInt(process.env.PORT ?? "3014", 10);
const DEFAULT_HTTPS_CERT_FILE = "../frontend/localhost.pem";
const DEFAULT_HTTPS_KEY_FILE = "../frontend/localhost-key.pem";
const hasDefaultTlsFiles =
  existsSync(resolve(process.cwd(), DEFAULT_HTTPS_CERT_FILE)) &&
  existsSync(resolve(process.cwd(), DEFAULT_HTTPS_KEY_FILE));
const HTTPS_CERT_FILE =
  process.env.HTTPS_CERT_FILE ?? (hasDefaultTlsFiles ? DEFAULT_HTTPS_CERT_FILE : undefined);
const HTTPS_KEY_FILE =
  process.env.HTTPS_KEY_FILE ?? (hasDefaultTlsFiles ? DEFAULT_HTTPS_KEY_FILE : undefined);
const FRONTEND_URL =
  process.env.FRONTEND_URL ??
  (HTTPS_CERT_FILE && HTTPS_KEY_FILE ? "https://localhost:5186" : "http://localhost:5186");

// Milestone E — direct-to-agent delegation courier to eliza-service.
// AGENT_DID: the did:pkh all users delegate to (eliza-service's stable identity).
// ELIZA_SERVICE_URL / ELIZA_SERVICE_SECRET: where to courier + the Layer-1 credential.
const AGENT_DID = process.env.AGENT_DID;
const ELIZA_SERVICE_URL = process.env.ELIZA_SERVICE_URL;
const ELIZA_SERVICE_SECRET = process.env.ELIZA_SERVICE_SECRET;

// §E.6/E.7 — ledger shadow-push + lazy rehydrate (additive; disabled when unset).
// Mirrors the ELIZA_SERVICE_URL/ELIZA_SERVICE_SECRET outbound-service precedent.
const LEDGER_SERVICE_URL = process.env.LEDGER_SERVICE_URL;
const LEDGER_SERVICE_SECRET = process.env.LEDGER_SERVICE_SECRET;

type LedgerStartupEnv = {
  LEDGER_AUTHORITATIVE?: string;
  LEDGER_SERVICE_URL?: string;
  LEDGER_SERVICE_SECRET?: string;
  LEDGER_OUTAGE_POLICY?: string;
};

const VALID_LEDGER_OUTAGE_POLICIES = new Set(["bounded_k", "fail_open", "fail_closed"]);

/**
 * The Fireflies OAuth client (custody branch b1), built once and only when the dark ingest flag
 * is armed — `firefliesOAuthConfigFromEnv` throws on an unregistered app, and boot has already
 * checked it above, so this cannot fail later at request time for a config reason.
 */
let firefliesOAuthClient: FirefliesOAuthClient | null = null;
function firefliesOAuth(): FirefliesOAuthClient {
  firefliesOAuthClient ??= new FirefliesOAuthClient(firefliesOAuthConfigFromEnv());
  return firefliesOAuthClient;
}

/**
 * Connector webhooks ship dark (§7.1): flag off means the public route is not mounted (404 —
 * the deploy-probe canary), the authenticated companions 404, and the frontend section hides.
 */
export function connectorWebhooksEnabled(): boolean {
  return process.env.CONNECTOR_WEBHOOKS_ENABLED === "true";
}

/**
 * Google Meet OAuth ships dark on the same terms (gmeet plan §6 WP-A / §11):
 * `GOOGLE_MEET_OAUTH_ENABLED` off ⇒ the five `/api/connectors/google/oauth/*` routes are never
 * mounted, so every one of them 404s — the identical canary shape `connectorWebhooksEnabled()`
 * gives the webhook route.
 *
 * RE-EXPORTED rather than redefined here. The flag that decides the MOUNT and the flag
 * `googleOAuthConfigFromEnv` reads to decide "armed ⇒ the client vars are mandatory" have to be
 * one function: two copies could drift into a deployment that mounts the routes without ever
 * demanding a client id, which is precisely the half-armed state the boot check below refuses.
 */
export { googleMeetOAuthEnabled };

/**
 * The ONLY two paths under the Google OAuth mount that run without `authMiddleware`.
 *
 * An allowlist, deliberately, rather than a "skip auth when the method is GET": a GET added to
 * that router later is authenticated by default, which is the direction an accident should fall.
 * These two are unauthenticated by necessity — `/callback` is a top-level browser navigation from
 * Google that carries no Bearer at all, and `/start` is the same navigation one hop earlier.
 */
export const GOOGLE_OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/start",
  "/callback",
]);

/**
 * Presence is NOT the check that matters (§7.1/§4.2). §4.2's derivation hands every consenting
 * user a complete (public salt, known info, displayed 32-byte output) oracle against
 * `WEBHOOK_HMAC_MASTER`, testable offline at any rate — so a weak master is a silent, total
 * compromise of delivery authentication for the whole cohort. Refuse to boot on one.
 */
export function validateConnectorWebhookSecrets(env: NodeJS.ProcessEnv): {
  ok: true;
} | { ok: false; error: string } {
  try {
    assertStrongSecret("WEBHOOK_HMAC_MASTER", env.WEBHOOK_HMAC_MASTER);
    assertStrongSecret("WEBHOOK_HMAC_MASTER_PREV", env.WEBHOOK_HMAC_MASTER_PREV, {
      optional: true,
    });
    assertStrongSecret("LOG_HASH_SALT", env.LOG_HASH_SALT);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function validateLedgerStartupConfig(
  env: LedgerStartupEnv,
): { ok: true } | { ok: false; error: string } {
  if (
    env.LEDGER_AUTHORITATIVE === "true" &&
    (!env.LEDGER_SERVICE_URL || !env.LEDGER_SERVICE_SECRET)
  ) {
    return {
      ok: false,
      error:
        "LEDGER_AUTHORITATIVE=true requires both LEDGER_SERVICE_URL and LEDGER_SERVICE_SECRET; refusing to start with ledger enforcement silently disabled.",
    };
  }

  if (
    env.LEDGER_OUTAGE_POLICY !== undefined &&
    !VALID_LEDGER_OUTAGE_POLICIES.has(env.LEDGER_OUTAGE_POLICY)
  ) {
    return {
      ok: false,
      error:
        "LEDGER_OUTAGE_POLICY must be one of bounded_k, fail_open, or fail_closed; refusing to start with an unrecognized policy.",
    };
  }

  return { ok: true };
}

async function main() {
  const ledgerStartupConfig = validateLedgerStartupConfig({
    LEDGER_AUTHORITATIVE: process.env.LEDGER_AUTHORITATIVE,
    LEDGER_SERVICE_URL,
    LEDGER_SERVICE_SECRET,
    LEDGER_OUTAGE_POLICY: process.env.LEDGER_OUTAGE_POLICY,
  });
  if (!ledgerStartupConfig.ok) {
    console.error(`[startup] FATAL LEDGER CONFIGURATION ERROR: ${ledgerStartupConfig.error}`);
    process.exit(1);
    return;
  }

  if (connectorWebhooksEnabled()) {
    const webhookSecrets = validateConnectorWebhookSecrets(process.env);
    if (!webhookSecrets.ok) {
      console.error(webhookSecrets.error);
      process.exit(1);
      return;
    }
  }

  // WP-A — armed-but-unregistered is a BOOT failure, the same posture the Fireflies config check
  // below has (`firefliesOAuthConfigFromEnv`, :236). An operator who sets GOOGLE_MEET_OAUTH_ENABLED
  // and forgets a client var must learn it from a refused start, never from a user stranded on a
  // half-finished consent screen — and the message names the missing VARS only, never a value,
  // because one of them is the client secret and this CVM logs publicly.
  if (googleMeetOAuthEnabled()) {
    try {
      googleOAuthConfigFromEnv(process.env);
      // The callback page's `postMessage` target, validated at boot rather than at the first
      // consent. This web origin is also one member of the CORS allowlist; Exo's fixed Tauri origin
      // is the other. The callback deliberately stays pinned to the web origin because the desktop
      // Google OAuth handoff has not been designed yet. A bare host or `*` throws here.
      normalizeAppOrigin(FRONTEND_URL);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
      return;
    }
  }

  // W2 — the credential-custody master (backend-ingest plan §6.2). Gated on the DARK ingest flag,
  // so a deployment that never enables backend ingestion needs none of this; armed, it gets the
  // same refuse-boot-on-weak-master posture WEBHOOK_HMAC_MASTER has, because from that moment the
  // backend holds a full-scope Fireflies credential per cohort user.
  if (backendIngestEnabled()) {
    const custody = validateCredentialCustodyConfig(process.env);
    if (!custody.ok) {
      console.error(custody.error);
      process.exit(1);
      return;
    }
    // W4 — the content-envelope master (backend-ingest plan §8.1 W4 / DECISIONS D3). Same gate,
    // same reason, one invariant further: armed, the backend also holds a copy of the meeting
    // itself. It must SURVIVE redeploys — a deploy that drops it orphans every stored meeting.
    const contentCustody = validateContentCustodyConfig(process.env);
    if (!contentCustody.ok) {
      console.error(contentCustody.error);
      process.exit(1);
      return;
    }
    try {
      firefliesOAuthConfigFromEnv(process.env);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
      return;
    }
    // W9 (findings §6 control 6) — the Host-header allowlist is a Gate 5 control under backend
    // ingest, so its ABSENCE at boot must be as loud as an absent master. Silent-null is the same
    // fallback-that-hides-an-error posture the two masters explicitly refuse. Either a resolvable
    // allowlist (explicit list or a parseable public origin) or the loud "*" opt-out.
    let hostAllowlist: ReadonlySet<string> | null;
    try {
      hostAllowlist = resolveWebhookHostAllowlist(process.env);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
      return;
    }
    const hostArm =
      process.env.CONNECTOR_WEBHOOK_HOST_ALLOWLIST?.trim() === "*"
        ? "disabled_explicit"
        : hostAllowlist === null
          ? "absent"
          : process.env.CONNECTOR_WEBHOOK_HOST_ALLOWLIST?.trim()
            ? "explicit"
            : "derived";
    if (hostArm === "absent") {
      console.error(
        "CONNECTOR_WEBHOOK_HOST_ALLOWLIST or CONNECTOR_WEBHOOK_PUBLIC_ORIGIN must be set " +
          "when CONNECTOR_BACKEND_INGEST_ENABLED=true (use CONNECTOR_WEBHOOK_HOST_ALLOWLIST=\"*\" " +
          "to disable explicitly).",
      );
      process.exit(1);
      return;
    }
    console.log(
      `[startup] op=host-allowlist result=ok arm=${hostArm} ` +
        `t=${new Date().toISOString()}`,
    );
  }

  if (!BACKEND_PRIVATE_KEY) {
    console.error(
      "BACKEND_PRIVATE_KEY is required. Generate one from the repo root with `bun run generate-key`.",
    );
    process.exit(1);
    return;
  }
  const backendPrivateKey = BACKEND_PRIVATE_KEY;

  const { node, did } = await createTinychatBackendIdentity({
    privateKey: backendPrivateKey,
    host: TINYCLOUD_HOST,
  });

  // §E.6/E.7 — construct and start the ledger flusher + rehydrator when configured.
  let ledgerFlusher: LedgerFlusher | undefined;
  let ledgerRehydrator: LedgerRehydrator | undefined;
  if (LEDGER_SERVICE_URL && LEDGER_SERVICE_SECRET) {
    ledgerFlusher = new LedgerFlusher(LEDGER_SERVICE_URL, LEDGER_SERVICE_SECRET);
    ledgerFlusher.start();
    ledgerRehydrator = new LedgerRehydrator(LEDGER_SERVICE_URL, LEDGER_SERVICE_SECRET);
    console.log("[startup] ledger shadow-push + rehydration enabled.");
  } else {
    console.warn(
      "[startup] LEDGER_SERVICE_URL / LEDGER_SERVICE_SECRET not set — " +
        "ledger shadow-push + rehydration disabled.",
    );
  }
  const delegationStore = new DelegationStore(node);
  const delegationCache = new DelegationCache();
  const nonceStore = createNonceStore();
  const authMiddleware = createAuthMiddleware(backendPrivateKey);
  // No `createDelegationMiddleware(...)` here. Under Option B no route reaches user-space KV
  // through a delegated accessor, so nothing consumes `req.delegatedAccess`; the drain worker
  // runs outside the Express chain and re-validates the stored record itself (§2.2, §3.6). The
  // factory is wired only when an Option A writer path lands — until then it is a live handle
  // on the delegation cache built at startup for no reader.

  const app = express();
  app.set("trust proxy", 1);
  applySecurityDefaults(app);
  app.use(cors({ origin: appCorsOrigins(FRONTEND_URL) }));

  // Stripe webhook MUST be mounted before the JSON body parser and CSRF
  // middleware: it needs the raw request bytes for signature verification, and
  // Stripe's servers do not send the X-Requested-With CSRF header.
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    createBillingWebhookHandler(),
  );

  // ONE set of instances shared by BOTH connector mounts, the public one below and the
  // authenticated companions further down (§3.6/§4.4): the companions' teardown must evict the
  // very token cache the public route reads, and `GET …/webhooks/pending` must see the queue
  // the public route enqueued into. Two instances would make revocation look like it worked.
  const connectorWebhooks = connectorWebhooksEnabled()
    ? (() => {
        const tokens = new WebhookTokenService(node);
        // §9.3 — one shared lane for every component that writes to the backend space (queue,
        // content store, credential store). TinyCloud drops concurrent responses on one space,
        // so cross-component writes MUST funnel through the same lane; two lanes are no lane.
        const backendStorageLane = new BackendStorageLane();
        const queue = new ConnectorQueue(node, { storageLane: backendStorageLane });
        const control = new ConnectorControlStore(node);
        // W1 — ONE ingest-mode service for both mounts, for the same reason the token cache and
        // the queue are shared: the delivery path's "is this address the worker's?" and the
        // companions' "may this browser drain?" must never disagree. Dark by default
        // (CONNECTOR_BACKEND_INGEST_ENABLED); with the flag off it makes no node call at all.
        const modes = new IngestModeService(node);
        return {
          limiters: new ConnectorWebhookLimiters(),
          tokens,
          queue,
          control,
          modes,
          backendStorageLane,
          // §5.4/§4.7 — the drain worker. Under OPTION C it surfaces the pending id list to the
          // user who is right here and writes NOTHING to the user's space; no writer is wired
          // in. §3.6 rule 3's abort flag is here; rule 1's stored-record re-validation is NOT,
          // and must not be: the backend holds no connector delegation, so the only record a
          // gate could re-validate is the app's unrelated chat delegation. Wiring it would make
          // an expired chat grant silently stop the connector card and prompt the user to
          // re-authorize something this feature never used.
          drain: new ConnectorDrainWorker({
            tokens,
            queue,
            control,
            abort: connectorDrainAbort,
          }),
        };
      })()
    : null;

  // W9 / D4 — the process that actually CONSUMES the cohort queues, or nothing at all. Assigned
  // below only when the dark flag is armed; `shutdown` releases its lease so a rolling deploy
  // hands the seat over instead of idling out the TTL.
  let ingestSupervisor: IngestInstanceSupervisor | null = null;

  // The connectors webhook MUST be mounted before the JSON body parser and CSRF middleware:
  // the HMAC is computed over the exact bytes Fireflies signed, and Fireflies does not send
  // the X-Requested-With CSRF header. It also mounts before applyRateLimiters, so it carries
  // its OWN limiter — an unauthenticated public route must not share the global per-IP bucket
  // in either direction (burst deliveries must not be dropped; a scanner must not be free).
  if (connectorWebhooks) {
    const connectorWebhookLimiters = connectorWebhooks.limiters;
    // IP-ONLY pre-limiter, large. It rejects only an already-tripped bucket and counts a
    // request ONLY once the handler reports it failed the §4.1 format check or resolved to no
    // registered token. It must NOT key on req.params.token: that is unvalidated attacker
    // input, it runs before the traversal guard, and it would grow one store entry per
    // attacker-chosen URL segment. The (ip, token) failure bucket is checked and incremented
    // INSIDE the handler, after the token->address lookup, because only then is the token
    // known to be registered (§4.4).
    const connectorWebhookIpPreLimiter = connectorWebhookLimiters.ipPreLimiter;
    // app.post on the EXACT two-segment path — NEVER app.use on the prefix. An app.use in the
    // raw window would also run for the authenticated companions (/config, /pending, /drain):
    // it would Buffer-ify their JSON bodies and set req._body so the global parser skips them,
    // and it would apply a token-keyed limiter whose key is undefined there, collapsing every
    // user into one bucket. Companion routes must stay ONE segment deep (index-wiring.test.ts
    // pins both halves).
    app.post(
      "/api/connectors/webhooks/:source/:token",
      // W9 (plan §8.1 W9 / §10; findings §6 control 6) — the Host-header allowlist, FIRST on the
      // chain: ahead of the pre-limiter, ahead of `express.raw`, so a delivery that did not arrive
      // at the hostname we minted into the provider's dashboard is refused before a byte of its
      // body is read. It is load-bearing under backend ingest — where an off-target delivery
      // would cost a credentialed upstream fetch and a server-side content row rather than one
      // enqueue — and STRICTLY GATED on `backendIngestEnabled()`. Plan §5.3 / §8.1 W1 require
      // non-cohort behavior to be byte-identical; the ingress-presented host is UNDETERMINED in
      // this repo (see docs/connector-webhooks-trust-proxy.md), so under Option C the guard
      // would risk fail-closing every existing user's deliveries. Off ⇒ pure pass-through.
      // Derived from CONNECTOR_WEBHOOK_PUBLIC_ORIGIN unless CONNECTOR_WEBHOOK_HOST_ALLOWLIST
      // overrides it, so the host we answer on cannot drift from the URL we hand out.
      createConnectorWebhookHostGuard({
        allowlist: backendIngestEnabled()
          ? resolveWebhookHostAllowlist(process.env)
          : null,
        limiters: connectorWebhookLimiters,
      }),
      connectorWebhookIpPreLimiter,
      // inflate:false is deliberate: body-parser would otherwise decompress a gzip/deflate
      // body and apply the 64 kb cap to the DECOMPRESSED stream — free pre-auth CPU and one
      // more decoder between the bytes the provider signed and the bytes we verify (§4.3).
      express.raw({ type: "application/json", limit: "64kb", inflate: false }),
      // §4.4's accounting for requests that die IN the parser (413 / 415). Without it, an
      // oversize or gzip-declared body reached no bucket at all — not the IP one, and not the
      // IP-INDEPENDENT global ceiling — because this mount runs ahead of applyRateLimiters and
      // every other increment lives inside the handler below. 4-arity, so it only ever sees a
      // parser error, and it re-throws unless a bucket is already tripped.
      createConnectorWebhookParserErrorHandler(connectorWebhookLimiters),
      // §5.4 trigger 1, W1's version. OPTION C retired the post-ack DRAIN kick and that stays
      // retired: it ran a full drain pass — config, disabled-marker, queue and purge-ledger
      // reads — after EVERY delivery and handed the ids to a promise nobody consumed. What is
      // wired here instead is the ingest NUDGE: for a cohort address (dark flag + operator
      // allowlist) it tells W3's fetch worker an item just landed; for everyone else it returns
      // immediately and the browser still picks the id up on its next visit (trigger 3).
      // Strictly after the 202 — the ack waits on the durable enqueue and nothing else.
      createConnectorWebhookHandler({
        tokens: connectorWebhooks.tokens,
        queue: connectorWebhooks.queue,
        limiters: connectorWebhookLimiters,
        onDelivery: createIngestOnDelivery({ modes: connectorWebhooks.modes }),
      }),
    );
  }

  // The Phala TDX-verify passthrough carries a hex quote (a few KB); give it
  // headroom over the global 64 KB parser. Registered before the global parser
  // so it applies to that mount specifically (like the nras-proxy mount above).
  app.use("/api/phala-verify", express.json({ limit: "256kb" }));

  // 1 MB global body limit (raised from 64 KB): a long chat history serialized as
  // {model, messages} can exceed 64 KB well below the model's context window, and
  // the bare parser 413 (non-JSON PayloadTooLargeError) is un-catchable client-side.
  // Auth + rate limiting already sit in front of this parser (see below), so the
  // larger limit does not widen the unauthenticated attack surface. (compaction §C.4a)
  const globalJsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    if (req.path === "/api/nras-proxy" || req.path.startsWith("/api/nras-proxy/")) {
      next();
      return;
    }
    // Recovery is deliberately bodyless. Leave its stream untouched so authentication and the
    // owner index run before the route rejects any supplied body from bounded HTTP headers.
    if (shouldBypassGlobalJsonParserForTranscriberRecovery(req.method, req.path)) {
      next();
      return;
    }
    globalJsonParser(req, res, next);
  });
  app.use(createCsrfMiddleware());
  // ST5 — global 120/15min limiter plus a separate, larger bucket for the
  // verification proxies so badge traffic can't 429 /api/chat (see rate-limits.ts).
  applyRateLimiters(app);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, app: APP_ID });
  });
  app.use("/api/manifest", createManifestRouter());
  app.use("/api/server-info", createServerInfoRouter(did));
  app.use(
    "/api/auth",
    createAuthRouter({
      nonceStore,
      privateKey: backendPrivateKey,
    }),
  );
  app.use(
    "/api/delegations",
    createDelegationRouter({
      node,
      backendDid: did,
      store: delegationStore,
      cache: delegationCache,
      authMiddleware,
      // OPTION C — NOTHING connector-shaped is wired here, and nothing may be. This is the
      // generic chat delegation; the Fireflies webhook toggle is a separate, optional feature
      // that must never be able to refuse or revoke it (see routes/delegations.ts).
    }),
  );

  // The AUTHENTICATED companions (§2.2 consequence 2): the normal window, behind the global
  // JSON parser, CSRF, `applyRateLimiters`' dedicated companion bucket and `authMiddleware`.
  // A prefix mount is correct HERE and forbidden in the raw window above — every path inside
  // the router is ONE segment deep, so none of them can be matched by the public
  // `/:source/:token` mount (index-wiring.test.ts pins both halves).
  if (connectorWebhooks) {
    app.use(
      "/api/connectors/webhooks",
      authMiddleware,
      createConnectorWebhookCompanionRouter({
        tokens: connectorWebhooks.tokens,
        queue: connectorWebhooks.queue,
        control: connectorWebhooks.control,
        limiters: connectorWebhooks.limiters,
        // W1 — the same ingest-mode service the delivery path reads. For a cohort address the
        // fetch worker is the queue's SOLE consumer, so /drain surfaces nothing and /ack is an
        // idempotent no-op here; every non-cohort address is untouched Option C.
        modes: connectorWebhooks.modes,
        // The public HTTPS origin every minted callback URL carries. Pinned rather than derived
        // from the request's Host header + forwarded scheme: a wrong host or an http:// scheme
        // mints a webhook that silently never delivers. A malformed value throws here, at
        // construction, rather than at the first mint.
        ...(process.env.CONNECTOR_WEBHOOK_PUBLIC_ORIGIN
          ? { publicOrigin: process.env.CONNECTOR_WEBHOOK_PUBLIC_ORIGIN }
          : {}),
        // OPTION C — no `delegations` collaborator: `DELETE /config` tears down the connector's
        // own state only. It must not remove or evict the app's unrelated backend delegation.
        // §5.4 trigger 3 (user visit) — the path that works when the STORED delegation is dead
        // but the user is right here. `force` skips the anti-tight-loop interval, never the
        // singleton. Under B/C the route then returns the pending ids; nothing was written.
        drain: ({ source, address }) =>
          connectorWebhooks.drain.kick({ source, address, force: true }),
      }),
    );

    // W2 — the credential-custody surface (plan §6.2 obtain/revoke). Mounted ONLY with the dark
    // ingest flag armed, and 404 inside the router for every non-cohort address: a deployment
    // that has not enabled backend ingestion has no credential route to probe, and a signed-in
    // user outside the cohort cannot tell the mount exists. The store's row adapter is the D3
    // substrate seam — it sees ciphertext and a wrapped DEK, never a credential.
    if (backendIngestEnabled()) {
      // W4/W5 — ONE content store for the whole process, for the same reason the token cache and
      // the queue are shared above: two instances are two sets of per-tenant lanes over one
      // substrate, which is exactly the interleaved read-modify-write the lanes exist to prevent.
      // W3's fetch worker takes THIS instance when it is wired; it must not build its own.
      // W7 — the SHIPPED §6.2 purge ledger is the content store's second tombstone input, so a
      // disconnect (or a user purge) that writes the watermark also stops a replayed delivery
      // from re-creating rows the user tore down. Same `control` the drain and `POST …/purged`
      // use: one ledger, one rule, two consumers.
      const contentStore = new ContentStore(
        new KvContentBlobStore(node, connectorWebhooks.backendStorageLane),
        { purgeLedger: connectorWebhooks.control },
      );
      const credentialStore = new CredentialStore(
        new KvCredentialRowStore(node, connectorWebhooks.backendStorageLane),
        { upstreamRevoker: (secret) => firefliesOAuth().revoke(secret) },
      );

      app.use(
        "/api/connectors/credentials",
        authMiddleware,
        createConnectorCredentialRouter({
          credentials: credentialStore,
          // W7 — `DELETE /:source` is the FULL disconnect: purge tombstone, credential (+
          // upstream revoke), every content row, the queue. A disconnect that left the server's
          // copy of the meetings behind is §9 anti-pattern 8.
          teardown: new ConnectorTeardownService({
            credentials: credentialStore,
            content: contentStore,
            queue: connectorWebhooks.queue,
            control: connectorWebhooks.control,
          }),
          oauth: {
            authorizeUrl: ({ state, challenge }) =>
              firefliesOAuth().authorizeUrl({ state, challenge }),
            exchangeCode: ({ code, verifier }) =>
              firefliesOAuth().exchangeCode({ code, verifier }),
            revoke: (secret) => firefliesOAuth().revoke(secret),
          },
          modes: connectorWebhooks.modes,
        }),
      );

      // W5 — the authenticated READ API (plan §8.1 W5): the surface the goal is stated in. A
      // device that has never opened the app has no vault and no Fireflies key, so these routes
      // are the only way it can see a meeting the backend ingested while nobody was looking.
      // Same two gates as the credential surface (dark flag decides the mount, per-address cohort
      // decides visibility), same session `authMiddleware`, and the tenant is ALWAYS the session
      // address. Both GETs are strictly side-effect-free (§9 anti-pattern 5); the ONE mutation is
      // `POST /:source/:sourceId/reconciled`, W6's reconcile-ack.
      app.use(
        "/api/connectors/meetings",
        authMiddleware,
        createConnectorMeetingsRouter({
          content: contentStore,
          modes: connectorWebhooks.modes,
        }),
      );

      // W3 + W9 — the fetch worker, behind D4's SINGLE-INSTANCE seat. Two boundaries, both
      // required: `ConnectorFetchWorker` keeps one worker per PROCESS, and the lease below keeps
      // one worker per DEPLOYMENT, because the queue's mutual exclusion is a per-address
      // in-process mutex over a per-instance storage lane — neither crosses a process boundary, so
      // a second instance is not throughput, it is interleaved read-modify-writes on one array
      // (findings §2.2/§2.5). An instance that cannot take the lease keeps serving HTTP and
      // ingests NOTHING; an unreadable lease refuses too, because "I could not tell who holds it"
      // must never resolve to "nobody does". Constraint and its exit:
      // `docs/connector-webhooks-single-instance.md`.
      const supervisor = new IngestInstanceSupervisor({
        guard: new IngestInstanceGuard(new KvInstanceLeaseStore(node)),
        worker: new ConnectorFetchWorker({
          queue: connectorWebhooks.queue,
          modes: connectorWebhooks.modes,
          // §6.2 "rotate": the worker reads credentials through the REFRESHING lookup, so an
          // OAuth access token that is about to expire is rotated (and re-sealed) before it is
          // presented upstream. Handing it the bare store made expiry — the routine case under
          // `V-a-branch: b1` — a permanent stall behind a 5-minute credential hold.
          credentials: createRefreshingCredentialLookup({
            store: credentialStore,
            client: () => firefliesOAuth(),
          }),
          // Refetch BY ID with the user's own credential; the fetcher never sees a stored link.
          fetcher: new FirefliesMeetingFetcher(),
          content: contentStore,
          // W4's retention + purge tombstones: a swept or purged id is never re-stored by a
          // replayed delivery.
          retention: contentStore,
        }),
        // W4/D2a — the retention window is enforced by the instance that HOLDS the seat, so the
        // 90-day bound is a running sweep rather than a documented intention.
        retention: new IngestRetentionSweeper({
          content: contentStore,
          cohort: () => connectorWebhooks.modes.cohort(),
          sources: [DEFAULT_CONNECTOR_SOURCE],
        }),
      });
      ingestSupervisor = supervisor;
      ingestSupervisor.start();

      // W8 — the operator surface (plan §8.1 W8; §8.2 delta 9). One periodic line carrying the
      // system numbers no single module can see: dead-letter depth across the cohort, fetch
      // ok/fail, overflow drops, reconcile lag, the credential-op audit — plus an alert line when
      // the DLQ grows or the fetch SLA is breached. Numbers ONLY: nothing it emits identifies a
      // tenant or a meeting, which is why it is safe on a `public_logs=true` CVM. Same dark gate
      // as everything else here, and its timer is unref'd, so a deployment without backend
      // ingestion neither starts it nor is held open by it. The worker's counters are looked up
      // per emit, so the seat can be claimed after this is constructed and the numbers still
      // arrive. Exactly ONE process reports (D4): the emit is gated on the lease, so an instance
      // that refused the seat neither narrates a system it is not part of nor spends a cohort read
      // per emit against the shared single-writer node.
      new IngestObservabilityReporter(
        {
          content: () => contentStore.stats(),
          deadLetters: connectorWebhooks.queue,
          cohort: () => connectorWebhooks.modes.cohort(),
          sources: [DEFAULT_CONNECTOR_SOURCE],
        },
        { enabled: () => supervisor.guard.isHolder() },
      ).start();
    }
  }

  // WP-A — the Google Meet OAuth proxy (gmeet plan §4.1 / §6 WP-A), DARK by default. With the flag
  // off this `app.use` never runs, so all five paths 404: the same canary the webhook mount gives.
  // A SIBLING prefix of `/api/connectors/webhooks`, so it can collide with neither the public
  // two-segment delivery route nor the one-segment companions, and it carries its own rate-limit
  // bucket (rate-limits.ts) — an OAuth dance plus a few refreshes must not spend `/api/chat`'s
  // 120/15min global allowance.
  //
  // The middleware SPLIT is why this mounts here, in the normal window (behind the global JSON
  // parser, CSRF and `applyRateLimiters`) rather than in the raw window:
  //
  //  - `GET /start` and `GET /callback` run WITHOUT `authMiddleware`. `/callback` is a top-level
  //    browser navigation from Google carrying no Bearer, so auth would 401 the flow before the
  //    popup could hand anything back; `/start` is the same navigation one hop earlier. CSRF
  //    exempts GET, and the anti-forgery control on these two is the `state` param the SPA mints
  //    and re-checks. Neither reads a session, a store or a credential — `/callback` renders one
  //    nonce'd page that postMessages `{code, state}` to the pinned app origin and nothing else.
  //  - Everything else — the three POSTs that actually reach Google's token endpoint — goes
  //    through `authMiddleware`, with global CSRF already covering the unsafe methods.
  if (googleMeetOAuthEnabled()) {
    app.use(
      "/api/connectors/google/oauth",
      (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (req.method === "GET" && GOOGLE_OAUTH_PUBLIC_PATHS.has(req.path)) {
          next();
          return;
        }
        void authMiddleware(req, res, next);
      },
      createGoogleOAuthRouter({
        // Explicit, and deliberately NOT the router's `googleAppOriginFromEnv()` default: this
        // process already resolved the web app origin once, with the localhost/TLS fallback a bare
        // env read does not have. CORS also accepts Exo's fixed Tauri origin, but the callback stays
        // pinned to this web origin until a desktop OAuth handoff is designed.
        appOrigin: FRONTEND_URL,
      }),
    );
  }

  if (AGENT_DID && ELIZA_SERVICE_URL && ELIZA_SERVICE_SECRET) {
    const elizaServiceUrl = ELIZA_SERVICE_URL.replace(/\/$/, "");
    const redpillApiKey = process.env.REDPILL_API_KEY;
    app.use(
      "/api/agent",
      createAgentRouter({
        agentDid: AGENT_DID,
        elizaServiceUrl,
        elizaServiceSecret: ELIZA_SERVICE_SECRET,
        authMiddleware,
        // Mount POST /api/agent/chat (tool-calling orchestration) only when RedPill
        // is configured; reuse the canonical offered-model allowlist so the agent
        // tool path accepts only the curated picker models (same gate as the relay).
        ...(redpillApiKey
          ? {
              chat: {
                agentId: TINYCHAT_AGENT_ID,
                entityIdFor: (address: string) => addressToEntityId(address, TINYCHAT_AGENT_ID),
                elizaServiceUrl,
                elizaServiceSecret: ELIZA_SERVICE_SECRET,
                redpillApiKey,
                redpillBaseUrl: process.env.REDPILL_BASE_URL ?? "https://api.redpill.ai/v1",
                defaultModel,
                isModelOffered: (m: string) => isOfferedModel(m),
                flusher: ledgerFlusher,
                rehydrator: ledgerRehydrator,
              },
            }
          : {}),
      }),
    );
  } else {
    console.warn(
      "[startup] AGENT_DID / ELIZA_SERVICE_URL / ELIZA_SERVICE_SECRET not all set — " +
        "/api/agent (eliza delegation courier) is disabled.",
    );
  }
  app.use(
    "/api/chat",
    authMiddleware,
    createChatRouter({ flusher: ledgerFlusher, rehydrator: ledgerRehydrator }),
  );
  app.use("/api/signature", authMiddleware, createSignatureRouter());
  app.use("/api/nras-proxy", authMiddleware, express.json({ limit: "4mb" }), createNrasProxyRouter());
  app.use("/api/phala-verify", authMiddleware, createPhalaVerifyRouter());
  app.use(
    "/api/attestation/self",
    authMiddleware,
    createAttestationSelfRouter({
      privateKey: backendPrivateKey,
      did,
    }),
  );
  app.use("/api/billing", createBillingRouter({ authMiddleware }));

  // The TRANSCRIBER surface (routes/transcriber.ts): send a bot to a meeting URL through the
  // TinyCloud Private Transcription API and read the speaker-attributed transcript back. Mounted
  // only when TRANSCRIPTION_API_URL + TRANSCRIPTION_API_KEY are set — the project key stays in
  // this process, and the browser only ever talks to this authenticated, per-address proxy.
  const transcriptionConfig = transcriptionApiConfigFromEnv();
  const transcriberRecoveryConfig = transcriberRecoveryConfigFromEnv();
  const transcriberRecoveryLimiter = transcriberRecoveryConfig.ready
    && transcriberRecoveryConfig.pseudonymKey !== null
    && transcriberRecoveryConfig.rateLimitMax !== null
    && transcriberRecoveryConfig.rateLimitWindowMs !== null
    ? createRecoveryRateLimiter({
        key: transcriberRecoveryConfig.pseudonymKey,
        limit: transcriberRecoveryConfig.rateLimitMax,
        windowMs: transcriberRecoveryConfig.rateLimitWindowMs,
      })
    : undefined;
  if (transcriptionConfig) {
    // §9.3 — writes to the backend's own space share ONE lane per process. Reuse the connector
    // lane when it exists; a process without connectors gets its own, single one.
    const transcriberStorageLane = connectorWebhooks?.backendStorageLane ?? new BackendStorageLane();
    app.use(
      "/api/transcriber/meetings",
      authMiddleware,
      createTranscriberRouter({
        api: createTranscriptionApiClient({
          ...transcriptionConfig,
          ...(transcriberRecoveryConfig.contractVersion === null
            ? {}
            : { recoveryContractVersion: transcriberRecoveryConfig.contractVersion }),
          ...(transcriberRecoveryConfig.capabilityCacheMs === null
            ? {}
            : { recoveryCapabilityCacheMs: transcriberRecoveryConfig.capabilityCacheMs }),
        }),
        index: new KvTranscriberIndexStore(node, transcriberStorageLane),
        recovery: transcriberRecoveryConfig,
        ...(transcriberRecoveryLimiter === undefined
          ? {}
          : { recoveryLimiter: transcriberRecoveryLimiter }),
        ...(process.env.TRANSCRIPTION_BOT_NAME
          ? { defaultBotName: process.env.TRANSCRIPTION_BOT_NAME }
          : {}),
      }),
    );
  } else {
    console.warn(
      "[startup] TRANSCRIPTION_API_URL / TRANSCRIPTION_API_KEY not set — /api/transcriber is disabled.",
    );
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const spec = loadYaml(readFileSync(resolve(__dirname, "../openapi.yaml"), "utf-8")) as object;
  app.get("/api/openapi.json", (_req, res) => res.json(spec));
  app.use("/api/docs", apiReference({ spec: { content: spec } }));

  // Terminal Express error handler (§4.3 requirement 2). Express 4 does not await handler
  // promises and this app previously registered NO error middleware, so a synchronous throw
  // (or a body-parser rejection) on an unauthenticated route left the socket hanging until
  // timeout. Answer, log, and never leak the error to the client. The four-argument signature
  // is what marks this as an error handler — it must stay last.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const detail = (err ?? {}) as { status?: unknown; name?: unknown; message?: unknown; type?: unknown };
    const status = typeof detail.status === "number" ? detail.status : 500;
    // A PROJECTION, never the error object (§6.3: public_logs=true on the CVM). body-parser
    // attaches the raw request body to an `entity.parse.failed` error as `err.body`, and
    // inspecting an Error prints its own enumerable properties — so logging `err` here prints
    // attacker-chosen bytes from an unauthenticated route, including the two connector bodies
    // that matter (a serialized delegation bundle, raw meeting ids). Fields only.
    // `message` is dropped for body-parser's own errors (the ones carrying `type`): a
    // `entity.parse.failed` message is the JSON parser's, and that echoes a fragment of the
    // body it choked on. `type` + `status` say everything an operator needs about those.
    const parserError = typeof detail.type === "string";
    console.error("[express] route error", {
      name: typeof detail.name === "string" ? detail.name : "unknown",
      message: parserError ? "<omitted: parser error>" : typeof detail.message === "string" ? detail.message : "unknown",
      status,
      type: parserError ? detail.type : undefined,
    });
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: "internal_error" });
  });

  const tlsConfig = loadTlsConfig();
  const server = tlsConfig
    ? createHttpsServer(tlsConfig, app).listen(PORT, () => {
        console.log(`TinyChat backend ready: https://localhost:${PORT}`);
      })
    : app.listen(PORT, () => {
        console.log(`TinyChat backend ready: http://localhost:${PORT}`);
      });

  // §5.4 trigger 2, RE-SCOPED under Option C — bounded queue maintenance, never a background
  // drain. Started ONLY when the flag is on, `unref()`'d inside so it never hangs a test or a
  // shutdown. A timed drain would have surfaced ids to nobody; the TTL / dead-letter sweep is
  // the part that still earns its cost, because an abandoned connector's queue is otherwise
  // swept only when a delivery or a user visit happens to touch it — and the 14-day TTL is a
  // retention promise. `sweep` reports counts only, so nothing is surfaced here.
  const connectorQueueMaintenance = connectorWebhooks
    ? startConnectorQueueMaintenanceTimer({
        listAddresses: createWebhookConfigDirectory(node),
        intervalMs: drainIntervalFromEnv(process.env),
        sweep: async (address) => {
          // Sequential, one address at a time (§9.3). The config read supplies the source the
          // queue key needs; a config that is gone took its queue with it (§4.8 teardown).
          const config = await connectorWebhooks.tokens.config(address);
          if (config === null) return;
          await connectorWebhooks.queue.sweep(config.source, address);
        },
      })
    : null;

  const shutdown = (signal: string) => {
    console.log(`${signal} received. Shutting down.`);
    ledgerFlusher?.stop();
    connectorWebhooks?.drain.stop();
    connectorQueueMaintenance?.stop();
    // Stops the worker AND releases the D4 lease, so the next instance takes the seat
    // immediately rather than waiting out the 90 s TTL. Best-effort: the 10 s exit timer below
    // still fires, and an unreleased lease costs one TTL of ingest lag, never correctness.
    void ingestSupervisor?.stop().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function loadTlsConfig() {
  if (!HTTPS_CERT_FILE && !HTTPS_KEY_FILE) return null;
  if (!HTTPS_CERT_FILE || !HTTPS_KEY_FILE) {
    throw new Error("Both HTTPS_CERT_FILE and HTTPS_KEY_FILE are required to enable HTTPS.");
  }
  const certFile = resolve(process.cwd(), HTTPS_CERT_FILE);
  const keyFile = resolve(process.cwd(), HTTPS_KEY_FILE);
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    throw new Error(`HTTPS certificate files were not found: ${certFile}, ${keyFile}`);
  }
  return {
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Failed to start TinyChat backend:", error);
    process.exit(1);
  });
}
