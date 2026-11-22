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
  EXO_SYNC_GRANT_KIND,
  TRANSCRIPT_WRITER_GRANT_KIND,
  createCsrfMiddleware,
  createNonceStore,
} from "@tinyboilerplate/server";
import { APP_ID } from "@tinyboilerplate/core";
import { applySecurityDefaults } from "./security.js";
import { applyRateLimiters, logGlobalBucketRoutes } from "./rate-limits.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createAuthRouter } from "./routes/auth.js";
import { mcpChatFromEnv } from "./mcp-meetings/config.js";
import { BotHistory } from "./bot-history.js";
import { createBotHistoryRouter, startBotHistoryDrain } from "./routes/bot-history.js";
import { botsFromEnv, createBotsRouter, removeBotFromService } from "./routes/bots.js";
import { capModeFromEnv, planFor } from "./bot-caps.js";
import { BotsRegistry, turnListHook } from "./bots-registry.js";
import { BOT_DELETION_PASS_MS, BotDeletions } from "./bot-deletion.js";
import { resolveTier } from "./billing/stripe.js";
import { createDelegationRouter } from "./routes/delegations.js";
import { createExoGrantRouter } from "./routes/exo-grant.js";
import { createAgentRouter } from "./routes/agent.js";
import { meetingRolloutFromEnv } from "./transcripts/meeting-rollout.js";
import { createManifestRouter } from "./routes/manifest.js";
import { createChatRouter, defaultModel } from "./routes/chat.js";
import { DEFAULT_RED_PILL_BASE_URL, RECEIPT_AUDIT_TIMEOUT_MS, redPillAciFetch, validateRedPillBaseUrl } from "./redpill-aci.js";
import { LedgerFlusher } from "./billing/ledger-flusher.js";
import { LedgerRehydrator } from "./billing/ledger-rehydrate.js";
import { isOfferedModel } from "./billing/catalog.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "./entity-id.js";
import { createSignatureRouter } from "./routes/signature.js";
import { createNrasProxyRouter } from "./routes/nras-proxy.js";
import { createPhalaVerifyRouter } from "./routes/phala-verify.js";
import { createAttestationSelfRouter } from "./routes/attestation-self.js";
import { createServerInfoRouter } from "./routes/server-info.js";
import { readBackendBuildInfo } from "./build-info.js";
import { createBillingRouter } from "./routes/billing.js";
import { createBillingWebhookHandler } from "./routes/billing-webhook.js";
import {
  ConnectorControlStore,
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  createConnectorPurgeRouter,
  respondToConnectorPurgeCheck,
  createConnectorWebhookHandler,
  createConnectorWebhookParserErrorHandler,
  connectorDrainAbort,
} from "./routes/connector-webhooks.js";
import { credentialRouteUnavailable } from "./routes/route-unavailable.js";
import { createGoogleOAuthRouter, normalizeAppOrigin } from "./routes/google-oauth.js";
import { createPrivateCloudOnlyBulkDeleteRouter, createTranscriberRouter } from "./routes/transcriber.js";
import { createTranscriberWebhookRouter } from "./routes/transcriber-webhook.js";
import { createExoMailboxRouter } from "./routes/exo-mailbox.js";
import { WakeQueue } from "./exo/wake-intake.js";
import { createTrackedGrantStore, GrantHolderIndex } from "./exo/grant-holders.js";
import { createExoStorePorts, createOwnerGrantOpener, type ExoBackendKv } from "./exo/stores.js";
import { startExoRetentionSweepTimer, type ExoRetentionSweepTimer } from "./exo/retention-sweep.js";
import { clearExoOwnerState, clearExoSourceState } from "./exo/teardown.js";
import { exoCapabilitiesEnabled } from "./exo/mailbox.js";
import { ASSEMBLYAI_HOSTED_MOUNT, createAssemblyAiHostedRouter, reconcileHostedJobs } from "./routes/assemblyai-hosted.js";
import {
  DEFAULT_MAX_CONCURRENT_UPLOADS,
  HEARTBEAT_INTERVAL_MS,
  HostedProviderMonitor,
  HostedUploadStore,
  assemblyAiHostedConfigFromEnv,
  type AssemblyAiHostedConfig,
} from "./services/assemblyai-hosted.js";
import { createPrivateCloudTranscriptionRouter } from "./routes/private-cloud-transcription.js";
import { createCalendarAutojoinRouter } from "./routes/calendar-autojoin.js";
import { CalendarAutojoinConnection } from "./services/calendar-autojoin-connection.js";
import { kvCalendarAutojoinStores, TenantCoordinator } from "./services/calendar-autojoin-store.js";
import { CalendarAutojoinWorker } from "./services/calendar-autojoin-worker.js";
import { ExternalOperationLimiter, GoogleCalendarClient } from "./services/google-calendar.js";
import {
  createTranscriptionApiClient,
  transcriptionApiConfigFromEnv,
  transcriptDeliveryConfigFromEnv,
} from "./services/transcription-api.js";
import { KvJsonKv, KvTranscriberIndexStore } from "./services/transcriber-index.js";
import { PurgeSweeper } from "./services/transcriber-purge.js";
import { TranscriptDeliveryWorker, WriteGovernor } from "./services/transcript-delivery.js";
import {
  PRIVATE_CLOUD_TRANSCRIPTION_MOUNT,
  createPtxClient,
  privateCloudTranscriptionConfigFromEnv,
  type PrivateCloudTranscriptionConfig,
} from "./services/private-cloud-transcription.js";
import { createPrivateCloudPurger } from "./services/private-cloud-purge.js";
import { BackendStorageLane } from "./services/backend-storage-lane.js";
import { runInWriteLane } from "./services/write-lane.js";
import { ConnectorQueue } from "./services/connector-queue.js";
import {
  CredentialStore,
  KvCredentialRowStore,
  validateCredentialCustodyConfig,
} from "./services/credential-store.js";
import { CREDENTIAL_COUNT_ADMIN_KEY_ENV, mountCredentialCountRoute } from "./routes/credential-count.js";
import { createAssemblyAiStatusRouter } from "./routes/assemblyai-status.js";
import { createCalendarAutojoinCountsRouter } from "./routes/calendar-autojoin-counts.js";
import { CREDENTIAL_ROW_COUNT_ENV, logCredentialRowCounts } from "./services/credential-row-count.js";
import {
  GoogleOAuthClient,
  googleMeetOAuthEnabled,
  googleOAuthConfigFromEnv,
} from "./services/google-oauth.js";
import { createGranolaProxyRouter, granolaProxyEnabled } from "./routes/granola-proxy.js";
import {
  ConnectorDrainWorker,
  createWebhookQueueDirectory,
  createWebhookPurgeLedgerDirectory,
  drainIntervalFromEnv,
  startConnectorQueueMaintenanceTimer,
} from "./services/connector-drain.js";
import { assertStrongSecret, WebhookTokenService } from "./services/webhook-tokens.js";
import { createTinychatBackendIdentity } from "./startup.js";
import { appCorsOptions, frontendOriginsFromEnv } from "./cors-origins.js";
import { agentStreamPolicyFromEnv, type AgentStreamPolicy } from "./agent-stream-policy.js";
import { localValidationFromEnv, localValidationGuard } from "./local-validation.js";
import { createApiBodyParser } from "./body-parsing.js";
import { configureRequestLogAccountHash, createRequestContextMiddleware, installRequestLogBoundary, parseRequestIdFirstPartyOrigins, recordMountTemplates } from "./request-context.js";
import { renewalVerifyConfigFromEnv } from "./renewal-verify.js";

