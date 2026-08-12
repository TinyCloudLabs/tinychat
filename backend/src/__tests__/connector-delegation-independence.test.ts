import { describe, expect, test } from "bun:test";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { backendDelegationResolvedPermissions } from "../manifest.js";
import { createDelegationMiddleware } from "../middleware/delegation.js";
import { createDelegationRouter } from "../routes/delegations.js";
import {
  ConnectorWebhookLimiters,
  createConnectorWebhookCompanionRouter,
  type ConnectorControl,
  type DisabledMarker,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import type {
  ClearResult,
  DeadItem,
  PendingItem,
} from "../services/connector-queue.js";
import type { WebhookConfigRecord } from "../services/webhook-tokens.js";

/**
 * OPTION C, the load-bearing regression: **turning Fireflies webhooks off cannot break normal
 * TinyChat chat access.**
 *
 * Under the drafted Option-B shape the two features shared one grant: `POST /api/delegations`
 * consulted the connector disabled marker before minting (409 `background_sync_disabled`, 503
 * when the marker was unreadable), and `DELETE /api/connectors/webhooks/config` removed and
 * evicted the app's *chat* delegation as steps 3 and 4 of its teardown. Under Option C the
 * server holds NO connector delegation at all — it queues meeting ids and nothing else — so
 * that coupling is not merely unused, it is a live outage path: a user who switches off an
 * optional notification connector loses the delegation every authenticated chat write needs.
 *
 * This file drives the two routers that were coupled against ONE shared delegation store and
 * cache, through a real HTTP server, in the order a user would: connect chat, turn webhooks
 * off, keep chatting, reconnect.
 *
 * INGEST-CUTOVER(plan §11) — findings §4 flagged this file as one that might have to be rewritten
 * for backend ingestion, and the plan carried the caveat that it could survive instead. It
 * survives. Under backend ingest the server holds a Fireflies credential and its own encrypted
 * copy of the meeting (plan §5, §6), but custody is OUT OF BAND: no connector delegation is
 * minted into a user's space in either mode (plan §9 row 3), so the teardown these tests drive
 * still has no chat grant to reach for. The disposition is therefore an explicit regression
 * guard, per plan §11's rule — not a deletion, and not a silent keep. Every test below carries
 * the marker with the reason it holds AFTER the cutover, because "there is nothing server-side"
 * is no longer that reason.
 */

const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const BACKEND_DID = "did:key:z6MkBackendIndependence";
const SOURCE = "fireflies";

function createStore() {
  const records = new Map<string, any>();
  return {
    _records: records,
    store: async (identifier: string, serialized: string, metadata: any) => {
      records.set(identifier, { serialized, ...metadata });
    },
    load: async (identifier: string) => records.get(identifier) ?? null,
    remove: async (identifier: string) => {
      records.delete(identifier);
    },
  };
}

function createCache() {
  const records = new Map<string, unknown>();
  return {
    _records: records,
    get: (identifier: string) => records.get(identifier) ?? null,
    set: (identifier: string, access: unknown) =>
      records.set(identifier, access),
    evict: (identifier: string) => records.delete(identifier),
  };
}

/** Minimal stand-ins for the companion router's collaborators — see connector-companions.test.ts. */
class FakeTokens {
  readonly configs = new Map<string, WebhookConfigRecord>();

  async config(address: string): Promise<WebhookConfigRecord | null> {
    return this.configs.get(address.toLowerCase()) ?? null;
  }

  async mint(address: string, source: string) {
    return this.issue(address, source);
  }

  async rotate(address: string, source: string) {
    return this.issue(address, source);
  }

  async revoke(address: string): Promise<void> {
    this.configs.delete(address.toLowerCase());
  }

  private issue(address: string, source: string) {
    const previous = this.configs.get(address.toLowerCase()) ?? null;
    const createdAt = new Date().toISOString();
    const token = `tok-${this.configs.size + 1}`;
    this.configs.set(address.toLowerCase(), { token, source, createdAt });
    return {
      token,
      record: { address: address.toLowerCase(), source, createdAt },
      rotatedFrom: previous?.token ?? null,
    };
  }
}

class FakeQueue {
  readonly items = new Map<string, PendingItem[]>();

  async list(source: string, address: string): Promise<PendingItem[]> {
    return this.items.get(`${source}/${address.toLowerCase()}`) ?? [];
  }

  async dead(_source: string, _address: string): Promise<DeadItem[]> {
    return [];
  }

  /** F010: the real queue reports what it deleted; the fake mirrors that contract. */
  async clear(source: string, address: string): Promise<ClearResult> {
    const key = `${source}/${address.toLowerCase()}`;
    const cleared = (this.items.get(key) ?? []).length;
    this.items.delete(key);
    return { cleared, superseded: 0 };
  }
}

class FakeControl implements ConnectorControl {
  readonly markers = new Map<string, DisabledMarker>();

  async readDisabled(address: string): Promise<DisabledMarker | null> {
    return this.markers.get(address.toLowerCase()) ?? null;
  }

  async markDisabled(address: string, source: string | null): Promise<void> {
    this.markers.set(address.toLowerCase(), {
      revokedAt: new Date().toISOString(),
      source,
    });
  }

  async clearDisabled(address: string): Promise<void> {
    this.markers.delete(address.toLowerCase());
  }

  async readLedger(
    _source: string,
    _address: string,
  ): Promise<PurgeLedgerRead> {
    // Exactly the `absent` variant: it carries no `ledger`, and structural
    // subtyping lets an excess property through `tsc` unnoticed.
    return { status: "absent" } satisfies PurgeLedgerRead;
  }

  async writeLedger(
    _source: string,
    _address: string,
    _ledger: PurgeLedger,
  ): Promise<void> {}

  async clearLedger(_source: string, _address: string): Promise<void> {}

  async quarantineLedger(
    _source: string,
    _address: string,
    _raw: unknown,
  ): Promise<void> {}
}

function mintableBundle() {
  return JSON.stringify({
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ownerAddress: ADDRESS,
    chainId: 1,
    delegateDID: BACKEND_DID,
    resources: backendDelegationResolvedPermissions(BACKEND_DID),
  });
}

function createApp() {
  const store = createStore();
  const cache = createCache();
  const tokens = new FakeTokens();
  const queue = new FakeQueue();
  const control = new FakeControl();

  const app = express();
  app.use(express.json());
  const authMiddleware = (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    req.user = { address: ADDRESS };
    next();
  };

  app.use(
    "/api/delegations",
    createDelegationRouter({
      backendDid: BACKEND_DID,
      store: store as any,
      cache: cache as any,
      authMiddleware,
      deserializeDelegationSet: (serialized: string) => JSON.parse(serialized),
      activateDelegation: async () => ({ kv: {}, sql: {} }) as any,
      extractResources: (delegation: any) => delegation.resources,
      extractExpiry: (delegation: any) => new Date(delegation.expiresAt),
    }),
  );

  app.use(
    "/api/connectors/webhooks",
    authMiddleware,
    createConnectorWebhookCompanionRouter({
      tokens: tokens as any,
      queue: queue as any,
      control,
      limiters: new ConnectorWebhookLimiters({
        ipLimit: 0,
        tokenSuccessLimit: 0,
      }),
    }),
  );

  // Stands in for every authenticated route that writes to the user's space (chat history,
  // billing ledger, connector sync): the generic delegation middleware, nothing else.
  app.use(
    "/api/chat",
    authMiddleware,
    createDelegationMiddleware({
      node: undefined as unknown as TinyCloudNode,
      store: store as any,
      cache: cache as any,
      backendDid: BACKEND_DID,
    }),
    (_req: Request, res: Response) => {
      res.json({ ok: true });
    },
  );

  return { app, store, cache, tokens, queue, control };
}

async function withServer<T>(
  app: express.Express,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("chat delegation is independent of the webhook connector, in either ingest mode", () => {
  // INGEST-CUTOVER(plan §11) — regression guard. The user-visible promise is unchanged and the
  // reason it holds is unchanged in shape: `DELETE /config` tears down the connector's own state
  // only. What the cutover adds to that teardown is server-side — credential revoke + content
  // delete + queue drop for a cohort address (plan §8.1 W7) — and none of it touches the chat
  // delegation store or its cache, which is what steps 4 and 5 below assert.
  test("disabling Fireflies webhooks cannot break normal TinyChat chat access", async () => {
    const { app, store, cache, tokens } = createApp();

    await withServer(app, async (base) => {
      // 1. The user signs in and grants the ordinary backend delegation.
      const minted = await fetch(`${base}/api/delegations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serialized: mintableBundle() }),
      });
      expect(minted.status).toBe(200);

      // 2. Chat works.
      expect((await fetch(`${base}/api/chat`)).status).toBe(200);

      // 3. The user enables, then turns OFF, background meeting notifications.
      tokens.configs.set(ADDRESS, {
        token: "tok-existing",
        source: SOURCE,
        createdAt: new Date().toISOString(),
      });
      const disabled = await fetch(
        `${base}/api/connectors/webhooks/config`,
        { method: "DELETE" },
      );
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toEqual({
        status: "disabled",
        queueDropped: 0,
      });

      // 4. The connector is off — and chat is untouched. INGEST-CUTOVER(plan §11): the reason is
      //    restated rather than left stale. It is NOT "the server holds nothing" — for a cohort
      //    address it holds a Fireflies credential and stored meetings, and this teardown deletes
      //    both. It is that the server holds no connector DELEGATION in either mode (custody is
      //    out of band, plan §6), so teardown has no grant of the user's to remove and no reason
      //    to reach into the chat one.
      expect((await fetch(`${base}/api/chat`)).status).toBe(200);
      const status = await fetch(`${base}/api/delegations/status`);
      expect(status.status).toBe(200);
      expect(((await status.json()) as { status: string }).status).toBe(
        "active",
      );

      // 5. And the record + warm cache the middleware reads are still there, unevicted.
      expect(await store.load(ADDRESS)).not.toBeNull();
      expect(cache.get(ADDRESS)).not.toBeNull();
    });
  });

  // INGEST-CUTOVER(plan §11) — regression guard, unchanged in substance and more load-bearing
  // than before. Backend ingest adds more connector state a mint could have been made to consult
  // (the cohort list, the credential row, the fetch worker's health); the answer stays that a
  // chat mint consults NONE of it. A cohort address whose credential is missing or revoked must
  // still be able to sign in and chat.
  test("a standing disabled marker never blocks a fresh chat delegation mint", async () => {
    const { app, store, control } = createApp();
    await control.markDisabled(ADDRESS, SOURCE);

    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/delegations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serialized: mintableBundle() }),
      });

      // Not 409 `background_sync_disabled`, not 503 `background_sync_state_unavailable`:
      // the webhook toggle is a different feature and does not gate chat.
      expect(response.status).toBe(200);
      expect(await store.load(ADDRESS)).not.toBeNull();
      expect((await fetch(`${base}/api/chat`)).status).toBe(200);
    });
  });

  // INGEST-CUTOVER(plan §11) — regression guard. Idempotent teardown matters MORE after the
  // cutover: a cohort disconnect fans out to an upstream OAuth revoke, a credential-row delete
  // and a content purge (plan §8.1 W7), any of which a user may retry after a failure. A second
  // DELETE must still be a clean no-op for chat rather than a path that evicts the chat grant.
  test("DELETE /config is idempotent for chat too — a second teardown still leaves chat up", async () => {
    const { app } = createApp();

    await withServer(app, async (base) => {
      await fetch(`${base}/api/delegations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serialized: mintableBundle() }),
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const disabled = await fetch(
          `${base}/api/connectors/webhooks/config`,
          { method: "DELETE" },
        );
        expect(disabled.status).toBe(200);
        expect((await fetch(`${base}/api/chat`)).status).toBe(200);
      }
    });
  });
});
