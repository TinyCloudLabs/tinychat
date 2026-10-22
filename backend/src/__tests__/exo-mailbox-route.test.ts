import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createUnwiredExoPorts } from "../exo/default-ports.js";
import { createExoWakeLimiters } from "../rate-limits.js";
import { createExoMailboxRouter } from "../routes/exo-mailbox.js";

const OWNER = `0x${"b".repeat(40)}`;
const UNIFORM = { error: "exo_sync_unavailable" };

async function withWakeServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/api/exo/v1", createExoMailboxRouter(
    createUnwiredExoPorts("https://app.example.test"),
    createExoWakeLimiters(),
  ));
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  const bound = await listening.promise;
  const { port } = bound.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    bound.closeAllConnections();
    bound.close(() => closed.resolve());
    await closed.promise;
  }
}

function post(base: string, body: string, contentType = "application/json") {
  return fetch(`${base}/api/exo/v1/requests`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("Exo wake route refusals are the uniform 409", () => {
  test("a malformed JSON body returns exactly the uniform 409", async () => {
    await withWakeServer(async (base) => {
      const response = await post(base, "{not json");
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(UNIFORM);
    });
  });

  test("a body above 1 KB returns the uniform 409", async () => {
    await withWakeServer(async (base) => {
      const response = await post(base, JSON.stringify({ owner: OWNER, requestId: "x".repeat(2048) }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(UNIFORM);
    });
  });

  test("a non-JSON content type returns the uniform 409", async () => {
    await withWakeServer(async (base) => {
      const response = await post(base, `{"owner":"${OWNER}","requestId":"req-1"}`, "text/plain");
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(UNIFORM);
    });
  });
});

describe("Exo wake route per-owner limit", () => {
  test("the 31st wake for one owner in a minute is 429 with Retry-After", async () => {
    await withWakeServer(async (base) => {
      const body = JSON.stringify({ owner: OWNER, requestId: "req-1" });
      for (let i = 0; i < 30; i += 1) {
        expect((await post(base, body)).status).toBe(409);
      }
      const limited = await post(base, body);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "rate_limited" });
      const retryAfter = Number(limited.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);
    });
  });
});
