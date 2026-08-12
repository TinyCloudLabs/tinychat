import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");

describe("backend index middleware wiring", () => {
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

  test("large NRAS JSON parsing happens after auth on the route mount", () => {
    expect(INDEX).not.toContain('app.use("/api/nras-proxy", express.json({ limit: "4mb" }))');
    expect(INDEX).toContain(
      'app.use("/api/nras-proxy", authMiddleware, express.json({ limit: "4mb" }), createNrasProxyRouter())',
    );
  });
});
