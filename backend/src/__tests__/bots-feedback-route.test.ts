import { describe, expect, test } from "bun:test";
import express from "express";
import { createCsrfMiddleware, issueSessionToken } from "@tinyboilerplate/server";
import { createAuthMiddleware } from "../middleware/auth.js";
import { BotsRegistry } from "../bots-registry.js";
import { botsFromEnv, createBotsRouter } from "../routes/bots.js";
import { fakeRegistryStore } from "./helpers/fake-registry-store.js";

const sessionKey = `0x${"03".repeat(32)}`;
const owner = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
const secret = "bots-test-secret-not-real";
const ID = "0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef";
const BINDING = "c".repeat(64);
const REPORT_ID = "01HZY3J5Q8V6K9W2X4N7M0P1RS";

interface UpstreamCall { method: string; url: string; body: string | undefined }

/** The real router with a recording stand-in for the bots service. */
async function setup(upstream: () => Response) {
  const seen: UpstreamCall[] = [];
  const fetchImpl = (async (input, init) => {
    seen.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
    return upstream();
  }) as typeof fetch;
  const config = botsFromEnv({ BOTS_ENABLED: "true", BOTS_TEST_ACCOUNTS: owner, BOTS_SERVICE_URL: "http://bots.test/", BOTS_SERVICE_SECRET: secret })!;
  const registry = new BotsRegistry(fakeRegistryStore(), { now: () => new Date("2026-11-19T00:00:00.000Z") });
  const app = express();
  app.use(express.json()); app.use(createCsrfMiddleware());
  const listForTurn = (_ownerDid: string, sourceKey: string) => registry.listForTurn(owner, sourceKey);
  app.use("/api/bots", createBotsRouter({ config: { ...config, listForTurn, fetchImpl }, authMiddleware: createAuthMiddleware(sessionKey), registry }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const base = `http://127.0.0.1:${address.port}/api/bots/main`;
  const send = async (method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest", authorization: `Bearer ${(await issueSessionToken(owner, sessionKey)).token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { seen, send, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const REPORT = {
  area: "other", kind: "bug", title: "Search shows an empty list", tried: "I searched my notes.", happened: "The list was empty.",
  expected: "My notes in the list.", agent: "TinyCloud One bot (TrustBot)",
};

const feedback = (over: Record<string, unknown> = {}) => ({
  id: ID, kind: "action", action: "send_feedback", state: "pending", askedAt: "2026-11-19T12:00:00.000Z", expiresAt: "2026-11-20T12:00:00.000Z",
  outside: false, targets: [], text: JSON.stringify(REPORT), binding: BINDING, ...over,
});

const question = { id: OTHER, kind: "ask", state: "pending", askedAt: "2026-11-19T12:00:00.000Z", expiresAt: "2026-11-20T12:00:00.000Z", question: "Lunch?", outside: false };

describe("feedback proposals on the requests routes", () => {
  test("a listing leaves feedback proposals out unless the app asks for them", async () => {
    const run = await setup(() => Response.json({ requests: [feedback(), question] }));
    try {
      const plain = await run.send("GET", "/requests");
      expect(plain.status).toBe(200);
      expect(((await plain.json()) as { requests: Array<{ id: string }> }).requests.map(listed => listed.id)).toEqual([OTHER]);

      const opted = await run.send("GET", "/requests?include=feedback");
      expect(opted.status).toBe(200);
      const [listed] = ((await opted.json()) as { requests: unknown[] }).requests;
      expect(listed).toEqual({
        id: ID, kind: "action", action: "send_feedback", state: "pending", askedAt: "2026-11-19T12:00:00.000Z", expiresAt: "2026-11-20T12:00:00.000Z",
        outside: false, report: REPORT, binding: BINDING,
      });
      // The service is asked for the same list either way.
      expect(run.seen.map(call => call.url)).toEqual(["http://bots.test/v1/bots/main/requests", "http://bots.test/v1/bots/main/requests"]);
    } finally { await run.close(); }
  });

  test("a sent report carries its outcome and a report id only of the ULID form", async () => {
    for (const [sent, shown] of [
      [{ outcome: "filed", reportId: REPORT_ID }, { outcome: "filed", reportId: REPORT_ID }],
      [{ outcome: "filed", reportId: "not-a-ulid" }, { outcome: "filed" }],
      [{ outcome: "rejected", code: "title_too_long" }, { outcome: "rejected" }],
    ] as const) {
      const run = await setup(() => Response.json({ requests: [feedback({ state: "done", text: undefined, binding: undefined, feedback: sent })] }));
      try {
        const listed = ((await (await run.send("GET", "/requests?include=feedback")).json()) as { requests: Array<{ feedback?: unknown; report?: unknown }> }).requests[0]!;
        expect(listed.feedback).toEqual(shown);
        expect(listed.report).toBeUndefined();
      } finally { await run.close(); }
    }
  });

  test("a report outside the contract's shape is refused", async () => {
    const bad = [
      { text: JSON.stringify({ ...REPORT, agent: "Someone else" }) },
      { text: JSON.stringify({ ...REPORT, area: "billing" }) },
      { text: JSON.stringify({ ...REPORT, kind: "security" }) },
      { text: JSON.stringify({ ...REPORT, owner: "x" }) },
      { text: JSON.stringify({ ...REPORT, title: "two\nlines" }) },
      { text: "not json" },
      { targets: ["a".repeat(32)] },
      { feedback: { outcome: "posted" } },
    ];
    for (const over of bad) {
      const run = await setup(() => Response.json({ requests: [feedback(over)] }));
      try { expect((await run.send("GET", "/requests?include=feedback")).status).toBe(502); } finally { await run.close(); }
    }
  });

  test("the answer to a Send on a report is the report's view", async () => {
    const run = await setup(() => Response.json(feedback({ state: "sending", text: undefined, binding: undefined })));
    try {
      const response = await run.send("POST", `/requests/${ID}/answer`, { decision: "approve", binding: BINDING });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: ID, kind: "action", action: "send_feedback", state: "sending", askedAt: "2026-11-19T12:00:00.000Z", expiresAt: "2026-11-20T12:00:00.000Z", outside: false,
      });
    } finally { await run.close(); }
  });
});
