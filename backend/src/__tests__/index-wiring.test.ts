import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";

const INDEX = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");

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
  const indexPath = resolve(import.meta.dir, "../index.ts");
  const build = await Bun.build({
    entrypoints: [indexPath],
    target: "node",
    format: "cjs",
    external: ["*"],
    plugins: [{
      name: "isolated-startup",
      setup(builder) {
        builder.onLoad({ filter: /\/index\.ts$/ }, () => ({
          contents: INDEX.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(indexPath).href))
            + "\nexport { main as runMain };\n",
          loader: "ts",
        }));
      },
    }],
  });
  if (!build.success) throw new Error("Could not compile isolated startup fixture");
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
  const load = createRequire(indexPath);
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
      if (id in known) return known[id];
      // These import collaborators only register handlers or hold inert local state.
      return new Proxy({}, { get: (_target, name) => {
        if (name === "__esModule") return false;
        return function () {};
      } });
    },
  };
  runInNewContext(await build.outputs[0]!.text(), context);
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
    const jsonParserIndex = INDEX.indexOf("const globalJsonParser");
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
    const rawWindowEnd = INDEX.indexOf("const globalJsonParser");
    const prefixMount = INDEX.search(/app\.use\(\s*\n?\s*"\/api\/connectors\/webhooks"/);
    expect(rawWindowEnd).toBeGreaterThan(-1);
    expect(prefixMount === -1 || prefixMount > rawWindowEnd).toBe(true);
  });

  test("the authenticated companions mount in the normal window, behind auth", () => {
    // §2.2 consequence 2 / W3b: json + CSRF + applyRateLimiters + authMiddleware, so
    // `POST /config` reaches the handler with a PARSED OBJECT and never a Buffer, and the
    // webhook route's own token-keyed limiter chain does not apply to it.
    const companionMount = INDEX.search(/app\.use\(\s*\n?\s*"\/api\/connectors\/webhooks"/);
    const jsonParserIndex = INDEX.indexOf("const globalJsonParser");
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
    const jsonParserIndex = INDEX.indexOf("const globalJsonParser");
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

  test("large NRAS JSON parsing happens after auth on the route mount", () => {
    expect(INDEX).not.toContain('app.use("/api/nras-proxy", express.json({ limit: "4mb" }))');
    expect(INDEX).toContain(
      'app.use("/api/nras-proxy", authMiddleware, express.json({ limit: "4mb" }), createNrasProxyRouter())',
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
