import { describe, expect, test } from "bun:test";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { botsFromEnv } from "../routes/bots.js";
import { createTrustBotReadsRouter } from "../routes/trustbot-reads.js";
import type { ReadAudit, ReadSummary } from "../trustbot-reads/audit.js";
import type { TrustBotReadGrants } from "../trustbot-reads/grants.js";

const key = `0x${"04".repeat(32)}`;
const address = `0x${"aB".repeat(20)}`;
const other = `0x${"cd".repeat(20)}`;
const owner = `did:pkh:eip155:1:${address.toLowerCase()}`;
const otherOwner = `did:pkh:eip155:1:${other}`;
const days: ReadSummary["days"] = [{ day: "2026-11-10", area: "meetings", tool: "tinycloud_read_meeting", ok: 3, refused: 1 }];
const dayMs = 86_400_000;

async function withRoute(
  run: (get: (query?: string, address?: string | null) => Promise<Response>, seen: Parameters<ReadAudit["summary"]>[]) => Promise<void>,
  { enabled = true, fails = false }: { enabled?: boolean; fails?: boolean } = {},
) {
  const seen: Parameters<ReadAudit["summary"]>[] = [];
  const audit: ReadAudit = {
    async begin() { throw new Error("unexpected begin"); },
    async settle() { throw new Error("unexpected settle"); },
    async summary(who, from, to) {
      seen.push([who, from, to]);
      if (fails) throw new Error("fixture storage detail");
      return { owner: who, from, to, days: who === owner ? days : [], total: who === owner ? 4 : 0 };
    },
  };
  const config = botsFromEnv({
    BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: `${address},${other}`,
    BOTS_SERVICE_URL: "http://bots.test", BOTS_SERVICE_SECRET: "fixture-secret",
  })!;
  const app = express();
  app.use("/api/bots/main/reads", createTrustBotReadsRouter({
    grants: {} as TrustBotReadGrants, config, auth: createAuthMiddleware(key), standingEnabled: enabled, audit,
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots/main/reads/standing/summary`;
  try {
    await run(async (query = "", caller = address) => {
      const headers = caller ? { authorization: `Bearer ${(await issueSessionToken(caller, key)).token}` } : undefined;
      return fetch(base + query, { headers });
    }, seen);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

describe("the owner's standing read summary", () => {
  test("uses the authenticated owner and defaults to the last seven days", async () => {
    await withRoute(async (get, seen) => {
      const started = Date.now();
      const response = await get(`?owner=${encodeURIComponent(otherOwner)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(seen).toHaveLength(1);
      const [who, from, to] = seen[0]!;
      expect(who).toBe(owner);
      expect(Date.parse(to)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(to)).toBeLessThanOrEqual(Date.now());
      expect(Date.parse(to) - Date.parse(from)).toBe(7 * dayMs);
      expect(await response.json()).toEqual({ owner, from, to, days, total: 4 });

      const otherResponse = await get(`?owner=${encodeURIComponent(owner)}`, other);
      expect(otherResponse.status).toBe(200);
      expect(await otherResponse.json()).toMatchObject({ owner: otherOwner, days: [], total: 0 });
    });
  });

  test("requires an authorized session and the standing reads flag", async () => {
    await withRoute(async (get, seen) => {
      expect((await get("", null)).status).toBe(401);
      expect((await get("", `0x${"ef".repeat(20)}`)).status).toBe(404);
      expect(seen).toEqual([]);
    });
    await withRoute(async (get, seen) => {
      expect((await get()).status).toBe(404);
      expect(seen).toEqual([]);
    }, { enabled: false });
  });

  test("passes normalized UTC bounds and accepts exactly 90 days", async () => {
    await withRoute(async (get, seen) => {
      expect((await get("?from=2026-08-14T00:00:00Z&to=2026-11-12T00:00:00Z")).status).toBe(200);
      expect((await get("?to=2026-11-12T00:00:00Z")).status).toBe(200);
      expect(seen).toEqual([
        [owner, "2026-08-14T00:00:00.000Z", "2026-11-12T00:00:00.000Z"],
        [owner, "2026-11-05T00:00:00.000Z", "2026-11-12T00:00:00.000Z"],
      ]);
    });
  });

  test("rejects oversized, backwards, empty, invalid and repeated bounds before reading", async () => {
    await withRoute(async (get, seen) => {
      for (const query of [
        "?from=2026-08-14T00:00:00Z&to=2026-11-12T00:00:00.001Z",
        "?from=2026-11-13T00:00:00Z&to=2026-11-12T00:00:00Z",
        "?from=2026-11-12T00:00:00Z&to=2026-11-12T00:00:00Z",
        "?to=2026-02-30T00:00:00Z", "?to=invalid",
        "?to=2026-11-12T00:00:00Z&to=2026-11-12T00:00:00Z",
      ]) {
        const response = await get(query);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "invalid_range" });
      }
      expect(seen).toEqual([]);
    });
  });

  test("returns a generic failure if the audit store is unavailable", async () => {
    await withRoute(async get => {
      const response = await get();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "reads_unavailable" });
    }, { fails: true });
  });
});
