import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { join } from "node:path";
import { createCredentialCountRouter } from "../routes/credential-count.js";
import { CredentialRowCountError, type CredentialRowCounter } from "../services/credential-row-count.js";
import { createCredentialCountLimiters } from "../rate-limits.js";

const SCRIPT = join(import.meta.dir, "../../../scripts/ops/read-credential-row-count.sh");
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

async function withRoute<T>(counter: CredentialRowCounter, body: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use("/api/internal/credential-row-count", createCredentialCountRouter(KEY, () => counter, createCredentialCountLimiters()));
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

const counting = (count: number): CredentialRowCounter => ({ countRows: async () => count });

describe("read-credential-row-count.sh against the real route", () => {
  test("a zero count prints only the source, the status and the count, and exits 0", async () => {
    await withRoute(counting(0), async (url) => {
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: url });
      expect(result).toEqual({ out: "source=fireflies http=200 count=0\n", code: 0 });
    });
  });

  test("a count above zero is printed as it is and still exits 0", async () => {
    await withRoute(counting(3), async (url) => {
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: url });
      expect(result).toEqual({ out: "source=fireflies http=200 count=3\n", code: 0 });
    });
  });

  test("a wrong key prints the 401 and fails without printing either key", async () => {
    await withRoute(counting(0), async (url) => {
      const wrong = "w".repeat(40);
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: wrong, API_URL: url });
      expect(result.code).toBe(1);
      expect(result.out).toBe("source=fireflies http=401 count=unavailable\n");
      expect(result.out).not.toContain(wrong);
    });
  });

  test("a store failure prints its fixed code and fails", async () => {
    const failing: CredentialRowCounter = {
      countRows: async () => {
        throw new CredentialRowCountError("LIST_FAILED");
      },
    };
    await withRoute(failing, async (url) => {
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: url });
      expect(result).toEqual({ out: "source=fireflies http=200 count=unavailable code=LIST_FAILED\n", code: 1 });
    });
  });

  test("another source is passed through", async () => {
    await withRoute(counting(7), async (url) => {
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: url, SOURCE: "granola" });
      expect(result).toEqual({ out: "source=granola http=200 count=7\n", code: 0 });
    });
  });
});

describe("read-credential-row-count.sh with a server that sends other things", () => {
  test("a body that echoes the key or request headers never reaches the output", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => new Response(`{"source":"fireflies","count":0,"echo":"${request.headers.get("x-admin-key") ?? ""}"}`, { status: 200 }),
    });
    try {
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: `http://127.0.0.1:${server.port}` });
      expect(result.out).toBe("source=fireflies http=200 count=unavailable\n");
      expect(result.out).not.toContain("a1a1");
      expect(result.code).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("the key arrives in x-admin-key unchanged, whatever characters it holds", async () => {
    let seen: string | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen = request.headers.get("x-admin-key");
        return new Response('{"source":"fireflies","count":0}', { status: 200 });
      },
    });
    try {
      const result = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: `http://127.0.0.1:${server.port}` });
      expect(result.code).toBe(0);
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
      const redirected = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: `http://127.0.0.1:${server.port}` });
      expect(redirected).toEqual({ out: "source=fireflies http=302 count=unavailable\n", code: 1 });
    } finally {
      server.stop(true);
    }
    const unreachable = await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: "http://127.0.0.1:1" });
    expect(unreachable).toEqual({ out: "source=fireflies http=000 count=unavailable\n", code: 1 });
  });
});

describe("read-credential-row-count.sh refuses before any request", () => {
  test("a missing key, a bad source and a target that is not https make no request", async () => {
    let requests = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (requests++, new Response("{}")) });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      expect(await run({ API_URL: url })).toEqual({ out: "source=fireflies key=missing\n", code: 1 });
      expect(await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: url, SOURCE: "Fireflies/../x" })).toEqual({ out: "source=invalid\n", code: 1 });
      expect(await run({ CREDENTIAL_COUNT_ADMIN_KEY: KEY, API_URL: "http://example.com" })).toEqual({
        out: "source=fireflies api_url=refused\n",
        code: 1,
      });
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
