import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { createCalendarAutojoinCountsRouter } from "../routes/calendar-autojoin-counts.js";
import type { CalendarConnection } from "../services/calendar-autojoin-store.js";

const SCRIPT = join(import.meta.dir, "../../../scripts/ops/read-calendar-autojoin-counts.sh");
// A key with a quote and a backslash: both must reach the server intact and neither may reach the output.
const KEY = `k-${"a1".repeat(20)}"\\z`;

async function run(env: Record<string, string | undefined>): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    env: { PATH: process.env.PATH ?? "", ...env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out: out + err, code };
}

async function withRoute<T>(list: () => Promise<CalendarConnection[]>, body: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(createCalendarAutojoinCountsRouter({ CREDENTIAL_COUNT_ADMIN_KEY: KEY }, { listConnections: list }));
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  const bound = await listening.promise;
  try {
    return await body(`http://127.0.0.1:${(bound.address() as AddressInfo).port}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    bound.closeAllConnections();
    bound.close(() => closed.resolve());
    await closed.promise;
  }
}

const connection = (tenant: string, patch: Partial<CalendarConnection>): CalendarConnection =>
  ({ tenant, subject: "s", state: "enabled", generation: 1, scopes: ["openid"], nextScanAt: 0, scanComplete: true, ...patch });

describe("read-calendar-autojoin-counts.sh against the real route", () => {
  test("prints the five counts on one line and exits 0", async () => {
    const rows = [
      connection("0x1", { scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"], verifiedEmail: "x@example.com" }),
      connection("0x2", {}),
      connection("0x3", { state: "disabled" }),
    ];
    await withRoute(async () => rows, async (url) => {
      expect(await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: url })).toEqual({
        out: "http=200 connections=3 enabled=2 email_scope=1 verified_email=1 needing_reconnect=1\n", code: 0,
      });
    });
  });

  test("a wrong key prints the 401 and fails without printing either key", async () => {
    await withRoute(async () => [], async (url) => {
      const wrong = "w".repeat(40);
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: wrong, API_URL: url });
      expect(result).toEqual({ out: "http=401 counts=unavailable\n", code: 1 });
    });
  });

  test("a listing failure prints the 503 and fails", async () => {
    await withRoute(async () => { throw new Error("down"); }, async (url) => {
      expect(await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: url })).toEqual({ out: "http=503 counts=unavailable\n", code: 1 });
    });
  });
});

describe("read-calendar-autojoin-counts.sh with a server that sends other things", () => {
  test("a body that echoes the key or adds a field never reaches the output, and the key arrives unchanged", async () => {
    let seen: string | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen = request.headers.get("x-admin-key");
        return new Response(`{"connections":1,"enabled":1,"enabled_with_email_scope_granted":1,"enabled_with_verified_email":1,"enabled_needing_reconnect":0,"echo":"${seen ?? ""}"}`);
      },
    });
    try {
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: `http://127.0.0.1:${server.port}` });
      expect(result).toEqual({ out: "http=200 counts=unavailable\n", code: 1 });
      expect(seen).toBe(KEY);
    } finally {
      server.stop(true);
    }
  });

  test("a redirect is not followed and an unreachable server prints http=000", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(null, { status: 302, headers: { location: "https://example.invalid/steal" } }),
    });
    try {
      expect(await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: `http://127.0.0.1:${server.port}` }))
        .toEqual({ out: "http=302 counts=unavailable\n", code: 1 });
    } finally {
      server.stop(true);
    }
    expect(await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: "http://127.0.0.1:1" })).toEqual({ out: "http=000 counts=unavailable\n", code: 1 });
  });

  test("a missing key or a target that is not https makes no request", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (requests++, new Response("{}")) });
    try {
      expect(await run({ API_URL: `http://127.0.0.1:${server.port}` })).toEqual({ out: "key=missing\n", code: 1 });
      expect(await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: "http://example.com" })).toEqual({ out: "api_url=refused\n", code: 1 });
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
