import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import express from "express";

const INDEX = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");
// The global JSON parser's mount: everything above it is the raw-body window.
const API_BODY_PARSER = "\n  app.use(createApiBodyParser());";

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
const AGENT_ENV = {
  BACKEND_PRIVATE_KEY: "synthetic-private-key",
  AGENT_DID: "synthetic-agent-did",
  ELIZA_SERVICE_URL: "https://tools.invalid",
  ELIZA_SERVICE_SECRET: "synthetic-tool-secret",
  REDPILL_API_KEY: "synthetic-provider-key",
};
const STREAM_ENV = {
  AGENT_STREAM_HEARTBEAT_MS: "17",
  AGENT_STREAM_TURN_TIMEOUT_MS: "251",
  AGENT_STREAM_DRAIN_GRACE_MS: "31",
};

// Execute the actual startup body with isolated imports and environment. Every side effect
// is intercepted; stop at the agent-router factory, before any socket or external I/O.
async function runIsolatedStartup(env: Record<string, string | undefined>) {
  const calls: string[] = [];
  const logs: string[] = [];
  let agentConfig: any;
  const stopped = new Error("synthetic-startup-stopped");
  const noop = () => {};
  const middleware = () => noop;
  const fakeApp = {
    set: noop,
    use: () => { calls.push("mount"); },
    post: () => { calls.push("mount"); },
    get: () => { calls.push("mount"); },
    listen: () => { calls.push("listen"); throw stopped; },
  };
  const express = Object.assign(() => fakeApp, { raw: middleware, json: middleware });
  const moduleExports = {};
  const known: Record<string, any> = {
    fs: { existsSync: () => false },
    path: load("node:path"),
    url: load("node:url"),
    express,
    cors: middleware,
    "./startup.js": {
      createTinychatBackendIdentity: async () => {
        calls.push("identity");
        return { node: {}, did: "synthetic-backend-did" };
      },
    },
    "./services/ingest-mode.js": { backendIngestEnabled: () => false },
    "./services/google-oauth.js": { googleMeetOAuthEnabled: () => false },
    // TC-641: the real default-off parser, so `transcriptDeliveryConfig` is a config, not undefined.
    "./services/transcription-api.js": {
      transcriptDeliveryConfigFromEnv: (e: NodeJS.ProcessEnv) => transcription.transcriptDeliveryConfigFromEnv(e),
      transcriptionApiConfigFromEnv: () => transcription.transcriptionApiConfigFromEnv(env),
      createTranscriptionApiClient: () => ({}),
    },
    "./routes/agent.js": {
      createAgentRouter: (config: unknown) => {
        agentConfig = config;
        calls.push("agent-router");
        throw stopped;
      },
    },
    "./routes/chat.js": {
      defaultModel: "synthetic-model",
      createChatRouter: () => { calls.push("plain-router"); throw stopped; },
    },
    "./billing/ledger-flusher.js": {
      LedgerFlusher: class { start() { calls.push("background"); } },
    },
  };
  const context = {
    Error,
    module: { exports: moduleExports },
    exports: moduleExports,
    process: {
      env,
      argv: [],
      cwd: () => "/synthetic-startup",
      exit: () => { calls.push("exit"); throw stopped; },
    },
    console: { error: (...args: unknown[]) => logs.push(args.join(" ")), log: noop, warn: noop },
    require: (id: string) => {
      if (id === "./agent-stream-policy.js") return load("./agent-stream-policy.ts");
      if (id === "./transcripts/meeting-rollout.js") return load("./transcripts/meeting-rollout.ts");
      if (id === "./services/private-cloud-transcription.js") return load("./services/private-cloud-transcription.ts");
      if (id === "./services/assemblyai-hosted.js") return load("./services/assemblyai-hosted.ts");
      if (id in known) return known[id];
      // These import collaborators only register handlers or hold inert local state.
      return new Proxy({}, { get: (_target, name) => {
        if (name === "__esModule") return false;
        return function () {};
      } });
    },
  };
  runInNewContext(compiled, context);
  try {
    await (context.module.exports as { runMain: () => Promise<void> }).runMain();
  } catch (error) {
    if (error !== stopped) logs.push(error instanceof Error ? error.message : String(error));
  }
  return { calls, logs, agentConfig };
}

