import { describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { createAgentRouter } from "../routes/agent.js";
import { mcpChatFromEnv } from "../mcp-meetings/config.js";

const ADDRESS = "0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2";
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";
const OWNER_DID = `did:pkh:eip155:1:${ADDRESS}`;
const SERVICE_DID = "did:key:z6MkServiceDidForTests";
const AGENT_DID = "did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c";
const CREDENTIAL = "credential-for-tests-with-plenty-of-entropy";
const DAY_MS = 24 * 60 * 60 * 1000;
const SQL_PATH = "xyz.tinycloud.tinychat/connectors";

const spaceOf = (address: string) => `tinycloud:pkh:eip155:1:${address}:applications`;
const sqlUri = (address = ADDRESS) => `${spaceOf(address)}/sql/${SQL_PATH}`;
const kvUri = (address = ADDRESS) => `${spaceOf(address)}/kv/${SQL_PATH}/`;

function grant(resources: Record<string, string[]>, overrides: Record<string, unknown> = {}, expiryMs = 29 * DAY_MS) {
  const att = Object.fromEntries(Object.entries(resources).map(([uri, actions]) => [uri, Object.fromEntries(actions.map(action => [action, []]))]));
  const payload = Buffer.from(JSON.stringify({ att, exp: Math.floor((Date.now() + expiryMs) / 1000) })).toString("base64url");
  return JSON.stringify({
    ownerAddress: ADDRESS, chainId: 1, primaryDid: OWNER_DID, delegateDID: SERVICE_DID,
    expiry: new Date(Date.now() + expiryMs).toISOString(), delegationHeader: { Authorization: `Bearer x.${payload}.x` }, ...overrides,
  });
}
const exactGrant = (overrides: Record<string, unknown> = {}, expiryMs?: number) =>
  grant({ [sqlUri()]: ["tinycloud.sql/read"], [kvUri()]: ["tinycloud.kv/get", "tinycloud.kv/list"] }, overrides, expiryMs);

interface Recorded { url: string; method: string; headers: Headers; body: unknown }

function setup(options: { mcpAccounts?: string; address?: string; elizaConfigured?: boolean; grantStatus?: number; grantBody?: unknown; mcpResult?: { status: number; body: unknown } } = {}) {
  const mcpCalls: Recorded[] = [];
  const elizaCalls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const record = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(init.body as string) : undefined };
    if (url.startsWith("https://eliza.test")) {
      elizaCalls.push(record);
      return Response.json({ entityId: "x", status: "active", transcriptStatus: "active", revision: "r1" });
    }
    mcpCalls.push(record);
    if (url.endsWith("/native/grant")) {
      return Response.json(options.grantBody ?? { ownerDid: OWNER_DID, serviceDid: SERVICE_DID, expiresAt: "2026-11-25T00:00:00.000Z" }, { status: options.grantStatus ?? 201 });
    }
    const result = options.mcpResult ?? { status: 200, body: { jsonrpc: "2.0", id: 1, result: { structuredContent: { status: "ok", output: { columns: ["1"], rows: [[1]] } } } } };
    return Response.json(result.body, { status: result.status });
  }) as unknown as typeof fetch;
  const mcp = mcpChatFromEnv({
    MCP_CHAT_ENABLED: "true", MCP_CHAT_URL: "https://mcp.test/mcp", MCP_CHAT_SERVICE_CREDENTIAL: CREDENTIAL,
    MCP_CHAT_SERVICE_CREDENTIAL_HEADER: "x-test-credential", MCP_CHAT_OWNER_DID_HEADER: "x-test-owner", MCP_CHAT_SERVICE_DID: SERVICE_DID,
    MCP_CHAT_TEST_ACCOUNTS: options.mcpAccounts ?? ADDRESS, MCP_CHAT_GRANT_EXPIRED_ERROR: "native_grant_expired", MCP_CHAT_GRANT_REJECTED_ERROR: "native_grant_rejected",
  }, fetchImpl);
  const app = express();
  app.use(express.json());
  app.use("/api/agent", createAgentRouter({
    ...(options.elizaConfigured === false ? {} : { agentDid: AGENT_DID, elizaServiceUrl: "https://eliza.test", elizaServiceSecret: "svc" }),
    mcp,
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => { req.user = { address: options.address ?? ADDRESS }; next(); },
    fetchImpl,
    deserializeDelegationSet: (serialized: string) => JSON.parse(serialized),
    sessionStatusTimeoutMs: 200,
  }));
  return { app, mcpCalls, elizaCalls };
}

