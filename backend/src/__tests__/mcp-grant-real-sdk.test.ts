import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAgentRouter } from "../routes/agent.js";
import { mcpChatFromEnv } from "../mcp-meetings/config.js";

// The grant below is the captured output of the real node-sdk `delegateTo` (see the fixture's note), parsed here by the
// backend's real delegation deserializer. Nothing in this file builds a grant with the functions under test.
const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/mcp-native-grant.json"), "utf8")) as {
  audience: string; ownerAddress: string; chainId: number; issuedAtMs: number; serialized: string;
};
const OTHER = "0x2222222222222222222222222222222222222222";

interface PostedGrant { url: string; body: unknown; headers: Headers }

function setup(options: { chain?: string; serviceDid?: string } = {}) {
  const posts: PostedGrant[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    posts.push({ url: String(input), body: JSON.parse(init!.body as string), headers: new Headers(init?.headers) });
    return Response.json({ ownerDid: `did:pkh:eip155:${options.chain ?? "1"}:${fixture.ownerAddress}`, serviceDid: options.serviceDid ?? fixture.audience, expiresAt: "2026-11-25T00:00:00.000Z" }, { status: 201 });
  }) as unknown as typeof fetch;
  const mcp = mcpChatFromEnv({
    MCP_CHAT_ENABLED: "true", MCP_CHAT_URL: "https://mcp.test/mcp", MCP_CHAT_SERVICE_CREDENTIAL: "credential-with-plenty-of-entropy-for-tests",
    MCP_CHAT_SERVICE_CREDENTIAL_HEADER: "x-test-credential", MCP_CHAT_OWNER_DID_HEADER: "x-test-owner", MCP_CHAT_SERVICE_DID: options.serviceDid ?? fixture.audience,
    MCP_CHAT_TEST_ACCOUNTS: fixture.ownerAddress, ...(options.chain ? { MCP_CHAT_OWNER_CHAIN_ID: options.chain } : {}),
  }, fetchImpl);
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // The default (real) delegation deserializer is used on purpose.
  app.use("/api/agent", createAgentRouter({
    mcp, fetchImpl,
    authMiddleware: (req: Request, _res: Response, next: NextFunction) => { req.user = { address: fixture.ownerAddress }; next(); },
  }));
  return { app, posts };
}

async function post(app: express.Express, delegation: string) {
  const server = await new Promise<Server>(resolveServer => { const instance = app.listen(0, () => resolveServer(instance)); });
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${port}/api/agent/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: "r", mcp: { delegation } }),
    });
    return { status: res.status, body: await res.json() as { error?: string; status?: string } };
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => (error ? reject(error) : resolveClose())));
  }
}

/** Re-encode the grant's signed `att` claim; the header and signature are left as the SDK produced them. */
function withAtt(change: (att: Record<string, Record<string, unknown>>) => void): string {
  const parsed = JSON.parse(fixture.serialized) as { delegationHeader: { Authorization: string } };
  const [head, payloadSegment, signature] = parsed.delegationHeader.Authorization.replace(/^Bearer\s+/i, "").split(".");
  const payload = JSON.parse(Buffer.from(payloadSegment!, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown>> };
  // The SDK writes the owner's checksummed address; the mutations below address resources with the lowercase form.
  payload.att = Object.fromEntries(Object.entries(payload.att).map(([uri, actions]) => [uri.replace(/^(tinycloud:pkh:eip155:\d+:)(0x[0-9a-fA-F]{40})/, (_m, prefix: string, address: string) => prefix + address.toLowerCase()), actions]));
  change(payload.att);
  parsed.delegationHeader.Authorization = `Bearer ${head}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
  return JSON.stringify(parsed);
}

beforeEach(() => setSystemTime(new Date(fixture.issuedAtMs + 5 * 60_000)));
afterEach(() => setSystemTime());

describe("the real SDK grant at the courier boundary", () => {
  it("is accepted once, unchanged, for the session's own owner DID and the configured service DID", async () => {
    const { app, posts } = setup();
    const res = await post(app, fixture.serialized);
    expect(res.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://mcp.test/native/grant");
    expect(posts[0]!.body).toEqual({ delegation: fixture.serialized });
    expect(posts[0]!.headers.get("origin")).toBeNull();
  });

  it("is refused before any MCP call when the owner DID's chain is not the grant's, for the same address", async () => {
    const { app, posts } = setup({ chain: "137" });
    const res = await post(app, fixture.serialized);
    expect([res.status, res.body.error]).toEqual([400, "wrong_delegator"]);
    expect(posts).toHaveLength(0);
  });

  it("is refused before any MCP call when it was minted for another service DID", async () => {
    const { app, posts } = setup({ serviceDid: "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktA" });
    const res = await post(app, fixture.serialized);
    expect([res.status, res.body.error]).toEqual([400, "wrong_delegatee"]);
    expect(posts).toHaveLength(0);
  });

  it("is refused before any MCP call once it has expired", async () => {
    setSystemTime(new Date(fixture.issuedAtMs + 2 * 60 * 60_000));
    const { app, posts } = setup();
    const res = await post(app, fixture.serialized);
    expect([res.status, res.body.error]).toEqual([400, "delegation_expired"]);
    expect(posts).toHaveLength(0);
  });

  const space = `tinycloud:pkh:eip155:1:${fixture.ownerAddress}:applications`;
  const readOnly = { "tinycloud.capabilities/read": [] };
  it.each([
    ["a canonical capabilities entry", (att: Record<string, Record<string, unknown>>) => { att[`${space}/capabilities/all`] = readOnly; }, "mcp_grant_policy_exceeded"],
    ["duplicate capabilities entries", (att: Record<string, Record<string, unknown>>) => { att[`${space}/capabilities/all`] = readOnly; att[`${space}/capabilities/more`] = readOnly; }, "mcp_grant_policy_exceeded"],
    ["a capabilities entry for another owner", (att: Record<string, Record<string, unknown>>) => { att[`tinycloud:pkh:eip155:1:${OTHER}:applications/capabilities/all`] = readOnly; }, "mcp_grant_policy_exceeded"],
    ["an extra resource", (att: Record<string, Record<string, unknown>>) => { att[`${space}/kv/other/`] = { "tinycloud.kv/get": [] }; }, "mcp_grant_policy_exceeded"],
    ["a missing KV entry", (att: Record<string, Record<string, unknown>>) => { delete att[`${space}/kv/xyz.tinycloud.tinychat/connectors/`]; }, "mcp_grant_policy_exceeded"],
    ["a write action on the database", (att: Record<string, Record<string, unknown>>) => { att[`${space}/sql/xyz.tinycloud.tinychat/connectors`]!["tinycloud.sql/write"] = []; }, "mcp_grant_policy_exceeded"],
  ])("is refused before any MCP call with %s", async (_name, change, error) => {
    const { app, posts } = setup();
    const res = await post(app, withAtt(change));
    expect([res.status, res.body.error]).toEqual([400, error]);
    expect(posts).toHaveLength(0);
  });
});
