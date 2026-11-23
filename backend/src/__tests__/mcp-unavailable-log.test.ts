import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createAgentRouter } from "../routes/agent.js";
import { McpPortError } from "../mcp-meetings/port.js";
import type { McpChatWiring } from "../mcp-meetings/config.js";

const ADDRESS = "0x4db6e7be716ba504cd103bc16b9329fe6bbe41f2";
const OWNER_DID = `did:pkh:eip155:1:${ADDRESS}`;
const SERVICE_DID = "did:key:z6MkServiceDidForTests";
const DAY_MS = 24 * 60 * 60 * 1000;
const SQL_PATH = "xyz.tinycloud.tinychat/connectors";
const SPACE = `tinycloud:pkh:eip155:1:${ADDRESS}:applications`;
const SECRET_MESSAGE = "secret-message-text-should-never-be-logged";

function delegation() {
  const att = {
    [`${SPACE}/sql/${SQL_PATH}`]: { "tinycloud.sql/read": [] },
    [`${SPACE}/kv/${SQL_PATH}/`]: { "tinycloud.kv/get": [], "tinycloud.kv/list": [] },
  };
  const payload = Buffer.from(JSON.stringify({ att, exp: Math.floor((Date.now() + 29 * DAY_MS) / 1000) })).toString("base64url");
  return JSON.stringify({
    ownerAddress: ADDRESS, chainId: 1, primaryDid: OWNER_DID, delegateDID: SERVICE_DID,
    expiry: new Date(Date.now() + 29 * DAY_MS).toISOString(), delegationHeader: { Authorization: `Bearer x.${payload}.x` },
  });
}

function appFailingWith(failure: () => never, options: { statusDelayMs?: number; sessionStatusTimeoutMs?: number } = {}) {
  const mcp = {
    mcpGrants: { serviceDid: SERVICE_DID, accept: async () => failure() },
    mcpMeetings: { status: async () => { if (options.statusDelayMs) await new Promise(resolve => setTimeout(resolve, options.statusDelayMs)); return failure(); } },
    mcpChatAccountAllowed: () => true,
    mcpOwnerDidFor: (address: string) => `did:pkh:eip155:1:${address}`,
  } as unknown as McpChatWiring;
  const app = express();
  app.use(express.json());
  app.use("/api/agent", createAgentRouter({
    mcp,
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => { req.user = { address: ADDRESS }; next(); },
    deserializeDelegationSet: (serialized: string) => JSON.parse(serialized),
    ...(options.sessionStatusTimeoutMs === undefined ? {} : { sessionStatusTimeoutMs: options.sessionStatusTimeoutMs }),
  }));
  return app;
}

async function call(app: express.Express, method: "GET" | "POST") {
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}/api/agent/session`, {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ revision: "r", mcp: { delegation: delegation() } }) } : {}),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

describe("MCP unavailable log line", () => {
  let lines: string[];
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    lines = [];
    spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  });
  afterEach(() => spy.mockRestore());

  it("logs the route, the code and the upstream status for a port error on GET", async () => {
    const res = await call(appFailingWith(() => { throw new McpPortError("MCP_HTTP_ERROR", 503); }), "GET");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mcp_unavailable" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[agent\] mcp_unavailable route=get code=mcp_http_error upstream_status=503 duration_ms=\d+$/);
  });

  it("logs the code and the elapsed milliseconds when the status call aborts at the timeout on GET", async () => {
    const app = appFailingWith(() => { throw new McpPortError("TIMEOUT"); }, { statusDelayMs: 60 });
    const res = await call(app, "GET");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mcp_unavailable" });
    expect(lines).toHaveLength(1);
    const match = /^\[agent\] mcp_unavailable route=get code=timeout duration_ms=(\d+)$/.exec(lines[0]!);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(50);
  });

  it("logs a timeout on POST without an upstream status", async () => {
    const res = await call(appFailingWith(() => { throw new McpPortError("TIMEOUT"); }), "POST");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "mcp_unavailable" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[agent\] mcp_unavailable route=post code=timeout duration_ms=\d+$/);
  });

  for (const method of ["GET", "POST"] as const) {
    it(`logs non_port_error and no error text for a plain error on ${method}`, async () => {
      const res = await call(appFailingWith(() => { throw new Error(`${SECRET_MESSAGE} ${ADDRESS}`); }), method);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "mcp_unavailable" });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^\\[agent\\] mcp_unavailable route=${method.toLowerCase()} code=non_port_error duration_ms=\\d+$`));
      const all = lines.join("\n");
      expect(all).not.toContain(SECRET_MESSAGE);
      expect(all).not.toContain(ADDRESS);
      expect(all).not.toContain(SERVICE_DID);
    });
  }

  it("bounds the MCP status call at 8 s by default and at the configured value when one is set", async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => { timeouts.push(ms); return real(ms); });
    try {
      await call(appFailingWith(() => { throw new McpPortError("TIMEOUT"); }), "GET");
      await call(appFailingWith(() => { throw new McpPortError("TIMEOUT"); }, { sessionStatusTimeoutMs: 200 }), "GET");
    } finally {
      timeoutSpy.mockRestore();
    }
    expect(timeouts).toEqual([8_000, 200]);
  });

  it("does not log a grant rejection answered as a 400", async () => {
    const res = await call(appFailingWith(() => { throw new McpPortError("GRANT_EXPIRED", 401); }), "POST");
    expect(res.status).toBe(400);
    expect(lines).toEqual([]);
  });
});