async function call(app: express.Express, path: string, init?: RequestInit) {
  const server = await new Promise<Server>(resolve => { const instance = app.listen(0, () => resolve(instance)); });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}
const post = (app: express.Express, delegation: string) => call(app, "/api/agent/session", { method: "POST", body: JSON.stringify({ revision: "r", mcp: { delegation } }) });

describe("MCP account session courier", () => {
  it("forwards the serialized grant to the MCP with the service credential, no owner header and no Origin, never to eliza-service", async () => {
    const { app, mcpCalls, elizaCalls } = setup();
    const delegation = exactGrant();
    const res = await post(app, delegation);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "active", transcriptStatus: "active", expiresAt: "2026-11-25T00:00:00.000Z" });
    expect(mcpCalls).toHaveLength(1);
    expect(mcpCalls[0]!.url).toBe("https://mcp.test/native/grant");
    expect(mcpCalls[0]!.method).toBe("POST");
    expect(mcpCalls[0]!.body).toEqual({ delegation });
    expect(mcpCalls[0]!.headers.get("x-test-credential")).toBe(CREDENTIAL);
    expect(mcpCalls[0]!.headers.get("x-test-owner")).toBeNull();
    expect(mcpCalls[0]!.headers.get("origin")).toBeNull();
    expect(elizaCalls).toHaveLength(0);
  });

  it("rejects a grant whose owner is not the authenticated session, before forwarding anything", async () => {
    const { app, mcpCalls } = setup();
    const foreign = grant({ [sqlUri(OTHER_ADDRESS)]: ["tinycloud.sql/read"], [kvUri(OTHER_ADDRESS)]: ["tinycloud.kv/get", "tinycloud.kv/list"] }, { ownerAddress: OTHER_ADDRESS });
    const res = await post(app, foreign);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("wrong_delegator");
    expect(mcpCalls).toHaveLength(0);
  });

  it("rejects a grant minted for the eliza agent instead of the MCP service DID", async () => {
    const { app, mcpCalls } = setup();
    const res = await post(app, exactGrant({ delegateDID: AGENT_DID }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("wrong_delegatee");
    expect(mcpCalls).toHaveLength(0);
  });

  it("rejects extra scope, write actions, a missing entry, a non-applications space and a lifetime over 30 days", async () => {
    const { app, mcpCalls } = setup();
    const cases: Array<[string, string, string]> = [
      ["write action", grant({ [sqlUri()]: ["tinycloud.sql/read", "tinycloud.sql/write"], [kvUri()]: ["tinycloud.kv/get", "tinycloud.kv/list"] }), "mcp_grant_policy_exceeded"],
      ["extra resource", grant({ [sqlUri()]: ["tinycloud.sql/read"], [kvUri()]: ["tinycloud.kv/get", "tinycloud.kv/list"], [`${spaceOf(ADDRESS)}/kv/other/`]: ["tinycloud.kv/get"] }), "mcp_grant_policy_exceeded"],
      ["missing kv entry", grant({ [sqlUri()]: ["tinycloud.sql/read"] }), "mcp_grant_policy_exceeded"],
      ["kv get only", grant({ [sqlUri()]: ["tinycloud.sql/read"], [kvUri()]: ["tinycloud.kv/get"] }), "mcp_grant_policy_exceeded"],
      ["default space", grant({ [`tinycloud:pkh:eip155:1:${ADDRESS}:default/sql/${SQL_PATH}`]: ["tinycloud.sql/read"], [`tinycloud:pkh:eip155:1:${ADDRESS}:default/kv/${SQL_PATH}/`]: ["tinycloud.kv/get", "tinycloud.kv/list"] }), "wrong_delegator"],
      ["31 days", exactGrant({}, 31 * DAY_MS), "delegation_expiry_too_long"],
    ];
    for (const [name, delegation, error] of cases) {
      const res = await post(app, delegation);
      expect([name, res.status, (await res.json() as { error: string }).error]).toEqual([name, 400, error]);
    }
    expect(mcpCalls).toHaveLength(0);
  });

  it("accepts the SDK's read-only capabilities entry because the MCP decides on effective permissions", async () => {
    const { app } = setup();
    const withCapabilities = grant({
      [sqlUri()]: ["tinycloud.sql/read"], [kvUri()]: ["tinycloud.kv/get", "tinycloud.kv/list"], [`${spaceOf(ADDRESS)}/capabilities/all`]: ["tinycloud.capabilities/read"],
    });
    expect((await post(app, withCapabilities)).status).toBe(200);
  });

  it("keeps expired, rejected and unavailable MCP answers distinct, and refuses an unexpected owner or service in the reply", async () => {
    const expired = await post(setup({ grantStatus: 401, grantBody: { error: "native_grant_expired" } }).app, exactGrant());
    expect([expired.status, (await expired.json() as { error: string }).error]).toEqual([400, "delegation_expired"]);
    const rejected = await post(setup({ grantStatus: 401, grantBody: { error: "native_grant_rejected" } }).app, exactGrant());
    expect([rejected.status, (await rejected.json() as { error: string }).error]).toEqual([400, "delegation_rejected"]);
    const badCredential = await post(setup({ grantStatus: 403, grantBody: { error: "native_service_unauthorized" } }).app, exactGrant());
    expect([badCredential.status, (await badCredential.json() as { error: string }).error]).toEqual([502, "mcp_unavailable"]);
    const outage = await post(setup({ grantStatus: 503, grantBody: { error: "native_service_unavailable" } }).app, exactGrant());
    expect([outage.status, (await outage.json() as { error: string }).error]).toEqual([502, "mcp_unavailable"]);
    const wrongOwner = await post(setup({ grantBody: { ownerDid: `did:pkh:eip155:1:${OTHER_ADDRESS}`, serviceDid: SERVICE_DID, expiresAt: "2026-11-25T00:00:00.000Z" } }).app, exactGrant());
    expect([wrongOwner.status, (await wrongOwner.json() as { error: string }).error]).toEqual([502, "mcp_grant_mismatch"]);
    const wrongService = await post(setup({ grantBody: { ownerDid: OWNER_DID, serviceDid: "did:key:z6MkSomeoneElse", expiresAt: "2026-11-25T00:00:00.000Z" } }).app, exactGrant());
    expect([wrongService.status, (await wrongService.json() as { error: string }).error]).toEqual([502, "mcp_grant_mismatch"]);
  });
});

