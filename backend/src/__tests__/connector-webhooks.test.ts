import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { connect as netConnect } from "node:net";
import { gzipSync } from "node:zlib";
import express from "express";
import { assertKvResult } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  ConnectorQueue,
  type EnqueueInput,
  type EnqueueResult,
} from "../services/connector-queue.js";
import {
  _resetWebhookTokenState,
  deriveWebhookSecret,
  generateWebhookToken,
  type WebhookTokenRecord,
} from "../services/webhook-tokens.js";
import {
  ConnectorDrainAbortFlags,
  ConnectorWebhookLimiters,
  createConnectorWebhookHandler,
  createConnectorWebhookParserErrorHandler,
  parseDeliveryTimestamp,
  type ConnectorWebhookLimiterOptions,
} from "../routes/connector-webhooks.js";

/**
 * Route tests for the PUBLIC connector webhook (§4.6's response table, row by row, plus
 * §8.3's list). Built off `billing-webhook.test.ts:19-31` — the ephemeral-port + real-`fetch`
 * template — with a minimal app carrying only the pre-limiter, the raw parser, the handler and
 * `index.ts`'s terminal error handler, so the raw-body path is exercised in isolation.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS = "0x7d033300000000000000000000000000000073f2";
const OTHER_ADDRESS = "0xb1b1b10000000000000000000000000000001111";
const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const PREV_MASTER = "9zQ1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

class FakeTokenStore {
  readonly records = new Map<string, WebhookTokenRecord>();
  lookupCalls = 0;
  failWith: Error | null = null;

  register(token: string, address = ADDRESS, source = SOURCE): string {
    this.records.set(token, {
      address,
      source,
      createdAt: new Date(0).toISOString(),
    });
    return token;
  }

  async lookup(token: unknown): Promise<WebhookTokenRecord | null> {
    this.lookupCalls += 1;
    if (this.failWith) throw this.failWith;
    return typeof token === "string" ? (this.records.get(token) ?? null) : null;
  }
}

class FakeQueue {
  readonly enqueued: Array<{
    source: string;
    address: string;
    input: EnqueueInput;
  }> = [];
  failWith: Error | null = null;
  status: EnqueueResult["status"] = "queued";

  async enqueue(
    source: string,
    address: string,
    input: EnqueueInput,
  ): Promise<EnqueueResult> {
    if (this.failWith) throw this.failWith;
    this.enqueued.push({ source, address, input });
    return { status: this.status, depth: this.enqueued.length };
  }
}

interface Harness {
  app: express.Express;
  tokens: FakeTokenStore;
  queue: FakeQueue;
  limiters: ConnectorWebhookLimiters;
  kicks: Array<{ source: string; address: string }>;
}

function createHarness(
  options: { limiter?: ConnectorWebhookLimiterOptions; mounted?: boolean } = {},
): Harness {
  const tokens = new FakeTokenStore();
  const queue = new FakeQueue();
  const limiters = new ConnectorWebhookLimiters(options.limiter);
  const kicks: Array<{ source: string; address: string }> = [];
  const app = express();
  // Mirrors index.ts exactly: trust exactly one ingress hop, so req.ip is the last XFF entry.
  app.set("trust proxy", 1);
  if (options.mounted !== false) {
    app.post(
      "/api/connectors/webhooks/:source/:token",
      limiters.ipPreLimiter,
      express.raw({ type: "application/json", limit: "64kb", inflate: false }),
      createConnectorWebhookParserErrorHandler(limiters),
      createConnectorWebhookHandler({
        tokens,
        queue,
        limiters,
        onDelivery: (input) => {
          kicks.push(input);
        },
      }),
    );
  }
  // index.ts's terminal error handler (§4.3 requirement 2).
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const status =
        typeof err === "object" &&
        err !== null &&
        typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : 500;
      res
        .status(status >= 400 && status < 600 ? status : 500)
        .json({ error: "internal_error" });
    },
  );
  return { app, tokens, queue, limiters, kicks };
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

function sign(body: string | Buffer, token: string, source = SOURCE): string {
  const secret = deriveWebhookSecret(source, token);
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function path(token: string, source = SOURCE): string {
  return `/api/connectors/webhooks/${source}/${token}`;
}

function currentBody(
  meetingId = "01JABCDEF0123456789",
  event = "meeting.transcribed",
): string {
  return JSON.stringify({
    meeting_id: meetingId,
    event,
    timestamp: new Date().toISOString(),
  });
}

interface DeliveryInit {
  body?: string | Buffer;
  signature?: string | null;
  contentType?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

async function deliver(
  base: string,
  url: string,
  init: DeliveryInit = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.contentType !== null)
    headers["content-type"] = init.contentType ?? "application/json";
  if (init.signature) headers["x-hub-signature"] = init.signature;
  headers["x-forwarded-for"] = init.ip ?? "203.0.113.7";
  return fetch(`${base}${url}`, {
    method: "POST",
    headers,
    body: init.body === undefined ? undefined : (init.body as BodyInit),
  });
}

/** Send an UNNORMALIZED request path over a raw socket and return the response status. */
async function rawPostStatus(base: string, rawPath: string): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise<number>((resolve, reject) => {
    const socket = netConnect({ host: hostname, port: Number(port) }, () => {
      socket.write(
        `POST ${rawPath} HTTP/1.1\r\nHost: localhost\r\n` +
          "Content-Type: application/json\r\nContent-Length: 0\r\n" +
          "X-Forwarded-For: 203.0.113.7\r\nConnection: close\r\n\r\n",
      );
    });
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
    socket.on("end", () => {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (match) resolve(Number(match[1]));
      else
        reject(
          new Error(`no status line in response: ${received.slice(0, 80)}`),
        );
    });
    socket.on("error", reject);
  });
}

/** Capture console output for the log-hygiene assertions (§6.3/§8.3). */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