describe("agent stream startup policy wiring", () => {
  test("rejects missing policy before identity, background work, route mounting or listening", async () => {
    const result = await runIsolatedStartup({
      ...AGENT_ENV,
      LEDGER_SERVICE_URL: "https://ledger.invalid",
      LEDGER_SERVICE_SECRET: "synthetic-ledger-secret",
    });
    expect(result.logs.join(" ")).toContain("AGENT_STREAM_HEARTBEAT_MS");
    expect(result.calls.filter((call) => call !== "exit")).toEqual([]);
  });

  test("passes the validated numeric values unchanged to the agent handler configuration", async () => {
    const result = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV });
    expect(result.logs).toEqual([]);
    expect(result.agentConfig?.chat?.streamPolicy).toEqual({
      heartbeatMs: 17,
      turnTimeoutMs: 251,
      drainGraceMs: 31,
    });
    expect(result.calls).toContain("agent-router");
    expect(result.calls).not.toContain("listen");
  });

  test("wires explicit meeting account and evaluated-model allowlists with rollout off by default", async () => {
    const initial = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV });
    expect(initial.agentConfig.chat.meetingContentRetrievalEnabled).toBe(false);
    const enabled = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, MEETING_CONTENT_RETRIEVAL_ENABLED: "true", MEETING_CONTENT_TEST_ACCOUNTS: "0xabc", MEETING_CONTENT_MODELS: "phala/evaluated" });
    expect(enabled.logs).toEqual([]); expect(enabled.agentConfig.chat.meetingContentRetrievalEnabled).toBe(true);
    expect(enabled.agentConfig.chat.meetingContentAccountAllowed("0xabc")).toBe(true); expect(enabled.agentConfig.chat.meetingContentAccountAllowed("0xother")).toBe(false);
    expect(enabled.agentConfig.chat.meetingContentModelAllowed("phala/evaluated")).toBe(true); expect(enabled.agentConfig.chat.meetingContentModelAllowed("phala/untested")).toBe(false);
  });

  test("rejects every malformed stream setting before any startup effects without logging values", async () => {
    for (const setting of Object.keys(STREAM_ENV)) {
      for (const value of [undefined, "", "synthetic-private-sentinel", "Infinity", "1.5", "0", "-1", "2147483648"]) {
        const result = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, [setting]: value });
        expect(result.logs).toEqual([`Invalid agent stream configuration: ${setting}`]);
        expect(result.calls).toEqual(["exit"]);
      }
    }
  });

  test("leaves agent sessions available without requiring stream policy when chat is disabled", async () => {
    const result = await runIsolatedStartup({ ...AGENT_ENV, REDPILL_API_KEY: undefined });
    expect(result.logs).toEqual([]);
    expect(result.agentConfig).toBeDefined();
    expect(result.agentConfig.chat).toBeUndefined();
  });

  test("leaves the plain-chat startup path available when the agent is disabled", async () => {
    for (const missing of ["AGENT_DID", "ELIZA_SERVICE_URL", "ELIZA_SERVICE_SECRET"]) {
      const result = await runIsolatedStartup({ ...AGENT_ENV, [missing]: undefined });
      expect(result.logs).toEqual([]);
      expect(result.calls).toContain("plain-router");
      expect(result.calls).not.toContain("agent-router");
    }
  });
});

