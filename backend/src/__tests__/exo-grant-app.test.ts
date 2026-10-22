import { describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { APP_ID } from "@tinyboilerplate/core";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import { createApiBodyParser } from "../body-parsing.js";
import { backendDelegationPolicyHash } from "../manifest.js";
import { createExoGrantRouter } from "../routes/exo-grant.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant, type TranscriptAtt } from "./helpers/transcript-grant.js";

const REQUESTS = `${APP_ID}/exo/v1/requests/`;
const JOBS = `${APP_ID}/exo/v1/jobs/`;
const SQL = `${APP_ID}/connectors`;
const CONNECTOR_KV = `${APP_ID}/connectors/tinycloud-transcriber/`;
const PAST = "2000-01-01T00:00:00.000Z";

function exoAtt(spaceId: string): TranscriptAtt {
  return {
    [`${spaceId}/kv/${REQUESTS}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/list": [{}], "tinycloud.kv/del": [{}] },
    [`${spaceId}/kv/${JOBS}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}], "tinycloud.kv/del": [{}] },
  };
}

function connectorAtt(spaceId: string): TranscriptAtt {
  return {
    [`${spaceId}/sql/${SQL}`]: { "tinycloud.sql/read": [{}], "tinycloud.sql/write": [{}] },
    [`${spaceId}/kv/${CONNECTOR_KV}`]: { "tinycloud.kv/get": [{}], "tinycloud.kv/put": [{}] },
  };
}

interface Fixture {
  app: express.Express;
  calls: {
    load: string[];
    store: Array<{ address: string; envelope: string; meta: { resources: unknown[]; expiresAt: string } }>;
    remove: string[];
    teardown: string[];
    order: string[];
    useDelegation: number;
  };
  setRecord: (record: Record<string, unknown> | null) => void;
}

// The session address is what `authMiddleware` puts on `req.user`; the route scopes every
// read and write to it.
function fixtureFor(
  grant: SignedTranscriptGrant,
  sessionAddress: string = grant.address,
  teardown: (address: string) => Promise<void> = async () => {},
): Fixture {
  const calls: Fixture["calls"] = { load: [], store: [], remove: [], teardown: [], order: [], useDelegation: 0 };
  let record: Record<string, unknown> | null = null;
  const node = {
    computeDelegationCid: grant.computeDelegationCid,
    useDelegation: async () => { calls.useDelegation++; return { kv: {}, sql: {} }; },
  } as unknown as TinyCloudNode;
  const store = {
    load: async (address: string) => { calls.load.push(address); return record; },
    store: async (address: string, envelope: string, meta: Fixture["calls"]["store"][number]["meta"]) => {
      calls.store.push({ address, envelope, meta });
      record = { serialized: envelope, expiresAt: meta.expiresAt, policyHash: backendDelegationPolicyHash(grant.backendDid), delegateDid: grant.backendDid };
    },
    remove: async (address: string) => { calls.order.push("remove"); calls.remove.push(address); record = null; },
  };
  const authMiddleware = (req: Request, _res: Response, next: NextFunction) => {
    req.user = { address: sessionAddress };
    next();
  };
  const app = express();
  // Production ordering: global parser (which skips this path), CSRF, then the router.
  app.use(createApiBodyParser());
  app.use(createCsrfMiddleware());
  app.use("/api/exo/v1/grant", createExoGrantRouter({
    backendDid: grant.backendDid,
    configuredHost: grant.configuredHost,
    store: store as never,
    authMiddleware,
    node,
    teardownExoOwner: async (address: string) => {
      calls.order.push("teardown");
      calls.teardown.push(address);
      await teardown(address);
    },
  }));
  return { app, calls, setRecord: (next) => { record = next; } };
}

async function withServer<T>(app: express.Express, run: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0);
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closing = once(server, "close");
    server.close();
    await closing;
  }
}

