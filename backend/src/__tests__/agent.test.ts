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

const DAY_MS = 24 * 60 * 60 * 1000;
const SPACE = `tinycloud:pkh:eip155:1:${TEST_ADDRESS}:default`;
const TRANSCRIPT_SQL_URI = `${SPACE}/sql/xyz.tinycloud.tinychat/connectors`;
const TRANSCRIPT_KV_URI = `${SPACE}/kv/xyz.tinycloud.tinychat/connectors/`;

function signedDelegation(
  resources: Record<string, string[]>,
  overrides: Record<string, unknown> = {},
  jwtClaims: Record<string, unknown> = {},
) {
  const att = Object.fromEntries(
    Object.entries(resources)
      .filter(([, actions]) => actions.length > 0)
      .map(([key, actions]) => [key, Object.fromEntries(actions.map((action) => [action, []]))]),
  );
  const payload = Buffer.from(JSON.stringify({ att, ...jwtClaims })).toString("base64url");
  return validDelegation({
    expiry: new Date(Date.now() + 60_000).toISOString(),
    delegationHeader: { Authorization: `Bearer x.${payload}.x` },
    ...overrides,
  });
}

/** Build a v2 envelope; `transcripts` overrides the exact transcript att. */
function v2Session(
  transcripts: Record<string, string[]> = {},
  opts: { overrides?: Record<string, unknown>; jwtClaims?: Record<string, unknown> } = {},
) {
  return {
    version: 2 as const,
    delegations: {
      memory: signedDelegation({ [`${SPACE}/sql/xyz.tinycloud.eliza/memory`]: ["tinycloud.sql/read"] }),
      transcripts: signedDelegation(
        {
          [TRANSCRIPT_SQL_URI]: ["tinycloud.sql/read"],
          [TRANSCRIPT_KV_URI]: ["tinycloud.kv/get", "tinycloud.kv/list"],
          ...transcripts,
        },
        opts.overrides ?? {},
        opts.jwtClaims ?? {},
      ),
    },
  };
}

function cidBackedV2Session(
  resourceOverrides: Array<Record<string, unknown>> = [],
  transcriptOverrides: Record<string, unknown> = {},
) {
  const cid = "bafkr4iharnesscid";
  return {
    version: 2 as const,
    delegations: {
      memory: signedDelegation({ [`${SPACE}/sql/xyz.tinycloud.eliza/memory`]: ["tinycloud.sql/read"] }),
      transcripts: validDelegation({
        cid,
        expiry: new Date(Date.now() + 60_000).toISOString(),
        delegationHeader: { Authorization: `Bearer ${cid}` },
        resources: resourceOverrides.length > 0 ? resourceOverrides : [
          { service: "kv", space: SPACE, path: "xyz.tinycloud.tinychat/connectors/", actions: ["tinycloud.kv/get", "tinycloud.kv/list"] },
          { service: "sql", space: SPACE, path: "xyz.tinycloud.tinychat/connectors", actions: ["tinycloud.sql/read"] },
        ],
        ...transcriptOverrides,
      }),
    },
  };
}

async function postSession(app: express.Express, session: unknown) {
  return request(app, "/api/agent/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session }),
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

  it("couriers the versioned two-grant session only when the signed transcript att is exact", async () => {
    const { app, calls } = createApp();
    const session = v2Session();
    const res = await postSession(app, session);
    expect(res.status).toBe(200);
    expect((calls[0].body as { session?: unknown }).session).toEqual(session);
  });

  it("couriers the SDK's CID-backed multi-resource transcript attenuation", async () => {
    const { app, calls } = createApp();
    const session = cidBackedV2Session();
    const res = await postSession(app, session);
    expect(res.status).toBe(200);
    expect((calls[0].body as { session?: unknown }).session).toEqual(session);
  });

  it("rejects a CID-backed attenuation whose Authorization does not match cid", async () => {
    const { app, calls } = createApp();
    const res = await postSession(app, cidBackedV2Session([], {
      delegationHeader: { Authorization: "Bearer bafkr4different" },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("malformed");
    expect(calls).toHaveLength(0);
  });

  it("couriers a grant that also carries the SDK's capabilities/read entry", async () => {
    const { app, calls } = createApp();
    const res = await postSession(app, v2Session({
      [`${SPACE}/capabilities/xyz.tinycloud.tinychat/connectors`]: ["tinycloud.capabilities/read"],
    }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  const rejected: Array<[string, string, () => unknown]> = [
    ["an extra signed transcript action", "transcript_policy_exceeded", () =>
      v2Session({ [TRANSCRIPT_SQL_URI]: ["tinycloud.sql/read", "tinycloud.sql/write"] })],
    ["an extra KV action", "transcript_policy_exceeded", () =>
      v2Session({ [TRANSCRIPT_KV_URI]: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/put"] })],
    ["a broader KV path", "transcript_policy_exceeded", () =>
      v2Session({ [TRANSCRIPT_KV_URI]: [], [`${SPACE}/kv/`]: ["tinycloud.kv/get"] })],
    ["a resource outside the transcript ceiling", "transcript_policy_exceeded", () =>
      v2Session({ [`${SPACE}/sql/xyz.tinycloud.eliza/memory`]: ["tinycloud.sql/read"] })],
    ["a missing required transcript resource", "transcript_policy_exceeded", () =>
      v2Session({ [TRANSCRIPT_KV_URI]: [] })],
    ["a capabilities entry beyond read", "transcript_policy_exceeded", () =>
      v2Session({ [`${SPACE}/capabilities/x`]: ["tinycloud.capabilities/read", "tinycloud.capabilities/delegate"] })],
    ["a transcript grant owned by someone else", "wrong_delegator", () => {
      const other = "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:default";
      return v2Session({
        [TRANSCRIPT_SQL_URI]: [],
        [TRANSCRIPT_KV_URI]: [],
        [`${other}/sql/xyz.tinycloud.tinychat/connectors`]: ["tinycloud.sql/read"],
        [`${other}/kv/xyz.tinycloud.tinychat/connectors/`]: ["tinycloud.kv/get", "tinycloud.kv/list"],
      });
    }],
    ["a transcript grant naming another delegatee", "wrong_delegatee", () =>
      v2Session({}, { overrides: { delegateDID: OTHER_DID } })],
    ["an expired transcript grant", "delegation_expired", () =>
      v2Session({}, { overrides: { expiry: new Date(Date.now() - 1_000).toISOString() } })],
    ["a transcript grant valid for more than seven days", "delegation_expiry_too_long", () =>
      v2Session({}, { overrides: { expiry: new Date(Date.now() + 8 * DAY_MS).toISOString() } })],
    ["a short summary expiry hiding a long SIGNED expiry", "delegation_expiry_too_long", () =>
      v2Session({}, { jwtClaims: { exp: Math.floor((Date.now() + 30 * DAY_MS) / 1_000) } })],
  ];

  for (const [label, code, build] of rejected) {
    it(`rejects ${label} with ${code} before couriering`, async () => {
      const { app, calls } = createApp();
      const res = await postSession(app, build());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(code);
      expect(calls).toHaveLength(0);
    });
  }

  it("never echoes delegation material in a courier rejection", async () => {
    const { app } = createApp();
    const session = v2Session({ [TRANSCRIPT_SQL_URI]: ["tinycloud.sql/read", "tinycloud.sql/admin"] });
    const res = await postSession(app, session);
    const rendered = JSON.stringify(await res.json());
    expect(rendered).not.toContain("Bearer");
    expect(rendered).not.toContain("Authorization");
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
