import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import express from "express";

// Compile the entry point, not a copy of its middleware chain. External dependencies are
// replaced at the require boundary so a boot never opens a real TinyCloud connection.
const indexPath = resolve(import.meta.dir, "../index.ts");
const load = createRequire(indexPath);
const build = await Bun.build({
  entrypoints: [indexPath], target: "node", format: "cjs", external: ["*"],
  plugins: [{
    name: "isolated-index",
    setup(builder) {
      builder.onLoad({ filter: /\/index\.ts$/ }, async () => ({
        contents: (await Bun.file(indexPath).text()).replaceAll("import.meta.url", JSON.stringify(pathToFileURL(indexPath).href)) + "\nexport { main as runMain };",
        loader: "ts",
      }));
    },
  }],
});
if (!build.success) throw new Error("Cannot compile backend startup test fixture");
const compiled = await build.outputs[0]!.text();
const envBase = { BACKEND_PRIVATE_KEY: "test-only-private-key", PORT: "0" };
const privateCloud = load("./services/private-cloud-transcription.ts");
const hosted = load("./services/assemblyai-hosted.ts");
const transcription = load("./services/transcription-api.ts");
const google = load("./services/google-oauth.ts");
const { createApiBodyParser } = load("./body-parsing.ts");
const { createTranscriberWebhookRouter } = load("./routes/transcriber-webhook.ts");
const { createGoogleOAuthRouter, normalizeAppOrigin } = load("./routes/google-oauth.ts");

interface Boot {
  url: string | null;
  logs: string[];
  exits: number[];
  signals: EventEmitter;
  server: Server | null;
  close(): Promise<void>;
}

const servers = new Set<Boot>();
afterEach(async () => {
  for (const boot of servers) await boot.close();
  servers.clear();
});

