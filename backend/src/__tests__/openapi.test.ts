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
      ]),
    );
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
