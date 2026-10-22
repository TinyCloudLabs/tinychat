import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createUnwiredExoPorts } from "../exo/default-ports.js";
import { EXO_NAMESPACE, type ExoLedgerSnapshot, type ExoMailboxPorts } from "../exo/mailbox.js";
import { createExoWakeLimiters } from "../rate-limits.js";
import { createExoMailboxRouter } from "../routes/exo-mailbox.js";

const OWNER_DID = `did:pkh:eip155:1:0x${"b".repeat(40)}`;
const REQ1 = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
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
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: "x".repeat(2048) }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(UNIFORM);
    });
  });

  test("a non-JSON content type returns the uniform 409", async () => {
    await withWakeServer(async (base) => {
      const response = await post(base, `{"owner":"${OWNER_DID}","requestId":"${REQ1}"}`, "text/plain");
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(UNIFORM);
    });
  });
});

/** Ports that verify a wake for REQ1, then fail the first store write in startWake. */
function verifiedPorts(): ExoMailboxPorts {
  const base = createUnwiredExoPorts("https://app.example.test");
  return {
    ...base,
    grants: { isActive: async () => true },
    requests: {
      get: async (_owner, path) => (path.endsWith(`/requests/sync-google/${REQ1}`) ? { v: 1, capability: "sync-google" } : undefined),
    },
    connectors: { isOn: async () => true, hasFirefliesWebhook: async () => false },
    executor: { start: async () => undefined },
    jobs: {
      ...base.jobs,
      get: async () => undefined,
      putIfAbsent: async () => {
        throw new Error("store offline at /internal/db");
      },
    },
  };
}

describe("Exo wake route store failure", () => {
  test("a store failure while starting returns the uniform 409 with no stack or error text", async () => {
    await withWakeServer(async (base) => {
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
      const text = await response.text();
      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toEqual(UNIFORM);
      expect(text).not.toContain("Error");
      expect(text).not.toContain("store offline");
      expect(text).not.toContain("<");
    }, verifiedPorts());
  });
});

describe("Exo wake route per-owner limit", () => {
  test("the 31st verified wake for one owner in a minute is 429 with Retry-After", async () => {
    // Each verified wake is refused by the 30-min cooldown, a 429 that carries retryAfterSec.
    const ports = refusedByLedgerPorts({ startsToday: 1, lastStartedAt: T0 - MINUTE_MS });
    await withWakeServer(async (base) => {
      const body = JSON.stringify({ owner: OWNER_DID, requestId: REQ1 });
      for (let i = 0; i < 30; i += 1) {
        const refused = await post(base, body);
        expect(refused.status).toBe(429);
        expect(await refused.json()).toEqual({ error: "rate_limited", retryAfterSec: 1740 });
      }
      const limited = await post(base, body);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ error: "rate_limited" });
      expect(limited.headers.get("retry-after")).toBe("60");
    }, ports);
  });
});

describe("Exo wake per-owner limit counts verified wakes only", () => {
  test("refused unverified wakes naming an owner do not spend that owner's budget", async () => {
    const ports = refusedByLedgerPorts({ startsToday: 1, lastStartedAt: T0 - MINUTE_MS });
    await withWakeServer(async (base) => {
      const unknown = JSON.stringify({ owner: OWNER_DID, requestId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" });
      for (let i = 0; i < 31; i += 1) {
        const refused = await post(base, unknown);
        expect(refused.status).toBe(409);
        expect(await refused.json()).toEqual(UNIFORM);
      }
      const verified = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
      expect(verified.status).toBe(429);
      expect(await verified.json()).toEqual({ error: "rate_limited", retryAfterSec: 1740 });
    }, ports);
  });
});

const T0 = Date.UTC(2026, 0, 1, 12);
const MINUTE_MS = 60_000;
const GOOGLE_REQUEST_PATH = `${EXO_NAMESPACE}/requests/sync-google/${REQ1}`;

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
    ledger: { snapshot: async () => snapshot, recordStart: unexpected, attach: unexpected, clearActive: unexpected },
    now: () => T0,
    frontendOrigin: "https://app.example.test",
  };
}

describe("Exo wake 429 responses carry Retry-After", () => {
  test("a cooldown 429 sends Retry-After equal to retryAfterSec", async () => {
    // Google cooldown is 30 min; the last run started 1 min ago, so 29 min (1740 s) remain.
    const ports = refusedByLedgerPorts({ startsToday: 1, lastStartedAt: T0 - MINUTE_MS });
    await withWakeServer(async (base) => {
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "rate_limited", retryAfterSec: 1740 });
      expect(response.headers.get("retry-after")).toBe("1740");
    }, ports);
  });

  test("a daily-cap 429 sends Retry-After equal to retryAfterSec", async () => {
    // The Google daily cap of 300 is reached; it resets at UTC midnight, 12 h after T0 (43200 s).
    const ports = refusedByLedgerPorts({ startsToday: 300 });
    await withWakeServer(async (base) => {
      const response = await post(base, JSON.stringify({ owner: OWNER_DID, requestId: REQ1 }));
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: "budget_exhausted", retryAfterSec: 43200 });
      expect(response.headers.get("retry-after")).toBe("43200");
    }, ports);
  });
});

const FORM_HEADERS = { "content-type": "application/json" };

/** The status, headers (minus the clock-driven Date), and body of one wake response. */
async function refusalOf(base: string, body: string, headers: Record<string, string>) {
  const response = await fetch(`${base}/api/exo/v1/requests`, { method: "POST", headers, body });
  return {
    status: response.status,
    headers: [...response.headers].filter(([name]) => name !== "date").sort(([a], [b]) => a.localeCompare(b)),
    body: await response.text(),
  };
}

describe("Exo wake refusals before verification are byte-identical", () => {
  const WELL_FORMED = JSON.stringify({ owner: OWNER_DID, requestId: REQ1 });

  test("every refusal has the same status, headers, and body as an unknown request", async () => {
    await withWakeServer(async (base) => {
      const reference = await refusalOf(base, WELL_FORMED, FORM_HEADERS);
      expect(reference.status).toBe(409);
      expect(JSON.parse(reference.body)).toEqual(UNIFORM);
      const cases: Array<[string, Record<string, string>]> = [
        [JSON.stringify({ owner: OWNER_DID, requestId: "x".repeat(2048) }), FORM_HEADERS],
        ["{not json", FORM_HEADERS],
        [WELL_FORMED, { "content-type": "text/plain" }],
        [WELL_FORMED, { "content-type": "application/json; charset=klingon" }],
        [WELL_FORMED, { ...FORM_HEADERS, "content-encoding": "br" }],
        [JSON.stringify({ owner: `0x${"b".repeat(40)}`, requestId: REQ1 }), FORM_HEADERS],
        [JSON.stringify({ owner: OWNER_DID, requestId: "Some_Title-Meeting_Q3_Budget" }), FORM_HEADERS],
      ];
      for (const [body, headers] of cases) {
        expect(await refusalOf(base, body, headers)).toEqual(reference);
      }
    });
  });
});