function send(base: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<Response> {
  return fetch(`${base}/api/exo/v1/grant`, {
    method,
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function bodyOf(grant: SignedTranscriptGrant): Record<string, string> {
  return { serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature };
}

describe("exo grant route: POST", () => {
  it("accepts the exact exo grant for the session owner and stores it under the exo kind", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    const fixture = fixtureFor(grant);
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "POST", bodyOf(grant));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual({ status: "active", expiresAt: expect.any(String), verified: true });
    });
    expect(fixture.calls.useDelegation).toBe(2);
    expect(fixture.calls.store).toHaveLength(1);
    const [stored] = fixture.calls.store;
    expect(stored.address).toBe(grant.address.toLowerCase());
    expect(JSON.parse(stored.envelope).format).toBe("tinychat.exo-sync-grant");
    expect(stored.meta.resources).toEqual([
      { service: "kv", space: grant.spaceId, path: REQUESTS, actions: ["tinycloud.kv/get", "tinycloud.kv/list", "tinycloud.kv/del"] },
      { service: "kv", space: grant.spaceId, path: JOBS, actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"] },
    ]);
  });

  for (const { name, build, code } of [
    { name: "a connector grant", build: async (base: SignedTranscriptGrant) => makeSignedTranscriptGrant({ att: connectorAtt(base.spaceId) }), code: "overbroad_delegation" },
    { name: "an exo grant widened to the whole app namespace", build: async (base: SignedTranscriptGrant) => {
      const att = exoAtt(base.spaceId);
      att[`${base.spaceId}/kv/${APP_ID}/`] = att[`${base.spaceId}/kv/${REQUESTS}`];
      delete att[`${base.spaceId}/kv/${REQUESTS}`];
      return makeSignedTranscriptGrant({ att });
    }, code: "overbroad_delegation" },
    { name: "a grant mixing connector and exo resources", build: async (base: SignedTranscriptGrant) => makeSignedTranscriptGrant({ att: { ...connectorAtt(base.spaceId), ...exoAtt(base.spaceId) } }), code: "overbroad_delegation" },
    { name: "an exo grant on another user's space", build: async () => {
      const other = await makeSignedTranscriptGrant({ wallet: "B" });
      return makeSignedTranscriptGrant({ att: exoAtt(other.spaceId) });
    }, code: "foreign_space_delegation" },
  ]) {
    it(`refuses ${name} and stores nothing`, async () => {
      const base = await makeSignedTranscriptGrant();
      const grant = await build(base);
      const fixture = fixtureFor(grant);
      await withServer(fixture.app, async (url) => {
        const response = await send(url, "POST", bodyOf(grant));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(code);
      });
      expect(fixture.calls.store).toEqual([]);
      expect(fixture.calls.useDelegation).toBe(0);
    });
  }

  it("refuses an exo grant presented by a session that does not own it", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    const fixture = fixtureFor(grant, "0x0000000000000000000000000000000000000001");
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "POST", bodyOf(grant));
      expect(response.status).toBe(400);
    });
    expect(fixture.calls.store).toEqual([]);
    expect(fixture.calls.useDelegation).toBe(0);
  });

  it("refuses a serialized grant over the 64 KiB cap before any verification", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    const fixture = fixtureFor(grant);
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "POST", { ...bodyOf(grant), serialized: "x".repeat(65 * 1024) });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("bundle_too_large");
    });
    expect(fixture.calls.store).toEqual([]);
  });

  it("answers 413 for a body over the 96 KiB route limit", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    const fixture = fixtureFor(grant);
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "POST", { serialized: "x".repeat(97 * 1024) });
      expect(response.status).toBe(413);
    });
    expect(fixture.calls.store).toEqual([]);
  });

  it("limits accepted POSTs to six per address per hour", async () => {
    const base = await makeSignedTranscriptGrant();
    const grant = await makeSignedTranscriptGrant({ att: exoAtt(base.spaceId) });
    const fixture = fixtureFor(grant);
    await withServer(fixture.app, async (url) => {
      for (let i = 0; i < 6; i++) {
        expect((await send(url, "POST", {})).status).toBe(400);
      }
      const limited = await send(url, "POST", {});
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toBe("delegation_rate_limited");
    });
  });
});

describe("exo grant route: GET and DELETE", () => {
  it("answers GET with status only and reads only the session owner's record", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = fixtureFor(grant);
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "GET");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "none", expiresAt: null, verified: false });
    });
    expect(fixture.calls.load).toEqual([grant.address.toLowerCase()]);
  });

  it("reports a stored record past its expiry as expired and removes it", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = fixtureFor(grant);
    fixture.setRecord({
      serialized: "stored", expiresAt: PAST, policyHash: backendDelegationPolicyHash(grant.backendDid), delegateDid: grant.backendDid,
    });
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "GET");
      expect(await response.json()).toEqual({ status: "expired", expiresAt: PAST, verified: false });
    });
    expect(fixture.calls.remove).toEqual([grant.address.toLowerCase()]);
  });

  it("removes only the session owner's record on DELETE", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = fixtureFor(grant);
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "DELETE");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "none", expiresAt: null });
    });
    expect(fixture.calls.remove).toEqual([grant.address.toLowerCase()]);
  });

  it("clears owner Exo state before removing the record on DELETE", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = fixtureFor(grant);
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "DELETE");
      expect(response.status).toBe(200);
    });
    expect(fixture.calls.teardown).toEqual([grant.address.toLowerCase()]);
    expect(fixture.calls.order).toEqual(["teardown", "remove"]);
  });

  it("keeps the record and returns 503 when owner Exo teardown fails", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = fixtureFor(grant, grant.address, async () => { throw new Error("kv unavailable"); });
    fixture.setRecord({
      serialized: "stored", expiresAt: new Date(Date.now() + 60_000).toISOString(), policyHash: backendDelegationPolicyHash(grant.backendDid), delegateDid: grant.backendDid,
    });
    await withServer(fixture.app, async (url) => {
      const response = await send(url, "DELETE");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "unavailable" });
    });
    expect(fixture.calls.remove).toEqual([]);
  });
});