describe("backend index middleware wiring", () => {
  test("CORS uses the web + Exo desktop origin allowlist", () => {
    expect(INDEX).toContain('import { appCorsOrigins } from "./cors-origins.js"');
    expect(INDEX).toContain("app.use(cors({ origin: appCorsOrigins(FRONTEND_URL) }))");
  });

  test("trusts exactly one ingress proxy before rate limiters are applied", () => {
    const trustIndex = INDEX.indexOf('app.set("trust proxy", 1)');
    const limiterIndex = INDEX.indexOf("applyRateLimiters(app)");

    expect(trustIndex).toBeGreaterThan(-1);
    expect(limiterIndex).toBeGreaterThan(-1);
    expect(trustIndex).toBeLessThan(limiterIndex);
  });

  test("the connectors webhook mounts inside the raw-body window", () => {
    // §4.3/§8.4 — the guard listen never had. The HMAC is computed over the exact bytes
    // Fireflies signed, Fireflies sends no X-Requested-With, and an unauthenticated public
    // route must not share the global per-IP bucket in either direction.
    const billingIndex = INDEX.indexOf('"/api/billing/webhook"');
    const webhookIndex = INDEX.indexOf('"/api/connectors/webhooks/:source/:token"');
    const jsonParserIndex = INDEX.indexOf(API_BODY_PARSER);
    const csrfIndex = INDEX.indexOf("createCsrfMiddleware()");
    const limiterIndex = INDEX.indexOf("applyRateLimiters(app)");

    expect(billingIndex).toBeGreaterThan(-1);
    expect(webhookIndex).toBeGreaterThan(billingIndex);
    expect(webhookIndex).toBeLessThan(jsonParserIndex);
    expect(webhookIndex).toBeLessThan(csrfIndex);
    expect(webhookIndex).toBeLessThan(limiterIndex);
  });

  test("the connectors webhook raw parser carries the 64kb cap and inflate:false", () => {
    expect(INDEX).toContain('express.raw({ type: "application/json", limit: "64kb", inflate: false })');
  });

  test("the parser's own rejects are metered, immediately after express.raw", () => {
    // §4.4's accounting: a 413/415 that dies in the parser used to reach no bucket at all,
    // including the IP-INDEPENDENT ceiling. Order matters — before the parser it would never
    // see a parser error; after the handler it would be unreachable for the mount's own rejects.
    const rawIndex = INDEX.indexOf("express.raw({ type: \"application/json\"");
    const meterIndex = INDEX.indexOf("createConnectorWebhookParserErrorHandler(");
    const handlerIndex = INDEX.indexOf("createConnectorWebhookHandler({");
    expect(meterIndex).toBeGreaterThan(rawIndex);
    expect(meterIndex).toBeLessThan(handlerIndex);
  });

  test("the public webhook mount is app.post on the exact path and never a prefix mount", () => {
    // An app.use on the prefix in the RAW WINDOW would Buffer-ify the authenticated
    // companions' JSON bodies and hand them a token-keyed limiter with an undefined key.
    // The companions' own prefix mount is correct — but only after the JSON parser (below).
    expect(INDEX).toContain('app.post(\n      "/api/connectors/webhooks/:source/:token",');
    const rawWindowEnd = INDEX.indexOf(API_BODY_PARSER);
    const prefixMount = INDEX.search(/app\.use\(\s*\n?\s*"\/api\/connectors\/webhooks"/);
    expect(rawWindowEnd).toBeGreaterThan(-1);
    expect(prefixMount === -1 || prefixMount > rawWindowEnd).toBe(true);
  });

  test("the authenticated companions mount in the normal window, behind auth", () => {
    // §2.2 consequence 2 / W3b: json + CSRF + applyRateLimiters + authMiddleware, so
    // `POST /config` reaches the handler with a PARSED OBJECT and never a Buffer, and the
    // webhook route's own token-keyed limiter chain does not apply to it.
    const companionMount = INDEX.search(/app\.use\(\s*\n?\s*"\/api\/connectors\/webhooks"/);
    const jsonParserIndex = INDEX.indexOf(API_BODY_PARSER);
    const csrfIndex = INDEX.indexOf("createCsrfMiddleware()");
    const limiterIndex = INDEX.indexOf("applyRateLimiters(app)");

    expect(companionMount).toBeGreaterThan(jsonParserIndex);
    expect(companionMount).toBeGreaterThan(csrfIndex);
    expect(companionMount).toBeGreaterThan(limiterIndex);
    expect(INDEX).toMatch(
      /app\.use\(\s*\n?\s*"\/api\/connectors\/webhooks",\s*\n?\s*authMiddleware,/,
    );
    expect(INDEX).toContain("createConnectorWebhookCompanionRouter({");
  });

  test("the companion routes each stay exactly one path segment deep", () => {
    // Two segments deep would be matched by the public raw mount instead (§4.3's collision
    // rule), so this reads the router source and pins every literal it registers.
    const ROUTES = readFileSync(resolve(import.meta.dir, "../routes/connector-webhooks.ts"), "utf8");
    const paths = [...ROUTES.matchAll(/router\.(get|post|delete|put|patch)\(\s*"([^"]+)"/g)].map(
      (m) => m[2]!,
    );
    expect(paths.length).toBeGreaterThanOrEqual(6);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(true);
      expect(path.slice(1).split("/").filter(Boolean).length).toBe(1);
    }
    // The four companion families §11.2 names, all present.
    expect(paths).toContain("/config");
    expect(paths).toContain("/pending");
    expect(paths).toContain("/drain");
    expect(paths).toContain("/purged");
  });

  test("the connector companions and /api/delegations carry their own rate-limit buckets", () => {
    // §4.4 — never globalLimiter's 120/15min, which /api/chat shares.
    const LIMITS = readFileSync(resolve(import.meta.dir, "../rate-limits.ts"), "utf8");
    expect(LIMITS).toContain('CONNECTOR_COMPANION_PATHS = ["/api/connectors/webhooks"]');
    expect(LIMITS).toContain('DELEGATION_PATHS = ["/api/delegations"]');
    expect(LIMITS).toContain("connectorCompanionLimiter");
    expect(LIMITS).toContain("delegationLimiter");
  });

  test("no companion path can overlap the two-segment public route", () => {
    // Every `/api/connectors/webhooks/...` literal in index.ts must be either the public
    // two-param mount or ONE segment deep. Two segments deep would collide with the public
    // route and inherit the raw parser.
    const paths = [...INDEX.matchAll(/"(\/api\/connectors\/webhooks[^"]*)"/g)].map((m) => m[1]!);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      if (path === "/api/connectors/webhooks/:source/:token") continue;
      const rest = path.slice("/api/connectors/webhooks".length).replace(/^\//, "");
      expect(rest.split("/").filter(Boolean).length).toBeLessThanOrEqual(1);
    }
  });

  test("a terminal Express error handler is registered so no async throw hangs a socket", () => {
    // §4.3 requirement 2 — Express 4 does not await handler promises, and this app had no
    // error middleware at all: a throw on an unauthenticated route hung the socket to timeout.
    expect(INDEX).toMatch(/app\.use\(\s*\(\s*err[^)]*res[^)]*\)/);
    const errorHandlerIndex = INDEX.search(/app\.use\(\s*\(\s*err[^)]*res[^)]*\)/);
    const webhookIndex = INDEX.indexOf('"/api/connectors/webhooks/:source/:token"');
    expect(errorHandlerIndex).toBeGreaterThan(webhookIndex);
  });

  test("the terminal error handler logs a projection, never the error object (§6.3)", () => {
    // body-parser attaches the raw request body to an `entity.parse.failed` error as
    // `err.body`, and inspecting an Error prints its own enumerable properties — so logging the
    // object publishes attacker-chosen bytes (a serialized delegation bundle, raw meeting ids)
    // into the stream the code itself documents as `public_logs=true`, from an unauthenticated
    // route that runs before CSRF and before auth.
    expect(INDEX).not.toMatch(/console\.error\([^)]*,\s*err\s*\)/);
    expect(INDEX).toContain('console.error("[express] route error"');
  });

  test("the delegation middleware is not built for a reader that does not exist", () => {
    // Under Option B nothing consumes `req.delegatedAccess`; the factory is wired when an
    // Option A writer path lands, not before.
    expect(INDEX).not.toMatch(/=\s*createDelegationMiddleware\(/);
  });

  test("the google oauth mount lives INSIDE the googleMeetOAuthEnabled() branch", () => {
    // WP-A ships dark (gmeet plan §6/§11): flag off ⇒ no mount ⇒ 404 on all five paths, the same
    // canary shape the webhook route has. A mount that drifted OUT of the branch would arm the
    // OAuth proxy on every deployment the moment this file is edited.
    const gate = INDEX.lastIndexOf("if (googleMeetOAuthEnabled()) {");
    const mount = INDEX.indexOf('"/api/connectors/google/oauth"');
    expect(gate).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(gate);
    // Nothing closes the branch between the gate and the mount — a `\n  }` is a top-level
    // statement boundary inside main(), so its absence is what "inside" means here.
    expect(INDEX.slice(gate, mount)).not.toMatch(/\n {2}\}/);
    // Exactly ONE mount: a second app.use on the prefix would re-run the router with a
    // different middleware chain, and the unauthenticated one would win.
    expect(INDEX.match(/"\/api\/connectors\/google\/oauth"/g)).toHaveLength(1);
  });

  test("google oauth mounts in the NORMAL window — parser, CSRF and its own limiter first", () => {
    // The opposite of the webhook route's raw window. These bodies are ordinary JSON, the POSTs
    // must be CSRF-covered, and the prefix has to reach `applyRateLimiters` for its own bucket.
    const mount = INDEX.indexOf('"/api/connectors/google/oauth"');
    const jsonParserIndex = INDEX.indexOf(API_BODY_PARSER);
    const csrfIndex = INDEX.indexOf("createCsrfMiddleware()");
    const limiterIndex = INDEX.indexOf("applyRateLimiters(app)");

    expect(mount).toBeGreaterThan(jsonParserIndex);
    expect(mount).toBeGreaterThan(csrfIndex);
    expect(mount).toBeGreaterThan(limiterIndex);
  });

  test("GET /start and /callback mount WITHOUT authMiddleware; the three POSTs are behind it", () => {
    // `/callback` is a top-level navigation from Google and carries no Bearer — middleware/auth.ts
    // would 401 it before the popup could hand `{code, state}` back. CSRF exempts GET, and the
    // anti-forgery control on the pair is the `state` param the SPA mints and re-checks.
    // `authMiddleware` must therefore NOT sit unconditionally in front of the mount…
    expect(INDEX).not.toMatch(
      /app\.use\(\s*\n?\s*"\/api\/connectors\/google\/oauth",\s*\n?\s*authMiddleware/,
    );
    // …it is reached through an ALLOWLIST gate: exactly the two GETs skip it, everything else
    // (the three POSTs, and any route added later) goes through it. Default-deny, so the
    // accident falls toward authentication rather than away from it.
    expect(INDEX).toContain(
      'export const GOOGLE_OAUTH_PUBLIC_PATHS: ReadonlySet<string> = new Set([\n  "/start",\n  "/callback",\n]);',
    );
    expect(INDEX).toMatch(
      /if \(req\.method === "GET" && GOOGLE_OAUTH_PUBLIC_PATHS\.has\(req\.path\)\) \{/,
    );
    expect(INDEX).toMatch(/void authMiddleware\(req, res, next\);/);

    // And the router really does register those five and only those five, split the way the
    // gate assumes: the unauthenticated names are GETs, the authenticated ones are POSTs.
    const ROUTES = readFileSync(resolve(import.meta.dir, "../routes/google-oauth.ts"), "utf8");
    const registered = [...ROUTES.matchAll(/router\.(get|post|delete|put|patch)\(\s*"([^"]+)"/g)]
      .map((m) => ({ method: m[1]!, path: m[2]! }));
    expect(registered).toEqual([
      { method: "get", path: "/start" },
      { method: "get", path: "/callback" },
      { method: "post", path: "/exchange" },
      { method: "post", path: "/refresh" },
      { method: "post", path: "/revoke" },
    ]);
    // Nothing that reaches Google's token endpoint may be in the public set.
    for (const route of registered) {
      const isPublic = ['"/start"', '"/callback"'].includes(`"${route.path}"`);
      expect(isPublic).toBe(route.method === "get");
    }
  });

  test("the google oauth prefix carries its own rate-limit bucket, never the global one", () => {
    // An OAuth dance plus a few refreshes must not spend `/api/chat`'s 120/15min allowance —
    // the same rule §4.4 applies to the connector companions.
    const LIMITS = readFileSync(resolve(import.meta.dir, "../rate-limits.ts"), "utf8");
    expect(LIMITS).toContain('GOOGLE_OAUTH_PATHS = ["/api/connectors/google/oauth"]');
    expect(LIMITS).toContain("googleOAuthLimiter");
    // …and the prefix is EXEMPTED from the global bucket, not merely given a second one.
    expect(LIMITS).toMatch(/const DEDICATED_PATHS = \[[\s\S]*\.\.\.GOOGLE_OAUTH_PATHS,[\s\S]*\]/);
  });

  test("an armed-but-unregistered google OAuth config refuses to boot", () => {
    // The `firefliesOAuthConfigFromEnv` posture (:236): an operator who sets the flag and forgets
    // a client var learns it from a refused start, not from a user's half-finished consent screen.
    const bootCheck = INDEX.indexOf("if (googleMeetOAuthEnabled()) {");
    const mount = INDEX.indexOf('"/api/connectors/google/oauth"');
    expect(bootCheck).toBeGreaterThan(-1);
    expect(bootCheck).toBeLessThan(mount);
    const block = INDEX.slice(bootCheck, mount);
    expect(block).toContain("googleOAuthConfigFromEnv(process.env)");
    // The callback's postMessage target is validated at boot too — a `*` or a bare host must not
    // wait until the first consent to fail.
    expect(block).toContain("normalizeAppOrigin(FRONTEND_URL)");
    expect(block).toMatch(/process\.exit\(1\)/);
  });

  test("private cloud transcription mounts once for every account, behind auth, CSRF and limiter", () => {
    const mount = INDEX.indexOf("PRIVATE_CLOUD_TRANSCRIPTION_MOUNT,\n    authMiddleware,");
    expect(mount).toBeGreaterThan(-1);
    expect(INDEX.match(/app\.use\(\s*PRIVATE_CLOUD_TRANSCRIPTION_MOUNT/g)).toHaveLength(1);
    expect(mount).toBeGreaterThan(INDEX.indexOf(API_BODY_PARSER));
    expect(mount).toBeGreaterThan(INDEX.indexOf("createCsrfMiddleware()"));
    expect(mount).toBeGreaterThan(INDEX.indexOf("applyRateLimiters(app)"));
  });

  test("hosted AssemblyAI mounts once, unconditionally, behind auth, and its parts skip the global JSON parser", () => {
    const mount = INDEX.indexOf("\n  app.use(ASSEMBLYAI_HOSTED_MOUNT, authMiddleware, createAssemblyAiHostedRouter(");
    expect(mount).toBeGreaterThan(-1);
    expect(INDEX.match(/app\.use\(\s*ASSEMBLYAI_HOSTED_MOUNT/g)).toHaveLength(1);
    expect(mount).toBeGreaterThan(INDEX.indexOf("createCsrfMiddleware()"));
    expect(mount).toBeGreaterThan(INDEX.indexOf("applyRateLimiters(app)"));
    // The global parser moved into body-parsing.ts; the hosted-part skip moved with it.
    expect(INDEX).toContain('import { createApiBodyParser } from "./body-parsing.js";');
    const parser = readFileSync(resolve(import.meta.dir, "../body-parsing.ts"), "utf8");
    expect(parser).toContain("isHostedPartPath(req.path)");
  });

  test("large NRAS JSON parsing happens after auth on the route mount", () => {
    expect(INDEX).not.toContain('app.use("/api/nras-proxy", express.json({ limit: "4mb" }))');
    expect(INDEX).toContain(
      'app.use("/api/nras-proxy", authMiddleware, express.json({ limit: "4mb" }), createNrasProxyRouter())',
    );
  });

  test("createApiBodyParser mounts once, at the top level, closing the raw window before CSRF, limiters and JSON routes", () => {
    const parser = INDEX.indexOf(API_BODY_PARSER);
    expect(parser).toBeGreaterThan(-1);
    expect(INDEX.match(/createApiBodyParser\(\)/g)).toHaveLength(1);
    // No second global JSON parser may reappear beside it.
    expect(INDEX).not.toMatch(/app\.use\(\s*express\.json\(/);
    expect(INDEX).not.toContain("globalJsonParser");
    // Raw-body routes sit above it…
    for (const raw of ['"/api/billing/webhook"', '"/api/connectors/webhooks/:source/:token"', 'app.use("/api/transcriber/webhooks/ptx"', 'app.post("/api/transcriber/webhooks/ptx"']) {
      const at = INDEX.indexOf(raw);
      expect({ raw, mounted: at > -1, beforeParser: at < parser }).toEqual({ raw, mounted: true, beforeParser: true });
    }
    // …and CSRF, the limiters and every JSON route below it.
    for (const later of ["app.use(createCsrfMiddleware())", "applyRateLimiters(app)", '"/api/auth"', '"/api/delegations"', '"/api/manifest"']) {
      const at = INDEX.indexOf(later);
      expect({ later, afterParser: at > parser }).toEqual({ later, afterParser: true });
    }
  });

  test("createApiBodyParser leaves delegation acceptance, NRAS and hosted parts unread", () => {
    const PARSER = readFileSync(resolve(import.meta.dir, "../body-parsing.ts"), "utf8");
    // Delegation POSTs are gated on eligibility before their route-local parser reads a byte.
    expect(PARSER).toContain('(req.method === "POST" && /^\\/api\\/delegations\\/*$/i.test(req.path))');
    expect(PARSER).toContain('req.path === "/api/nras-proxy"');
    expect(PARSER).toContain('req.path.startsWith("/api/nras-proxy/")');
    expect(PARSER).toContain("isHostedPartPath(req.path)");
    const ROUTES = readFileSync(resolve(import.meta.dir, "../routes/delegations.ts"), "utf8");
    const gate = ROUTES.indexOf('if (!config.eligibility(user.address)) { res.status(403).json({ error: "delivery_disabled" }); return; }');
    const json = ROUTES.indexOf('express.json({ limit: "96kb" })');
    expect(gate).toBeGreaterThan(-1);
    expect(json).toBeGreaterThan(gate);
  });

  test("the PTX webhook mounts in the raw window, only inside the transcriptWorker branch, with a dark 404 otherwise", () => {
    const worker = INDEX.indexOf("const transcriptWorker = transcriptDeliveryConfig.enabled && transcriberApi");
    const gate = INDEX.indexOf("if (transcriptWorker) {");
    const mount = INDEX.indexOf('app.use("/api/transcriber/webhooks/ptx", createTranscriberWebhookRouter(');
    const dark = INDEX.indexOf('app.post("/api/transcriber/webhooks/ptx", (_req, res) => res.sendStatus(404));');
    expect(worker).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(worker);
    expect(mount).toBeGreaterThan(gate);
    expect(INDEX.slice(gate, mount)).not.toMatch(/\n {2}\}/);
    expect(INDEX.slice(mount, dark)).toContain("} else {");
    expect(INDEX.match(/"\/api\/transcriber\/webhooks\/ptx"/g)).toHaveLength(2);
    // After Stripe, before the global parser, CSRF and the shared limiter.
    const billing = INDEX.indexOf('"/api/billing/webhook"');
    for (const at of [mount, dark]) {
      expect(at).toBeGreaterThan(billing);
      expect(at).toBeLessThan(INDEX.indexOf(API_BODY_PARSER));
      expect(at).toBeLessThan(INDEX.indexOf("createCsrfMiddleware()"));
      expect(at).toBeLessThan(INDEX.indexOf("applyRateLimiters(app)"));
    }
  });

  test("shutdown drains HTTP and every worker in one allSettled", () => {
    expect(INDEX).toContain(
      "Promise.allSettled([httpDrained, transcriptWorker?.stop(), calendarAutojoinWorker?.stop(), ingestSupervisor?.stop(), hostedUploads?.shutdown()])",
    );
  });
});

test("diagnostic foreground override isolates agent sends while unset startup preserves provider defaults", async () => {
  const initial = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, REDPILL_BASE_URL: "https://background.invalid/background" });
  expect(initial.agentConfig.chat.redpillBaseUrl).toBe("https://background.invalid/background");
  expect(initial.agentConfig.chat.redpillApiKey).toBe("synthetic-provider-key");
  const diagnostic = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, REDPILL_BASE_URL: "https://background.invalid/background",
    MEETING_DIAGNOSTIC_FOREGROUND_BASE_URL: "https://gateway.invalid/foreground", MEETING_DIAGNOSTIC_FOREGROUND_API_KEY: "synthetic-foreground-key" });
  expect(diagnostic.agentConfig.chat.redpillBaseUrl).toBe("https://gateway.invalid/foreground");
  expect(diagnostic.agentConfig.chat.redpillApiKey).toBe("synthetic-foreground-key");
  expect(diagnostic.logs).toEqual([]);
});

test("partial or empty diagnostic endpoint credentials fail before startup effects and never log values", async () => {
  for (const partial of [
    { MEETING_DIAGNOSTIC_FOREGROUND_BASE_URL: "https://gateway.invalid/foreground" },
    { MEETING_DIAGNOSTIC_FOREGROUND_API_KEY: "synthetic-sensitive-marker" },
    { MEETING_DIAGNOSTIC_FOREGROUND_BASE_URL: "", MEETING_DIAGNOSTIC_FOREGROUND_API_KEY: "synthetic-sensitive-marker" },
    { MEETING_DIAGNOSTIC_FOREGROUND_BASE_URL: "https://gateway.invalid/foreground", MEETING_DIAGNOSTIC_FOREGROUND_API_KEY: "" },
  ]) {
    const result = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, ...partial });
    expect(result.calls).toEqual(["exit"]);
    expect(result.logs).toEqual(["Invalid meeting diagnostic foreground configuration: set both endpoint and API key, or neither"]);
  }
});

