import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createUnwiredExoPorts } from "../exo/default-ports.js";
import { EXO_NAMESPACE, type ExoLedgerSnapshot, type ExoMailboxPorts } from "../exo/mailbox.js";
import { createExoWakeLimiters } from "../rate-limits.js";
import { createExoMailboxRouter } from "../routes/exo-mailbox.js";

const OWNER = `0x${"b".repeat(40)}`;
const UNIFORM = { error: "exo_sync_unavailable" };

async function withWakeServer<T>(
  run: (base: string) => Promise<T>,
  ports: ExoMailboxPorts = createUnwiredExoPorts("https://app.example.test"),
): Promise<T> {
  const app = express();
  app.use("/api/exo/v1", createExoMailboxRouter(ports, createExoWakeLimiters()));
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

const T0 = Date.UTC(2026, 0, 1, 12);
const MINUTE_MS = 60_000;
const GOOGLE_REQUEST_PATH = `${EXO_NAMESPACE}/requests/sync-google/req-1`;

/** Ports for a wake that the ledger refuses before any job is written. */
function refusedByLedgerPorts(snapshot: ExoLedgerSnapshot): ExoMailboxPorts {
  const unexpected = async (): Promise<never> => {
    throw new Error("a refused wake must not write a job or start a run");
  };
  return {
    grants: { isActive: async () => true },
    requests: {
      get: async (_owner, path) => (path === GOOGLE_REQUEST_PATH ? { v: 1, capability: "sync-google" } : undefined),
    },
    jobs: { get: async () => undefined, putIfAbsent: unexpected, put: unexpected, list: async () => [], remove: unexpected },
    connectors: { isOn: async () => true, hasFirefliesWebhook: async () => false },
    executor: { start: unexpected },
    ledger: { snapshot: async () => snapshot, recordStart: unexpected, clearActive: unexpected },
    now: () => T0,
    frontendOrigin: "https://app.example.test",
  };
}

describe("Exo wake 429 responses carry Retry-After", () => {
  test("a cooldown 429 sends Retry-After equal to retryAfterSec", async () => {
    // Google cooldown is 30 min; the last run started 1 min ago, so 29 min (1740 s) remain.
    const ports = refusedByLedgerPorts({ startsToday: 1, lastStartedAt: T0 - MINUTE_MS });
    await withWakeServer(async (base) => {
      const response = await post(base, JSON.stringify({ owner: OWNER, requestId: "req-1" }));
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "rate_limited", retryAfterSec: 1740 });
      expect(response.headers.get("retry-after")).toBe("1740");
    }, ports);
  });

  test("a daily-cap 429 sends Retry-After equal to retryAfterSec", async () => {
    // The Google daily cap of 300 is reached; it resets at UTC midnight, 12 h after T0 (43200 s).
    const ports = refusedByLedgerPorts({ startsToday: 300 });
    await withWakeServer(async (base) => {
      const response = await post(base, JSON.stringify({ owner: OWNER, requestId: "req-1" }));
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "budget_exhausted", retryAfterSec: 43200 });
      expect(response.headers.get("retry-after")).toBe("43200");
    }, ports);
  });
});