async function sensitiveStructuredKvFailure(): Promise<Error> {
  try {
    await Promise.resolve({
      ok: false as const,
      error: {
        code: "NETWORK_ERROR",
        message:
          "PRIVATE_RESULT_PAYLOAD delegation=AUTHZ_BYTES payload=PRIVATE",
        service: "kv",
      },
    }).then((result) => assertKvResult(result));
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected assertKvResult to reject the explicit failure");
}

beforeEach(() => {
  process.env.CONNECTOR_WEBHOOKS_ENABLED = "true";
  process.env.WEBHOOK_HMAC_MASTER = MASTER;
  process.env.LOG_HASH_SALT = LOG_SALT;
  delete process.env.WEBHOOK_HMAC_MASTER_PREV;
  _resetWebhookTokenState();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
});

describe("POST /api/connectors/webhooks/:source/:token", () => {
  test("flag off / route not mounted => 404 (the deploy-probe canary)", async () => {
    const h = createHarness({ mounted: false });
    const token = generateWebhookToken();
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), { body: currentBody() });
      expect(res.status).toBe(404);
    });
  });

  test("happy path => 202 {status:queued} and exactly one queued item", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JHAPPY0000000000A");
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "queued" });
    });
    expect(h.queue.enqueued).toHaveLength(1);
    expect(h.queue.enqueued[0]!.address).toBe(ADDRESS);
    expect(h.queue.enqueued[0]!.input).toMatchObject({
      meetingId: "01JHAPPY0000000000A",
      kind: "transcript",
    });
    // Fast-ack: the drain kick is fire-and-forget AFTER the response.
    expect(h.kicks).toEqual([{ source: SOURCE, address: ADDRESS }]);
  });

  test("the legacy body shape is accepted (and skips the freshness check)", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = JSON.stringify({
      meetingId: "01JLEGACY000000000B",
      eventType: "Transcription completed",
    });
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(202);
    });
    expect(h.queue.enqueued).toHaveLength(1);
    expect(h.queue.enqueued[0]!.input.kind).toBe("transcript");
  });

  test("meeting.summarized enqueues as a distinct kind", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JSUMMARY0000000C", "meeting.summarized");
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(202);
    });
    expect(h.queue.enqueued[0]!.input.kind).toBe("summary");
  });

  test("a queue at cap answers byte-identically to the happy path", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JCAPPED000000000D");
    h.queue.status = "dropped";
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(202);
      // The drop count goes to the log and the authenticated /pending — never the public body.
      expect(await res.text()).toBe(JSON.stringify({ status: "queued" }));
    });
  });

  test("a verified delivery under WEBHOOK_HMAC_MASTER_PREV is accepted", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    // Sign under the key that is about to become _PREV, then rotate the env under the route.
    const body = currentBody("01JROTATED00000000E");
    const signature = sign(body, token);
    process.env.WEBHOOK_HMAC_MASTER = PREV_MASTER;
    process.env.WEBHOOK_HMAC_MASTER_PREV = MASTER;
    _resetWebhookTokenState();
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), { body, signature });
      expect(res.status).toBe(202);
    });
  });
});

describe("connector webhook — identical 401s, no enumeration oracle", () => {
  test("missing signature, bad signature and unknown token are byte-identical 401s", async () => {
    const h = createHarness();
    const registered = h.tokens.register(generateWebhookToken());
    const unknown = generateWebhookToken();
    const body = currentBody();
    await withServer(h.app, async (base) => {
      const missing = await deliver(base, path(registered), { body });
      const bad = await deliver(base, path(registered), {
        body,
        signature: `sha256=${"a".repeat(64)}`,
      });
      const unknownToken = await deliver(base, path(unknown), {
        body,
        signature: sign(body, unknown),
      });

      expect(missing.status).toBe(401);
      expect(bad.status).toBe(401);
      expect(unknownToken.status).toBe(401);
      const bodies = await Promise.all([
        missing.text(),
        bad.text(),
        unknownToken.text(),
      ]);
      expect(bodies[0]).toBe(JSON.stringify({ error: "invalid_signature" }));
      expect(new Set(bodies).size).toBe(1);
    });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  test("malformed :token and an unknown :source are 401 with NO KV call", async () => {
    const h = createHarness();
    const body = currentBody();
    const valid = generateWebhookToken();
    await withServer(h.app, async (base) => {
      const cases = [
        path("..%2F..%2Fdelegations%2F0xabc"),
        path("..%2Fdelegations"),
        path(`${"a".repeat(44)}`),
        path("abcd"),
        path(valid, "unknown-source"),
        path(valid, "threads"),
      ];
      for (const url of cases) {
        const res = await deliver(base, url, {
          body,
          signature: sign(body, valid),
        });
        expect(res.status).toBe(401);
        expect(await res.text()).toBe(
          JSON.stringify({ error: "invalid_signature" }),
        );
      }

      // A LITERAL `..` segment: `fetch` collapses it per WHATWG URL rules, so this one has to
      // go over a raw socket to reach the router at all — which is exactly how an attacker
      // would send it. Express hands it to the handler as `token = ".."`.
      expect(
        await rawPostStatus(base, `/api/connectors/webhooks/${SOURCE}/..`),
      ).toBe(401);
    });
    // The traversal guard and the node-amplification guard are the same guard (§4.1).
    expect(h.tokens.lookupCalls).toBe(0);
  });

  test("a non-ASCII x-hub-signature is 401, never 500, and the process stays alive", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody();
    await withServer(h.app, async (base) => {
      // Same STRING length as a valid header, different BYTE length — listen's pre-check
      // throws RangeError here (§4.2).
      const res = await deliver(base, path(token), {
        body,
        signature: `sha256=${"Ã"}${"a".repeat(63)}`,
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe(
        JSON.stringify({ error: "invalid_signature" }),
      );

      const alive = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(alive.status).toBe(202);
    });
  });

  test("an uppercase-hex or sha1 signature is rejected — no algorithm negotiation", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody();
    const valid = sign(body, token);
    await withServer(h.app, async (base) => {
      const upper = await deliver(base, path(token), {
        body,
        signature: valid.toUpperCase(),
      });
      expect(upper.status).toBe(401);
      const sha1 = await deliver(base, path(token), {
        body,
        signature: valid.replace("sha256=", "sha1="),
      });
      expect(sha1.status).toBe(401);
    });
  });
});

describe("connector webhook — the body-coercion crash rows (§4.3)", () => {
  test("no Content-Type, a non-JSON Content-Type and a zero-length body are all answered 401", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody();
    await withServer(h.app, async (base) => {
      const noType = await deliver(base, path(token), {
        body,
        contentType: null,
      });
      expect(noType.status).toBe(401);

      const textPlain = await deliver(base, path(token), {
        body,
        contentType: "text/plain",
      });
      expect(textPlain.status).toBe(401);

      // Zero-length body: `express.raw` leaves `req.body = {}`, we coerce to `Buffer.alloc(0)`,
      // and an empty buffer never verifies against a real delivery's signature.
      const empty = await deliver(base, path(token), {
        body: "",
        signature: `sha256=${"e".repeat(64)}`,
      });
      expect(empty.status).toBe(401);

      const noBody = await deliver(base, path(token), {});
      expect(noBody.status).toBe(401);

      // The socket was answered every time and the process is still alive.
      const alive = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(alive.status).toBe(202);
    });
    expect(h.queue.enqueued).toHaveLength(1);
  });

  test("a gzip-encoded body is never decoded-and-verified", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const raw = currentBody("01JGZIP00000000000F");
    const gzipped = gzipSync(Buffer.from(raw, "utf8"));
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body: gzipped,
        // Signed over the PLAINTEXT, which is what a decompressing parser would hand us.
        signature: sign(raw, token),
        headers: { "content-encoding": "gzip" },
      });
      expect([401, 415]).toContain(res.status);
    });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  test("the effective body cap is 64kb, not body-parser's 100kb default", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    await withServer(h.app, async (base) => {
      // 80 kb would pass under the 100 kb default and must not here.
      const overCap = "x".repeat(80 * 1024);
      const over = await deliver(base, path(token), {
        body: overCap,
        signature: sign(overCap, token),
      });
      expect(over.status).toBe(413);

      // Just under the cap still reaches the handler and verifies.
      const padded = JSON.stringify({
        meeting_id: "01JBIG000000000000G",
        event: "meeting.transcribed",
        timestamp: new Date().toISOString(),
        pad: "y".repeat(60 * 1024),
      });
      expect(padded.length).toBeLessThan(64 * 1024);
      const under = await deliver(base, path(token), {
        body: padded,
        signature: sign(padded, token),
      });
      expect(under.status).toBe(202);
    });
  });
});

