/**
 * `/api/manifest` is the backend's manifest and never carries the app's key declaration
 * (`keys_app_id`, `keys`): that declaration lives in the web origin's
 * /.well-known/openkey-manifest.json, which is what OpenKey reads. Real router, real manifest.json.
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

describe("GET /api/manifest", () => {
  test("has neither keys nor keys_app_id, with or without a query", async () => {
    await withServer(async (base) => {
      const expected = JSON.parse(JSON.stringify(runtimeManifest())) as Record<string, unknown>;
      for (const query of ["", "?keys=1", "?keys=1&keys=0", "?keys=true", "?other=1"]) {
        const response = await fetch(`${base}/api/manifest${query}`);
        expect(response.status).toBe(200);
        const body = await response.json() as Record<string, unknown>;
        expect("keys_app_id" in body, query).toBe(false);
        expect("keys" in body, query).toBe(false);
        expect(body, query).toEqual(expected);
      }
    });
  });
});
