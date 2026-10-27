/**
 * `/api/manifest` serves the named-key rows only to a request that opts in with `keys=1`.
 * A client that does not send it (every build before named keys) always gets the manifest
 * without `keys_app_id` and `keys`. Real router, real manifest.json.
 */
import { describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import { createManifestRouter } from "../routes/manifest.js";
import { runtimeManifest } from "../manifest.js";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/api/manifest", createManifestRouter());
  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function served(base: string, query = ""): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/api/manifest${query}`);
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

describe("GET /api/manifest named-key gate", () => {
  test("serves the key rows with keys=1", async () => {
    await withServer(async (base) => {
      const body = await served(base, "?keys=1");
      expect(body.keys_app_id).toBe("chat.tinycloud.tinychat");
      expect(body.keys).toEqual([{ prefix: "apps/chat.tinycloud.tinychat/", abilities: ["key.create", "decrypt"] }]);
      expect(body).toEqual(JSON.parse(JSON.stringify(runtimeManifest())));
    });
  });

  test("serves the manifest without key rows when the request does not opt in", async () => {
    await withServer(async (base) => {
      const { keys_app_id: _a, keys: _k, ...expected } = JSON.parse(JSON.stringify(runtimeManifest())) as Record<string, unknown>;
      for (const query of ["", "?keys=0", "?keys=true", "?keys=", "?keys=1&keys=0", "?other=1"]) {
        const body = await served(base, query);
        expect("keys_app_id" in body, query).toBe(false);
        expect("keys" in body, query).toBe(false);
        expect(body, query).toEqual(expected);
      }
    });
  });
});
