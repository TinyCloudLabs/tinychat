// A REAL connector-webhook backend, over REAL HTTP, for the end-to-end drivers in
// `test/connectors/webhook-loop.e2e.test.ts` (E2E1).
//
// Not a `*.test.ts` file — `bun test` never picks it up; it is a support module, the same role
// `test/real-auth-support.ts` plays for the real-auth lane.
//
// WHY IT LIVES UNDER `backend/`. The drivers live in `test/connectors/`, but `express` is a
// dependency of the BACKEND workspace only (`bun` resolves per importing file, and
// `test/node_modules` has no express). The app has to be assembled by a file that can resolve
// express, so the backend half of the rig sits here and the drivers import it.
//
// WHAT IS REAL. `WebhookTokenService`, `ConnectorQueue`, `ConnectorControlStore`,
// `ConnectorDrainWorker`, the public delivery handler and the authenticated companion router are
// the production ones, mounted in the production ORDER: raw-body delivery route ahead of the JSON
// parser and CSRF, companions behind them. HMAC verification, token routing, the durable queue,
// the disabled marker and the purge ledger are therefore exercised for real.
//
// WHAT IS FAKED, AND WHY:
//   * the TinyCloud NODE — an in-memory KV, the same shape `connector-drain.test.ts` uses. The
//     backend's own KV is the only storage the server touches under Option C.
//   * `authMiddleware` — SIWE session verification is not what these drivers are about, so a
//     bearer token maps to an address through an in-process table. Every route still reads the
//     address from `req.user`, never from a body, so two-user isolation stays a real assertion.
//   * `applyRateLimiters` is NOT mounted. The companion bucket would 429 a driver that makes a
//     few dozen authenticated calls; the limiter contract has its own suites
//     (`rate-limits.test.ts`, `connector-webhooks.test.ts`).
//
// The HMAC master and log salt are RANDOM per harness, generated at start: no secret-shaped
// constant is tracked in this repo, and nothing here reads a real `.env`.

import { createHmac, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import express, { type NextFunction, type Request, type Response } from "express";
import { createCsrfMiddleware } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

import {
  ConnectorControlStore,
  ConnectorWebhookLimiters,
  connectorDrainAbort,
  createConnectorWebhookCompanionRouter,
  createConnectorWebhookHandler,
  createConnectorWebhookParserErrorHandler,
} from "../routes/connector-webhooks.js";
import { ConnectorQueue } from "../services/connector-queue.js";
import { ConnectorDrainWorker } from "../services/connector-drain.js";
import {
  _resetWebhookTokenState,
  WebhookTokenService,
} from "../services/webhook-tokens.js";

/** The in-memory stand-in for the backend's own node KV. */
export class FakeBackendNode {
  readonly store = new Map<string, unknown>();

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      if (!this.store.has(key)) return { data: null };
      return { data: { data: this.store.get(key) } };
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      this.store.set(key, JSON.parse(JSON.stringify(value)));
      return { data: true };
    },
    delete: async (key: string): Promise<unknown> => {
      this.store.delete(key);
      return { data: true };
    },
    list: async (): Promise<unknown> => ({ data: [] }),
  };
}

/** One observed companion request, in arrival order. */
export interface CompanionRequestLog {
  method: string;
  path: string;
  address: string | null;
}

export interface WebhookLoopBackendOptions {
  /**
   * Fires as each authenticated companion request ENTERS the router, before the handler runs.
   * The storage-before-ack driver uses it to snapshot the user's space at `POST /ack` time.
   */
  onCompanionRequest?: (info: CompanionRequestLog) => void;
}

export interface WebhookLoopBackend {
  /** e.g. `http://127.0.0.1:53312` — pass straight to `createConnectorWebhooksClient`. */
  baseUrl: string;
  node: FakeBackendNode;
  queue: ConnectorQueue;
  control: ConnectorControlStore;
  tokens: WebhookTokenService;
  /** Every companion request seen, in order. */
  requests: CompanionRequestLog[];
  /** Register a signed-in session for `address`; returns its bearer token. */
  signIn(address: string): string;
  signOut(token: string): void;
  stop(): Promise<void>;
}

/** `sha256=<hex>` over the exact bytes, exactly as Fireflies signs a V2 delivery. */
export function signDelivery(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export interface DeliveryInput {
  /** The minted delivery URL from `POST /config`. */
  url: string;
  /** The one-time delivery secret from the same response. */
  secret: string;
  /** `meeting.transcribed` | `meeting.summarized` | a legacy/unsupported name. */
  event: string;
  meetingId: string;
  /**
   * V2 millisecond stamp. Omit for the LEGACY shape (no timestamp at all), pass an explicit
   * value to exercise the freshness window. Defaults to `Date.now()`.
   */
  timestamp?: number | null;
  /** Overrides the signature — for the wrong-secret / tampered-body cases. */
  signature?: string;
}

export interface DeliveryResult {
  status: number;
  text: string;
  body: unknown;
}

/** Build the exact V2 (or legacy) body a driver signs and posts. */
export function deliveryBody(input: Pick<DeliveryInput, "event" | "meetingId" | "timestamp">): string {
  const payload: Record<string, unknown> = {
    event: input.event,
    meeting_id: input.meetingId,
  };
  if (input.timestamp !== null) payload.timestamp = input.timestamp ?? Date.now();
  return JSON.stringify(payload);
}

/** POST one signed delivery at the public route. No session, no CSRF header — like Fireflies. */
export async function deliverWebhook(input: DeliveryInput): Promise<DeliveryResult> {
  const body = deliveryBody(input);
  const response = await fetch(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature": input.signature ?? signDelivery(body, input.secret),
    },
    body,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, text, body: parsed };
}

