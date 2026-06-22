import { describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createAgentRouter } from "../routes/agent.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../entity-id.js";

const TEST_ADDRESS = "0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2";
const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const OTHER_DID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";

async function request(app: express.Express, path: string, init?: RequestInit) {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

interface ElizaCall {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

function createApp(opts: {
  address?: string;
  elizaStatus?: number;
  elizaBody?: unknown;
  elizaThrows?: boolean;
} = {}) {
  const calls: ElizaCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    if (opts.elizaThrows) throw new Error("connection refused");
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(JSON.stringify(opts.elizaBody ?? { entityId: "x", status: "active" }), {
      status: opts.elizaStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use(
    "/api/agent",
    createAgentRouter({
      agentDid: AGENT_DID,
      elizaServiceUrl: "https://eliza.test",
      elizaServiceSecret: "svc-secret",
      authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
        req.user = { address: opts.address ?? TEST_ADDRESS };
        next();
      },
      fetchImpl,
      deserializeDelegationSet: (serialized: string) => JSON.parse(serialized),
    }),
  );
  return { app, calls };
}

function validDelegation(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ownerAddress: TEST_ADDRESS,
    chainId: 1,
    primaryDid: `did:pkh:eip155:1:${TEST_ADDRESS}`,
    delegateDID: AGENT_DID,
    ...overrides,
  });
}

describe("agent delegation courier", () => {
  it("couriers a valid delegation to eliza /sessions with the derived entityId + credential", async () => {
    const { app, calls } = createApp();
    const serialized = validDelegation();

    const res = await request(app, "/api/agent/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized, roomId: "thread-1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entityId: "x", status: "active" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://eliza.test/sessions");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].authorization).toBe("Bearer svc-secret");
    expect(calls[0].body).toEqual({
      agentId: TINYCHAT_AGENT_ID,
      entityId: addressToEntityId(TEST_ADDRESS, TINYCHAT_AGENT_ID),
      serializedDelegation: serialized,
      roomId: "thread-1",
    });
  });

  it("rejects a missing serialized delegation", async () => {
    const { app, calls } = createApp();
    const res = await request(app, "/api/agent/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_body");
    expect(calls).toHaveLength(0);
  });

  it("rejects a delegation owned by a different wallet (no courier)", async () => {
    const { app, calls } = createApp({ address: "0xdifferent" });
    const res = await request(app, "/api/agent/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: validDelegation() }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("wrong_delegator");
    expect(calls).toHaveLength(0);
  });

  it("rejects a delegation whose delegatee is not the agent DID (no courier)", async () => {
    const { app, calls } = createApp();
    const res = await request(app, "/api/agent/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: validDelegation({ delegateDID: OTHER_DID }) }),
    });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("wrong_delegatee");
    expect(body.expected).toBe(AGENT_DID);
    expect(calls).toHaveLength(0);
  });

  it("passes through eliza-service error codes", async () => {
    const { app } = createApp({ elizaStatus: 400, elizaBody: { error: "delegation_expired" } });
    const res = await request(app, "/api/agent/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: validDelegation() }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "delegation_expired" });
  });

  it("returns 502 when eliza-service is unreachable", async () => {
    const { app } = createApp({ elizaThrows: true });
    const res = await request(app, "/api/agent/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialized: validDelegation() }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "eliza_unreachable" });
  });

  it("GET /session proxies eliza GET /sessions/:entityId for liveness", async () => {
    const { app, calls } = createApp({ elizaBody: { entityId: "x", status: "expired" } });
    const res = await request(app, "/api/agent/session", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entityId: "x", status: "expired" });
    expect(calls[0].url).toBe(
      `https://eliza.test/sessions/${encodeURIComponent(addressToEntityId(TEST_ADDRESS, TINYCHAT_AGENT_ID))}`,
    );
    expect(calls[0].method).toBe("GET");
  });
});