describe("connector webhook — payload rows (§4.5/§4.6)", () => {
  test("a verified non-JSON body is 400 invalid_json", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = "not json at all";
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_json" });
    });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  test("an unhandled event is 200 ignored so the provider stops retrying", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JIGNORED00000000H", "meeting.created");
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: "ignored",
        event: "meeting.created",
      });
    });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  test("the echoed event is allowlisted and bounded, not a 128-char slice of the payload", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody(
      "01JIGNORED00000000H",
      `${"x".repeat(5_000)}<script>`,
    );
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(200);
      const echoed = (await res.json()) as { status: string; event: string };
      expect(echoed.status).toBe("ignored");
      expect(echoed.event).toBe("x".repeat(48));
    });
  });

  test("a handled event with no meeting id is 400 missing_meeting_id", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = JSON.stringify({
      event: "meeting.transcribed",
      timestamp: new Date().toISOString(),
    });
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "missing_meeting_id" });
    });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  test("a traversal or oversize meeting id is 400 invalid_meeting_id and never enqueued", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    await withServer(h.app, async (base) => {
      const traversal = JSON.stringify({
        meeting_id: "../../threads/x",
        event: "meeting.transcribed",
      });
      const first = await deliver(base, path(token), {
        body: traversal,
        signature: sign(traversal, token),
      });
      expect(first.status).toBe(400);
      expect(await first.json()).toEqual({ error: "invalid_meeting_id" });

      const oversize = JSON.stringify({
        meeting_id: "a".repeat(60 * 1024),
        event: "meeting.transcribed",
      });
      const second = await deliver(base, path(token), {
        body: oversize,
        signature: sign(oversize, token),
      });
      expect(second.status).toBe(400);
      expect(await second.json()).toEqual({ error: "invalid_meeting_id" });

      const slash = JSON.stringify({
        meeting_id: "abc/def",
        event: "meeting.transcribed",
      });
      const third = await deliver(base, path(token), {
        body: slash,
        signature: sign(slash, token),
      });
      expect(third.status).toBe(400);
    });
    expect(h.queue.enqueued).toHaveLength(0);
  });

  test("a timestamp outside +/-24h is 400 stale_delivery, never enqueued and never a 5xx", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const stale = JSON.stringify({
      meeting_id: "01JSTALE0000000000J",
      event: "meeting.transcribed",
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    const future = JSON.stringify({
      meeting_id: "01JFUTURE000000000K",
      event: "meeting.transcribed",
      timestamp: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    });
    const fresh = JSON.stringify({
      meeting_id: "01JFRESH0000000000L",
      event: "meeting.transcribed",
      timestamp: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
    });
    await withServer(h.app, async (base) => {
      const past = await deliver(base, path(token), {
        body: stale,
        signature: sign(stale, token),
      });
      expect(past.status).toBe(400);
      expect(await past.json()).toEqual({ error: "stale_delivery" });

      const ahead = await deliver(base, path(token), {
        body: future,
        signature: sign(future, token),
      });
      expect(ahead.status).toBe(400);

      const ok = await deliver(base, path(token), {
        body: fresh,
        signature: sign(fresh, token),
      });
      expect(ok.status).toBe(202);
    });
    expect(h.queue.enqueued).toHaveLength(1);
    expect(h.queue.enqueued[0]!.input.meetingId).toBe("01JFRESH0000000000L");
  });

  // `Date.parse(String(1700000000))` is NaN, and NaN used to mean "skip the check" — so every
  // epoch-seconds and epoch-millis stamp silently disabled the window, and so did any non-string
  // value. That is the control T1's replay residual leans on.
  test("epoch-seconds, epoch-millis and unparseable timestamps all reach the window", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const bodyWith = (id: string, timestamp: unknown) =>
      JSON.stringify({
        meeting_id: id,
        event: "meeting.transcribed",
        timestamp,
      });

    const cases: Array<[string, unknown, number]> = [
      ["01JEPOCHSEC0000001", 1_500_000_000, 400], // July 2017, epoch seconds
      ["01JEPOCHMS00000001", 1_500_000_000_000, 400], // the same instant, epoch millis
      ["01JOBJECT000000001", { when: "now" }, 400], // present but unreadable ⇒ stale
      ["01JSTRINGNUM000001", String(Date.now()), 202], // a numeric STRING is still a number
      ["01JFRESHSEC0000001", Math.floor(Date.now() / 1000), 202],
      ["01JFRESHMS00000001", Date.now(), 202],
    ];

    await withServer(h.app, async (base) => {
      for (const [id, timestamp, expected] of cases) {
        const body = bodyWith(id, timestamp);
        const res = await deliver(base, path(token), {
          body,
          signature: sign(body, token),
        });
        expect([id, res.status]).toEqual([id, expected]);
        if (expected === 400)
          expect(await res.json()).toEqual({ error: "stale_delivery" });
      }
    });

    expect(h.queue.enqueued.map((entry) => entry.input.meetingId)).toEqual([
      "01JSTRINGNUM000001",
      "01JFRESHSEC0000001",
      "01JFRESHMS00000001",
    ]);
    // Carried onto the item so §6.2's tombstone has an instant a replay cannot refresh.
    for (const entry of h.queue.enqueued) {
      expect(typeof entry.input.sourceTimestamp).toBe("string");
    }
  });

  test("backend KV unreachable is the only retry we ask for", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JKVDOWN000000000M");
    h.queue.failWith = new Error("node unreachable");
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    });
  });

  test("a queue enqueue that surfaced kv Result{ok:false} takes the enqueue-error path — 503, no drain kick, no result=queued", async () => {
    // The node SDK's kv.put now resolves to `{ok:false,error}` on a DURABLE write failure and
    // never rejects. `connector-queue` re-throws that shape so the 202 stays gated on a write
    // that actually landed (§4.6). Here we assert the whole chain: the response is the enqueue
    // arm's 503, no `result=queued` line reaches the public log stream, no drain kick fires as
    // though persistence succeeded, and nothing sits in the fake queue.
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JOKFALSE00000000P");
    h.queue.failWith = new Error("kv operation failed: WRITE_REJECTED");
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await deliver(base, path(token), {
          body,
          signature: sign(body, token),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }
    expect(h.queue.enqueued).toHaveLength(0);
    expect(h.kicks).toHaveLength(0);
    const lines = capture.lines;
    expect(lines.some((l) => l.includes("result=queued"))).toBe(false);
    expect(lines.some((l) => l.includes("op=enqueue-error"))).toBe(true);
  });

  test("a structured enqueue failure returns 503 without exposing the Result message in public logs", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JREDACTEDENQUEUE1");
    h.queue.failWith = await sensitiveStructuredKvFailure();
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await deliver(base, path(token), {
          body,
          signature: sign(body, token),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }

    expect(
      capture.lines.some((line) => line.includes("op=enqueue-error")),
    ).toBe(true);
    expect(capture.lines.join("\n")).not.toContain("AUTHZ_BYTES");
    expect(capture.lines.join("\n")).not.toContain("payload=PRIVATE");
    expect(capture.lines.join("\n")).not.toContain("PRIVATE_RESULT_PAYLOAD");
  });

  test("a token lookup failure answers 503 rather than hanging or 500-ing", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody();
    h.tokens.failWith = new Error("node unreachable");
    await withServer(h.app, async (base) => {
      const res = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    });
  });

  test("a structured lookup failure returns 503 without exposing the Result message in public logs", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody("01JREDACTEDLOOKUP01");
    h.tokens.failWith = await sensitiveStructuredKvFailure();
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await deliver(base, path(token), {
          body,
          signature: sign(body, token),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }

    expect(capture.lines.some((line) => line.includes("op=lookup-error"))).toBe(
      true,
    );
    expect(capture.lines.join("\n")).not.toContain("AUTHZ_BYTES");
    expect(capture.lines.join("\n")).not.toContain("payload=PRIVATE");
    expect(capture.lines.join("\n")).not.toContain("PRIVATE_RESULT_PAYLOAD");
  });

  // ── End-to-end: real ConnectorQueue over a FakeNode that resolves kv.put ok:false ──
  //
  // The prior test above wires the surfaced-throw at the FakeQueue seam; this pins the FULL
  // chain the finding calls for: the REAL `ConnectorQueue` (backend/src/services/connector-queue.ts)
  // over a FakeNode whose `kv.put` resolves `{ok:false,error:{code:"WRITE_REJECTED"}}`. Every
  // hop between assertKvResult and the handler's `op=enqueue-error` arm is exercised — a future
  // regression that intercepts the assertion or swallows the throw would fail here where the
  // seam-level fake could not observe it. Shape mirrors `connector-queue.test.ts:876-946`.
  test("public handler + real ConnectorQueue over a FakeNode that resolves kv.put ok:false: 503, no result=queued, no drain kick, store empty", async () => {
    const failure = {
      ok: false as const,
      error: { code: "WRITE_REJECTED", message: "quota exhausted" },
    };
    const store = new Map<string, unknown>();
    const node = {
      kv: {
        async get(key: string): Promise<unknown> {
          if (!store.has(key)) return { data: null };
          return { data: { data: store.get(key) } };
        },
        async put(_key: string, _value: unknown): Promise<unknown> {
          return failure;
        },
        async delete(key: string): Promise<unknown> {
          store.delete(key);
          return { ok: true, data: true };
        },
      },
      async signIn(): Promise<void> {},
    } as unknown as TinyCloudNode;

    const tokens = new FakeTokenStore();
    const queue = new ConnectorQueue(node, {
      flushWindowMs: 1,
      now: () => Date.now(),
      jitter: () => 0,
    });
    const limiters = new ConnectorWebhookLimiters();
    const kicks: Array<{ source: string; address: string }> = [];
    const app = express();
    app.set("trust proxy", 1);
    app.post(
      "/api/connectors/webhooks/:source/:token",
      limiters.ipPreLimiter,
      express.raw({ type: "application/json", limit: "64kb", inflate: false }),
      createConnectorWebhookParserErrorHandler(limiters),
      createConnectorWebhookHandler({
        tokens,
        queue,
        limiters,
        onDelivery: (input) => {
          kicks.push(input);
        },
      }),
    );
    // index.ts's terminal error handler, same shape as `createHarness` uses.
    app.use(
      (
        err: unknown,
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction,
      ) => {
        if (res.headersSent) {
          next(err);
          return;
        }
        const status =
          typeof err === "object" &&
          err !== null &&
          typeof (err as { status?: unknown }).status === "number"
            ? (err as { status: number }).status
            : 500;
        res
          .status(status >= 400 && status < 600 ? status : 500)
          .json({ error: "internal_error" });
      },
    );

    const token = tokens.register(generateWebhookToken());
    const body = currentBody("01JREALKV000000000Q");
    const capture = captureLogs();
    try {
      await withServer(app, async (base) => {
        const res = await deliver(base, path(token), {
          body,
          signature: sign(body, token),
        });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ error: "unavailable" });
      });
    } finally {
      capture.restore();
    }
    // The 202 is gated on a durable write. The write never landed, so the store must be empty,
    // no `result=queued` line reaches the operator log, the drain kick must not fire, and the
    // enqueue-error line must be visible.
    expect(store.has(`webhooks/pending/${SOURCE}/${ADDRESS}`)).toBe(false);
    expect(kicks).toHaveLength(0);
    expect(capture.lines.some((l) => l.includes("result=queued"))).toBe(false);
    expect(capture.lines.some((l) => l.includes("op=enqueue-error"))).toBe(
      true,
    );
  });
});