export async function startWebhookLoopBackend(
  options: WebhookLoopBackendOptions = {},
): Promise<WebhookLoopBackend> {
  const previousMaster = process.env.WEBHOOK_HMAC_MASTER;
  const previousPrev = process.env.WEBHOOK_HMAC_MASTER_PREV;
  const previousSalt = process.env.LOG_HASH_SALT;
  process.env.WEBHOOK_HMAC_MASTER = randomBytes(32).toString("base64");
  delete process.env.WEBHOOK_HMAC_MASTER_PREV;
  process.env.LOG_HASH_SALT = randomBytes(32).toString("base64");
  // The master/salt are read through module-level memos; a fresh harness must not inherit the
  // previous one's derived values.
  _resetWebhookTokenState();

  const node = new FakeBackendNode();
  const asNode = node as unknown as TinyCloudNode;
  const tokens = new WebhookTokenService(asNode);
  // flushWindowMs: 0 — the 250 ms coalescing window is the queue's own contract
  // (connector-queue.test.ts owns it); a driver waiting it out adds latency without adding
  // coverage, and dedup by `(meetingId, kind)` is applied on the stored value either way.
  const queue = new ConnectorQueue(asNode, { flushWindowMs: 0 });
  const control = new ConnectorControlStore(asNode);
  const limiters = new ConnectorWebhookLimiters();
  const drain = new ConnectorDrainWorker({
    tokens,
    queue,
    control,
    abort: connectorDrainAbort,
    // Deterministic drivers: a forced kick must run a real pass every time rather than replaying
    // the previous result from inside the anti-tight-loop floor.
    minIntervalMs: 0,
    forcedMinIntervalMs: 0,
    lane: (fn) => Promise.resolve().then(fn),
  });

  const sessions = new Map<string, string>();
  const requests: CompanionRequestLog[] = [];

  const app = express();
  app.set("trust proxy", 1);

  // The PUBLIC delivery route, in the production raw-body window: ahead of the JSON parser and
  // CSRF, carrying its own limiter and parser-error accounting.
  app.post(
    "/api/connectors/webhooks/:source/:token",
    limiters.ipPreLimiter,
    express.raw({ type: "application/json", limit: "64kb", inflate: false }),
    createConnectorWebhookParserErrorHandler(limiters),
    // OPTION C: no `onDelivery` kick. Enqueueing the id is the whole server-side job.
    createConnectorWebhookHandler({ tokens, queue, limiters }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(createCsrfMiddleware());

  app.use(
    "/api/connectors/webhooks",
    (req: Request, res: Response, next: NextFunction) => {
      const header = req.get("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(header);
      const address = match ? sessions.get(match[1]) : undefined;
      const log: CompanionRequestLog = {
        method: req.method,
        path: req.path,
        address: address ?? null,
      };
      requests.push(log);
      options.onCompanionRequest?.(log);
      if (address === undefined) {
        res
          .status(401)
          .json({ error: "unauthenticated", message: "Authentication required" });
        return;
      }
      req.user = { address };
      next();
    },
    createConnectorWebhookCompanionRouter({
      tokens,
      queue,
      control,
      limiters,
      // OPTION C — no `delegations` collaborator, by construction.
      drain: ({ source, address }) => drain.kick({ source, address, force: true }),
    }),
  );

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    node,
    queue,
    control,
    tokens,
    requests,
    signIn(address: string): string {
      const token = randomBytes(24).toString("hex");
      sessions.set(token, address);
      return token;
    },
    signOut(token: string): void {
      sessions.delete(token);
    },
    async stop(): Promise<void> {
      drain.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      _resetWebhookTokenState();
      if (previousMaster === undefined) delete process.env.WEBHOOK_HMAC_MASTER;
      else process.env.WEBHOOK_HMAC_MASTER = previousMaster;
      if (previousPrev === undefined) delete process.env.WEBHOOK_HMAC_MASTER_PREV;
      else process.env.WEBHOOK_HMAC_MASTER_PREV = previousPrev;
      if (previousSalt === undefined) delete process.env.LOG_HASH_SALT;
      else process.env.LOG_HASH_SALT = previousSalt;
    },
  };
}