test("armed private cloud transcription with a bad or missing value refuses boot before startup effects, without logging values", async () => {
  const armed = {
    PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "https://ptx-batch.invalid",
    PRIVATE_CLOUD_TRANSCRIPTION_API_KEY: "synthetic-ptx-batch-key",
    PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: "q3Jm8V0t6n0bqK1i2Xz7cP4sWf9YhR5uLd2eA8gT1kM=",
  };
  const ok = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, ...armed });
  expect(ok.logs).toEqual([]);
  expect(ok.calls).toContain("agent-router");
  for (const patch of [
    { PRIVATE_CLOUD_TRANSCRIPTION_TENANT_KEY: undefined },
    { PRIVATE_CLOUD_TRANSCRIPTION_API_URL: "http://ptx-batch.invalid" },
    { PRIVATE_CLOUD_TRANSCRIPTION_API_KEY: "" },
    // The batch key must be a distinct credential from the meeting transcriber's.
    { TRANSCRIPTION_API_KEY: "synthetic-ptx-batch-key" },
  ]) {
    const result = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, ...armed, ...patch });
    expect(result.logs.join(" ")).toContain("PRIVATE_CLOUD_TRANSCRIPTION_");
    expect(result.logs.join(" ")).not.toContain("synthetic-ptx-batch-key");
    expect(result.logs.join(" ")).not.toContain("q3Jm8V0t");
    expect(result.calls).toEqual(["exit"]);
  }
});