describe("connector webhook — limiter chain (§4.4)", () => {
  // The bucket trips at the 21st failure and stops the work from there on. It must NOT change
  // the answer: an unregistered token keeps returning 401 forever (it creates no per-token
  // state at all, §4.4's own observable), so a 429 here is a free live-token confirmation
  // oracle for anyone holding a token from a leaked URL — 21 unauthenticated requests, no
  // secret. §4.6's 429 row governs the per-token SUCCESS bucket, which is the visible one.
  test("the (ip, token) failure bucket trips at 21 without changing the answer", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const unregistered = generateWebhookToken();
    const body = currentBody();
    const badSignature = `sha256=${"b".repeat(64)}`;
    await withServer(h.app, async (base) => {
      for (let i = 0; i < 20; i += 1) {
        const res = await deliver(base, path(token), {
          body,
          signature: badSignature,
          ip: "198.51.100.9",
        });
        expect(res.status).toBe(401);
      }
      const tripped = await deliver(base, path(token), {
        body,
        signature: badSignature,
        ip: "198.51.100.9",
      });
      expect(tripped.status).toBe(401);
      expect(await tripped.json()).toEqual({ error: "invalid_signature" });

      // Wire-identical to the same request against a token that was never registered.
      const unknown = await deliver(base, path(unregistered), {
        body,
        signature: badSignature,
        ip: "198.51.100.9",
      });
      expect(unknown.status).toBe(tripped.status);
      expect(await unknown.json()).toEqual({ error: "invalid_signature" });
    });
    // …and the bucket really did trip: the registered token has an entry, the unknown one none.
    expect(h.limiters.stats().tokenFailureKeys).toBe(1);
  });

  test("60 verified deliveries all 202; the 61st is 429 and flags the card", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    await withServer(h.app, async (base) => {
      for (let i = 0; i < 60; i += 1) {
        const body = currentBody(`01JBURST${String(i).padStart(11, "0")}`);
        const res = await deliver(base, path(token), {
          body,
          signature: sign(body, token),
        });
        expect(res.status).toBe(202);
      }
      const body = currentBody("01JBURSTOVERFLOW001");
      const over = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(over.status).toBe(429);
    });
    // 429s must be visible, not silent (§4.4).
    expect(h.limiters.deliveriesAreRateLimited(ADDRESS)).toBe(true);
    expect(h.queue.enqueued).toHaveLength(60);
  });

  test("T12: unverified requests against a live token do not consume its delivery budget", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const junk = currentBody();
    await withServer(h.app, async (base) => {
      // 60 unsigned POSTs from the attacker's IP: 401 until the (ip, token) failure bucket
      // trips, 429 after — and never a single per-token success increment.
      for (let i = 0; i < 60; i += 1) {
        const res = await deliver(base, path(token), {
          body: junk,
          ip: "192.0.2.66",
        });
        expect([401, 429]).toContain(res.status);
      }
      // The provider's real delivery, from the provider's IP, still lands.
      const body = currentBody("01JREALDELIVERY001");
      const real = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
        ip: "203.0.113.7",
      });
      expect(real.status).toBe(202);
    });
    expect(h.queue.enqueued).toHaveLength(1);
  });

  test("the failure bucket is NOT cross-tenant: A's 30 bad deliveries do not drop B's valid one", async () => {
    const h = createHarness();
    const tokenA = h.tokens.register(generateWebhookToken(), ADDRESS);
    const tokenB = h.tokens.register(generateWebhookToken(), OTHER_ADDRESS);
    const body = currentBody("01JTENANTB00000000N");
    const sharedEgressIp = "203.0.113.7";
    await withServer(h.app, async (base) => {
      for (let i = 0; i < 30; i += 1) {
        await deliver(base, path(tokenA), {
          body,
          signature: `sha256=${"c".repeat(64)}`,
          ip: sharedEgressIp,
        });
      }
      const userB = await deliver(base, path(tokenB), {
        body,
        signature: sign(body, tokenB),
        ip: sharedEgressIp,
      });
      expect(userB.status).toBe(202);
    });
    expect(h.queue.enqueued).toHaveLength(1);
    expect(h.queue.enqueued[0]!.address).toBe(OTHER_ADDRESS);
  });

  test("unknown tokens from one IP are stopped by the IP-only bucket and create ZERO token buckets", async () => {
    // The observable that separates a correct chain from either forbidden one (§4.4): a
    // malformed or unregistered token must never create a per-token store entry, so the
    // in-memory store cannot be grown by attacker-chosen URL segments.
    const h = createHarness({ limiter: { ipLimit: 25 } });
    const body = currentBody();
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        for (let i = 0; i < 40; i += 1) {
          const res = await deliver(base, path(generateWebhookToken()), {
            body,
            ip: "198.51.100.44",
          });
          // The SAME 401 before and after the bucket trips — see the oracle note below.
          expect(res.status).toBe(401);
        }
        for (let i = 0; i < 20; i += 1) {
          const res = await deliver(base, path(`${"z".repeat(43)}`), {
            body,
            ip: "198.51.100.44",
          });
          expect(res.status).toBe(401);
        }
      });
    } finally {
      capture.restore();
    }
    // The bucket really did stop the work — observable on the log, never on the wire.
    expect(
      capture.lines.filter((line) => line.includes("reason=limited bucket=ip"))
        .length,
    ).toBeGreaterThan(0);
    const stats = h.limiters.stats();
    expect(stats.tokenFailureKeys).toBe(0);
    expect(stats.tokenSuccessKeys).toBe(0);
    expect(stats.ipKeys).toBe(1);
  });

  // The mount runs ahead of applyRateLimiters and every other increment lives inside the handler,
  // so a request that died in `express.raw` reached NO bucket — not the IP one, and not §4.4's
  // IP-INDEPENDENT ceiling, which exists precisely because a rotated XFF can uncap the others.
  test("parser-level rejects (413 / 415) are metered, not free", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const oversize = "x".repeat(70 * 1024);

    await withServer(h.app, async (base) => {
      const tooLarge = await deliver(base, path(token), {
        body: oversize,
        ip: "198.51.100.9",
      });
      expect(tooLarge.status).toBe(413);
      const gzip = await deliver(base, path(token), {
        body: "{}",
        ip: "198.51.100.9",
        headers: { "content-encoding": "gzip" },
      });
      expect(gzip.status).toBe(415);
    });

    const stats = h.limiters.stats();
    expect(stats.ipKeys).toBe(1);
    expect(stats.globalFailures).toBe(2);
    // Still no per-token state from an unauthenticated request (§4.4) — the token in the URL is
    // never validated on this path.
    expect(stats.tokenFailureKeys).toBe(0);
    expect(stats.tokenSuccessKeys).toBe(0);
  });

  test("a tripped bucket answers a parser reject with the same generic 401, not 413", async () => {
    // A bucket's job is to stop work, not to name itself: the response must not tell a scanner
    // which of the two ceilings it hit, and it must not grow the bucket further.
    const h = createHarness({ limiter: { ipLimit: 2 } });
    const token = h.tokens.register(generateWebhookToken());
    const oversize = "x".repeat(70 * 1024);

    await withServer(h.app, async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await deliver(base, path(token), {
          body: oversize,
          ip: "198.51.100.10",
        });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([413, 413, 401, 401]);
    });
  });

  test("a registered token's failures are accounted IDENTICALLY to an unknown token's (T8)", async () => {
    // T8/§4.4 rest on "unknown token and bad signature return the identical 401" — and they did,
    // while the ACCOUNTING gave the answer away: only the unknown-token path incremented the IP
    // bucket, so priming the bucket to one below its limit, sending the candidate, then sending
    // one more junk request distinguished a REGISTERED token (401) from an unregistered one (429)
    // in three requests. Anyone holding a token from a leaked URL or a screenshot could confirm
    // it live — T12's precondition. Both classes now count into both IP-keyed buckets.
    const registered = createHarness();
    const token = registered.tokens.register(generateWebhookToken());
    const unknown = createHarness();
    const body = currentBody();

    await withServer(registered.app, async (base) => {
      for (let i = 0; i < 5; i += 1) {
        await deliver(base, path(token), {
          body,
          signature: `sha256=${"d".repeat(64)}`,
          ip: "198.51.100.5",
        });
      }
    });
    await withServer(unknown.app, async (base) => {
      for (let i = 0; i < 5; i += 1) {
        await deliver(base, path(generateWebhookToken()), {
          body,
          signature: `sha256=${"d".repeat(64)}`,
          ip: "198.51.100.5",
        });
      }
    });

    // The distinguisher: one IP bucket entry either way. Only the tenant-scoped bucket differs,
    // and nothing unauthenticated can read it.
    expect(registered.limiters.stats().ipKeys).toBe(1);
    expect(unknown.limiters.stats().ipKeys).toBe(1);
    expect(registered.limiters.stats().globalFailures).toBe(
      unknown.limiters.stats().globalFailures,
    );
    // Unchanged and still load-bearing: an unknown token creates no per-token state (§4.4).
    expect(registered.limiters.stats().tokenFailureKeys).toBe(1);
    expect(unknown.limiters.stats().tokenFailureKeys).toBe(0);
  });

  test("a tripped IP bucket does not touch a registered token's verified delivery", async () => {
    // The cross-tenant failure §4.4 says must not ship, reached WITHOUT a token and WITHOUT a
    // secret while the IP bucket rejected in middleware position: `req.ip` under `trust proxy 1`
    // is the client-written last XFF entry, so an attacker picked any victim IP (Fireflies' small
    // shared egress range, which every legitimate delivery for every user arrives from), sent a
    // handful of malformed POSTs, and 429'd the whole cohort's correctly-signed deliveries for
    // the rest of the window. §4.4's claim that a spoofable XFF and a cross-tenant bucket are
    // mutually exclusive is false: a spoofable XFF makes the bucket trippable against an
    // ARBITRARY chosen IP, which is strictly worse than untrippable.
    const h = createHarness({
      limiter: { ipLimit: 2, globalFailureLimit: 1_000 },
    });
    const token = h.tokens.register(generateWebhookToken());
    const body = currentBody();
    await withServer(h.app, async (base) => {
      // Trip the victim IP's bucket with unauthenticated junk…
      for (let i = 0; i < 4; i += 1) {
        await deliver(base, path(generateWebhookToken()), {
          body,
          ip: "192.0.2.55",
        });
      }
      // …answered with the generic 401, not a 429: see the scanner-oracle test below.
      expect(
        (
          await deliver(base, path(generateWebhookToken()), {
            body,
            ip: "192.0.2.55",
          })
        ).status,
      ).toBe(401);

      // …and the correctly signed delivery from that same IP is still accepted.
      const victim = currentBody("01JIPVICTIM00000001");
      const res = await deliver(base, path(token), {
        body: victim,
        signature: sign(victim, token),
        ip: "192.0.2.55",
      });
      expect(res.status).toBe(202);
    });
    expect(h.queue.enqueued).toHaveLength(1);
  });

  test("the IP-independent global failure bucket caps a spoofed-XFF flood", async () => {
    // §4.4: the real XFF hop count cannot be measured without a deploy, so the second,
    // IP-INDEPENDENT bucket ships — a rotating X-Forwarded-For must not uncap the route.
    const h = createHarness({
      limiter: { ipLimit: 1_000, globalFailureLimit: 10 },
    });
    const body = currentBody();
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        for (let i = 0; i < 20; i += 1) {
          const res = await deliver(base, path(generateWebhookToken()), {
            body,
            ip: `198.51.100.${i + 1}`,
          });
          expect(res.status).toBe(401);
        }
      });
    } finally {
      capture.restore();
    }
    expect(
      capture.lines.filter((line) =>
        line.includes("reason=limited bucket=global"),
      ).length,
    ).toBeGreaterThan(0);
    expect(h.limiters.stats().tokenFailureKeys).toBe(0);
  });

  test("a tripped global bucket does not touch a registered token's verified delivery", async () => {
    // Evaluated in the pre-limiter it ran before the token lookup and before HMAC, so ~5000
    // unauthenticated requests against unregistered tokens disabled webhook ingestion for
    // EVERY tenant for the rest of the window — §4.4's cross-tenant failure, reached without a
    // secret and without knowing a single live token.
    const h = createHarness({
      limiter: { ipLimit: 1_000, globalFailureLimit: 5 },
    });
    const token = h.tokens.register(generateWebhookToken());
    const junk = currentBody();
    await withServer(h.app, async (base) => {
      for (let i = 0; i < 6; i += 1) {
        await deliver(base, path(generateWebhookToken()), {
          body: junk,
          ip: `203.0.113.${i + 1}`,
        });
      }
      // Scanner traffic is still cut off — and answered with the generic 401, not a 429.
      const scanner = await deliver(base, path(generateWebhookToken()), {
        body: junk,
        ip: "203.0.113.99",
      });
      expect(scanner.status).toBe(401);

      // …and the victim's correctly-signed delivery still lands.
      const body = currentBody("01JGLOBALVICTIM001");
      const real = await deliver(base, path(token), {
        body,
        signature: sign(body, token),
      });
      expect(real.status).toBe(202);
    });
    expect(h.queue.enqueued.map((entry) => entry.input.meetingId)).toEqual([
      "01JGLOBALVICTIM001",
    ]);
  });

  test("a tripped scanner bucket does not distinguish a REGISTERED token from an unknown one", async () => {
    // The oracle §4.4/T8 say must not exist, in its surviving form: the accounting was equalised
    // (both classes increment both IP-keyed buckets) but the RESPONSE still diverged. The scanner
    // paths consult `scannerIpLimited()`; the registered-token path never does. So once the
    // bucket tripped — once, from any IP the attacker chooses, since `trust proxy 1` makes
    // `req.ip` the client-written last XFF entry — one request per candidate answered 429 for an
    // unknown token and 401 for a registered one. A tripped bucket short-circuits WITHOUT
    // incrementing and registered probes keep it above the limit, so the oracle was stable for
    // the rest of the window: ~300 requests once, then one per candidate, no secret.
    //
    // Consulting the IP bucket on the registered path instead would restore the cross-tenant
    // blast radius the pre-limiter fix removed, so the fix is the other direction: the scanner
    // path answers the same generic 401 and keeps its no-work short-circuit.
    const h = createHarness({ limiter: { ipLimit: 3 } });
    const registered = h.tokens.register(generateWebhookToken());
    const body = currentBody();
    const badSignature = `sha256=${"e".repeat(64)}`;
    const attackerIp = "198.51.100.77";

    await withServer(h.app, async (base) => {
      // Prime the IP bucket past its limit with format-fail requests.
      for (let i = 0; i < 5; i += 1) {
        await deliver(base, path("not-a-valid-token"), {
          body,
          ip: attackerIp,
        });
      }

      const unknown = await deliver(base, path(generateWebhookToken()), {
        body,
        signature: badSignature,
        ip: attackerIp,
      });
      const live = await deliver(base, path(registered), {
        body,
        signature: badSignature,
        ip: attackerIp,
      });

      // Wire-identical: status AND body. This is the whole assertion.
      expect(unknown.status).toBe(401);
      expect(live.status).toBe(401);
      expect(await unknown.json()).toEqual({ error: "invalid_signature" });
      expect(await live.json()).toEqual({ error: "invalid_signature" });
    });
    // Nothing was enqueued and no per-token success state was created either way.
    expect(h.queue.enqueued).toHaveLength(0);
    expect(h.limiters.stats().tokenSuccessKeys).toBe(0);
  });
});

