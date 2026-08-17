import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { load as loadYaml } from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = loadYaml(readFileSync(resolve(__dirname, "../../openapi.yaml"), "utf-8")) as Record<
  string,
  unknown
>;

function components() {
  return spec.components as Record<string, Record<string, unknown>>;
}

function paths() {
  return spec.paths as Record<string, Record<string, Record<string, unknown>>>;
}

describe("TinyChat OpenAPI spec", () => {
  test("is OpenAPI 3.1 and publishes the starter routes", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(paths())).toEqual(
      expect.arrayContaining([
        "/api/manifest",
        "/api/server-info",
        "/api/auth/nonce",
        "/api/auth/verify",
        "/api/delegations",
        "/api/delegations/status",
        "/api/chat",
        "/api/chat/models",
        "/api/attestation/self",
        "/api/billing/config",
        "/api/billing/rates",
        "/api/billing/status",
        "/api/billing/checkout",
        "/api/billing/portal",
        "/api/billing/webhook",
      ]),
    );
  });

  test("documents billing routes, paywall errors, and cents-based pricing", () => {
    // Public pricing + rates + webhook are unauthenticated; status/checkout/portal need auth.
    expect(paths()["/api/billing/config"].get.security).toEqual([]);
    expect(paths()["/api/billing/rates"].get.security).toEqual([]);
    expect(paths()["/api/billing/webhook"].post.security).toEqual([]);
    expect(paths()["/api/billing/status"].get.security).toEqual([{ bearerAuth: [] }]);
    expect(paths()["/api/billing/checkout"].post.security).toEqual([{ bearerAuth: [] }]);

    // 402 paywall response on chat.
    expect(paths()["/api/chat"].post.responses["402"]).toEqual({
      $ref: "#/components/responses/PaymentRequired",
    });

    const schemas = components().schemas as Record<string, Record<string, any>>;
    // Paywall error contract used by the frontend.
    expect(schemas.PaywallError.properties.error.enum).toEqual([
      "model_not_allowed",
      "credit_budget_exceeded",
    ]);
    // Model annotation contract — rate fields are always present (spec §6).
    expect(schemas.ModelInfo.required).toEqual([
      "id",
      "allowed",
      "creditsPerKInput",
      "creditsPerKOutput",
      "multiplier",
    ]);
    expect(schemas.ModelInfo.properties.requiredTier.enum).toEqual(["plus", "pro"]);
    // TierInfo carries credit budget (renamed from tokenBudget).
    expect(schemas.TierInfo.required).toContain("creditBudget");
    expect(schemas.TierInfo.properties).not.toHaveProperty("tokenBudget");
    // Weekly-windows: budgetWindow enum must stay [day, week] (never revert to month).
    expect(schemas.TierInfo.properties.budgetWindow.enum).toEqual(["day", "week"]);
    // SubscriptionInfo must carry the billing anchor for weekly-window math.
    expect(schemas.SubscriptionInfo.required).toContain("anchor");
    expect(schemas.SubscriptionInfo.properties.anchor).toBeTruthy();
    // Rates response contract.
    expect(schemas.RatesResponse.required).toEqual(["baseline", "models"]);
    expect(schemas.RateInfo.required).toEqual([
      "id",
      "creditsPerKInput",
      "creditsPerKOutput",
      "multiplier",
    ]);
    // /api/billing/rates mirrors /models' error contract (500 + 502).
    expect(paths()["/api/billing/rates"].get.responses["502"]).toEqual({
      $ref: "#/components/responses/UpstreamError",
    });
    expect(paths()["/api/billing/rates"].get.responses["500"]).toEqual({
      $ref: "#/components/responses/InternalError",
    });
    // Display prices documented as integer cents.
    expect(schemas.TierInfo.properties.priceMonthly.description).toContain("cents");
  });

  test("does not expose the removed probe route", () => {
    expect(Object.keys(paths())).not.toContain("/api/probe");
  });

  test("defines bearer auth and leaves public bootstrap routes unauthenticated", () => {
    const schemes = components().securitySchemes as Record<string, Record<string, unknown>>;
    expect(schemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    expect(paths()["/api/manifest"].get.security).toEqual([]);
    expect(paths()["/api/server-info"].get.security).toEqual([]);
    expect(paths()["/api/auth/nonce"].get.security).toEqual([]);
    expect(paths()["/api/auth/verify"].post.security).toEqual([]);
    expect(paths()["/api/chat"].post.security).toEqual([{ bearerAuth: [] }]);
    expect(paths()["/api/chat/models"].get.security).toEqual([{ bearerAuth: [] }]);
    expect(paths()["/api/attestation/self"].get.security).toEqual([{ bearerAuth: [] }]);
  });

  test("documents delegation status including stale", () => {
    const schemas = components().schemas as Record<string, Record<string, any>>;
    expect(schemas.DelegationStatus.enum).toEqual(["active", "expired", "none", "stale"]);
    expect(schemas.DelegationResponse.properties.status).toEqual({
      $ref: "#/components/schemas/DelegationStatus",
    });
  });

  test("requires policy hash on the server-info contract", () => {
    const schemas = components().schemas as Record<string, Record<string, any>>;
    expect(schemas.ServerInfo.required).toEqual([
      "did",
      "status",
      "name",
      "expiry",
      "permissions",
      "policyHash",
    ]);
    expect(schemas.ServerInfo.properties.policyHash).toEqual({
      type: "string",
      pattern: "^[a-f0-9]{64}$",
    });
  });

  test("defines chat schemas and common API error responses", () => {
    const schemas = components().schemas as Record<string, Record<string, unknown>>;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        "ApiError",
        "DelegationResponse",
        "Manifest",
        "ChatRequest",
        "ChatMessage",
        "ModelsResponse",
        "ModelInfo",
        "ServerInfo",
      ]),
    );

    expect(paths()["/api/chat"].post.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ChatRequest" },
        },
      },
    });
    expect(paths()["/api/chat"].post.responses["400"]).toEqual({
      $ref: "#/components/responses/BadRequest",
    });
    expect(paths()["/api/chat"].post.responses["502"]).toEqual({
      $ref: "#/components/responses/UpstreamError",
    });
    expect(paths()["/api/chat/models"].get.responses["502"]).toEqual({
      $ref: "#/components/responses/UpstreamError",
    });
  });
});