async function bootIndex(patch: Record<string, string | undefined> = {}, options: {
  stop?: Record<string, () => Promise<void>>;
  billingEvent?: (body: Buffer) => void | Promise<void>;
  onExit?: (code: number) => void;
} = {}): Promise<Boot> {
  const env: Record<string, string | undefined> = { ...envBase, ...patch };
  const logs: string[] = [];
  const exits: number[] = [];
  const signals = new EventEmitter();
  let server: Server | null = null;
  let bootComplete = false;
  const sentinel = new Error("startup-exit-intercepted");
  const router = () => express.Router();
  const stop = options.stop ?? {};
  const expressFactory = Object.assign(() => {
    const app = express();
    const originalListen = app.listen.bind(app);
    app.listen = ((_opts: unknown, listener?: () => void) => {
      server = originalListen(0, "127.0.0.1", listener);
      return server;
    }) as typeof app.listen;
    return app;
  }, express);
  const noop = () => {};
  const auth = () => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization === "Bearer test-session") next();
    else res.sendStatus(401);
  };
  const known: Record<string, unknown> = {
    fs: { existsSync: () => false, readFileSync: () => "{}" },
    path: load("node:path"), url: load("node:url"),
    express: expressFactory,
    cors: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    "@tinyboilerplate/server": {
      DelegationStore: class {}, DelegationCache: class {}, createNonceStore: () => ({}),
      createCsrfMiddleware: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      createDelegationMiddleware: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    },
    "@tinyboilerplate/core": { APP_ID: "test-backend" },
    "./startup.js": { createTinychatBackendIdentity: async () => ({ node: {}, did: "did:test:backend" }) },
    "./build-info.js": { readBackendBuildInfo: () => ({}) },
    "./body-parsing.js": { createApiBodyParser },
    "./services/ingest-mode.js": { backendIngestEnabled: () => false, IngestModeService: class {} },
    "./services/transcription-api.js": {
      transcriptDeliveryConfigFromEnv: (e: object) => transcription.transcriptDeliveryConfigFromEnv(e),
      transcriptionApiConfigFromEnv: () => transcription.transcriptionApiConfigFromEnv(env),
      createTranscriptionApiClient: () => ({}),
    },
    "./services/private-cloud-transcription.js": privateCloud,
    "./services/assemblyai-hosted.js": { ...hosted, HostedUploadStore: class {
      init() { return Promise.resolve(); }
      shutdown() { return stop.hosted?.() ?? Promise.resolve(); }
    } },
    "./services/google-oauth.js": {
      googleMeetOAuthEnabled: () => google.googleMeetOAuthEnabled(env),
      googleOAuthConfigFromEnv: () => google.googleOAuthConfigFromEnv(env),
      GoogleOAuthClient: google.GoogleOAuthClient,
    },
    "./routes/google-oauth.js": {
      createGoogleOAuthRouter: (options: Parameters<typeof createGoogleOAuthRouter>[0]) => createGoogleOAuthRouter({
        ...options,
        config: google.googleOAuthConfigFromEnv(env),
      }),
      normalizeAppOrigin,
    },
    "./routes/transcriber-webhook.js": { createTranscriberWebhookRouter },
    "./services/transcript-delivery.js": {
      TranscriptDeliveryWorker: class {
        start() {}
        stop() { return stop.transcript?.() ?? Promise.resolve(); }
        hasSchemaMissing() { return false; }
        async wake() {}
      },
      WriteGovernor: class {},
    },
    "./services/calendar-autojoin-store.js": { TenantCoordinator: class {} },
    "./routes/billing-webhook.js": { createBillingWebhookHandler: () => async (req: express.Request, res: express.Response) => {
      if (!Buffer.isBuffer(req.body)) return res.sendStatus(415);
      const signature = createHmac("sha256", "isolated-stripe-key").update(req.body).digest("hex");
      if (req.headers["stripe-signature"] !== signature) return res.sendStatus(401);
      await options.billingEvent?.(req.body);
      res.sendStatus(202);
    } },
    "./routes/connector-webhooks.js": {
      createConnectorWebhookCompanionRouter: router,
      ConnectorControlStore: class {}, ConnectorWebhookLimiters: class {
        ipPreLimiter(_req: express.Request, _res: express.Response, next: express.NextFunction) { next(); }
      },
      createConnectorWebhookHostGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
      createConnectorWebhookParserErrorHandler: () => (error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => next(error),
      createConnectorWebhookHandler: () => (req: express.Request, res: express.Response) => {
        res.sendStatus(Buffer.isBuffer(req.body) ? 202 : 415);
      },
    },
    "./services/webhook-tokens.js": { assertStrongSecret: () => {}, WebhookTokenService: class {} },
    "./routes/delegations.js": { createDelegationRouter: () => router() },
    "./middleware/auth.js": { createAuthMiddleware: auth },
    "./services/ingest-nudge.js": { createIngestOnDelivery: noop },
    "./rate-limits.js": { applyRateLimiters: noop },
    "./security.js": { applySecurityDefaults: noop },
    "./routes/nras-proxy.js": { createNrasProxyRouter: router },
    "./routes/assemblyai-hosted.js": { ASSEMBLYAI_HOSTED_MOUNT: "/api/assemblyai", createAssemblyAiHostedRouter: router },
    "./routes/assemblyai-delete.js": { ASSEMBLYAI_DELETE_MOUNT: "/api/assemblyai/delete", createAssemblyAiDeleteRouter: router },
    "./billing/ledger-flusher.js": { LedgerFlusher: class { start() {} stop() {} } },
    "./billing/ledger-rehydrate.js": { LedgerRehydrator: class {} },
    "./services/connector-drain.js": { ConnectorDrainWorker: class { stop() {} }, startConnectorQueueMaintenanceTimer: () => ({ stop() {} }), drainIntervalFromEnv: () => 60_000, createWebhookConfigDirectory: noop },
    "./services/connector-queue.js": { ConnectorQueue: class {} },
    "./services/backend-storage-lane.js": { BackendStorageLane: class {} },
    "./services/transcriber-index.js": { KvTranscriberIndexStore: class {} },
    "./services/google-calendar.js": { ExternalOperationLimiter: class {} },
    "./services/calendar-autojoin-worker.js": { CalendarAutojoinWorker: class { start() {} stop() { return stop.calendar?.() ?? Promise.resolve(); } } },
    "./services/ingest-instance.js": { IngestInstanceSupervisor: class { start() {} stop() { return stop.ingest?.() ?? Promise.resolve(); } } },
    "./routes/chat.js": { createChatRouter: router, defaultModel: "test-model" },
    "./agent-stream-policy.js": load("./agent-stream-policy.ts"),
    "./transcripts/meeting-rollout.js": load("./transcripts/meeting-rollout.ts"),
    "./local-validation.js": { localValidationFromEnv: () => false, localValidationGuard: noop },
    "./cors-origins.js": { appCorsOrigins: () => [] },
    "js-yaml": { load: () => ({}) },
    "@scalar/express-api-reference": { apiReference: router },
  };
  const fallback = new Proxy({}, { get: (_target, key) => {
    if (key === "__esModule") return false;
    if (typeof key === "string" && key.startsWith("create") && key.endsWith("Router")) return router;
    return class { start() {} stop() { return Promise.resolve(); } };
  } });
  const exports = {};
  const context = {
    module: { exports }, exports, Buffer, URL, Promise, setTimeout,
    setInterval: () => ({ unref() {} }),
    process: {
      env, argv: [], cwd: () => "/test-startup", on: signals.on.bind(signals),
      exit: (code: number) => {
        exits.push(code);
        options.onExit?.(code);
        if (!bootComplete) throw sentinel;
      },
    },
    console: {
      log: noop, warn: noop,
      error: (...args: unknown[]) => logs.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")),
    },
    require: (id: string) => id in known ? known[id] : fallback,
  };
  runInNewContext(compiled, context);
  try {
    await (context.module.exports as { runMain(): Promise<void> }).runMain();
  } catch (error) {
    if (error !== sentinel) throw error;
  }
  bootComplete = true;
  // app.listen assigns inside its callback; the compiler cannot see that mutation through VM execution.
  const listeningServer = server as Server | null;
  if (listeningServer && !listeningServer.listening) {
    const ready = Promise.withResolvers<void>();
    listeningServer.once("listening", ready.resolve);
    await ready.promise;
  }
  const address = listeningServer?.address();
  if (listeningServer && (!address || typeof address === "string")) {
    throw new Error("Isolated backend did not listen on a TCP port");
  }
  const result: Boot = {
    url: address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : null,
    server: listeningServer, logs, exits, signals,
    close: async () => {
      if (listeningServer?.listening) {
        const closed = Promise.withResolvers<void>();
        listeningServer.close(closed.resolve);
        listeningServer.closeIdleConnections();
        await closed.promise;
      }
    },
  };
  servers.add(result);
  return result;
}