describe("connector webhook — log hygiene (§6.3)", () => {
  test("attacker-supplied fields cannot forge log lines and no raw identifier is logged", async () => {
    const h = createHarness();
    const token = h.tokens.register(generateWebhookToken());
    const meetingId = "01JLOGHYGIENE00001";
    const body = currentBody(meetingId);
    const capture = captureLogs();
    try {
      await withServer(h.app, async (base) => {
        const res = await deliver(base, path(token), {
          body,
          signature: sign(body, token),
        });
        expect(res.status).toBe(202);
      });
    } finally {
      capture.restore();
    }

    const forgedCapture = captureLogs();
    let forgedLines: string[];
    try {
      await withServer(h.app, async (base) => {
        // Express percent-decodes path params: `%0A[connector-writer]` would otherwise forge a
        // second line into the very stream §6.3 designates as the forensic record.
        const res = await deliver(
          base,
          `/api/connectors/webhooks/${SOURCE}/%0A%5Bconnector-writer%5D`,
          {
            body,
          },
        );
        expect(res.status).toBe(401);
      });
      forgedLines = [...forgedCapture.lines];
    } finally {
      forgedCapture.restore();
    }

    expect(forgedLines).toHaveLength(1);
    expect(forgedLines[0]).toContain("[connector-webhook]");
    expect(forgedLines[0]!.indexOf("[connector-writer]")).toBe(-1);
    expect(forgedLines[0]).not.toContain("\n");

    const all = [...capture.lines, ...forgedLines];
    for (const line of all) {
      expect(line).not.toContain(meetingId);
      expect(line).not.toContain(token);
      expect(line).not.toContain(token.slice(0, 8));
      expect(line.toLowerCase()).not.toContain(ADDRESS.toLowerCase());
      expect(line.toLowerCase()).not.toContain(
        ADDRESS.slice(2, 10).toLowerCase(),
      );
      expect(line.toLowerCase()).not.toContain(ADDRESS.slice(-8).toLowerCase());
      expect(line).not.toContain("spaceId");
    }
    // The hop-count measurement is present and logs no addresses (§4.4).
    expect(all.some((line) => line.includes("op=xff-hops hops=1"))).toBe(true);
    expect(all.some((line) => line.includes("203.0.113.7"))).toBe(false);
  });
});