/**
 * Connector webhooks (W6b). Additive: nothing above changes. The group documents a
 * flag-gated mount — while `CONNECTOR_WEBHOOKS_ENABLED` is off every path here 404s,
 * which is exactly what the post-deploy probe asserts.
 */
describe("connector webhook paths", () => {
  test("publishes the public delivery route and every authenticated companion", () => {
    expect(Object.keys(paths())).toEqual(
      expect.arrayContaining([
        "/api/connectors/webhooks/{source}/{token}",
        "/api/connectors/webhooks/config",
        "/api/connectors/webhooks/pending",
        "/api/connectors/webhooks/drain",
        "/api/connectors/webhooks/ack",
        "/api/connectors/webhooks/purged",
      ]),
    );
  });

  test("every companion path is ONE segment deep — two would hit the raw public mount", () => {
    for (const path of Object.keys(paths())) {
      if (!path.startsWith("/api/connectors/webhooks/")) continue;
      if (path === "/api/connectors/webhooks/{source}/{token}") continue;
      expect(path.slice("/api/connectors/webhooks/".length)).not.toContain("/");
    }
  });

  test("/ack settles by session-owned identity, successes only, no silent truncation", () => {
    const ackPath = paths()["/api/connectors/webhooks/ack"];
    expect(ackPath.post).toBeTruthy();
    // Authenticated like every other companion — never `security: []`.
    expect(ackPath.post.security).toBeUndefined();
    const body = ackPath.post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/ConnectorAckRequest" });

    const schemas = components().schemas as Record<string, Record<string, any>>;
    const request = schemas.ConnectorAckRequest;
    // Ownership comes from the session; a body address would be a cross-tenant settle.
    expect(Object.keys(request.properties)).not.toContain("address");
    expect(request.required).toEqual(["items"]);
    const item = request.properties.items;
    // An over-cap batch is a documented 400, never a silent truncation.
    expect(item.minItems).toBe(1);
    expect(item.maxItems).toBe(200);
    expect(item.items.required).toEqual(["meetingId", "kind"]);
    expect(item.items.properties.meetingId.pattern).toBe("^[A-Za-z0-9_-]{1,64}$");
    expect(item.items.properties.kind.enum).toEqual(["transcript", "summary"]);
    // SUCCESS acks only — a browser-reported failure has no shape to arrive in.
    expect(item.items.properties.status.const).toBe("done");
    expect(Object.keys(item.items.properties)).not.toContain("error");
    expect(Object.keys(item.items.properties)).not.toContain("lastError");

    // The response is the caller's OWN queue snapshot plus the settlement counts.
    const result = schemas.ConnectorAckResult;
    expect(result.allOf[0]).toEqual({
      $ref: "#/components/schemas/ConnectorWebhookPending",
    });
    expect(result.allOf[1].required).toEqual([
      "status",
      "acknowledged",
      "alreadySettled",
      "tombstoned",
    ]);
    expect(ackPath.post.responses["400"]).toBeTruthy();
    expect(ackPath.post.responses["401"]).toEqual({
      $ref: "#/components/responses/Unauthenticated",
    });
  });

  test("documents BOTH verbs on /purged — the ledger has a record and a clear", () => {
    const purged = paths()["/api/connectors/webhooks/purged"];
    expect(purged.post).toBeTruthy();
    expect(purged.delete).toBeTruthy();
    // The clear verb is the re-sync path; without it a purge is permanent by accident.
    expect(purged.delete.responses["204"]).toBeTruthy();
    expect(purged.post.responses["204"]).toBeTruthy();
    // The overflow is REPORTED, never a silent truncation.
    const overflow = purged.post.responses["200"].content["application/json"].schema;
    expect(overflow.required).toEqual(["status", "stored", "dropped"]);
    // Address comes from the session, never the body.
    const body = purged.post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/ConnectorPurgeRequest" });
    const schemas = components().schemas as Record<string, Record<string, any>>;
    expect(Object.keys(schemas.ConnectorPurgeRequest.properties)).not.toContain("address");
  });

  test("the delivery route is unauthenticated, signature-gated, and 401s identically", () => {
    const delivery = paths()["/api/connectors/webhooks/{source}/{token}"].post;
    expect(delivery.security).toEqual([]);
    expect(delivery.responses["202"]).toBeTruthy();
    expect(delivery.responses["401"]).toEqual({
      $ref: "#/components/responses/ConnectorDeliveryRejected",
    });
    expect(delivery.responses["429"]).toEqual({
      $ref: "#/components/responses/ConnectorRateLimited",
    });
    // The token pattern is the traversal guard, documented where clients read it.
    const token = (delivery.parameters as Record<string, any>[]).find((p) => p.name === "token");
    expect(token.schema.pattern).toBe("^[A-Za-z0-9_-]{43}$");
    const signature = (delivery.parameters as Record<string, any>[]).find(
      (p) => p.name === "x-hub-signature",
    );
    expect(signature.required).toBe(true);
    expect(signature.schema.pattern).toBe("^sha256=[0-9a-fA-F]{64}$");
  });

  test("companions are bearer-authenticated and the teardown is a single DELETE", () => {
    for (const path of [
      "/api/connectors/webhooks/config",
      "/api/connectors/webhooks/pending",
      "/api/connectors/webhooks/drain",
      "/api/connectors/webhooks/ack",
      "/api/connectors/webhooks/purged",
    ]) {
      for (const operation of Object.values(paths()[path])) {
        // No `security: []` anywhere in the companion group — that would document the
        // authenticated routes as public.
        expect((operation as Record<string, unknown>).security).toBeUndefined();
      }
    }
    const config = paths()["/api/connectors/webhooks/config"];
    expect(config.get).toBeTruthy();
    expect(config.post).toBeTruthy();
    expect(config.delete.responses["200"].content["application/json"].schema.required).toEqual([
      "status",
      "queueDropped",
    ]);
  });

  // The descriptions are the contract clients read. Under the selected ingest shape (Option C,
  // operator decision 2026-08-04) the server queues ids and settles acknowledgements; it holds no
  // connector delegation and runs no background drain. A description still promising the
  // Option-B/shape-B behaviour is a false contract, so pin the corrections.
  test("descriptions describe Option C: queue-only delivery, browser-side ingest, /ack settlement", () => {
    const delivery = paths()["/api/connectors/webhooks/{source}/{token}"].post;
    const drain = paths()["/api/connectors/webhooks/drain"].post;
    const ack = paths()["/api/connectors/webhooks/ack"].post;

    // The post-delivery drain kick is RETIRED — nothing runs after the 202.
    expect(delivery.description).not.toMatch(/drain runs after the response/i);
    expect(delivery.description).toMatch(/queued/i);
    expect(delivery.description).toMatch(/never (?:receives|sees).{0,60}key|no .{0,30}delegation/i);

    // The drain is THE processing trigger, and it is gateless: no stored connector delegation.
    expect(drain.description).not.toMatch(/shape B/);
    expect(drain.description).not.toMatch(/stored\s+delegation is dead/i);
    expect(drain.description).toMatch(/Option C/);
    expect(drain.description).toMatch(/ack/);

    // The ack route already documents shape C; keep it named so a future edit cannot drift it.
    expect(ack.description).toMatch(/Option C|shape C/);
    expect(ack.description).toMatch(/BROWSER is the writer/i);
  });

  /**
   * INGEST-CUTOVER(plan §11) — the delivery route's description is the ONE place in this spec that
   * still stated the retired invariant flatly. Every other connector description was scoped in the
   * cutover, so this one was an omission, not a deliberate carve-out: for a cohort address the
   * same route nudges the fetch worker and the server DOES hold that user's Fireflies credential.
   * Both halves are pinned, in the same shape as the deploy-doc regex in consent-scope.test.ts, so
   * neither can go stale on its own.
   */
  test("the delivery description scopes the retired invariant to non-cohort addresses", () => {
    const delivery = paths()["/api/connectors/webhooks/{source}/{token}"].post;

    // Half 1 — the Option-C claim survives WITH its scope attached (plan §5.3 keeps that path
    // byte-identical), never as an unqualified promise about every address.
    expect(delivery.description).toMatch(
      /(?:outside the backend-ingest cohort|non-cohort)[\s\S]{0,400}never receives the user's connector API key/i,
    );
    expect(delivery.description).not.toMatch(
      /nothing is written to the user's space\.\s+This server never receives/i,
    );

    // Half 2 — the cohort truth, stated on the route that triggers it.
    expect(delivery.description).toMatch(/cohort address/i);
    expect(delivery.description).toMatch(/nudges the backend\s+fetch worker/i);
    expect(delivery.description).toMatch(/per-user Fireflies OAuth credential/i);
    expect(delivery.description).toMatch(/encrypted server-side copy/i);
    expect(delivery.description).toMatch(/90 days/);

    // And the invariant that did NOT reverse, so the scoping cannot be read as "everything went".
    expect(delivery.description).toMatch(/holds no connector\s+delegation for any address/i);
  });

  test("every connector $ref resolves and the error body needs only `error`", () => {
    const schemas = components().schemas as Record<string, Record<string, any>>;
    const responses = components().responses as Record<string, Record<string, any>>;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        "ConnectorError",
        "ConnectorDelivery",
        "ConnectorWebhookConfig",
        "ConnectorWebhookEnabled",
        "ConnectorPendingItem",
        "ConnectorDeadItem",
        "ConnectorWebhookPending",
        "ConnectorAckRequest",
        "ConnectorAckResult",
        "ConnectorPurgeRequest",
      ]),
    );
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining([
        "ConnectorDeliveryRejected",
        "ConnectorRateLimited",
        "ConnectorUnavailable",
      ]),
    );
    // The public route's bodies carry no `message` — ApiError would have over-promised one.
    expect(schemas.ConnectorError.required).toEqual(["error"]);
    // The dead-letter is surfaced on /pending so an operator can answer "why didn't it arrive".
    expect(schemas.ConnectorWebhookPending.required).toContain("dead");
    expect(schemas.ConnectorWebhookPending.required).toContain("deliveriesRateLimited");
  });
});

