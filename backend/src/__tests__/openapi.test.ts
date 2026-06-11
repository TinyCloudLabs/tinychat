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