// ── F009 (3): the epoch-seconds / epoch-millis cutoff, exactly ───────
//
// `parseDeliveryTimestamp` is the freshness window's only input, and NaN used to mean "skip the
// check" — so the branch that decides seconds-vs-millis is security-relevant. `1e11` is the
// cutoff itself and had no test: it is treated as SECONDS (year 5138), which the ±24h window
// then rejects as stale. The point of pinning it is that the boundary is a decision, not an
// accident: 1e11 ms would be 1973, and no provider stamps a 1973 delivery.

describe("parseDeliveryTimestamp boundary (§4.5)", () => {
  test("exactly 1e11 is epoch SECONDS, and 1e11 + 1 is the first millis value", () => {
    expect(parseDeliveryTimestamp(1e11)).toBe(1e11 * 1000);
    expect(parseDeliveryTimestamp(1e11 + 1)).toBe(1e11 + 1);
    // The numeric-string form takes the identical branch — a string is not an exemption.
    expect(parseDeliveryTimestamp("100000000000")).toBe(1e11 * 1000);
    expect(parseDeliveryTimestamp("100000000001")).toBe(1e11 + 1);
  });

  test("the boundary value is STALE, not exempt — the window still runs on it", () => {
    const parsed = parseDeliveryTimestamp(1e11);
    expect(parsed).not.toBeNull();
    // Year 5138: whatever else it is, it is not within ±24h of now.
    expect(Math.abs(Date.now() - parsed!)).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  test("no instant establishable ⇒ null, which the caller reads as stale", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "", "   ", {}, null, undefined, true]) {
      expect(parseDeliveryTimestamp(value)).toBeNull();
    }
  });
});