describe("MCP account session status", () => {
  const unauthorized = (error: string) => ({ status: 401, body: { error } });
  it("reports the MCP grant, includes the service DID to delegate to, and never calls eliza-service", async () => {
    const { app, mcpCalls, elizaCalls } = setup();
    const res = await call(app, "/api/agent/session");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "active", transcriptStatus: "active", revision: "mcp", mcp: { serviceDid: SERVICE_DID } });
    expect(mcpCalls[0]!.headers.get("x-test-owner")).toBe(OWNER_DID);
    expect(mcpCalls[0]!.headers.get("x-test-credential")).toBe(CREDENTIAL);
    expect(elizaCalls).toHaveLength(0);
  });

  it("maps missing, expired and rejected grants to none, expired and stale", async () => {
    const none = await (await call(setup({ mcpResult: unauthorized("native_grant_required") }).app, "/api/agent/session")).json() as { status: string };
    const expired = await (await call(setup({ mcpResult: unauthorized("native_grant_expired") }).app, "/api/agent/session")).json() as { status: string };
    const rejected = await (await call(setup({ mcpResult: unauthorized("native_grant_rejected") }).app, "/api/agent/session")).json() as { status: string };
    expect([none.status, expired.status, rejected.status]).toEqual(["none", "expired", "stale"]);
  });

  it("answers 502 when the MCP cannot answer instead of claiming a state", async () => {
    const res = await call(setup({ mcpResult: { status: 503, body: { error: "native_service_unavailable" } } }).app, "/api/agent/session");
    expect([res.status, (await res.json() as { error: string }).error]).toEqual([502, "mcp_unavailable"]);
  });

  it("does not claim a disconnect the MCP cannot perform", async () => {
    const { app, elizaCalls } = setup();
    const res = await call(app, "/api/agent/session", { method: "DELETE" });
    expect([res.status, (await res.json() as { error: string }).error]).toEqual([409, "disconnect_unsupported"]);
    expect(elizaCalls).toHaveLength(0);
  });
});

describe("operator rollback", () => {
  it("serves an account that is not on the MCP list through eliza-service exactly as before", async () => {
    const { app, mcpCalls, elizaCalls } = setup({ mcpAccounts: OTHER_ADDRESS });
    const res = await call(app, "/api/agent/session");
    expect(res.status).toBe(200);
    expect(elizaCalls).toHaveLength(1);
    expect(mcpCalls).toHaveLength(0);
  });

  it("says so, rather than falling back, when eliza-service is not configured and the account is not on the MCP", async () => {
    const { app, mcpCalls } = setup({ mcpAccounts: OTHER_ADDRESS, elizaConfigured: false });
    const res = await call(app, "/api/agent/session");
    expect([res.status, (await res.json() as { error: string }).error]).toEqual([503, "eliza_unavailable"]);
    expect(mcpCalls).toHaveLength(0);
  });
});