const BACKEND_PRIVATE_KEY = process.env.BACKEND_PRIVATE_KEY;
const TINYCLOUD_HOST = process.env.TINYCLOUD_HOST ?? "https://tee.node.tinycloud.xyz";
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

/** TC-2537: key for the request record's account_hash. Missing or weak only drops that field; it never stops a boot. */
function requestLogHmacKey(value: string | undefined): string | undefined {
  try {
    assertStrongSecret("REQUEST_LOG_HMAC_KEY", value);
    return value;
  } catch {
    console.warn("[startup] REQUEST_LOG_HMAC_KEY is missing or too weak; request records omit account_hash");
    return undefined;
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
  const localValidation = localValidationFromEnv(process.env);
  const requestIdFirstPartyOrigins = parseRequestIdFirstPartyOrigins(process.env.REQUEST_ID_FIRST_PARTY_ORIGINS);
  // CORS, SIWE domains and Google OAuth returns: FRONTEND_URL plus FRONTEND_ORIGINS (default: both
  // production sites), so moving FRONTEND_URL to home.tinycloud.xyz keeps tinycloud.chat working.
  const frontendOrigins = frontendOriginsFromEnv(FRONTEND_URL, process.env);
  let transcriptDeliveryConfig;
  try {
    transcriptDeliveryConfig = transcriptDeliveryConfigFromEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid transcript delivery configuration");
    process.exit(1);
    return;
  }
  const diagnosticUrl = process.env.MEETING_DIAGNOSTIC_FOREGROUND_BASE_URL;
  const diagnosticKey = process.env.MEETING_DIAGNOSTIC_FOREGROUND_API_KEY;
  if ((diagnosticUrl !== undefined || diagnosticKey !== undefined) && (!diagnosticUrl?.trim() || !diagnosticKey?.trim())) {
    console.error("Invalid meeting diagnostic foreground configuration: set both endpoint and API key, or neither");
    process.exit(1);
    return;
  }
  let redpillBaseUrl: string;
  try {
    redpillBaseUrl = validateRedPillBaseUrl(process.env.REDPILL_BASE_URL ?? DEFAULT_RED_PILL_BASE_URL);
    if (diagnosticUrl) validateRedPillBaseUrl(diagnosticUrl);
  } catch {
    console.error("Invalid confidential model endpoint: expected the attested gateway");
    process.exit(1);
    return;
  }
  const redpillApiKey = process.env.REDPILL_API_KEY;
  const mcpChat = mcpChatFromEnv(process.env);
  let agentStreamPolicy: AgentStreamPolicy | undefined;
  try {
    agentStreamPolicy = agentStreamPolicyFromEnv(
      process.env,
      Boolean(((AGENT_DID && ELIZA_SERVICE_URL && ELIZA_SERVICE_SECRET) || mcpChat.mcpMeetings) && redpillApiKey),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid agent stream configuration");
    process.exit(1);
    return;
  }

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

  // Partial PTX configuration refuses boot; a fully absent configuration remains mounted and
  // answers authenticated callers with service_misconfigured.
  let privateCloudTranscription: PrivateCloudTranscriptionConfig;
  try {
    privateCloudTranscription = privateCloudTranscriptionConfigFromEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  // AssemblyAI under TinyCloud's account (routes/assemblyai-hosted.ts): on when the server key and
  // the handle key are both set, off (capabilities say so) when either is unset; a value that is
  // set but weak, reused or malformed refuses boot.
  let assemblyAiHosted: AssemblyAiHostedConfig;
  try {
    assemblyAiHosted = assemblyAiHostedConfigFromEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }
  if (!assemblyAiHosted.hosted) {
    console.warn(`[startup] hosted AssemblyAI is off (${assemblyAiHosted.reason}); clients can still use their own key.`);
  }

  if (connectorWebhooksEnabled()) {
    const webhookSecrets = validateConnectorWebhookSecrets(process.env);
    if (!webhookSecrets.ok) {
      console.error(webhookSecrets.error);
      process.exit(1);
      return;
    }
  }

  // WP-A — armed-but-unregistered is a BOOT failure. An operator who sets GOOGLE_MEET_OAUTH_ENABLED
  // and forgets a client var must learn it from a refused start, never from a user stranded on a
  // half-finished consent screen — and the message names the missing VARS only, never a value,
  // because one of them is the client secret and this CVM logs publicly.
  if (googleMeetOAuthEnabled()) {
    try {
      googleOAuthConfigFromEnv(process.env);
      if (transcriptionApiConfigFromEnv() && process.env.CONNECTOR_CREDENTIAL_MASTER) {
        const custody = validateCredentialCustodyConfig(process.env);
        if (!custody.ok) throw new Error(custody.error);
      }
      // The callback page's `postMessage` target, validated at boot rather than at the first
      // consent. This web origin is also in the FRONTEND_ORIGINS allowlist (CORS, SIWE, OAuth
      // returns). The callback page only targets allowlisted web origins: the Exo apps never use it,
      // they return through the router's fixed native deep link (`native.` states, TC-521).
      // A bare host or `*` throws here.
      normalizeAppOrigin(FRONTEND_URL);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
      return;
    }
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
    localValidation,
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
  const delegationStore = new DelegationStore(node, TRANSCRIPT_WRITER_GRANT_KIND);
  const exoGrantStore = new DelegationStore(node, EXO_SYNC_GRANT_KIND);
  const exoGrantHolders = new GrantHolderIndex({ list: (prefix) => node.kv.list({ prefix }) });
  const delegationCache = new DelegationCache();
  const nonceStore = createNonceStore();
  const authMiddleware = createAuthMiddleware(backendPrivateKey);
  // No `createDelegationMiddleware(...)` here. Under Option B no route reaches user-space KV
  // through a delegated accessor, so nothing consumes `req.delegatedAccess`; the drain worker
  // runs outside the Express chain and re-validates the stored record itself (§2.2, §3.6). The
  // factory is wired only when an Option A writer path lands — until then it is a live handle
  // on the delegation cache built at startup for no reader.

  const app = express();
  installRequestLogBoundary();
  configureRequestLogAccountHash(requestLogHmacKey(process.env.REQUEST_LOG_HMAC_KEY));
  app.use(createRequestContextMiddleware());
  recordMountTemplates(app);
  if (localValidation) app.use(localValidationGuard);
  app.set("trust proxy", 1);
  applySecurityDefaults(app);
  app.use(cors(appCorsOptions(frontendOrigins)));

  // Stripe webhook MUST be mounted before the JSON body parser and CSRF
  // middleware: it needs the raw request bytes for signature verification, and
  // Stripe's servers do not send the X-Requested-With CSRF header.
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    createBillingWebhookHandler(),
  );

  // §9.3 — one shared lane for every component that writes to the backend space (connector
  // queue, credential store, exo job mirror). TinyCloud drops concurrent responses on one space,
  // so cross-component writes MUST funnel through the same lane; two lanes are no lane.
  const backendStorageLane = new BackendStorageLane();

  // TC-1013 S4b: owner teardown exists only when the exo flag is on. With the flag off, the DELETE
  // routes and connector disconnect make no exo calls; they behave as before this stage.
  const exoBackendKv: ExoBackendKv = {
    get: (key, options) => node.kv.get(key, options),
    put: (key, value, options) => backendStorageLane.run(() => node.kv.put(key, value, options)),
    delete: (key) => backendStorageLane.run(() => node.kv.delete(key)),
    list: (prefix) => node.kv.list({ prefix }),
  };
  // One open of an owner's grant is a stored-grant load plus node calls, and a wake check opens it four times. The
  // cache keeps one open per owner for a short window; every write or removal of the stored grant drops that owner.
  const openOwnerGrant = createOwnerGrantOpener({
    node,
    backendDid: did,
    configuredHost: TINYCLOUD_HOST,
    grantStore: exoGrantStore,
    cache: true,
  });
  const forgetOwnerGrant = (owner: string): void => openOwnerGrant.invalidate(owner);
  const exoGrantTracked = createTrackedGrantStore(exoGrantStore, exoGrantHolders, forgetOwnerGrant);
  const teardownExoOwner: ((owner: string) => Promise<void>) | undefined = exoCapabilitiesEnabled(process.env)
    ? async (owner: string): Promise<void> => {
        // Clear owner rows first, then remove the grant: a failed clear keeps the grant so the retry still has it.
        await clearExoOwnerState({ kv: exoBackendKv, openOwnerGrant }, owner);
        await exoGrantTracked.remove(owner);
      }
    : undefined;

  // Share these stores with the optional routes, but keep retention maintenance alive even when
  // the connector webhook feature is disabled.
  const connectorKeyDirectory = process.env.CONNECTOR_KEY_STORE_DIR?.trim();
  const connectorRetention = connectorKeyDirectory
    ? await import("./services/connector-key-store.js").then(({ ConnectorKeyStore, startConnectorKeyRotation }) => {
        const store = ConnectorKeyStore.open(connectorKeyDirectory);
        return { store, startRotation: () => startConnectorKeyRotation(store) };
      })
    : undefined;
  const connectorKeyStore = connectorRetention?.store;
  const connectorControl = new ConnectorControlStore(node, undefined, connectorKeyStore);
  const connectorQueue = new ConnectorQueue(node, {
    storageLane: backendStorageLane,
    retentionKeys: connectorKeyStore,
    isDisabled: async address => (await connectorControl.readDisabled(address)) !== null,
  });
  // ONE set of instances shared by BOTH connector mounts, the public one below and the
  // authenticated companions further down (§3.6/§4.4): the companions' teardown must evict the
  // very token cache the public route reads, and `GET …/webhooks/pending` must see the queue
  // the public route enqueued into. Two instances would make revocation look like it worked.
  const connectorWebhooks = connectorWebhooksEnabled()
    ? (() => {
        const tokens = new WebhookTokenService(node);
        const queue = connectorQueue;
        const control = connectorControl;
        return {
          limiters: new ConnectorWebhookLimiters(),
          tokens,
          queue,
          control,
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
  const transcriptionConfig = transcriptionApiConfigFromEnv();
  const transcriberStorageLane = connectorWebhooks?.backendStorageLane ?? new BackendStorageLane();
  const transcriberApi = transcriptionConfig ? createTranscriptionApiClient({ ...transcriptionConfig, requestIdFirstPartyOrigins }) : null;
  const transcriberIndex = new KvTranscriberIndexStore(node, transcriberStorageLane);
  // TC-3136: retries recording removals whose provider-side purge is not yet confirmed.
  const transcriberPurgeSweeper = transcriberApi ? new PurgeSweeper(transcriberApi, transcriberIndex) : null;
  const transcriptCoordinator = new TenantCoordinator();
  const transcriptEligibility = (address: string) =>
    transcriptDeliveryConfig.enabled &&
    (!transcriptDeliveryConfig.allowlist || transcriptDeliveryConfig.allowlist.has(address.toLowerCase()));
  const transcriptWorker = transcriptDeliveryConfig.enabled && transcriberApi
    ? new TranscriptDeliveryWorker({
        api: transcriberApi,
        index: transcriberIndex,
        delegationStore,
        delegationCache,
        storageLane: transcriberStorageLane,
        sweepMs: transcriptDeliveryConfig.sweepMs,
        node,
        backendDid: did,
        configuredHost: TINYCLOUD_HOST,
        eligibility: transcriptEligibility,
        coordinator: transcriptCoordinator,
        limiter: new ExternalOperationLimiter(4),
        governor: new WriteGovernor(transcriptDeliveryConfig.maxWritesPerMin),
        runInWriteLane,
      })
    : null;
  if (transcriptWorker) {
    app.use("/api/transcriber/webhooks/ptx", createTranscriberWebhookRouter(
      transcriptWorker, transcriptDeliveryConfig.webhookSecret,
    ));
  } else {
    // An unmounted webhook must remain 404 even before the global CSRF gate.
    app.post("/api/transcriber/webhooks/ptx", (_req, res) => res.sendStatus(404));
  }
  // TC-1013 S4b: Exo capability mailbox. Mounted only when the flag is exactly "true".
  // Stores are the owner's activated grant (S4a) plus a backend-space job mirror on the shared
  // storage lane. No executor is registered yet, so a verified wake settles `unavailable`.
  // The wake queue is owned here so shutdown can drain it after HTTP has closed.
  let exoWakeQueue: WakeQueue | null = null;
  let exoRetentionSweep: ExoRetentionSweepTimer | null = null;
  if (exoCapabilitiesEnabled(process.env)) {
    exoWakeQueue = new WakeQueue();
    // The index starts empty. Load it before the router mounts, so a wake for an existing holder is not
    // answered as an unknown owner after a restart.
    await exoGrantHolders.refresh();
    const exoPorts = createExoStorePorts({
      backendKv: exoBackendKv,
      openOwnerGrant,
      webhooks: new WebhookTokenService(node),
      controls: connectorControl,
      grantHolders: exoGrantHolders,
      frontendOrigin: process.env.FRONTEND_URL ?? "https://localhost:5186",
    });
    app.use("/api/exo/v1", createExoMailboxRouter(exoPorts, exoGrantHolders, { queue: exoWakeQueue }));
    exoRetentionSweep = startExoRetentionSweepTimer({ kv: exoBackendKv, ports: exoPorts });
  }

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
    // user into one bucket. Companion routes must stay ONE segment deep.
    app.post(
      "/api/connectors/webhooks/:source/:token",
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
      // The ack waits on the durable enqueue and nothing else.
      createConnectorWebhookHandler({
        tokens: connectorWebhooks.tokens,
        queue: connectorWebhooks.queue,
        control: connectorWebhooks.control,
        limiters: connectorWebhookLimiters,
      }),
    );
  }

  // The Phala TDX-verify passthrough carries a hex quote (a few KB); give it
  // headroom over the global 64 KB parser. Registered before the global parser
  // so it applies to that mount specifically (like the nras-proxy mount above).
  app.use("/api/phala-verify", express.json({ limit: "256kb" }));

  // Delegation acceptance gates eligibility before its route-local body parser.
  app.use(createApiBodyParser());

  app.use(createCsrfMiddleware());
  // ST5 — global 120/15min limiter plus a separate, larger bucket for the
  // verification proxies so badge traffic can't 429 /api/chat (see rate-limits.ts).
  const { globalRoutes, paidChatLimiter } = applyRateLimiters(app, { sessionKey: backendPrivateKey });
  // What the global bucket is charged for, per route, until the log shipper (TC-959) lands.
  logGlobalBucketRoutes(globalRoutes);

  app.get("/health", (_req, res) => {
    // TEMPORARY: aggregate route templates and counts only, our one view of the global bucket
    // until the tinychat log shipper (TC-959) is live. Remove this field then.
    res.json({ ok: true, app: APP_ID, globalBucketRoutes: globalRoutes.top(10) });
  });
  app.use("/api/manifest", createManifestRouter());
  app.use("/api/server-info", createServerInfoRouter(did, readBackendBuildInfo()));
  // Operator view of hosted AssemblyAI: the events, the heartbeat and the status route read this one monitor.
  const assemblyAiMonitor = new HostedProviderMonitor();
  // TC-1964: optional authenticated count of stored credential rows. Not registered (404) unless
  // CREDENTIAL_COUNT_ADMIN_KEY is set; no session, the admin key is the only credential.
  if (process.env[CREDENTIAL_COUNT_ADMIN_KEY_ENV]?.trim()) {
    mountCredentialCountRoute(
      app,
      process.env,
      () => new KvCredentialRowStore(node, transcriberStorageLane, { priority: "background" }),
    );
  }
  // Its read-only status for the operator probe: the same key and gating, so no routes (404) unless that key is set.
  app.use(createAssemblyAiStatusRouter(process.env, assemblyAiMonitor));
  app.use(
    "/api/auth",
    createAuthRouter({
      nonceStore,
      privateKey: backendPrivateKey,
      frontendOrigins,
      nativeSiweDomain: process.env.OPENKEY_SIWE_DOMAIN,
      renewal: renewalVerifyConfigFromEnv(process.env, TINYCLOUD_HOST),
    }),
  );
  app.use(
    "/api/delegations",
    createDelegationRouter({
      node,
      backendDid: did,
      store: delegationStore,
      authMiddleware,
      configuredHost: TINYCLOUD_HOST,
      eligibility: transcriptEligibility,
      teardownExoOwner,
      schemaMissing: (address) => transcriptWorker?.hasSchemaMissing(address) ?? false,
      coordinator: transcriptCoordinator,
      onGrantChanged: (address, previousEnvelope) => transcriptWorker?.invalidateGrant(address, previousEnvelope),
    }),
  );

  // TC-1013 S4a: exo sync grant. Session auth and CSRF match the connector grant. Mounted only
  // when the exo flag is exactly "true"; otherwise the path falls through to 404.
  if (exoCapabilitiesEnabled(process.env)) {
    app.use("/api/exo/v1/grant", createExoGrantRouter({
      node,
      backendDid: did,
      configuredHost: TINYCLOUD_HOST,
      store: createTrackedGrantStore(exoGrantStore, exoGrantHolders, forgetOwnerGrant),
      teardownExoOwner,
      authMiddleware,
    }));
  }

  // The AUTHENTICATED companions (§2.2 consequence 2): the normal window, behind the global
  // JSON parser, CSRF, `applyRateLimiters`' dedicated companion bucket and `authMiddleware`.
  // A prefix mount is correct HERE and forbidden in the raw window above — every path inside
  // the router is ONE segment deep, so none of them can be matched by the public
  // `/:source/:token` mount.
  // Direct imports consult the ledger even when notification delivery is disabled.
  app.post("/api/connectors/webhooks/purge-check", authMiddleware, (req, res) =>
    respondToConnectorPurgeCheck(connectorControl, req, res));
  app.use("/api/connectors/webhooks", createConnectorPurgeRouter({ control: connectorControl, authMiddleware }));
  if (connectorWebhooks) {
    app.use(
      "/api/connectors/webhooks",
      authMiddleware,
      createConnectorWebhookCompanionRouter({
        tokens: connectorWebhooks.tokens,
        queue: connectorWebhooks.queue,
        control: connectorWebhooks.control,
        limiters: connectorWebhooks.limiters,
        // The public HTTPS origin every minted callback URL carries. Pinned rather than derived
        // from the request's Host header + forwarded scheme: a wrong host or an http:// scheme
        // mints a webhook that silently never delivers. A malformed value throws here, at
        // construction, rather than at the first mint.
        ...(process.env.CONNECTOR_WEBHOOK_PUBLIC_ORIGIN
          ? { publicOrigin: process.env.CONNECTOR_WEBHOOK_PUBLIC_ORIGIN }
          : {}),
        // DELETE /config disconnects every source, so each source's exo ledger rows are cleared
        // best-effort. Wired only with the exo flag on: a flag-off disconnect makes no exo call.
        ...(exoCapabilitiesEnabled(process.env)
          ? { exo: { clearSource: (source: string, address: string) => clearExoSourceState(exoBackendKv, address, source) } }
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
  }
  // The credential route is not mounted. It answers 404 with the backend's own marker, so a client
  // can tell "this deployment does not have it" from a 404 that came from somewhere else.
  app.use("/api/connectors/credentials", (_req, res) => credentialRouteUnavailable(res));

  let calendarAutojoin: CalendarAutojoinConnection | undefined;
  let calendarAutojoinWorker: CalendarAutojoinWorker | undefined;
  if (googleMeetOAuthEnabled() && transcriberApi && process.env.CONNECTOR_CREDENTIAL_MASTER) {
    const limiter = new ExternalOperationLimiter(4);
    const google = new GoogleOAuthClient(googleOAuthConfigFromEnv(), {
      fetchImpl: ((...args: Parameters<typeof fetch>) => limiter.run(() => fetch(...args))) as typeof fetch,
    });
    const calendar = new GoogleCalendarClient({ limiter });
    // Google revocation is exclusively through the connection service's shared-grant guard.
    const credentials = new CredentialStore(new KvCredentialRowStore(node, transcriberStorageLane));
    const backfillCredentials = new CredentialStore(new KvCredentialRowStore(node, transcriberStorageLane, { priority: "background" }));
    // Same lane; see kvCalendarAutojoinStores for the priorities and the shared row cache. The
    // worker shares the one connection service (it single-flights token refreshes); the reads of
    // its per-tick calls through it (cleanupEnabling, accessToken) use the worker's cached store.
    const stores = kvCalendarAutojoinStores(node, transcriberStorageLane);
    // Fail boot rather than claiming unattended recovery on a KV without prefix listing.
    await stores.worker.listConnections();
    const coordinator = new TenantCoordinator();
    calendarAutojoin = new CalendarAutojoinConnection({
      store: stores.request, workerStore: stores.worker, credentials, backfillCredentials, oauth: google, coordinator, calendar,
      teardownExoOwner,
      // TC-1047: disable, disconnect and needs_reconnect cancel the tenant's due-time timers.
      onDisabled: tenant => calendarAutojoinWorker?.cancelTenant(tenant),
    });
    calendarAutojoinWorker = new CalendarAutojoinWorker({
      store: stores.worker, dispatchStore: stores.dispatch, coordinator, calendar, connection: calendarAutojoin, api: transcriberApi,
      index: transcriberIndex, limiter, botName: process.env.TRANSCRIPTION_BOT_NAME || undefined,
      // TC-581: one capture per Meet across tenants. The flag gates only sharing the transcript.
      meetingCoordinator: new TenantCoordinator(),
      sharingEnabled: process.env.CALENDAR_AUTOJOIN_SHARING === "true",
      sharingAccounts: new Set((process.env.CALENDAR_AUTOJOIN_SHARING_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean)),
      webhookUrl: transcriptDeliveryConfig.enabled ? transcriptDeliveryConfig.webhookUrl : undefined,
      onRecordingCompleted: transcriptWorker
        ? async (tenant, meetingId) => { await transcriptWorker.wake(tenant, meetingId, "completed"); }
        : undefined,
    });
    app.use("/api/connectors/google/autojoin", authMiddleware, createCalendarAutojoinRouter({ connection: calendarAutojoin }));
    // TC-916: operator counts of auto-join connections; no routes (404) unless CREDENTIAL_COUNT_ADMIN_KEY is set.
    app.use(createCalendarAutojoinCountsRouter(process.env, stores.worker));
    console.log("[startup] calendar-autojoin enabled; deployment requires one backend writer, with stop-and-drain replacement.");
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
  //    nonce'd page that postMessages `{code, state}` to the pinned app origin and nothing else
  //    (or, for the Exo app's `native.` states, 302s them to one constant deep link).
  //  - Everything else — desktop start and the three POSTs that reach Google's token endpoint
  //    or revoke a token — goes through `authMiddleware`. Global CSRF covers unsafe methods.
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
        autojoin: calendarAutojoin,
        // Explicit, and deliberately NOT the router's `googleAppOriginFromEnv()` default: this
        // process already resolved the web app origin once, with the localhost/TLS fallback a bare
        // env read does not have. CORS also accepts Exo's fixed app origins, but the callback page
        // only returns to an allowlisted web origin (FRONTEND_URL, tinycloud.chat once FRONTEND_URL
        // is the Home or tinycloud.one site, or the fixed Home origin for `home.`/`hometab.` states); the Exo apps
        // return through the fixed native deep link.
        appOrigin: FRONTEND_URL,
        frontendOrigins,
      }),
    );
  }

  // The Granola REST pass-through (granola plan S1). Same dark-ship shape as the Google OAuth
  // proxy: flag off ⇒ no mount ⇒ 404. It sits in the normal window — JSON parser, global CSRF
  // (GETs exempt anyway), `applyRateLimiters`' granolaProxy bucket and `authMiddleware` — and
  // forwards ONLY the three documented read paths to the pinned Granola host. The user's key
  // arrives per-request in `x-granola-key` and is never stored or logged.
  if (granolaProxyEnabled()) {
    app.use("/api/connectors/granola", authMiddleware, createGranolaProxyRouter());
  }

  // Tiny bots (BOTS_ENABLED): Main bot chat proxied to the bots service for listed accounts; status always answers.
  const botsConfig = botsFromEnv(process.env);
  // Stored history permissions are read and removed here whether or not the history routes are on, so that deleting
  // a bot always clears one that was stored earlier.
  const botHistory = botsConfig ? new BotHistory(node, backendPrivateKey as `0x${string}`, TINYCLOUD_HOST) : undefined;
  if (botsConfig && botHistory && process.env.BOTS_HISTORY_ENABLED === "true") {
    app.use("/api/bots/history", createBotHistoryRouter(botHistory, botsConfig, authMiddleware));
    const historyDrain = startBotHistoryDrain(botHistory, botsConfig);
    botsConfig.onTurnFinished = () => { void historyDrain.drain(); };
    process.once("SIGTERM", historyDrain.stop);
    process.once("SIGINT", historyDrain.stop);
  }
  // The record of each owner's bots is kept in the backend's own space and written through the one storage lane.
  // Finding every owner pages through the store's listing.
  const botsRegistry = botsConfig ? new BotsRegistry({ get: exoBackendKv.get, put: exoBackendKv.put, list: options => node.kv.list(options) }) : undefined;
  if (botsConfig && botsRegistry) botsConfig.listForTurn = turnListHook(botsRegistry);
  // A deletion is carried out when it is recorded, and on a pass for whatever is still outstanding, as after a restart.
  const botDeletions = botsConfig && botsRegistry && botHistory ? new BotDeletions({
    registry: botsRegistry,
    removeFromService: (address, key, seq) => removeBotFromService(botsConfig, address, key, seq),
    storedGrantCid: (address, key) => botHistory.storedGrantCid(address, key),
    forgetGrant: (address, key) => botHistory.forget(address, key),
    revoke: cid => botHistory.revoke(cid),
  }) : undefined;
  if (botDeletions) {
    void botDeletions.sweep();
    setInterval(() => { void botDeletions.sweep(); }, BOT_DELETION_PASS_MS).unref();
  }
  app.use("/api/bots", createBotsRouter({
    config: botsConfig, authMiddleware, paidLimiter: paidChatLimiter, registry: botsRegistry,
    // Read only when bots are configured: with bots off no route uses it, and startup calls nothing it does not need.
    ...(botsConfig ? { capMode: capModeFromEnv(process.env) } : {}),
    planOf: async address => planFor((await resolveTier(address)).tier),
    onDeleting: (address, key) => { void botDeletions?.run(address, key); },
  }));

  // MCP chat (MCP_CHAT_ENABLED) serves its listed accounts without eliza-service; every other account keeps the eliza path.
  if ((AGENT_DID && ELIZA_SERVICE_URL && ELIZA_SERVICE_SECRET) || mcpChat.mcpMeetings) {
    const elizaServiceUrl = ELIZA_SERVICE_URL?.replace(/\/$/, "");
    const meetingRollout = meetingRolloutFromEnv(process.env);
    app.use(
      "/api/agent",
      createAgentRouter({
        agentDid: AGENT_DID,
        elizaServiceUrl,
        elizaServiceSecret: ELIZA_SERVICE_SECRET,
        mcp: mcpChat,
        authMiddleware,
        paidLimiter: paidChatLimiter,
        // Mount POST /api/agent/chat (tool-calling orchestration) only when RedPill
        // is configured; reuse the canonical offered-model allowlist so the agent
        // tool path accepts only the curated picker models (same gate as the relay).
        ...(redpillApiKey
          ? {
              chat: {
                streamPolicy: agentStreamPolicy!,
                elizaTasksEnabled: process.env.ELIZA_TASKS_ENABLED === "true",
                elizaTasksAccountAllowed: (address: string) => {
                  const accounts = (process.env.ELIZA_TASKS_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
                  return accounts.length === 0 || accounts.includes(address.toLowerCase());
                },
                ...mcpChat,
                meetingContentRetrievalEnabled: meetingRollout.enabled,
                meetingContentAccountAllowed: meetingRollout.accountAllowed,
                meetingContentModelAllowed: meetingRollout.modelAllowed,
                meetingContentMcpAccountAllowed: meetingRollout.mcpAccountAllowed,
                meetingContentMcpModelAllowed: meetingRollout.mcpModelAllowed,
                backendRevision: process.env.BUILD_REVISION ?? process.env.GIT_SHA ?? "unknown",
                agentId: TINYCHAT_AGENT_ID,
                entityIdFor: (address: string) => addressToEntityId(address, TINYCHAT_AGENT_ID),
                elizaServiceUrl: elizaServiceUrl ?? "",
                elizaServiceSecret: ELIZA_SERVICE_SECRET ?? "",
                redpillApiKey: diagnosticKey ?? redpillApiKey,
                redpillBaseUrl: diagnosticUrl ?? redpillBaseUrl,
                redpillFetch: redPillAciFetch(diagnosticUrl ?? redpillBaseUrl, RECEIPT_AUDIT_TIMEOUT_MS),
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
    createChatRouter({
      flusher: ledgerFlusher,
      rehydrator: ledgerRehydrator,
      redpillFetch: redPillAciFetch(redpillBaseUrl, RECEIPT_AUDIT_TIMEOUT_MS),
      paidLimiter: paidChatLimiter,
    }),
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
  app.use("/api/billing", createBillingRouter({ authMiddleware, rehydrator: ledgerRehydrator }));

  // One PTX client serves the private cloud relay below and the account-deletion purge (TC-3166).
  const privateCloudPtxClient = privateCloudTranscription.enabled
    ? createPtxClient({ ...privateCloudTranscription, requestIdFirstPartyOrigins })
    : null;

  // The TRANSCRIBER surface (routes/transcriber.ts): send a bot to a meeting URL through the
  // TinyCloud Private Transcription API and read the speaker-attributed transcript back. Mounted
  // only when TRANSCRIPTION_API_URL + TRANSCRIPTION_API_KEY are set — the project key stays in
  // this process, and the browser only ever talks to this authenticated, per-address proxy.
  if (transcriptionConfig) {
    // §9.3 — writes to the backend's own space share ONE lane per process. Reuse the connector
    // lane when it exists; a process without connectors gets its own, single one.
    app.use(
      "/api/transcriber/meetings",
      authMiddleware,
      createTranscriberRouter({
        api: transcriberApi!,
        index: transcriberIndex,
        purger: transcriberPurgeSweeper ?? undefined,
        ...(privateCloudPtxClient && privateCloudTranscription.enabled
          ? { privateCloud: createPrivateCloudPurger(privateCloudPtxClient, privateCloudTranscription.tenantKey) }
          : {}),
        webhookUrl: transcriptDeliveryConfig.enabled ? transcriptDeliveryConfig.webhookUrl : undefined,
        onObservedCompletion: transcriptWorker
          ? async (address, meetingId) => { await transcriptWorker.wake(address, meetingId, "observed"); }
          : undefined,
        ...(process.env.TRANSCRIPTION_BOT_NAME
          ? { defaultBotName: process.env.TRANSCRIPTION_BOT_NAME }
          : {}),
      }),
    );
  } else {
    console.warn(
      "[startup] TRANSCRIPTION_API_URL / TRANSCRIPTION_API_KEY not set — /api/transcriber is disabled.",
    );
    // Private cloud transcription can be on without the meeting transcriber: account deletion still has to
    // clear its jobs, so the bulk DELETE alone is mounted (TC-3166). Otherwise it would 404 as "dark".
    if (privateCloudPtxClient && privateCloudTranscription.enabled) {
      app.use(
        "/api/transcriber/meetings",
        authMiddleware,
        createPrivateCloudOnlyBulkDeleteRouter(createPrivateCloudPurger(privateCloudPtxClient, privateCloudTranscription.tenantKey)),
      );
    }
  }

  // Hosted AssemblyAI (routes/assemblyai-hosted.ts): the same mount, always, so the frontend can
  // tell "off" (capabilities `hosted: false`) from "dark". Uploads live in this process only: the
  // The persistent spool admits one writer under flock. Startup recovery completes before mount.
  let hostedUploads: HostedUploadStore | null = null;
  if (assemblyAiHosted.hosted) {
    hostedUploads = new HostedUploadStore(assemblyAiHosted.spoolDir, assemblyAiHosted.dailyBytes, DEFAULT_MAX_CONCURRENT_UPLOADS,
      undefined, undefined, undefined, new KvJsonKv(node));
    await hostedUploads.init();
    await reconcileHostedJobs(assemblyAiHosted, hostedUploads);
    assemblyAiMonitor.attach(hostedUploads);
    const sweeper = hostedUploads;
    setInterval(() => {
      sweeper.sweep(Date.now()).catch(() => console.error("[assemblyai-hosted] sweep failed alert=true"));
    }, 60_000).unref();
    setInterval(() => assemblyAiMonitor.heartbeat(), HEARTBEAT_INTERVAL_MS).unref();
    console.log("[startup] hosted AssemblyAI enabled.");
  }
  app.use(ASSEMBLYAI_HOSTED_MOUNT, authMiddleware, createAssemblyAiHostedRouter({ config: assemblyAiHosted, store: hostedUploads, monitor: assemblyAiMonitor }));

  // Exo private cloud transcription (routes/private-cloud-transcription.ts). A different PTX
  // deployment (`ptx-batch`) and key from the meeting transcriber above.
  app.use(
    PRIVATE_CLOUD_TRANSCRIPTION_MOUNT,
    authMiddleware,
    createPrivateCloudTranscriptionRouter({
      client: privateCloudPtxClient,
      tenantKey: privateCloudTranscription.enabled ? privateCloudTranscription.tenantKey : null,
    }),
  );

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const fullSpec = loadYaml(readFileSync(resolve(__dirname, "../openapi.yaml"), "utf-8")) as object;
  const spec = fullSpec;
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
    const errorStatus = typeof err === "object" && err !== null && "status" in err ? err.status : undefined;
    const status = typeof errorStatus === "number" && Number.isInteger(errorStatus) && errorStatus >= 400 && errorStatus < 600
      ? errorStatus : 500;
    // Error names/messages/properties may contain raw request or dependency payloads.
    console.error("[express] route error", { status });
    res.status(status).json({ error: "internal_error" });
  });

  const tlsConfig = loadTlsConfig();
  const listenOptions = { port: PORT, ...(localValidation ? { host: "127.0.0.1" } : {}) };
  const server = tlsConfig
    ? createHttpsServer(tlsConfig, app).listen(listenOptions, () => {
        console.log(`TinyChat backend ready: https://localhost:${PORT}`);
      })
    : app.listen(listenOptions, () => {
        console.log(`TinyChat backend ready: http://localhost:${PORT}`);
      });

  // Queue and purge-ledger retention is not a delivery feature: disconnected records must
  // expire even while webhook routes are disabled. This timer only deletes expired state and
  // reports counts; it never drains or surfaces meeting IDs.
  // The unref'd rotation stays active through shutdown so the drain cannot delay key erasure.
  connectorRetention?.startRotation();
  const connectorQueueMaintenance = startConnectorQueueMaintenanceTimer({
    listQueueEntries: createWebhookQueueDirectory(node),
    listLedgerAddresses: createWebhookPurgeLedgerDirectory(node),
    sweepLedger: async ({ source, address }, safetyMarginMs) => {
      await connectorControl.clearQuarantinedLedger(source, address);
      const read = await connectorControl.readLedger(
        source,
        address,
        safetyMarginMs,
      );
      if (read.status === "unparseable") {
        await connectorControl.repairUnreadableLedger(source, address);
      }
    },
    sweepQueue: ({ source, address }, safetyMarginMs) =>
      connectorQueue.sweep(source, address, safetyMarginMs),
    intervalMs: drainIntervalFromEnv(process.env),
  });

  calendarAutojoinWorker?.start();
  transcriptWorker?.start();
  transcriberPurgeSweeper?.start();
  // TC-1964: optional one-time, log-only count of stored credential rows. Unset = nothing runs.
  // Fired after boot, never awaited, and it cannot throw; it lists through the shared KV lane.
  if (process.env[CREDENTIAL_ROW_COUNT_ENV]?.trim()) {
    void logCredentialRowCounts(
      process.env[CREDENTIAL_ROW_COUNT_ENV],
      () => new KvCredentialRowStore(node, transcriberStorageLane, { priority: "background" }),
    );
  }
  // Bun can leave a request that finishes during shutdown on a keep-alive connection.
  // Retry idle-connection closure after it has left the active-request set.
  server.on("request", (_req, res) => {
    res.once("finish", () => {
      if (shuttingDown) setTimeout(() => server.closeIdleConnections(), 0).unref();
    });
  });
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received. Shutting down.`);
    ledgerFlusher?.stop();
    connectorWebhooks?.drain.stop();
    connectorQueueMaintenance?.stop();
    // Stop accepting HTTP writes, then drain BOTH HTTP and scheduling before replacement.
    // Deployment must wait for this process to exit.
    const httpDrained = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeIdleConnections();
    // Hosted AssemblyAI submits in flight are aborted; each deletes its own spool as it settles.
    // Wakes are acknowledged with 202 before their job record is written. Drain them only after HTTP has closed,
    // so no new wake can enqueue; past the bound, the drain rejects and the process exits non-zero.
    const wakesDrained = httpDrained.then(() => exoWakeQueue?.drain());
    void Promise.allSettled([httpDrained, wakesDrained, exoRetentionSweep?.stop(), transcriptWorker?.stop(), calendarAutojoinWorker?.stop(), hostedUploads?.shutdown()])
      .then((results) => process.exit(results.some((result) => result.status === "rejected") ? 1 : 0));
    setTimeout(() => process.exit(1), 120_000).unref();
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