function post(base: string, path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

const ptxEnv = {
  PRIVATE_CLOUD_TRANSCRIPTION_ENABLED: "true",
  PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "https://ptx.invalid",
  PRIVATE_CLOUD_TRANSCRIPTION_API_KEY: "test-ptx-secret-marker",
  PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: "q3Jm8V0t6n0bqK1i2Xz7cP4sWf9YhR5uLd2eA8gT1kM=",
};

describe("backend entry-point HTTP and lifecycle guards", () => {
  test("Stripe receives raw bytes without a CSRF header; unauthenticated NRAS rejects before its large parser", async () => {
    const boot = await bootIndex();
    const body = '{ "event" : "test" }';
    const signature = createHmac("sha256", "isolated-stripe-key").update(body).digest("hex");
    expect((await post(boot.url!, "/api/billing/webhook", body, { "stripe-signature": signature })).status).toBe(202);
    expect((await post(boot.url!, "/api/billing/webhook", body + " ", { "stripe-signature": signature })).status).toBe(401);
    const oversizedMalformed = "{" + "x".repeat(70_000);
    expect((await post(boot.url!, "/api/nras-proxy", oversizedMalformed)).status).toBe(401);
    expect((await post(boot.url!, "/api/nras-proxy", oversizedMalformed, { authorization: "Bearer test-session" })).status).toBe(400);
  });

  test("connector raw delivery rejects compressed requests without global JSON/CSRF interception", async () => {
    const boot = await bootIndex({ CONNECTOR_WEBHOOKS_ENABLED: "true" });
    const path = "/api/connectors/webhooks/fireflies/token";
    expect((await post(boot.url!, path, '{ "event": 1 }')).status).toBe(202);
    expect((await post(boot.url!, path, "{", { "content-encoding": "gzip" })).status).toBe(415);
    expect((await post(boot.url!, "/api/connectors/webhooks/config", "{}")).status).toBe(401);
    const disabled = await bootIndex();
    expect((await post(disabled.url!, path, "{}")).status).toBe(404);
  });

  test("PTX webhook is dark by default and accepts a valid unauthenticated event only when armed", async () => {
    const off = await bootIndex();
    const event = JSON.stringify({ type: "meeting.completed", data: { meeting_id: "meeting_1", metadata: { tinychat_address: "0x" + "a".repeat(40) } } });
    expect((await post(off.url!, "/api/transcriber/webhooks/ptx", event)).status).toBe(404);
    const on = await bootIndex({ TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true", TRANSCRIPTION_API_URL: "https://ptx.invalid", TRANSCRIPTION_API_KEY: "test-api-key" });
    expect((await post(on.url!, "/api/transcriber/webhooks/ptx", event)).status).toBe(202);
  });

  test("signed PTX delivery verifies the exact bytes without session or CSRF", async () => {
    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    const boot = await bootIndex({
      TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true",
      TRANSCRIPTION_API_URL: "https://ptx.invalid",
      TRANSCRIPTION_API_KEY: "test-api-key",
      TRANSCRIPTION_WEBHOOK_SECRET: secret,
    });
    const event = JSON.stringify({
      type: "meeting.completed",
      data: { meeting_id: "meeting_2", metadata: { tinychat_address: "0x" + "a".repeat(40) } },
    });
    const signature = `sha256=${createHmac("sha256", secret).update(event).digest("hex")}`;
    const path = "/api/transcriber/webhooks/ptx";
    expect((await post(boot.url!, path, event, { "x-webhook-signature": signature })).status).toBe(202);
    expect((await post(boot.url!, path, event + " ", { "x-webhook-signature": signature })).status).toBe(401);
  });

  test("Google OAuth is dark unless armed; only start and callback bypass session authentication", async () => {
    const off = await bootIndex();
    const prefix = "/api/connectors/google/oauth";
    expect((await fetch(off.url! + prefix + "/callback")).status).toBe(404);
    const on = await bootIndex({
      GOOGLE_MEET_OAUTH_ENABLED: "true", GOOGLE_OAUTH_CLIENT_ID: "test-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret", GOOGLE_OAUTH_REDIRECT_URI: "https://app.invalid/callback",
    });
    for (const path of ["/start", "/callback"]) {
      expect((await fetch(on.url! + prefix + path)).status).toBe(400);
    }
    for (const path of ["/exchange", "/refresh", "/revoke"]) {
      expect((await post(on.url!, prefix + path, "{}")).status).toBe(401);
    }
    expect((await fetch(on.url! + prefix + "/unknown")).status).toBe(401);
  });

  test("an armed but unregistered Google OAuth client refuses boot without exposing its secret", async () => {
    const boot = await bootIndex({
      GOOGLE_MEET_OAUTH_ENABLED: "true",
      GOOGLE_OAUTH_CLIENT_ID: "registered-client",
      GOOGLE_OAUTH_CLIENT_SECRET: "private-oauth-secret-marker",
    });
    expect(boot.url).toBeNull();
    expect(boot.exits).toEqual([1]);
    expect(boot.logs.join(" ")).toContain("GOOGLE_OAUTH_REDIRECT_URI");
    expect(boot.logs.join(" ")).not.toContain("private-oauth-secret-marker");
  });

  test("terminal parser errors respond without logging attacker body or an Error object", async () => {
    const boot = await bootIndex();
    const marker = "private-payload-marker";
    const response = await post(boot.url!, "/api/manifest", `{ "${marker}":`, { authorization: "Bearer test-session" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(boot.logs.join(" ")).not.toContain(marker);
    expect(boot.logs.join(" ")).not.toContain("body");
  });

  test("invalid PTX and hosted AssemblyAI configuration refuses boot without exposing credentials", async () => {
    for (const config of [
      { ...ptxEnv, PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "http://ptx.invalid" },
      { ...ptxEnv, PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: undefined },
      { ASSEMBLYAI_API_KEY: "test-assemblyai-secret-marker", ASSEMBLYAI_HOSTED_HANDLE_KEY: "weak" },
      { ASSEMBLYAI_API_KEY: "test-assemblyai-secret-marker", ASSEMBLYAI_HOSTED_HANDLE_KEY: "test-assemblyai-secret-marker" },
    ]) {
      const boot = await bootIndex(config);
      expect(boot.url).toBeNull();
      expect(boot.exits).toEqual([1]);
      expect(boot.logs.length).toBeGreaterThan(0);
      expect(boot.logs.join(" ")).not.toMatch(/test-ptx-secret-marker|test-assemblyai-secret-marker|q3Jm8V0t/);
    }
  });

  test("SIGTERM waits for in-flight HTTP and every worker even when one rejects", async () => {
    const requestStarted = Promise.withResolvers<void>();
    const releaseRequest = Promise.withResolvers<void>();
    const hostedComplete = Promise.withResolvers<void>();
    const exitObserved = Promise.withResolvers<void>();
    const calls: string[] = [];
    const boot = await bootIndex({
      TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true",
      TRANSCRIPTION_API_URL: "https://ptx.invalid",
      TRANSCRIPTION_API_KEY: "test-api-key",
      ASSEMBLYAI_API_KEY: randomBytes(32).toString("hex"),
      ASSEMBLYAI_HOSTED_HANDLE_KEY: randomBytes(32).toString("hex"),
    }, {
      billingEvent: async () => {
        requestStarted.resolve();
        await releaseRequest.promise;
      },
      onExit: () => exitObserved.resolve(),
      stop: {
        transcript: async () => { calls.push("transcript"); throw new Error("stop failed"); },
        hosted: () => { calls.push("hosted"); return hostedComplete.promise; },
      },
    });
    const request = post(boot.url!, "/api/billing/webhook", "{}", {
      "stripe-signature": createHmac("sha256", "isolated-stripe-key").update("{}").digest("hex"),
    });
    await requestStarted.promise;
    boot.signals.emit("SIGTERM");
    await Promise.resolve();
    expect(calls).toEqual(["transcript", "hosted"]);
    expect(boot.exits).toEqual([]);
    hostedComplete.resolve();
    await Promise.resolve();
    expect(boot.exits).toEqual([]);
    releaseRequest.resolve();
    expect((await request).status).toBe(202);
    await exitObserved.promise;
    expect(boot.exits).toEqual([1]);
  });
});
