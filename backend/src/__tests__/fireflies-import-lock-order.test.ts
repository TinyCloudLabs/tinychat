import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { deriveFirefliesImportKeys, FIREFLIES_DELEGATE_KMS_PATH } from "../fireflies-import-identity.js";
import { ConnectorWebhookLimiters, createConnectorWebhookCompanionRouter } from "../routes/connector-webhooks.js";
import { TenantCoordinator } from "../services/calendar-autojoin-store.js";
import { FirefliesDirectImporter, type FirefliesPurgeLedgerRead } from "../services/fireflies-import-executor.js";
import { FirefliesGrantStore } from "../services/fireflies-grant-store.js";
import { createMemoryGrantKv, HOST, mintGrantPair } from "./helpers/fireflies-grant-fixtures.js";

// A disconnect or a purge that lands while an import is running must finish. The importer takes the per-owner lock and then the
// connection-change lane; the routes run inside the lane, so grant removal there must not wait for the per-owner lock.

const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);
const FAKE_KEY = "ff_live_secret_token_never_log_me_xyz789";

const timeout = <T,>(ms: number, label: string) =>
  new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} did not finish in ${ms} ms`)), ms));
const within = <T,>(work: Promise<T>, ms: number, label: string) => Promise.race([work, timeout<T>(ms, label)]);

async function withServer<T>(app: express.Express, runIt: (base: string) => Promise<T>): Promise<T> {
  const server: Server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    return await runIt(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function setup(seed: number, removalTakesOwnerLock: boolean) {
  const keys = await deriveFirefliesImportKeys(
    { getKey: async (p) => Buffer.alloc(32, p === FIREFLIES_DELEGATE_KMS_PATH ? seed : seed + 1) },
    { host: HOST, env: {} },
  );
  const cidOf = keys.delegate.node.computeDelegationCid.bind(keys.delegate.node);
  const pair = await mintGrantPair(keys.delegate.did, cidOf, { now: NOW });
  const grantStore = new FirefliesGrantStore({ kv: createMemoryGrantKv().kv, kek: keys.grantKek, delegateDid: keys.delegate.did });
  await grantStore.store(pair.address, pair, pair.expiresAt);
  const owner = pair.address.toLowerCase();
  const coordinator = new TenantCoordinator();

  let ledger: FirefliesPurgeLedgerRead = { status: "absent" };
  const control = {
    markDisabled: async () => {},
    readDisabled: async () => null,
    readLedger: async () => ledger,
    readDeleted: async () => false,
    markDeleted: async () => {},
    clearDeleted: async () => {},
    writeLedger: async (_source: string, _address: string, next: unknown) => {
      ledger = { status: "ok", ledger: next } as FirefliesPurgeLedgerRead;
    },
    quarantineLedger: async () => {},
    clearLedger: async () => {},
  };

  let reached!: () => void;
  const atSecretRead = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const written: string[] = [];
  const fetchCalls: string[] = [];
  const importer = new FirefliesDirectImporter({
    delegate: keys.delegate,
    grantStore,
    configuredHost: HOST,
    control: control as never,
    coordinator,
    fetchOptions: {
      now: () => NOW,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const id = (JSON.parse(String(init?.body ?? "{}")) as { variables?: { id?: string } }).variables?.id ?? "unknown";
        fetchCalls.push(id);
        return new Response(
          JSON.stringify({ data: { transcript: { id, title: "t", date: NOW, duration: 1, sentences: [{ index: 0, speaker_name: "A", text: "x", start_time: 1, end_time: 2 }] } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    },
    checkMeetingsGrant: async () => ({ status: "ok" }),
    readSecretKey: async () => {
      reached();
      await gate;
      return { status: "ok", value: FAKE_KEY };
    },
    writeMeeting: async (_node, _verified, normalized) => {
      written.push(normalized.meeting.sourceId);
      return { status: "written" };
    },
    perUserSpacingMs: 0,
    now: () => NOW,
    log: () => {},
  });

  const removeFirefliesGrant = removalTakesOwnerLock
    ? (address: string) => coordinator.run(address, () => grantStore.remove(address))
    : (address: string) => grantStore.remove(address);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { address: pair.address };
    next();
  });
  app.use(
    "/api/connectors/webhooks",
    createConnectorWebhookCompanionRouter({
      tokens: { config: async () => ({ source: "fireflies", createdAt: new Date(NOW).toISOString() }), revoke: async () => {}, mint: async () => { throw new Error("unused"); } } as never,
      queue: { clear: async () => ({ cleared: 0 }), list: async () => [] } as never,
      control: control as never,
      limiters: new ConnectorWebhookLimiters(),
      removeFirefliesGrant,
    }),
  );
  const startImport = () => importer.handleWebhook({ address: pair.address, meetingId: "ff-1", receivedAt: new Date(NOW).toISOString() });
  const grantState = () => grantStore.status(owner, { configuredHost: HOST, deps: { computeDelegationCid: cidOf }, now: NOW });
  return { app, atSecretRead, release, startImport, grantState, written, fetchCalls };
}

describe("disconnect and purge while an import is running", () => {
  beforeEach(() => {
    process.env.WEBHOOK_HMAC_MASTER = Buffer.alloc(32, 0x41).toString("base64");
    process.env.LOG_HASH_SALT = Buffer.alloc(32, 0x42).toString("base64");
  });
  afterEach(() => {
    delete process.env.WEBHOOK_HMAC_MASTER;
    delete process.env.LOG_HASH_SALT;
  });

  it("a disconnect finishes, removes the grant, and the running import still ends", async () => {
    const h = await setup(0xd1, false);
    await withServer(h.app, async (base) => {
      const running = h.startImport();
      await within(h.atSecretRead, 2_000, "import reaching the secret read");

      const disconnect = await within(fetch(`${base}/api/connectors/webhooks/config`, { method: "DELETE" }), 2_000, "disconnect");
      expect(disconnect.status).toBe(200);
      expect((await h.grantState()).state).toBe("none");

      h.release();
      const outcome = await within(running, 2_000, "running import");
      expect(outcome).toMatchObject({ handled: true });
    });
  });

  it("a purge finishes while the import runs, and the purged meeting is not written", async () => {
    const h = await setup(0xd3, false);
    await withServer(h.app, async (base) => {
      const running = h.startImport();
      await within(h.atSecretRead, 2_000, "import reaching the secret read");

      const purge = await within(
        fetch(`${base}/api/connectors/webhooks/purged`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source: "fireflies", ids: ["ff-1"] }),
        }),
        2_000,
        "purge",
      );
      expect(purge.status).toBe(204);
      expect((await h.grantState()).state).toBe("none");

      h.release();
      await within(running, 2_000, "running import");
      // The import went on to fetch the meeting; the write guard then refused it because the purge ledger names it.
      expect(h.fetchCalls).toEqual(["ff-1"]);
      expect(h.written).toEqual([]);
    });
  });

  it("removal that waits for the per-owner lock is what hangs", async () => {
    const h = await setup(0xd5, true);
    await withServer(h.app, async (base) => {
      void h.startImport();
      await within(h.atSecretRead, 2_000, "import reaching the secret read");
      const pending = fetch(`${base}/api/connectors/webhooks/config`, { method: "DELETE" });
      await expect(within(pending, 400, "disconnect")).rejects.toThrow("did not finish");
    });
  });
});
