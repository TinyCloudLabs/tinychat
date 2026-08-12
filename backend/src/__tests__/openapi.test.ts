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

    // Walk every $ref in the document; a dangling one breaks the boot-time load.
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
