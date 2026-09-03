import { describe, expect, it } from "bun:test";
import express from "express";
import { backendDelegationPolicyHash, backendDelegationResolvedPermissions } from "../manifest.js";
import { createServerInfoRouter } from "../routes/server-info.js";

async function request(app: express.Express, path: string) {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("server-info route", () => {
  it("exposes backend DID, readiness, policy, expiry, and policy hash", async () => {
    const backendDid = "did:key:z6MkBackend";
    const app = express();
    app.use("/api/server-info", createServerInfoRouter(backendDid));

    const response = await request(app, "/api/server-info");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      did: backendDid,
      status: "ready",
      name: "TinyChat Backend",
      expiry: "7d",
      permissions: [
        {
          service: "tinycloud.kv",
          path: "threads/",
          actions: ["get", "put", "del", "list"],
          description: "Read and write chat threads and messages.",
        },
      ],
      policyHash: backendDelegationPolicyHash(backendDid),
      provenance: {
        build_sha: null,
        backend_image_digest: null,
      },
      transcriber_recovery: {
        proxy_enabled: false,
        contract_version: null,
      },
    });
    expect(backendDelegationResolvedPermissions(backendDid)[0].path).toBe(
      "xyz.tinycloud.tinychat/threads/",
    );
  });

  it("exposes only validated immutable provenance and static recovery visibility", async () => {
    const backendDid = "did:key:z6MkBackend";
    const validEnv = {
      TRANSCRIBER_RECOVERY_ENABLED: "true",
      TRANSCRIBER_RECOVERY_CONTRACT_VERSION: "space-save-v2",
      TRANSCRIBER_RECOVERY_CAPABILITY_CACHE_MS: "1000",
      TRANSCRIBER_RECOVERY_UPSTREAM_LEASE_MS: "5000",
      TRANSCRIBER_RECOVERY_RATE_LIMIT_MAX: "4",
      TRANSCRIBER_RECOVERY_RATE_LIMIT_WINDOW_MS: "60000",
      TRANSCRIBER_RECOVERY_PSEUDONYM_KEY: "correct-horse-battery-staple-key-material",
      TRANSCRIPTION_API_URL: "https://transcribe.example",
      TRANSCRIPTION_API_KEY: "different-provider-key",
      TINYCHAT_BUILD_SHA: "a".repeat(40),
      TINYCHAT_BACKEND_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    };
    const app = express();
    app.use("/api/server-info", createServerInfoRouter(backendDid, validEnv));

    expect(await (await request(app, "/api/server-info")).json()).toMatchObject({
      provenance: {
        build_sha: "a".repeat(40),
        backend_image_digest: `sha256:${"b".repeat(64)}`,
      },
      transcriber_recovery: {
        proxy_enabled: true,
        contract_version: "space-save-v2",
      },
    });

    const { TRANSCRIPTION_API_URL: _url, TRANSCRIPTION_API_KEY: _apiKey, ...withoutUpstream } = validEnv;
    const unmounted = express();
    unmounted.use("/api/server-info", createServerInfoRouter(backendDid, withoutUpstream));
    expect(await (await request(unmounted, "/api/server-info")).json()).toMatchObject({
      transcriber_recovery: {
        proxy_enabled: false,
        contract_version: "space-save-v2",
      },
    });

    const hostile = "hostile unbounded env text ".repeat(10);
    const invalid = express();
    invalid.use("/api/server-info", createServerInfoRouter(backendDid, {
      TRANSCRIBER_RECOVERY_ENABLED: "TRUE",
      TRANSCRIBER_RECOVERY_CONTRACT_VERSION: hostile,
      TINYCHAT_BUILD_SHA: hostile,
      TINYCHAT_BACKEND_IMAGE_DIGEST: hostile,
    }));
    const invalidBody = await (await request(invalid, "/api/server-info")).json();
    expect(invalidBody).toMatchObject({
      provenance: { build_sha: null, backend_image_digest: null },
      transcriber_recovery: { proxy_enabled: false, contract_version: null },
    });
    expect(JSON.stringify(invalidBody)).not.toContain(hostile);
  });
});
