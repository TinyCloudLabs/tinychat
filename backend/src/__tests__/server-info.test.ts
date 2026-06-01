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
    });
    expect(backendDelegationResolvedPermissions(backendDid)[0].path).toBe(
      "xyz.tinycloud.tinychat/threads/",
    );
  });
});
