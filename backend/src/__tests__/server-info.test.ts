import { describe, expect, it } from "bun:test";
import express from "express";
import { backendDelegationPolicyHash, backendDelegationResolvedPermissions } from "../manifest.js";
import { createServerInfoRouter } from "../routes/server-info.js";
import { readBackendBuildInfo } from "../build-info.js";
import backendPackage from "../../package.json";

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
  it("exposes backend DID, readiness, policy, expiry, policy hash, and build", async () => {
    const backendDid = "did:key:z6MkBackend";
    const app = express();
    app.use(
      "/api/server-info",
      createServerInfoRouter(backendDid, { backendRevision: "0123abc", backendVersion: "0.4.2" }),
    );

    const response = await request(app, "/api/server-info");
    expect(response.status).toBe(200);
    const info = await response.json() as {
      did: string;
      status: string;
      permissions: Array<{ service: string; path: string; actions: string[] }>;
      policyHash: string;
      backendRevision: string;
      backendVersion: string;
    };
    expect(info.did).toBe(backendDid);
    expect(info.status).toBe("ready");
    expect(info.permissions.map(({ service, path, actions }) => ({ service, path, actions }))).toEqual([
      { service: "tinycloud.sql", path: "connectors", actions: ["read", "write"] },
      { service: "tinycloud.kv", path: "connectors/tinycloud-transcriber/", actions: ["get", "put"] },
    ]);
    expect(info.policyHash).toBe(backendDelegationPolicyHash(backendDid));
    expect(info.backendRevision).toBe("0123abc");
    expect(info.backendVersion).toBe("0.4.2");
    expect(backendDelegationResolvedPermissions(backendDid).map(({ service, path }) => ({ service, path }))).toEqual([
      { service: "tinycloud.sql", path: "xyz.tinycloud.tinychat/connectors" },
      { service: "tinycloud.kv", path: "xyz.tinycloud.tinychat/connectors/tinycloud-transcriber/" },
    ]);
  });

  it("reads the build revision from BUILD_REVISION and the version from backend/package.json", () => {
    expect(readBackendBuildInfo({ BUILD_REVISION: "f".repeat(40) })).toEqual({
      backendRevision: "f".repeat(40),
      backendVersion: backendPackage.version,
    });
    expect(readBackendBuildInfo({}).backendRevision).toBe("unknown");
  });
});