/**
 * Google Meet OAuth proxy (WP-A). Additive, and the same flag-gated shape as the group above:
 * while `GOOGLE_MEET_OAUTH_ENABLED` is off every path here 404s. Documented because the SPA is the
 * only client and these five routes are the entire contract between it and Google.
 */
describe("google meet oauth paths", () => {
  const START = "/api/connectors/google/oauth/start";
  const CALLBACK = "/api/connectors/google/oauth/callback";
  const EXCHANGE = "/api/connectors/google/oauth/exchange";
  const REFRESH = "/api/connectors/google/oauth/refresh";
  const REVOKE = "/api/connectors/google/oauth/revoke";

  test("publishes exactly the five routes, on the sibling prefix", () => {
    expect(Object.keys(paths())).toEqual(
      expect.arrayContaining([START, CALLBACK, EXCHANGE, REFRESH, REVOKE]),
    );
    // A SIBLING of /api/connectors/webhooks, never a child: a path under the webhook prefix
    // would be caught by that group's one-segment rule (or worse, by the public raw mount).
    const googlePaths = Object.keys(paths()).filter((p) =>
      p.startsWith("/api/connectors/google/"),
    );
    expect(googlePaths.sort()).toEqual([CALLBACK, EXCHANGE, REFRESH, REVOKE, START].sort());
    for (const p of googlePaths) {
      expect(p.startsWith("/api/connectors/webhooks")).toBe(false);
    }
  });

  test("the two GETs are public and the three POSTs are bearer-authenticated", () => {
    // This is the whole middleware split index.ts wires, restated where clients read it: a
    // top-level navigation from Google carries no Bearer, so /start and /callback cannot require
    // one — and nothing that reaches Google's token endpoint may be missing one.
    expect(paths()[START].get.security).toEqual([]);
    expect(paths()[CALLBACK].get.security).toEqual([]);
    for (const p of [EXCHANGE, REFRESH, REVOKE]) {
      expect(paths()[p].post.security).toEqual([{ bearerAuth: [] }]);
      // …and each one documents the 401 it will actually return.
      expect(paths()[p].post.responses["401"]).toEqual({
        $ref: "#/components/responses/Unauthenticated",
      });
      // No GET verb sneaked onto an authenticated path (it would bypass CSRF too).
      expect(Object.keys(paths()[p])).toEqual(["post"]);
    }
    // And no POST on the public pair, which would be an unauthenticated mutation.
    expect(Object.keys(paths()[START])).toEqual(["get"]);
    expect(Object.keys(paths()[CALLBACK])).toEqual(["get"]);
  });

  test("the /start params are the anti-forgery contract, pinned to the router's own patterns", () => {
    const start = paths()[START].get;
    const params = start.parameters as Record<string, any>[];
    const state = params.find((p) => p.name === "state");
    const challenge = params.find((p) => p.name === "challenge");
    // Both required, both query params — `state` is the anti-forgery control on an
    // unauthenticated GET that turns into a 302, so a missing one must be a 400.
    expect(state.in).toBe("query");
    expect(state.required).toBe(true);
    expect(state.schema.pattern).toBe("^[A-Za-z0-9._~-]{16,512}$");
    expect(challenge.in).toBe("query");
    expect(challenge.required).toBe(true);
    // RFC 7636: the S256 challenge is 43-128 unreserved characters.
    expect(challenge.schema.pattern).toBe("^[A-Za-z0-9._~-]{43,128}$");
    // The redirect is the success case, and it is documented as one.
    expect(start.responses["302"].headers.Location.required).toBe(true);
    expect(start.responses["400"]).toBeTruthy();

    // The callback's `code` is length-bounded ONLY — Google codes carry `/` and `%`, so an
    // alphabet pattern here would reject valid codes.
    const callbackParams = paths()[CALLBACK].get.parameters as Record<string, any>[];
    const code = callbackParams.find((p) => p.name === "code");
    expect(code.schema.maxLength).toBe(2048);
    expect(code.schema.pattern).toBeUndefined();
    expect(code.required).toBe(false);
  });

  test("descriptions state the invariants: persists nothing, pinned origin, whitelisted payload", () => {
    const start = paths()[START].get.description as string;
    const callback = paths()[CALLBACK].get.description as string;
    const exchange = paths()[EXCHANGE].post.description as string;
    const refresh = paths()[REFRESH].post.description as string;
    const revoke = paths()[REVOKE].post.description as string;

    // Spike-verified 2026-08-17: without BOTH params Google mints no refresh token and the
    // connector silently becomes single-session. Named here so a future edit cannot drop one.
    expect(start).toMatch(/access_type=offline/);
    expect(start).toMatch(/prompt=consent/);
    expect(start).toMatch(/refresh token/i);
    // The scope pair is a compliance boundary, not a code tweak — a Drive scope is Restricted.
    expect(start).toMatch(/meetings\.space\.readonly/);
    expect(start).toMatch(/meetings\.space\.settings/);
    expect(start).toMatch(/no Drive/i);
    // The server holds the challenge, never the verifier.
    expect(start).toMatch(/never the verifier/i);

    // The callback's two controls: a PINNED target origin and no token in the message.
    expect(callback).toMatch(/pinned app origin/i);
    expect(callback).toMatch(/never .{0,10}"\*"/i);
    expect(callback).toMatch(/no Bearer/i);
    expect(callback).toMatch(/no-referrer/);

    // The reason this proxy exists at all, on the route where a token first appears.
    expect(exchange).toMatch(/stores NOTHING/);
    expect(exchange).toMatch(/id_token/);
    expect(exchange).toMatch(/invalid_grant/);
    expect(refresh).toMatch(/BROWSER holds the refresh token/);
    expect(refresh).toMatch(/nothing is written on this side/i);
    // A swallowed revoke is a lie to the user about what they just disconnected.
    expect(revoke).toMatch(/SURFACED, never\s+swallowed/);
  });

  test("the token payload is whitelisted and the error keeps Google's structure", () => {
    const schemas = components().schemas as Record<string, Record<string, any>>;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        "GoogleOAuthExchangeRequest",
        "GoogleOAuthRefreshRequest",
        "GoogleOAuthRevokeRequest",
        "GoogleTokenResponse",
        "GoogleOAuthError",
      ]),
    );

    // Only `access_token` is promised; `refresh_token` is absent on most refreshes.
    const token = schemas.GoogleTokenResponse;
    expect(token.required).toEqual(["access_token"]);
    expect(Object.keys(token.properties)).toEqual([
      "access_token",
      "token_type",
      "expires_in",
      "refresh_token",
      "scope",
    ]);
    // The id_token must never be documented as returned — documenting it would be the first
    // step to passing it through.
    expect(Object.keys(token.properties)).not.toContain("id_token");

    // The structured upstream error the UI branches on (plan §6 WP-A: Listen flattened it and
    // could not tell reconnect from no-access from slow-down).
    const error = schemas.GoogleOAuthError;
    expect(error.required).toEqual(["error"]);
    expect(Object.keys(error.properties)).toEqual([
      "error",
      "error_description",
      "upstream_status",
    ]);
    expect(error.properties.error_description.maxLength).toBe(200);

    // Request bodies carry no address/tenant field — ownership is the session, and these three
    // routes are stateless besides.
    for (const name of [
      "GoogleOAuthExchangeRequest",
      "GoogleOAuthRefreshRequest",
      "GoogleOAuthRevokeRequest",
    ]) {
      expect(Object.keys(schemas[name].properties)).not.toContain("address");
    }
    expect(schemas.GoogleOAuthExchangeRequest.required).toEqual(["code", "verifier"]);
    expect(schemas.GoogleOAuthRefreshRequest.required).toEqual(["refreshToken"]);
    expect(schemas.GoogleOAuthRevokeRequest.required).toEqual(["token"]);
  });

  test("upstream failures are documented separately from our own, and 429 is its own bucket", () => {
    const responses = components().responses as Record<string, Record<string, any>>;
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining([
        "GoogleOAuthRateLimited",
        "GoogleOAuthUpstreamRejected",
        "GoogleOAuthUpstreamUnavailable",
      ]),
    );
    // A Google 5xx / timeout is a 502 (retry), never a 4xx (re-consent).
    expect(responses.GoogleOAuthUpstreamUnavailable.description).toMatch(/RETRY/);
    for (const p of [START, CALLBACK]) {
      expect(paths()[p].get.responses["429"]).toEqual({
        $ref: "#/components/responses/GoogleOAuthRateLimited",
      });
    }
    for (const p of [EXCHANGE, REFRESH, REVOKE]) {
      expect(paths()[p].post.responses["429"]).toEqual({
        $ref: "#/components/responses/GoogleOAuthRateLimited",
      });
      expect(paths()[p].post.responses["502"]).toEqual({
        $ref: "#/components/responses/GoogleOAuthUpstreamUnavailable",
      });
      // 500 is deliberately detail-free: the cause is ours and its message is not
      // guaranteed token-free.
      expect(paths()[p].post.responses["500"]).toBeTruthy();
    }
  });

  test("every $ref in the document still resolves — a dangling one kills the boot-time load", () => {
    // index.ts loads openapi.yaml at BOOT, so a dangling $ref anywhere in this file — including
    // the block above — is a startup failure, not a documentation bug.
    const seen: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$ref" && typeof value === "string") seen.push(value);
        else walk(value);
      }
    };
    walk(spec);
    expect(seen.length).toBeGreaterThan(0);
    for (const ref of seen) {
      const segments = ref.replace(/^#\//, "").split("/");
      let cursor: unknown = spec;
      for (const segment of segments) {
        cursor = (cursor as Record<string, unknown>)[segment];
        expect(cursor).toBeTruthy();
      }
    }
  });
});
