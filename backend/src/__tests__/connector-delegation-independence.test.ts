import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import { describe, expect, it } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { StoredDelegation } from "@tinyboilerplate/core";
import type { DelegationMetadata } from "@tinyboilerplate/server";
import { createApiBodyParser } from "../body-parsing.js";
import { createDelegationRouter } from "../routes/delegations.js";
import {
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  type ConnectorControl,
  type DisabledMarker,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import type { ClearResult, DeadItem, PendingItem } from "../services/connector-queue.js";
import type { WebhookConfigRecord } from "../services/webhook-tokens.js";
import { makeSignedTranscriptGrant, type SignedTranscriptGrant } from "./helpers/transcript-grant.js";

const SOURCE = "fireflies";

const fingerprint = (value: string | undefined) => value === undefined ? null : createHash("sha256").update(value).digest("hex");
class FakeTokens {
  readonly configs = new Map<string, WebhookConfigRecord>();
  async config(address: string) { return this.configs.get(address.toLowerCase()) ?? null; }
  async mint(address: string, source: string) { return this.issue(address, source); }
  async rotate(address: string, source: string) { return this.issue(address, source); }
  async revoke(address: string) { this.configs.delete(address.toLowerCase()); }
  private issue(address: string, source: string) {
    const previous = this.configs.get(address.toLowerCase()) ?? null;
    const createdAt = new Date().toISOString();
    this.configs.set(address.toLowerCase(), { token: "connector-token", source, createdAt });
    return { token: "connector-token", record: { address: address.toLowerCase(), source, createdAt }, rotatedFrom: previous?.token ?? null };
  }
}

class FakeQueue {
  async list(_source: string, _address: string): Promise<PendingItem[]> { return []; }
  async dead(_source: string, _address: string): Promise<DeadItem[]> { return []; }
  async clear(_source: string, _address: string): Promise<ClearResult> { return { cleared: 0, superseded: 0 }; }
}

class FakeControl implements ConnectorControl {
  readonly markers = new Map<string, DisabledMarker>();
  async readDisabled(address: string) { return this.markers.get(address.toLowerCase()) ?? null; }
  async markDisabled(address: string, source: string | null) {
    this.markers.set(address.toLowerCase(), { revokedAt: new Date().toISOString(), source });
  }
  async clearDisabled(address: string) { this.markers.delete(address.toLowerCase()); }
  async readLedger(_source: string, _address: string): Promise<PurgeLedgerRead> { return { status: "absent" }; }
  async writeLedger(_source: string, _address: string, _ledger: PurgeLedger) {}
  async clearLedger(_source: string, _address: string) {}
  async quarantineLedger(_source: string, _address: string, _raw: unknown) {}
}

function createApp(grant: SignedTranscriptGrant) {
  const records = new Map<string, StoredDelegation>();
  const cached = new Map<string, unknown>();
  const tokens = new FakeTokens();
  const control = new FakeControl();
  let activations = 0;
  const authMiddleware = (req: Request, _res: Response, next: NextFunction) => {
    req.user = { address: grant.address };
    next();
  };
  const node = {
    computeDelegationCid: grant.computeDelegationCid,
    useDelegation: async () => {
      activations++;
      return { kv: { get: async () => ({ ok: true }) }, sql: {} };
    },
  } as unknown as TinyCloudNode;
  const app = express();
  app.use(createApiBodyParser());
  app.use("/api/delegations", createDelegationRouter({
    backendDid: grant.backendDid,
    configuredHost: grant.configuredHost,
    eligibility: () => true,
    authMiddleware,
    node,
    store: {
      load: async (address) => records.get(address) ?? null,
      store: async (address: string, serialized: string, metadata: DelegationMetadata) => {
        records.set(address, { serialized, grantedAt: new Date().toISOString(), ...metadata });
      },
      remove: async (address) => { records.delete(address); },
    },
    cache: {
      get: (address) => cached.get(address) ?? null,
      set: (address, access) => { cached.set(address, access); },
      evict: (address) => { cached.delete(address); },
    } as Parameters<typeof createDelegationRouter>[0]["cache"],
  }));
  app.use("/api/connectors/webhooks", authMiddleware, createConnectorWebhookCompanionRouter({
    tokens: tokens as Parameters<typeof createConnectorWebhookCompanionRouter>[0]["tokens"],
    queue: new FakeQueue() as Parameters<typeof createConnectorWebhookCompanionRouter>[0]["queue"],
    control,
    limiters: new ConnectorWebhookLimiters({ ipLimit: 0, tokenSuccessLimit: 0 }),
  }));
  return { app, records, cached, tokens, control, getActivations: () => activations };
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

function postGrant(base: string, grant: SignedTranscriptGrant) {
  return fetch(`${base}/api/delegations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ serialized: grant.serialized, siwe: grant.siwe, signature: grant.signature }),
  });
}

describe("transcriber grant and Fireflies webhook independence", () => {
  it("turning off Fireflies notifications leaves the signed transcript-writer grant active and cached", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = createApp(grant);
    fixture.tokens.configs.set(grant.address.toLowerCase(), {
      token: "connector-token", source: SOURCE, createdAt: new Date().toISOString(),
    });
    await withServer(fixture.app, async (base) => {
      expect((await postGrant(base, grant)).status).toBe(200);
      expect(fixture.getActivations()).toBe(2);
      expect(fixture.cached.has(grant.address)).toBe(true);
      const disabled = await fetch(`${base}/api/connectors/webhooks/config`, { method: "DELETE" });
      expect(disabled.status).toBe(200);
      expect((await disabled.json()).status).toBe("disabled");
      const status = await fetch(`${base}/api/delegations/status`);
      expect(await status.json()).toEqual({
        status: "active", expiresAt: grant.expiresAt.toISOString(), verified: true, delivery: "enabled",
      });
      expect((await postGrant(base, grant)).status).toBe(200);
    });
    expect(fingerprint(fixture.records.get(grant.address)?.serialized)).toBe(fingerprint(grant.envelope));
    expect(fixture.cached.has(grant.address)).toBe(true);
    expect(fixture.getActivations()).toBe(2);
  });

  it("a preexisting Fireflies disabled marker does not gate a signed transcript-writer grant", async () => {
    const grant = await makeSignedTranscriptGrant();
    const fixture = createApp(grant);
    await fixture.control.markDisabled(grant.address, SOURCE);
    await withServer(fixture.app, async (base) => {
      expect((await postGrant(base, grant)).status).toBe(200);
      expect((await fetch(`${base}/api/delegations/status`)).status).toBe(200);
    });
    expect(fingerprint(fixture.records.get(grant.address)?.serialized)).toBe(fingerprint(grant.envelope));
    expect(fixture.getActivations()).toBe(2);
  });
});