test("a set but weak or reused hosted AssemblyAI handle key refuses boot before startup effects, without logging values", async () => {
  const unset = await runIsolatedStartup({ ...AGENT_ENV, ...STREAM_ENV, ASSEMBLYAI_API_KEY: "synthetic-assemblyai-server-key" });
  // One key alone is "hosted off", not a boot failure.
  expect(unset.logs).toEqual([]);
  expect(unset.calls).toContain("agent-router");
  for (const handleKey of ["short-weak-value", "synthetic-assemblyai-server-key"]) {
    const result = await runIsolatedStartup({
      ...AGENT_ENV,
      ...STREAM_ENV,
      ASSEMBLYAI_API_KEY: "synthetic-assemblyai-server-key",
      ASSEMBLYAI_HOSTED_HANDLE_KEY: handleKey,
    });
    expect(result.logs.join(" ")).toContain("ASSEMBLYAI_HOSTED_HANDLE_KEY");
    expect(result.logs.join(" ")).not.toContain("synthetic-assemblyai-server-key");
    expect(result.logs.join(" ")).not.toContain("short-weak-value");
    expect(result.calls).toEqual(["exit"]);
  }
});

test("shutdown waits for other cleanups after a worker rejects", async () => {
  const start = INDEX.indexOf("  let shuttingDown = false;");
  const end = INDEX.indexOf('\n  process.on("SIGTERM"', start);
  const source = new Bun.Transpiler({ loader: "ts" }).transformSync(INDEX.slice(start, end) + '\nshutdown("SIGTERM");');
  const pending = Promise.withResolvers<void>();
  const exits: number[] = [];
  const attempts: string[] = [];
  runInNewContext(source, {
    Promise,
    console: { log: () => {} },
    process: { exit: (code: number) => exits.push(code) },
    setTimeout: () => ({ unref() {} }),
    ledgerFlusher: null, connectorWebhooks: null, connectorQueueMaintenance: null,
    server: { close: (done: () => void) => done(), closeIdleConnections() {} },
    transcriptWorker: { stop: () => { attempts.push("transcript"); return Promise.reject(new Error("synthetic")); } },
    calendarAutojoinWorker: { stop: () => { attempts.push("calendar"); return Promise.reject(new Error("synthetic")); } },
    ingestSupervisor: { stop: () => { attempts.push("ingest"); return pending.promise; } },
    hostedUploads: { shutdown: () => { attempts.push("hosted"); return Promise.resolve(); } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const exitedEarly = [...exits];
  pending.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(attempts).toEqual(["transcript", "calendar", "ingest", "hosted"]);
  expect(exitedEarly).toEqual([]);
  expect(exits).toEqual([1]);
});

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

  test("PTX webhook is dark by default and fails closed when armed without its receiver secret", async () => {
    const off = await bootIndex();
    const event = JSON.stringify({ type: "meeting.completed", data: { meeting_id: "meeting_1", metadata: { tinychat_address: "0x" + "a".repeat(40) } } });
    const path = "/api/transcriber/webhooks/ptx";
    expect((await post(off.url!, path, event)).status).toBe(404);
    const unset = await bootIndex({ TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true", TRANSCRIPTION_API_URL: "https://ptx.invalid", TRANSCRIPTION_API_KEY: "test-api-key" });
    expect((await post(unset.url!, path, event)).status).toBe(503);
    const empty = await bootIndex({ TRANSCRIPT_SERVER_DELIVERY_ENABLED: "true", TRANSCRIPTION_API_URL: "https://ptx.invalid", TRANSCRIPTION_API_KEY: "test-api-key", TRANSCRIPTION_WEBHOOK_SECRET: "" });
    expect((await post(empty.url!, path, event)).status).toBe(503);
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
    expect((await post(boot.url!, path, event)).status).toBe(401);
    expect((await post(boot.url!, path, event, { "x-webhook-signature": "sha256=" + "0".repeat(64) })).status).toBe(401);
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
