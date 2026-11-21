import { describe, expect, it } from "bun:test";
import express from "express";
import { NonceGuard, verifyCall } from "../bots-signed-call.js";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";

const key = `0x${"03".repeat(32)}`;
const enabled = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const other = "0x2222222222222222222222222222222222222222";
const secret = "bots-test-secret-not-real";

const signedFor = (call: { url: string; method?: string; headers: Headers; body?: BodyInit | null }) => {
  const claims = verifyCall(call.headers.get("authorization"), { method: call.method!, path: new URL(call.url).pathname, body: call.body == null ? undefined : String(call.body) }, { secret, direction: "to-service", environment: "private", nonces: new NonceGuard() });
  return claims ? { owner: claims.owner, bot: claims.bot } : undefined;
};

const SETTINGS = { mode: "listed", hosts: ["docs.example.com"], available: true, today: { searches: 4, pages: 9, blocked: 1 } };

type Upstream = (init: RequestInit) => Response | Promise<Response>;

async function setup(upstream: Upstream) {
  const seen: { url: string; method?: string; headers: Headers; body?: BodyInit | null; signal?: AbortSignal | null }[] = [];
  const fetchImpl = (async (input, init) => {
    seen.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: init?.body, signal: init?.signal });
    return upstream(init ?? {});
  }) as typeof fetch;
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: enabled, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  app.use("/api/bots", createBotsRouter({ config: { ...config, fetchImpl }, authMiddleware: createAuthMiddleware(key) }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/bots/main/web`;
  const headersFor = async (address: string) => ({ "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(address, key)).token}` });
  const put = async (body: unknown, address = enabled) => fetch(url, { method: "PUT", headers: await headersFor(address), body: JSON.stringify(body) });
  const get = async (address = enabled) => fetch(url, { headers: await headersFor(address) });
  return { seen, url, headersFor, put, get, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

describe("bots web access routes", () => {
  it("needs a session and an enabled account", async () => {
    const run = await setup(() => Response.json(SETTINGS));
    try {
      expect((await fetch(run.url)).status).toBe(401);
      expect((await fetch(run.url, { method: "PUT", headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest" }, body: "{}" })).status).toBe(401);
      expect((await run.get(other)).status).toBe(404);
      expect((await run.put({ mode: "off", hosts: [] }, other)).status).toBe(404);
      expect(run.seen).toHaveLength(0);
    } finally { await run.close(); }
  });

  it("proxies GET with the session owner and the secret, answering only the contract fields", async () => {
    const run = await setup(() => Response.json({ ...SETTINGS, secret: "x", extra: { a: 1 }, today: { ...SETTINGS.today, query: "leak" } }));
    try {
      const forged = { ...(await run.headersFor(enabled)), "x-tinycloud-owner": `did:pkh:eip155:1:${other}` };
      const response = await fetch(run.url, { headers: forged });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(SETTINGS);
      expect(run.seen[0]!.url).toBe("http://bots.test/v1/bots/main/web");
      expect(run.seen[0]!.method).toBe("GET");
      expect(signedFor(run.seen[0]!)).toEqual({ owner: `did:pkh:eip155:1:${enabled.toLowerCase()}`, bot: "main" });
      expect(run.seen[0]!.headers.get("x-tinycloud-owner")).toBeNull();
      expect(run.seen[0]!.signal).toBeTruthy();
    } finally { await run.close(); }
  });

  it("proxies PUT sending only mode and hosts", async () => {
    const run = await setup(() => Response.json({ ...SETTINGS, mode: "any" }));
    try {
      const response = await run.put({ mode: "any", hosts: ["a.example.com"], owner: other, extra: 1 });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...SETTINGS, mode: "any" });
      expect(run.seen[0]!.url).toBe("http://bots.test/v1/bots/main/web");
      expect(run.seen[0]!.method).toBe("PUT");
      expect(run.seen[0]!.headers.get("content-type")).toBe("application/json");
      expect(signedFor(run.seen[0]!)).toEqual({ owner: `did:pkh:eip155:1:${enabled.toLowerCase()}`, bot: "main" });
      expect(JSON.parse(String(run.seen[0]!.body))).toEqual({ mode: "any", hosts: ["a.example.com"] });
    } finally { await run.close(); }
  });

  it("rejects an invalid PUT body before calling the service", async () => {
    const run = await setup(() => Response.json(SETTINGS));
    try {
      const bad: unknown[] = [
        [], {}, { mode: "on", hosts: [] }, { mode: "off" }, { mode: "off", hosts: "a.example.com" },
        { mode: "listed", hosts: [1] }, { mode: "listed", hosts: [null] },
        { mode: "listed", hosts: Array.from({ length: 51 }, (_, index) => `h${index}.example.com`) },
        { mode: "listed", hosts: ["a".repeat(254)] },
      ];
      for (const body of bad) {
        const response = await run.put(body);
        expect(response.status).toBe(400);
        const json = await response.json() as { error: string; message: string };
        expect(json.error).toBe("invalid");
        expect(typeof json.message).toBe("string");
      }
      expect((await run.put({ mode: "listed", hosts: Array.from({ length: 50 }, (_, index) => `h${index}.example.com`) })).status).toBe(200);
      expect((await run.put({ mode: "listed", hosts: ["a".repeat(253)] })).status).toBe(200);
      expect(run.seen).toHaveLength(2);
    } finally { await run.close(); }
  });

  it("passes the service's short 400 message through and replaces anything else", async () => {
    let answer: Response = Response.json({ error: "invalid", message: "Sites must be hostnames.", detail: "x" }, { status: 400 });
    const run = await setup(() => answer.clone());
    try {
      let response = await run.put({ mode: "listed", hosts: ["x"] });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid", message: "Sites must be hostnames." });

      for (answer of [
        Response.json({ error: "invalid", message: "x".repeat(500) }, { status: 400 }),
        Response.json({ error: "invalid", message: { html: "<b>" } }, { status: 400 }),
        new Response("<html>nope</html>", { status: 400 }),
      ]) {
        response = await run.put({ mode: "listed", hosts: ["x"] });
        expect(response.status).toBe(400);
        const json = await response.json() as { error: string; message: string };
        expect(json.error).toBe("invalid");
        expect(json.message.length).toBeGreaterThan(0);
        expect(json.message.length).toBeLessThan(200);
        expect(json.message).not.toContain("<");
      }
    } finally { await run.close(); }
  });

  it("answers 502 for service failures and unexpected shapes, on both methods", async () => {
    const failures: Upstream[] = [
      () => new Response("down", { status: 503 }),
      () => new Response("nope", { status: 500 }),
      () => Response.json({ error: "invalid" }, { status: 404 }),
      () => { throw new Error("connection refused"); },
      () => new Response("not json", { status: 200 }),
      () => Response.json({ mode: "sometimes", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
      () => Response.json({ mode: "off", hosts: [1], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
      () => Response.json({ mode: "off", hosts: [], available: "yes", today: { searches: 0, pages: 0, blocked: 0 } }),
      () => Response.json({ mode: "off", hosts: [], available: true, today: { searches: "1", pages: 0, blocked: 0 } }),
      () => Response.json({ mode: "off", hosts: [], available: true }),
      () => Response.json(null),
    ];
    for (const failure of failures) {
      const run = await setup(failure);
      try {
        for (const response of [await run.get(), await run.put({ mode: "off", hosts: [] })]) {
          expect(response.status).toBe(502);
          expect(await response.json()).toEqual({ error: "bot_unavailable", message: "Main isn't available. Try again later." });
        }
      } finally { await run.close(); }
    }
  });
});