// ── F009 (2): the abort-flag bounded map ─────────────────────────────
//
// The flags are an in-process Set with a cap, and "no silent caps" is the rule: an eviction is
// safe (the DURABLE disabled marker is authoritative — §3.6 rule 3) but it must be visible, and
// it must never evict when it does not have to. Neither the bound nor the log line had a test.

describe("ConnectorDrainAbortFlags eviction (F009)", () => {
  const addr = (i: number) =>
    `0x${i.toString(16).padStart(40, "0")}`;

  test("the cap is enforced, the oldest entry goes, and the eviction is LOGGED", () => {
    const flags = new ConnectorDrainAbortFlags(3);
    const capture = captureLogs();
    try {
      flags.abort(addr(1));
      flags.abort(addr(2));
      flags.abort(addr(3));
      expect(flags.size()).toBe(3);
      expect(capture.lines.some((l) => l.includes("op=abort-evict"))).toBe(
        false,
      );

      flags.abort(addr(4));
      expect(flags.size()).toBe(3);
      expect(flags.isAborted(addr(1))).toBe(false); // oldest, evicted
      expect(flags.isAborted(addr(4))).toBe(true);
      const evictions = capture.lines.filter((l) =>
        l.includes("op=abort-evict"),
      );
      expect(evictions).toHaveLength(1);
      expect(evictions[0]).toContain("reason=cap cap=3");
      // §6.3: the line names the bound, never whose flag was dropped.
      expect(evictions[0]!.toLowerCase()).not.toContain(addr(1).slice(2));
    } finally {
      capture.restore();
    }
  });

  test("re-aborting an address already present evicts NOTHING", () => {
    const flags = new ConnectorDrainAbortFlags(2);
    flags.abort(addr(1));
    flags.abort(addr(2));
    const capture = captureLogs();
    try {
      flags.abort(addr(1).toUpperCase().replace("0X", "0x"));
      flags.abort(addr(2));
    } finally {
      capture.restore();
    }
    expect(flags.size()).toBe(2);
    expect(flags.isAborted(addr(1))).toBe(true);
    expect(flags.isAborted(addr(2))).toBe(true);
    expect(capture.lines.some((l) => l.includes("op=abort-evict"))).toBe(false);
  });

  test("clear() frees a slot, so the next abort does not have to evict", () => {
    const flags = new ConnectorDrainAbortFlags(2);
    flags.abort(addr(1));
    flags.abort(addr(2));
    flags.clear(addr(1));
    expect(flags.size()).toBe(1);

    const capture = captureLogs();
    try {
      flags.abort(addr(3));
    } finally {
      capture.restore();
    }
    expect(flags.size()).toBe(2);
    expect(flags.isAborted(addr(2))).toBe(true);
    expect(flags.isAborted(addr(3))).toBe(true);
    expect(capture.lines.some((l) => l.includes("op=abort-evict"))).toBe(false);
  });
});
